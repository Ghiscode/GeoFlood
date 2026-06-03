const OWM_KEY = "9183a88b82b8413818dc1379bd528094";
const BANDUNG_CENTER = [-6.9175, 107.6191];

const ALERT_DESC = {
  bahaya:  "Risiko banjir sangat tinggi. Segera waspada penuh, hindari area bantaran dan dataran rendah.",
  waspada: "Kondisi rawan banjir. Pantau terus perkembangan cuaca dan siaga mengungsi jika diperlukan.",
  aman:    "Kondisi saat ini relatif aman dari risiko banjir di area ini.",
};

const ZONA_LABEL = { 0:"Aman", 1:"Waspada", 2:"Bahaya" };

// Frekuensi historis banjir per kelurahan
const HIST = {
  "MEKAR MULYA":4,"BRAGA":2,"MARGASARI":2,"SUKAMISKIN":2,"RANCANUMPANG":2,
  "CIBADAK":2,"HEGARMANAH":2,"PAJAJARAN":2,"KARANG PAMULANG":2,
  "ANTAPANI TENGAH":1,"ANTAPANI WETAN":1,"PASIRLAYUNG":1,"BATUNUNGGAL":1,
  "CIGADUNG":1,"SUKALUYU":1,"ARJUNA":1,"CIPEDES":1,"PASTEUR":1,
  "SUKAWARNA":1,"DERWATI":1,"KUJANGSARI":1,"PAKEMITAN":1,"PASANGGRAHAN":1,
  "PASIRJATI":1,"KOPO":1,"CIPAGANTI":1,"PASIRWANGI":1,"CISARANTEN KULON":1,
  "CIBANGKONG":1,"GEGERKALONG":1,"CIJERAH":1,"JAMIKA":1,"CITARUM":1
};

let dataPompa    = [];
let dataKolam    = [];
let dataSumur    = [];
let zonaFeatures = [];
let kelurahanIndex = [];
let highlightLayer = null;

function skorPemicu(zoneLevel, rainMM) {
  const skorZona = zoneLevel === 2 ? 80 : zoneLevel === 1 ? 40 : 0;
  const skorHujan = rainMM > 10 ? 20 : rainMM >= 5 ? 10 : 0;
  return skorZona + skorHujan;
}

function jarakMeter(lat1, lng1, lat2, lng2) {
  return L.latLng(lat1, lng1).distanceTo(L.latLng(lat2, lng2));
}

function mitigasiPompa(lat, lng) {
  const BASE = { "Tier 1": 30, "Tier 2": 20, "Tier 3": 10 };
  let totalPoin = 0;

  for (const f of dataPompa) {
    const [fLng, fLat] = f.geometry.coordinates;
    const jarak = jarakMeter(lat, lng, fLat, fLng);
    if (jarak > 500) continue;

    const base = BASE[f.properties.tier] || 10;
    const multiplier = jarak <= 150 ? 1.0 : jarak <= 350 ? 0.5 : 0.25;
    totalPoin += Math.round(base * multiplier);
  }

  return totalPoin;
}

function mitigasiKolam(lat, lng) {
  const BASE = { "Tier 1": 20, "Tier 2": 10, "Tier 3": 5 };
  let totalPoin = 0;

  for (const f of dataKolam) {
    const [fLng, fLat] = f.geometry.coordinates;
    const jarak = jarakMeter(lat, lng, fLat, fLng);
    if (jarak > 1000) continue;

    const tier = f.properties.tier;
    const base = BASE[tier] || 5;

    let multiplier;
    if (jarak <= 300)       multiplier = 1.0;
    else if (jarak <= 700)  multiplier = 0.5;
    else {
      if (tier === "Tier 3") continue;
      multiplier = 0.25;
    }

    totalPoin += Math.round(base * multiplier);
  }

  return totalPoin;
}

function mitigasiSumur(lat, lng) {
  const BASE = { "Tier 1": 10, "Tier 2": 5 };
  let totalPoin = 0;

  for (const f of dataSumur) {
    const [fLng, fLat] = f.geometry.coordinates;
    const jarak = jarakMeter(lat, lng, fLat, fLng);
    if (jarak > 200) continue;

    const base = BASE[f.properties.tier] || 5;
    const multiplier = jarak <= 100 ? 1.0 : 0.5;
    totalPoin += Math.round(base * multiplier);
  }

  return totalPoin;
}

function hitungRisiko(zoneLevel, rainMM, lat, lng) {
  const pemicu   = skorPemicu(zoneLevel, rainMM);
  const mitigasi = mitigasiPompa(lat, lng) +
                   mitigasiKolam(lat, lng) +
                   mitigasiSumur(lat, lng);

  const skorAkhir = Math.max(0, pemicu - mitigasi);

  let level, label;
  if (skorAkhir > 60)      { level = "bahaya";  label = "BAHAYA";  }
  else if (skorAkhir > 30) { level = "waspada"; label = "WASPADA"; }
  else                     { level = "aman";    label = "AMAN";    }

  return { level, label, skorAkhir, pemicu, mitigasi };
}

function kondisiCuaca(id, rain) {
  if (id >= 200 && id < 300) return "Hujan Petir";
  if (id >= 300 && id < 600) {
    if (rain > 10) return "Hujan Lebat";
    if (rain >= 5) return "Hujan Sedang";
    return "Hujan Ringan";
  }
  if (id >= 600 && id < 800) return "Berawan";
  if (id === 800) return "Cerah";
  if (id === 801) return "Cerah Berawan";
  return "Mendung";
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
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
      const inHole = polygon.slice(1).some(h => pointInRing(lng, lat, h));
      if (!inHole) return true;
    }
  }
  return false;
}

function zonaAt(latlng) {
  if (!zonaFeatures.length) return 1;
  for (const z of [2, 1, 0]) {
    const feat = zonaFeatures.find(f => f.properties.zone === z);
    if (feat && pointInMultiPolygon(latlng.lng, latlng.lat, feat.geometry.coordinates))
      return z;
  }
  return 0;
}

let panelOpen = false;

function toggleLayerPanel() {
  panelOpen = !panelOpen;
  document.getElementById("panelBody").classList.toggle("hidden", !panelOpen);
  document.getElementById("panelToggleLabel").textContent = panelOpen ? "Sembunyikan" : "Tampilkan";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("panelBody").classList.add("hidden");
});

const map = L.map("map", { zoomControl:false, attributionControl:false })
  .setView(BANDUNG_CENTER, 13);

const basemaps = {
  streets:   L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19 }),
  satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom:19 }),
  light:     L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom:19 })
};
basemaps.satellite.addTo(map);
let activeBasemap = "satellite";

["paneZona","paneSungai","paneBatas","paneInfra","paneTitik"].forEach((name, i) => {
  map.createPane(name).style.zIndex = 400 + i * 50;
});

const layers = {
  zona:     L.layerGroup().addTo(map),
  sungai:   L.layerGroup().addTo(map),
  batas:    L.layerGroup().addTo(map),
  historis: L.layerGroup(),
  infra:    L.layerGroup(),
};

// Zona Kerawanan
fetch("data/Zona-Banjir-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    zonaFeatures = data.features;
    L.geoJSON(data, {
      pane: "paneZona", interactive: false,
      style: f => ({
        fillColor: f.properties.zone === 2 ? "#fca5a5"
                 : f.properties.zone === 1 ? "#fcd34d" : "#86efac",
        weight: 0, fillOpacity: 0.45,
      })
    }).addTo(layers.zona);
  });

// Sungai
fetch("data/Sungai-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneSungai",
      style: f => {
        const r = (f.properties.REMARK || "").toLowerCase();
        return { color:"#3b82f6", weight: r.includes("utama")||r.includes("induk") ? 2.5 : 1.5, opacity:0.7 };
      }
    }).addTo(layers.sungai);
  });

// Historis Banjir
fetch("data/Historis-Banjir.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneTitik",
      pointToLayer: (f, latlng) => {
        const jiwa = f.properties.Jiwa_Menderita || 0;
        const rad  = Math.min(4 + Math.sqrt(jiwa) * 1.4, 13);
        L.circleMarker(latlng, {
          pane:"paneTitik", radius:rad*2.2,
          fillColor:"#ef4444", fillOpacity:.1,
          color:"#ef4444", weight:.5, opacity:.25, interactive:false,
        }).addTo(layers.historis);
        return L.circleMarker(latlng, {
          radius:rad, fillColor:"#ef4444", color:"#fff", weight:1.8, fillOpacity:.92,
        });
      },
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindTooltip(`
          <div class="tt-name">📍 Kel. ${p.Kelurahan||"—"}</div>
          <div class="tt-stats">
            Kec. ${p.Kecamatan||"—"} &nbsp;·&nbsp; <strong>${p.Tgl_Kejadian||"—"}</strong><br>
            ${p.Jiwa_Menderita||0} jiwa &nbsp;·&nbsp; ${p.Rumah_Terendam||0} rumah terendam
          </div>
        `, { className:"geo-tt", sticky:true, offset:[10,0] });
        l.on("click", e => bukaPanel((p.Kelurahan||"—").toUpperCase(), e.latlng));
      }
    }).addTo(layers.historis);
  });

// Batas Wilayah
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
              const rain   = w.rain ? (w.rain["1h"] || w.rain["3h"] || 0) : 0;
              const entry  = kelurahanIndex.find(k => k.nama === nama);
              const zonePt = entry?.centroid || e.latlng;
              const zone   = zonaAt(zonePt);
              const hasil  = hitungRisiko(zone, rain, e.latlng.lat, e.latlng.lng);
              const warna  = { bahaya:"#dc2626", waspada:"#d97706", aman:"#16a34a" }[hasil.level];
              this.setTooltipContent(`
                <div class="tt-name">Kel. ${nama}</div>
                <div class="tt-alert" style="color:${warna}">● ${hasil.label} poin)</div>
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

// ── Infrastruktur: Ikon kustom ────────────────────────────────────
function buatIkon(warna, simbol) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:26px;height:26px;border-radius:50%;
      background:${warna};color:white;
      display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:700;
      box-shadow:0 2px 6px rgba(0,0,0,.3);
      border:2px solid white;">
      ${simbol}
    </div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

// Rumah Pompa
fetch("data/RumahPompa.json")
  .then(r => r.json())
  .then(data => {
    dataPompa = data.features;
    L.geoJSON(data, {
      pane: "paneInfra",
      pointToLayer: (f, latlng) => L.marker(latlng, { icon: buatIkon("#0ea5e9", "P") }),
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindTooltip(`
          <div class="tt-name">💧 ${p.nama}</div>
          <div class="tt-stats">${p.tier} &nbsp;·&nbsp; ${p.kapasitas} lt/dt</div>
        `, { className:"geo-tt", sticky:true });
      }
    }).addTo(layers.infra);
  });

// Kolam Retensi
fetch("data/KolamRetensi.json")
  .then(r => r.json())
  .then(data => {
    dataKolam = data.features;
    L.geoJSON(data, {
      pane: "paneInfra",
      pointToLayer: (f, latlng) => L.marker(latlng, { icon: buatIkon("#8b5cf6", "K") }),
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindTooltip(`
          <div class="tt-name">🏊 ${p.nama}</div>
          <div class="tt-stats">${p.tier} &nbsp;·&nbsp; ${p.volume.toLocaleString()} m³</div>
        `, { className:"geo-tt", sticky:true });
      }
    }).addTo(layers.infra);
  });

// Sumur Imbuhan
fetch("data/SumurImbuhan.json")
  .then(r => r.json())
  .then(data => {
    dataSumur = data.features;
    L.geoJSON(data, {
      pane: "paneInfra",
      pointToLayer: (f, latlng) => L.marker(latlng, { icon: buatIkon("#10b981", "S") }),
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindTooltip(`
          <div class="tt-name">🔵 ${p.nama}</div>
          <div class="tt-stats">${p.tier} &nbsp;·&nbsp; ${p.tipe || "—"} &nbsp;·&nbsp; ${p.kelurahan}</div>
        `, { className:"geo-tt", sticky:true });
      }
    }).addTo(layers.infra);
  });

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
      const rain    = w.rain ? (w.rain["1h"] || w.rain["3h"] || 0) : 0;
      const entry   = kelurahanIndex.find(k => k.nama === nama);
      const zonePt  = entry?.centroid || latlng;
      const zone    = zonaAt(zonePt);
      const hist    = HIST[nama] || 0;
      const hasil   = hitungRisiko(zone, rain, latlng.lat, latlng.lng);
      const zonaKls = { 0:"aman", 1:"waspada", 2:"bahaya" }[zone];

      alertBlock.className    = `alert-block ${hasil.level}`;
      alertDot.className      = `alert-dot ${hasil.level}`;
      alertStatus.className   = `alert-status ${hasil.level}`;
      alertStatus.textContent = `${hasil.label}`;
      alertDesc.textContent   = ALERT_DESC[hasil.level];

      factorTable.innerHTML = `
        <div class="ft-row">
          <span class="ft-label">Faktor Fisik</span>  
          <span class="ft-val ${zonaKls}">${ZONA_LABEL[zone]}</span>
        </div>
        <div class="ft-row">
          <span class="ft-label">Curah Hujan</span>
          <span class="ft-val">${rain} mm/jam</span>
        </div>
        <div class="ft-row">
          <span class="ft-label">Riwayat Banjir</span>
          <span class="ft-val">${hist > 0 ? hist + "× kejadian" : "Belum tercatat"}</span>
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

document.querySelectorAll(".toggle").forEach(t => {
  t.addEventListener("click", () => {
    const isOn = t.classList.toggle("on");
    isOn ? map.addLayer(layers[t.dataset.layer]) : map.removeLayer(layers[t.dataset.layer]);
  });
});

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
