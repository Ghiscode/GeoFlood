const OWM_KEY        = "c858ad50a4ac7282e4f4a25a290603b3";
const BANDUNG_CENTER = [-6.9175, 107.6191];

// Frekuensi historis banjir per kelurahan (sumber: QGIS)
const HIST = {
  "MEKAR MULYA":4, "BRAGA":2, "MARGASARI":2, "SUKAMISKIN":2, "RANCANUMPANG":2,
  "CIBADAK":2, "HEGARMANAH":2, "PAJAJARAN":2, "KARANG PAMULANG":2,
  "ANTAPANI TENGAH":1, "ANTAPANI WETAN":1, "PASIRLAYUNG":1, "BATUNUNGGAL":1,
  "CIGADUNG":1, "SUKALUYU":1, "ARJUNA":1, "CIPEDES":1, "PASTEUR":1,
  "SUKAWARNA":1, "DERWATI":1, "KUJANGSARI":1, "PAKEMITAN":1, "PASANGGRAHAN":1,
  "PASIRJATI":1, "KOPO":1, "CIPAGANTI":1, "PASIRWANGI":1, "CISARANTEN KULON":1,
  "CIBANGKONG":1, "GEGERKALONG":1, "CIJERAH":1, "JAMIKA":1, "CITARUM":1
};

const ALERT_DESC = {
  bahaya:  "Risiko banjir sangat tinggi. Segera waspada penuh, hindari area bantaran dan dataran rendah.",
  waspada: "Kondisi rawan banjir. Pantau terus perkembangan cuaca dan siaga mengungsi jika diperlukan.",
  aman:    "Kondisi saat ini relatif aman dari risiko banjir di area ini.",
};

const ZONA_LABEL = { 0:"Aman", 1:"Waspada", 2:"Bahaya" };

// ── Point-in-polygon (ray casting) ───────────────────────────────
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInMultiPolygon(lng, lat, coords) {
  for (const polygon of coords) {
    if (pointInRing(lng, lat, polygon[0])) {
      const inHole = polygon.slice(1).some(hole => pointInRing(lng, lat, hole));
      if (!inHole) return true;
    }
  }
  return false;
}

// ── Zona QGIS lookup ─────────────────────────────────────────────
let zonaFeatures = [];

function zonaAt(latlng) {
  if (!zonaFeatures.length) return 1;
  for (const z of [2, 1, 0]) {
    const feat = zonaFeatures.find(f => f.properties.zone === z);
    if (feat && pointInMultiPolygon(latlng.lng, latlng.lat, feat.geometry.coordinates))
      return z;
  }
  return 0;
}

// ── Kalkulasi peringatan dini ─────────────────────────────────────
// Sistem skoring sesuai metodologi penelitian:
//   Skor Zona QGIS  : Bahaya=3, Waspada=2, Aman=1  (data statis)
//   Skor Curah Hujan: >10mm=3, 5-10mm=2, <5mm=1    (data dinamis)
//   Total skor      : 7-9 = Bahaya, 5-6 = Waspada, 2-4 = Aman
function hitungPeringatan(rainMM, zoneLevel) {
  const skorZona  = zoneLevel === 2 ? 3 : zoneLevel === 1 ? 2 : 1;
  const skorHujan = rainMM > 10 ? 3 : rainMM >= 5 ? 2 : 1;
  const total     = skorZona + skorHujan;

  if (total >= 7) return { level:"bahaya",  label:"BAHAYA",  total };
  if (total >= 5) return { level:"waspada", label:"WASPADA", total };
  return              { level:"aman",    label:"AMAN",    total };
}

// ── Label cuaca berdasarkan curah hujan realtime ─────────────────
// 0mm = Cerah | 1-5mm = Hujan Ringan | 5-10mm = Hujan Sedang | >10mm = Hujan Lebat
function kondisiCuaca(id, rain) {
  if (rain === 0) {
    if (id >= 200 && id < 300) return "Hujan Petir";
    if (id === 800) return "Cerah";
    if (id === 801) return "Cerah Berawan";
    return "Mendung";
  }
  if (rain > 10) return "Hujan Lebat";
  if (rain >= 5)  return "Hujan Sedang";
  return "Hujan Ringan";
}

// ── Panel toggle ──────────────────────────────────────────────────
let panelOpen = false;

function toggleLayerPanel() {
  panelOpen = !panelOpen;
  document.getElementById("panelBody").classList.toggle("hidden", !panelOpen);
  document.getElementById("panelToggleLabel").textContent = panelOpen ? "Sembunyikan" : "Tampilkan";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("panelBody").classList.add("hidden");
});

// ── Map init ──────────────────────────────────────────────────────
const map = L.map("map", { zoomControl:false, attributionControl:false })
  .setView(BANDUNG_CENTER, 13);

const basemaps = {
  streets:   L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19 }),
  satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom:19 }),
  light:     L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom:19 })
};
basemaps.light.addTo(map);
let activeBasemap = "light";

["paneZona","paneSungai","paneBatas","paneTitik"].forEach((name, i) => {
  map.createPane(name).style.zIndex = 400 + i * 50;
});

const layers = {
  zona:     L.layerGroup().addTo(map),
  sungai:   L.layerGroup().addTo(map),
  batas:    L.layerGroup().addTo(map),
  historis: L.layerGroup().addTo(map),
};

let kelurahanIndex = [];
let highlightLayer = null;

// ── Load: Zona Kerawanan ──────────────────────────────────────────
fetch("data/Zona-Banjir-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    zonaFeatures = data.features;
    L.geoJSON(data, {
      pane: "paneZona",
      interactive: false,
      style: f => ({
        fillColor: f.properties.zone === 2 ? "#fca5a5"
                 : f.properties.zone === 1 ? "#fcd34d" : "#86efac",
        weight: 0,
        fillOpacity: 0.45,
      })
    }).addTo(layers.zona);
  });

// ── Load: Sungai ──────────────────────────────────────────────────
fetch("data/Sungai-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneSungai",
      style: f => {
        const r = (f.properties.REMARK || "").toLowerCase();
        const isMain = r.includes("utama") || r.includes("induk");
        return { color:"#3b82f6", weight: isMain ? 2.5 : 1.5, opacity:0.7 };
      }
    }).addTo(layers.sungai);
  });

// ── Load: Historis Banjir ─────────────────────────────────────────
fetch("data/Historis-Banjir.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneTitik",
      pointToLayer: (f, latlng) => {
        const jiwa = f.properties.Jiwa_Menderita || 0;
        const rad  = Math.min(4 + Math.sqrt(jiwa) * 1.4, 13);
        L.circleMarker(latlng, {
          pane:"paneTitik", radius:rad * 2.2,
          fillColor:"#ef4444", fillOpacity:.1,
          color:"#ef4444", weight:.5, opacity:.25, interactive:false,
        }).addTo(layers.historis);
        return L.circleMarker(latlng, {
          radius:rad, fillColor:"#ef4444",
          color:"#fff", weight:1.8, fillOpacity:.92,
        });
      },
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindTooltip(`
          <div class="tt-name">📍 Kel. ${p.Kelurahan || "—"}</div>
          <div class="tt-stats">
            Kec. ${p.Kecamatan || "—"} &nbsp;·&nbsp; <strong>${p.Tgl_Kejadian || "—"}</strong><br>
            ${p.Jiwa_Menderita || 0} jiwa &nbsp;·&nbsp; ${p.Rumah_Terendam || 0} rumah terendam
          </div>
        `, { className:"geo-tt", sticky:true, offset:[10,0] });
        l.on("click", e => bukaPanel((p.Kelurahan || "—").toUpperCase(), e.latlng));
      }
    }).addTo(layers.historis);
  });

// ── Load: Batas Wilayah ───────────────────────────────────────────
fetch("data/Batas-Wilayah.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneBatas",
      style: { color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" },
      onEachFeature: (f, l) => {
        const nama = (f.properties.desa || f.properties.NAMOBJ || "Wilayah").toUpperCase();
        let centroid = null;
        try { centroid = l.getBounds().getCenter(); } catch(_) {}
        kelurahanIndex.push({ nama, layer:l, centroid });

        l.on("mouseover", function(e) {
          this.setStyle({ weight:2.5, color:"#2563eb", dashArray:"" });
          this.bindTooltip(
            `<div class="tt-name">Kel. ${nama}</div>
             <div class="tt-stats" style="color:#94a3b8">Memuat…</div>`,
            { className:"geo-tt", sticky:true, offset:[10,0] }
          ).openTooltip();

          fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${e.latlng.lat}&lon=${e.latlng.lng}&appid=${OWM_KEY}&units=metric&lang=id`)
            .then(r => r.json())
            .then(w => {
              const rain   = w.rain ? (w.rain["1h"] || 0) : 0;
              const entry  = kelurahanIndex.find(k => k.nama === nama);
              const zonePt = entry?.centroid || e.latlng;
              const zone   = zonaAt(zonePt);
              const hasil  = hitungPeringatan(rain, zone);
              const warna  = { bahaya:"#dc2626", waspada:"#d97706", aman:"#16a34a" }[hasil.level];
              this.setTooltipContent(`
                <div class="tt-name">Kel. ${nama}</div>
                <div class="tt-alert" style="color:${warna}">● ${hasil.label}</div>
                <div class="tt-stats">
                  ${kondisiCuaca(w.weather[0].id, rain)} &nbsp;·&nbsp; ${w.main.temp.toFixed(1)}°C<br>
                  💧 ${rain} mm/jam
                </div>
              `);
            }).catch(() => {});
        });

        l.on("mouseout", function() {
          this.setStyle({ weight:.8, color:"#94a3b8", dashArray:"3,3" });
        });

        l.on("click", e => bukaPanel(nama, e.latlng));
      }
    }).addTo(layers.batas);
  });

// ── Info panel ────────────────────────────────────────────────────
function bukaPanel(nama, latlng) {
  document.getElementById("infoName").textContent   = nama;
  document.getElementById("infoCoords").textContent =
    `${latlng.lat.toFixed(5)}°N  ${latlng.lng.toFixed(5)}°E`;

  const alertBlock  = document.getElementById("alertBlock");
  const alertDot    = document.getElementById("alertDot");
  const alertStatus = document.getElementById("alertStatus");
  const alertDesc   = document.getElementById("alertDesc");
  const factorTable = document.getElementById("factorTable");
  const wStrip      = document.getElementById("weatherStrip");

  alertBlock.className    = "alert-block loading";
  alertDot.className      = "alert-dot";
  alertStatus.className   = "alert-status loading";
  alertStatus.textContent = "Menghitung…";
  alertDesc.textContent   = "";
  factorTable.innerHTML   = "";
  wStrip.innerHTML        = `<div class="ws-loading">Memuat cuaca…</div>`;

  document.getElementById("infoPanel").classList.add("visible");
  if (window.innerWidth > 600) {
    document.querySelector(".zoom-ctrl").style.bottom = "440px";
  }

  fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${latlng.lat}&lon=${latlng.lng}&appid=${OWM_KEY}&units=metric&lang=id`)
    .then(r => r.json())
    .then(w => {
      const rain    = w.rain ? (w.rain["1h"] || 0) : 0;
      const entry   = kelurahanIndex.find(k => k.nama === nama);
      const zonePt  = entry?.centroid || latlng;
      const zone    = zonaAt(zonePt);
      const hasil   = hitungPeringatan(rain, zone, nama);
      const zonaKls = { 0:"aman", 1:"waspada", 2:"bahaya" }[zone];

      alertBlock.className    = `alert-block ${hasil.level}`;
      alertDot.className      = `alert-dot ${hasil.level}`;
      alertStatus.className   = `alert-status ${hasil.level}`;
      alertStatus.textContent = hasil.label;
      alertDesc.textContent   = ALERT_DESC[hasil.level];

      factorTable.innerHTML = `
        <div class="ft-row">
          <span class="ft-label">Zona Kerawanan QGIS</span>
          <span class="ft-val ${zonaKls}">${ZONA_LABEL[zone]}</span>
        </div>
        <div class="ft-row">
          <span class="ft-label">Curah Hujan Realtime</span>
          <span class="ft-val">${rain} mm/jam</span>
        </div>
      `;

      wStrip.innerHTML = `
        <div class="ws-desc">${kondisiCuaca(w.weather[0].id, rain)}</div>
        <div class="ws-row">
          <div class="ws-item">
            <div class="ws-val">${w.main.temp.toFixed(1)}°</div>
            <div class="ws-unit">Suhu</div>
          </div>
          <div class="ws-item">
            <div class="ws-val">${rain}</div>
            <div class="ws-unit">mm/jam</div>
          </div>
        </div>
      `;
    })
    .catch(() => {
      alertStatus.textContent = "Gagal memuat";
      wStrip.innerHTML = `<div class="ws-loading">Koneksi gagal</div>`;
    });
}

function closeInfoPanel() {
  document.getElementById("infoPanel").classList.remove("visible");
  document.querySelector(".zoom-ctrl").style.bottom = "24px";
  clearHighlight();
}

// ── Layer toggles ─────────────────────────────────────────────────
document.querySelectorAll(".toggle").forEach(t => {
  t.addEventListener("click", () => {
    const isOn = t.classList.toggle("on");
    isOn ? map.addLayer(layers[t.dataset.layer]) : map.removeLayer(layers[t.dataset.layer]);
  });
});

// ── Basemap switcher ──────────────────────────────────────────────
document.querySelectorAll(".bmap-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.map;
    if (key === activeBasemap) return;
    map.removeLayer(basemaps[activeBasemap]);
    basemaps[key].addTo(map);
    activeBasemap = key;
    document.querySelectorAll(".bmap-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// ── Highlight wilayah ─────────────────────────────────────────────
function setHighlight(layer) {
  if (highlightLayer) {
    highlightLayer.setStyle({ color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" });
  }
  layer.setStyle({ color:"#16a34a", weight:3, fillOpacity:0.1, fillColor:"#16a34a", dashArray:"" });
  layer.bringToFront();
  highlightLayer = layer;
}

function clearHighlight() {
  if (highlightLayer) {
    highlightLayer.setStyle({ color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" });
    highlightLayer = null;
  }
}

// ── Search ────────────────────────────────────────────────────────
const searchInput   = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  searchResults.innerHTML = "";
  if (q.length < 2) { searchResults.classList.remove("open"); return; }

  const hits = kelurahanIndex.filter(k => k.nama.toLowerCase().includes(q)).slice(0, 8);
  if (!hits.length) { searchResults.classList.remove("open"); return; }

  hits.forEach(({ nama, layer }) => {
    const item = document.createElement("div");
    item.className = "search-result-item";
    item.innerHTML = `
      <div class="sri-icon">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
        </svg>
      </div>
      Kel. ${nama}
    `;
    item.addEventListener("click", () => {
      searchResults.classList.remove("open");
      searchInput.value = "";
      try {
        const b = layer.getBounds();
        map.flyToBounds(b, { padding:[60,60], maxZoom:15, duration:1 });
        setHighlight(layer);
        bukaPanel(nama, b.getCenter());
      } catch(_) {}
    });
    searchResults.appendChild(item);
  });
  searchResults.classList.add("open");
});

document.addEventListener("click", e => {
  if (!e.target.closest(".search-wrap")) searchResults.classList.remove("open");
});

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); searchInput.focus(); }
  if (e.key === "Escape") {
    closeInfoPanel();
    searchResults.classList.remove("open");
    searchInput.blur();
  }
});
