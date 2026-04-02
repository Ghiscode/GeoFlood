/* ═══════════════════════════════════════════════════════════════
   GeoFlood Bandung · script.js

   KALKULASI PERINGATAN DINI per kelurahan:
     Faktor 1 — Zona Kerawanan QGIS  (point-in-polygon, ray casting)
     Faktor 2 — Curah Hujan realtime OWM  (mm/jam)
     Faktor 3 — Riwayat Banjir historis QGIS  (frekuensi kejadian)
   Output: BAHAYA / WASPADA / AMAN
   ═══════════════════════════════════════════════════════════════ */

const OWM_KEY        = "c858ad50a4ac7282e4f4a25a290603b3";
const BANDUNG_CENTER = [-6.9175, 107.6191];

/* ── Frekuensi historis per kelurahan (dari Historis-Banjir QGIS) */
const HIST = {
  "MEKAR MULYA":4,"BRAGA":2,"MARGASARI":2,"SUKAMISKIN":2,"RANCANUMPANG":2,
  "CIBADAK":2,"HEGARMANAH":2,"PAJAJARAN":2,"ANTAPANI TENGAH":1,"ANTAPANI WETAN":1,
  "PASIRLAYUNG":1,"KARANG PAMULANG":2,"BATUNUNGGAL":1,"CIGADUNG":1,"SUKALUYU":1,
  "ARJUNA":1,"CIPEDES":1,"PASTEUR":1,"SUKAWARNA":1,"DERWATI":1,"KUJANGSARI":1,
  "PAKEMITAN":1,"PASANGGRAHAN":1,"PASIRJATI":1,"KOPO":1,"CIPAGANTI":1,
  "PASIRWANGI":1,"CISARANTEN KULON":1,"CIBANGKONG":1,"GEGERKALONG":1,
  "CIJERAH":1,"JAMIKA":1,"CITARUM":1
};

/* ─────────────────────────────────────────────────────────────────
   POINT-IN-POLYGON  (ray casting — akurat untuk MultiPolygon)
   Mengecek apakah titik [lng, lat] ada di dalam ring koordinat.
   GeoJSON ring: array of [lng, lat] pairs.
   ───────────────────────────────────────────────────────────────── */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/* Cek titik dalam MultiPolygon (GeoJSON spec: [[outerRing, ...holes], ...]) */
function pointInMultiPolygon(lng, lat, multiPolyCoords) {
  for (const polygon of multiPolyCoords) {
    const outerRing = polygon[0];
    if (pointInRing(lng, lat, outerRing)) {
      // Cek lubang (holes) — jika titik ada di hole, berarti di luar
      let inHole = false;
      for (let h = 1; h < polygon.length; h++) {
        if (pointInRing(lng, lat, polygon[h])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

/* ── Zona QGIS yang akurat ──────────────────────────────────────
   File Zona-Banjir-Bandung.geojson punya 3 feature MultiPolygon
   (zone 0, 1, 2) yang merupakan area-area terpisah hasil analisis
   spasial QGIS. Lookup dengan ray casting per titik.
   Prioritas: zone 2 (bahaya) > zone 1 (waspada) > zone 0 (aman)
   Default: -1 = di luar cakupan zona (treated as aman)
   ─────────────────────────────────────────────────────────────── */
let zonaFeatures = [];   // diisi setelah fetch

function zonaAt(latlng) {
  if (!zonaFeatures.length) return 1;  // fallback jika data belum siap
  const lng = latlng.lng, lat = latlng.lat;

  // Cek prioritas tertinggi dulu (bahaya > waspada > aman)
  for (const priority of [2, 1, 0]) {
    const feat = zonaFeatures.find(f => f.properties.zone === priority);
    if (feat && pointInMultiPolygon(lng, lat, feat.geometry.coordinates)) {
      return priority;
    }
  }
  return 0;  // di luar semua zona = aman
}

/* ── Kalkulasi status peringatan ────────────────────────────────
   Bobot:
     Zona QGIS    40% — kerentanan spasial dari analisis QGIS
     Curah Hujan  40% — kondisi cuaca aktual realtime OWM
     Riwayat      20% — frekuensi kejadian banjir historis
   ─────────────────────────────────────────────────────────────── */
function hitungPeringatan(rainMM, zoneLevel, kelurahan) {
  const nZona  = zoneLevel === 2 ? 1.0 : zoneLevel === 1 ? 0.5 : 0.0;
  const nHujan = Math.min(rainMM / 20, 1.0);
  const nHist  = Math.min((HIST[kelurahan] || 0) / 4, 1.0);

  const skor   = (nZona * 0.40) + (nHujan * 0.40) + (nHist * 0.20);
  const persen = Math.round(skor * 100);

  if (persen >= 60) return { level:"bahaya",  label:"BAHAYA",  persen };
  if (persen >= 35) return { level:"waspada", label:"WASPADA", persen };
  return                   { level:"aman",    label:"AMAN",    persen };
}

const ALERT_DESC = {
  bahaya:  "Risiko banjir sangat tinggi. Segera waspada penuh, hindari area bantaran dan dataran rendah.",
  waspada: "Kondisi rawan banjir. Pantau terus perkembangan cuaca dan siaga mengungsi jika diperlukan.",
  aman:    "Kondisi saat ini relatif aman dari risiko banjir di area ini.",
};

const ZONA_LABEL = { 0:"Aman", 1:"Waspada", 2:"Bahaya" };


/* ── Terjemahan kondisi cuaca ke bahasa umum ────────────────────
   Berdasarkan OWM weather condition ID:
   https://openweathermap.org/weather-conditions               */
function kondisiCuaca(weatherId, rainMM) {
  // Thunderstorm (2xx)
  if (weatherId >= 200 && weatherId < 300) return "Hujan Petir";
  // Drizzle (3xx)
  if (weatherId >= 300 && weatherId < 400) return "Gerimis";
  // Rain (5xx)
  if (weatherId >= 500 && weatherId < 600) {
    if (weatherId === 500) return "Hujan Ringan";
    if (weatherId === 501) return "Hujan Sedang";
    if (weatherId === 502 || weatherId === 503 || weatherId === 504) return "Hujan Lebat";
    if (weatherId === 511) return "Hujan Es";
    if (weatherId === 520 || weatherId === 521) return "Hujan Deras";
    if (weatherId === 522 || weatherId === 531) return "Hujan Sangat Lebat";
    return "Hujan";
  }
  // Snow (6xx) — tidak umum di Bandung
  if (weatherId >= 600 && weatherId < 700) return "Hujan";
  // Atmosphere (7xx)
  if (weatherId === 701 || weatherId === 741) return "Berkabut";
  if (weatherId >= 700 && weatherId < 800) return "Berkabut";
  // Clear (800)
  if (weatherId === 800) return "Cerah";
  // Clouds (80x)
  if (weatherId === 801) return "Cerah Berawan";
  if (weatherId === 802) return "Berawan";
  if (weatherId === 803 || weatherId === 804) return "Mendung";
  // Fallback: cek curah hujan realtime
  if (rainMM >= 10) return "Hujan Lebat";
  if (rainMM >= 3)  return "Hujan Sedang";
  if (rainMM > 0)   return "Gerimis";
  return "Cerah";
}

/* ═══ MAP INIT ══════════════════════════════════════════════════ */
const map = L.map("map", { zoomControl:false, attributionControl:false })
    .setView(BANDUNG_CENTER, 13);

const basemaps = {
  streets:   L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19}),
  satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {maxZoom:19}),
  light:     L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {maxZoom:19})
};
basemaps.light.addTo(map);
let activeBasemap = "light";

map.createPane("paneZona");   map.getPane("paneZona").style.zIndex   = 400;
map.createPane("paneSungai"); map.getPane("paneSungai").style.zIndex = 450;
map.createPane("paneBatas");  map.getPane("paneBatas").style.zIndex  = 500;
map.createPane("paneTitik");  map.getPane("paneTitik").style.zIndex  = 700;

const layers = {
  zona:     L.layerGroup().addTo(map),
  sungai:   L.layerGroup().addTo(map),
  batas:    L.layerGroup().addTo(map),
  historis: L.layerGroup().addTo(map),
};

let kelurahanIndex = [];
let highlightLayer = null;  // layer batas yang sedang di-highlight

/* ═══ 1. ZONA KERAWANAN (QGIS) ══════════════════════════════════ */
fetch("data/Zona-Banjir-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    zonaFeatures = data.features;   // simpan untuk ray casting
    L.geoJSON(data, {
      pane:"paneZona", interactive:false,
      style: f => ({
        fillColor: f.properties.zone === 2 ? "#fca5a5"
                 : f.properties.zone === 1 ? "#fcd34d" : "#86efac",
        weight:0, fillOpacity:0.45,
      })
    }).addTo(layers.zona);
  });

/* ═══ 2. SUNGAI ═════════════════════════════════════════════════ */
fetch("data/Sungai-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane:"paneSungai",
      style: f => {
        const r = (f.properties.REMARK||"").toLowerCase();
        return { color:"#3b82f6", weight: r.includes("utama")||r.includes("induk")?2.5:1.5, opacity:0.7 };
      }
    }).addTo(layers.sungai);
  });

/* ═══ 3. HISTORIS BANJIR (QGIS) ════════════════════════════════ */
fetch("data/Historis-Banjir.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane:"paneTitik",
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

/* ═══ 4. BATAS WILAYAH ══════════════════════════════════════════ */
fetch("data/Batas-Wilayah.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane:"paneBatas",
      style: { color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" },
      onEachFeature: (f, l) => {
        const nama = (f.properties.desa || f.properties.NAMOBJ || "Wilayah").toUpperCase();
        kelurahanIndex.push({ nama, layer:l });

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
              const rain  = w.rain ? (w.rain["1h"]||0) : 0;
              const zone  = zonaAt(e.latlng);
              const hasil = hitungPeringatan(rain, zone, nama);
              const warna = { bahaya:"#dc2626", waspada:"#d97706", aman:"#16a34a" }[hasil.level] || "#16a34a";
              this.setTooltipContent(`
                <div class="tt-name">Kel. ${nama}</div>
                <div class="tt-alert" style="color:${warna}">● ${hasil.label}</div>
                <div class="tt-stats">
                  ${kondisiCuaca(w.weather[0].id, rain)} &nbsp;·&nbsp; ${w.main.temp.toFixed(1)}°C<br>
                  💧 ${rain} mm/jam
                </div>
              `);
            }).catch(()=>{});
        });
        l.on("mouseout", function() {
          this.setStyle({ weight:.8, color:"#94a3b8", dashArray:"3,3" });
        });
        l.on("click", e => bukaPanel(nama, e.latlng));
      }
    }).addTo(layers.batas);
  });

/* ═══ INFO PANEL ════════════════════════════════════════════════ */
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
  document.querySelector(".zoom-ctrl").style.bottom = "440px";

  fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${latlng.lat}&lon=${latlng.lng}&appid=${OWM_KEY}&units=metric&lang=id`)
    .then(r => r.json())
    .then(w => {
      const rain  = w.rain ? (w.rain["1h"]||0) : 0;
      const zone  = zonaAt(latlng);         // ← ray casting yang akurat
      const hist  = HIST[nama] || 0;
      const hasil = hitungPeringatan(rain, zone, nama);

      // Alert block
      alertBlock.className    = `alert-block ${hasil.level}`;
      alertDot.className      = `alert-dot ${hasil.level}`;
      alertStatus.className   = `alert-status ${hasil.level}`;
      alertStatus.textContent = hasil.label;
      alertDesc.textContent   = ALERT_DESC[hasil.level];

      // Faktor tabel — zona dari ray casting QGIS yang akurat
      const zonaKls = { 0:"aman", 1:"waspada", 2:"bahaya" }[zone];
      factorTable.innerHTML = `
        <div class="ft-row">
          <span class="ft-label">Zona Kerawanan QGIS</span>
          <span class="ft-val ${zonaKls}">${ZONA_LABEL[zone]}</span>
        </div>
        <div class="ft-row">
          <span class="ft-label">Curah Hujan Realtime</span>
          <span class="ft-val">${rain} mm/jam</span>
        </div>
        <div class="ft-row">
          <span class="ft-label">Riwayat Banjir</span>
          <span class="ft-val">${hist > 0 ? hist + "× kejadian" : "Belum tercatat"}</span>
        </div>
      `;

      // Weather strip
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

/* ═══ LAYER TOGGLES ═════════════════════════════════════════════ */
document.querySelectorAll(".toggle").forEach(t => {
  t.addEventListener("click", () => {
    const isOn = t.classList.toggle("on");
    isOn ? map.addLayer(layers[t.dataset.layer]) : map.removeLayer(layers[t.dataset.layer]);
  });
});

/* ═══ BASEMAP ═══════════════════════════════════════════════════ */
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

/* ═══ HIGHLIGHT WILAYAH ════════════════════════════════════════ */
function setHighlight(layer) {
  // Kembalikan style layer sebelumnya
  if (highlightLayer) {
    highlightLayer.setStyle({ color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" });
  }
  // Terapkan highlight ke layer baru
  layer.setStyle({ color:"#2563eb", weight:2.5, fillOpacity:0.08, fillColor:"#2563eb", dashArray:"" });
  layer.bringToFront();
  highlightLayer = layer;
}

function clearHighlight() {
  if (highlightLayer) {
    highlightLayer.setStyle({ color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" });
    highlightLayer = null;
  }
}

/* ═══ SEARCH ════════════════════════════════════════════════════ */
const searchInput   = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  searchResults.innerHTML = "";
  if (q.length < 2) { searchResults.classList.remove("open"); return; }

  const hits = kelurahanIndex.filter(k => k.nama.toLowerCase().includes(q)).slice(0,8);
  if (!hits.length) { searchResults.classList.remove("open"); return; }

  hits.forEach(({ nama, layer }) => {
    const item = document.createElement("div");
    item.className = "search-result-item";
    item.innerHTML = `
      <div class="sri-icon">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
        </svg>
      </div>Kel. ${nama}`;
    item.addEventListener("click", () => {
      searchResults.classList.remove("open");
      searchInput.value = "";
      try {
        const b = layer.getBounds();
        map.flyToBounds(b, { padding:[60,60], maxZoom:15, duration:1 });

        // Highlight batas wilayah yang dipilih
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
  if ((e.ctrlKey||e.metaKey) && e.key==="k") { e.preventDefault(); searchInput.focus(); }
  if (e.key==="Escape") {
    closeInfoPanel();
    searchResults.classList.remove("open");
    searchInput.blur();
  }
});
