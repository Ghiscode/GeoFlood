/* ═══════════════════════════════════════════════════════════════
   GeoFlood Bandung · script.js
   Prediksi: Curah Hujan Realtime + Bulan Musim + Zona QGIS + Historis
   ═══════════════════════════════════════════════════════════════ */

const OWM_KEY = "c858ad50a4ac7282e4f4a25a290603b3";
const BANDUNG_CENTER = [-6.9175, 107.6191];

/* ── Bobot bulan rawan (dari analisis historis 44 kejadian) ─── */
const MONTH_RISK = {
  1: 0.9,  // Januari  — 8 kejadian
  2: 0.6,  // Februari — 4
  3: 0.7,  // Maret    — 6
  4: 0.65, // April    — 5
  5: 0.7,  // Mei      — 6
  6: 0.2,  // Juni     — 1
  7: 0.05, // Juli     — 0
  8: 0.1,  // Agustus  — 1
  9: 0.1,  // September— 1
  10: 0.4, // Oktober  — 3
  11: 0.85,// November — 7
  12: 0.35 // Desember — 2
};

/* ── Kelurahan historis rawan (dari QGIS data) ──────────────── */
const HIST_RISK = {
  "MEKAR MULYA":4,"BRAGA":2,"MARGASARI":2,"SUKAMISKIN":2,"RANCANUMPANG":2,
  "CIBADAK":2,"HEGARMANAH":2,"PAJAJARAN":2,"ANTAPANI TENGAH":1,"ANTAPANI WETAN":1,
  "PASIRLAYUNG":1,"KARANG PAMULANG":2,"BATUNUNGGAL":1,"CIGADUNG":1,"SUKALUYU":1,
  "ARJUNA":1,"CIPEDES":1,"PASTEUR":1,"SUKAWARNA":1,"DERWATI":1,"KUJANGSARI":1,
  "PAKEMITAN":1,"PASANGGRAHAN":1,"PASIRJATI":1,"KOPO":1,"CIPAGANTI":1,"PASIRWANGI":1,
  "CISARANTEN KULON":1,"CIBANGKONG":1,"GEGERKALONG":1,"CIJERAH":1,"JAMIKA":1,"CITARUM":1
};

/* ── Risk score calculator ───────────────────────────────────── */
function calcRisk(rainMM, month, kelurahan, zoneLevel) {
  const wRain   = Math.min(rainMM / 20, 1);          // 0–1  (20mm = max)
  const wMonth  = MONTH_RISK[month] || 0.1;          // 0–1
  const wHist   = Math.min((HIST_RISK[kelurahan] || 0) / 4, 1); // 0–1
  const wZone   = zoneLevel === 2 ? 1 : zoneLevel === 1 ? 0.5 : 0.1; // 0–1

  /* Weighted average — curah hujan & zona paling dominan */
  const score = (wRain * 0.40) + (wMonth * 0.25) + (wZone * 0.25) + (wHist * 0.10);
  return Math.round(score * 100);
}

function riskLabel(score) {
  if (score >= 65) return { key:"high",  text:"BAHAYA",   color:"#ef4444" };
  if (score >= 40) return { key:"mid",   text:"WASPADA",  color:"#f59e0b" };
  if (score >= 20) return { key:"low",   text:"SIAGA",    color:"#eab308" };
  return               { key:"safe",  text:"AMAN",     color:"#22c55e" };
}

function riskRec(rk, rain, month) {
  const msgs = {
    high: `⚠️ Risiko banjir TINGGI saat ini. Curah hujan ${rain} mm/jam terdeteksi. Hindari area dataran rendah dekat sungai, waspada genangan, dan siapkan jalur evakuasi.`,
    mid:  `🔔 Status WASPADA. Curah hujan ${rain} mm/jam terpantau. Pantau terus informasi BPBD Bandung dan hindari membuang sampah ke saluran air.`,
    low:  `📡 Status SIAGA dini. Musim penghujan aktif (bulan ${month}). Pastikan saluran drainase tidak tersumbat di sekitar tempat tinggal Anda.`,
    safe: `✅ Kondisi relatif aman saat ini. Curah hujan rendah. Tetap pantau prakiraan cuaca BMKG untuk beberapa hari ke depan.`
  };
  return msgs[rk] || msgs.safe;
}

/* ═══════════════════════════════════════════════════════════════
   MAP INIT
   ═══════════════════════════════════════════════════════════════ */
const map = L.map("map", { zoomControl:false, attributionControl:false })
    .setView(BANDUNG_CENTER, 13);

const basemaps = {
  streets:   L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19}),
  satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {maxZoom:19}),
  light:     L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {maxZoom:19})
};
basemaps.light.addTo(map);
let activeBasemap = "light";

/* Panes */
["paneZona","paneSungai","paneBatas","paneTitik"].forEach((p, i) => {
  map.createPane(p);
  map.getPane(p).style.zIndex = 400 + i * 50;
});

const layers = {
  zona:     L.layerGroup().addTo(map),
  sungai:   L.layerGroup().addTo(map),
  batas:    L.layerGroup().addTo(map),
  historis: L.layerGroup().addTo(map),
};

/* Zone lookup by point (used for prediction) */
let zonaGeoJSON = null;
let kelurahanIndex = [];
let currentMonth = new Date().getMonth() + 1;

/* ═══════════════════════════════════════════════════════════════
   LOAD LAYERS
   ═══════════════════════════════════════════════════════════════ */

/* 1. ZONA KERAWANAN */
fetch("data/Zona-Banjir-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    zonaGeoJSON = data;
    L.geoJSON(data, {
      pane: "paneZona", interactive: false,
      style: f => ({
        fillColor: f.properties.zone === 2 ? "#fca5a5"
                 : f.properties.zone === 1 ? "#fcd34d" : "#86efac",
        weight: 0, fillOpacity: 0.45,
      })
    }).addTo(layers.zona);
  });

/* 2. SUNGAI */
fetch("data/Sungai-Bandung.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneSungai",
      style: f => {
        const r = (f.properties.REMARK || "").toLowerCase();
        return { color:"#3b82f6", weight: r.includes("utama")||r.includes("induk") ? 2.5 : 1.5, opacity: 0.7 };
      }
    }).addTo(layers.sungai);
  });

/* 3. HISTORIS BANJIR */
fetch("data/Historis-Banjir.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneTitik",
      pointToLayer: (f, latlng) => {
        const jiwa = f.properties.Jiwa_Menderita || 0;
        const rad  = Math.min(4 + Math.sqrt(jiwa) * 1.4, 13);
        /* Pulse ring */
        L.circleMarker(latlng, {
          pane:"paneTitik", radius: rad * 2.2,
          fillColor:"#ef4444", fillOpacity:.1,
          color:"#ef4444", weight:.5, opacity:.25, interactive:false,
        }).addTo(layers.historis);
        return L.circleMarker(latlng, {
          radius: rad, fillColor:"#ef4444",
          color:"#fff", weight:1.8, fillOpacity:.92,
        });
      },
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindTooltip(`
          <div class="tt-name">📍 Kel. ${p.Kelurahan||"—"}</div>
          <div class="tt-stats">
            Kec. ${p.Kecamatan||"—"}<br>
            <strong>${p.Tgl_Kejadian||"—"}</strong><br>
            ${p.Jiwa_Menderita||0} jiwa · ${p.Rumah_Terendam||0} rumah terendam
          </div>
        `, { className:"geo-tt", sticky:true, offset:[10,0] });
        l.on("click", e => updateInfoPanel((p.Kelurahan||"—").toUpperCase(), e.latlng));
      }
    }).addTo(layers.historis);
  });

/* 4. BATAS WILAYAH */
fetch("data/Batas-Wilayah.geojson")
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pane: "paneBatas",
      style: { color:"#94a3b8", weight:.8, fillOpacity:0, dashArray:"3,3" },
      onEachFeature: (f, l) => {
        const nama = (f.properties.desa || f.properties.NAMOBJ || "Wilayah").toUpperCase();
        kelurahanIndex.push({ nama, layer: l });

        l.on("mouseover", function(e) {
          this.setStyle({ weight:2.5, color:"#2563eb", dashArray:"" });
          this.bindTooltip(
            `<div class="tt-name">Kel. ${nama}</div><div class="tt-stats" style="color:#94a3b8">Memuat cuaca…</div>`,
            { className:"geo-tt", sticky:true, offset:[10,0] }
          ).openTooltip();

          fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${e.latlng.lat}&lon=${e.latlng.lng}&appid=${OWM_KEY}&units=metric&lang=id`)
            .then(r => r.json())
            .then(w => {
              const rain = w.rain ? (w.rain["1h"]||0) : 0;
              this.setTooltipContent(`
                <div class="tt-name">Kel. ${nama}</div>
                <div class="tt-desc">${w.weather[0].description}</div>
                <div class="tt-stats">
                  ${w.main.temp.toFixed(1)}°C &nbsp;·&nbsp;
                  ${w.main.humidity}% RH &nbsp;·&nbsp;
                  💧 ${rain} mm
                </div>
              `);
            }).catch(()=>{});
        });

        l.on("mouseout", function() {
          this.setStyle({ weight:.8, color:"#94a3b8", dashArray:"3,3" });
        });

        l.on("click", e => updateInfoPanel(nama, e.latlng));
      }
    }).addTo(layers.batas);
  });

/* ═══════════════════════════════════════════════════════════════
   INFO PANEL
   ═══════════════════════════════════════════════════════════════ */
function updateInfoPanel(nama, latlng) {
  document.getElementById("infoName").textContent   = nama;
  document.getElementById("infoCoords").textContent =
    `${latlng.lat.toFixed(5)}°N  ${latlng.lng.toFixed(5)}°E`;

  const card      = document.getElementById("weatherCard");
  const riskRow   = document.getElementById("infoRiskRow");
  const riskValue = document.getElementById("infoRiskValue");
  card.innerHTML  = `<div class="wc-loading">Memuat cuaca…</div>`;
  riskRow.style.display = "none";

  document.getElementById("infoPanel").classList.add("visible");

  fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${latlng.lat}&lon=${latlng.lng}&appid=${OWM_KEY}&units=metric&lang=id`)
    .then(r => r.json())
    .then(w => {
      const rain  = w.rain ? (w.rain["1h"]||0) : 0;
      const score = calcRisk(rain, currentMonth, nama, getZoneAt(latlng));
      const rl    = riskLabel(score);

      card.innerHTML = `
        <div class="wc-desc">${w.weather[0].description}</div>
        <div class="wc-row">
          <div class="wc-item"><div class="wc-val">${w.main.temp.toFixed(1)}°</div><div class="wc-unit">Suhu</div></div>
          <div class="wc-item"><div class="wc-val">${w.main.humidity}%</div><div class="wc-unit">Kelembapan</div></div>
          <div class="wc-item"><div class="wc-val">${rain}</div><div class="wc-unit">mm hujan</div></div>
        </div>
      `;

      riskRow.style.display = "flex";
      riskValue.textContent  = rl.text;
      riskValue.className    = `irr-value ${rl.key}`;
    })
    .catch(() => { card.innerHTML = `<div class="wc-loading">Data tidak tersedia</div>`; });
}

function closeInfoPanel() {
  document.getElementById("infoPanel").classList.remove("visible");
}

/* Estimate zone level at a latlng using bounding box heuristic */
function getZoneAt(latlng) {
  if (!zonaGeoJSON) return 1;
  // Return the zone of the first polygon that contains this point (simple bbox check)
  for (const f of zonaGeoJSON.features) {
    const zone = f.properties.zone;
    // Use Leaflet's contains after creating temp layer
    try {
      const bounds = L.geoJSON(f).getBounds();
      if (bounds.contains([latlng.lat, latlng.lng])) return zone;
    } catch(_) {}
  }
  return 1;
}

/* ═══════════════════════════════════════════════════════════════
   PREDIKSI REALTIME (Bandung-wide)
   ═══════════════════════════════════════════════════════════════ */
function runPrediction() {
  const badge = document.getElementById("predBadge");
  const dot   = document.getElementById("predDot");
  const label = document.getElementById("predLabel");

  fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${BANDUNG_CENTER[0]}&lon=${BANDUNG_CENTER[1]}&appid=${OWM_KEY}&units=metric&lang=id`)
    .then(r => r.json())
    .then(w => {
      const rain  = w.rain ? (w.rain["1h"]||0) : 0;
      const score = calcRisk(rain, currentMonth, "", 1);
      const rl    = riskLabel(score);

      dot.className   = `pred-dot ${rl.key}`;
      label.textContent = `${rl.text} · ${score}% Risiko`;
      label.style.color = rl.color;

      /* Fill prediction panel */
      const bodyEl = document.getElementById("predPanelBody");
      bodyEl.innerHTML = `
        <div class="risk-meter-wrap">
          <div class="risk-meter-header">
            <span class="risk-meter-title">Indeks Risiko Kota Bandung</span>
            <span class="risk-meter-val" style="color:${rl.color}">${score}%</span>
          </div>
          <div class="risk-track">
            <div class="risk-fill" style="width:0%;background:${rl.color}" id="riskFill"></div>
          </div>
        </div>

        <div class="factor-grid">
          <div class="factor-card">
            <div class="fc-label">Curah Hujan</div>
            <div class="fc-value">${rain} <span style="font-size:11px;font-weight:400;color:#94a3b8">mm/jam</span></div>
            <div class="fc-sub">${rain >= 10 ? "⚠️ Lebat" : rain >= 5 ? "🔔 Sedang" : rain > 0 ? "🟡 Ringan" : "✅ Tidak ada"}</div>
          </div>
          <div class="factor-card">
            <div class="fc-label">Bulan Sekarang</div>
            <div class="fc-value">${new Date().toLocaleString('id',{month:'short'})}</div>
            <div class="fc-sub">${(MONTH_RISK[currentMonth]*100).toFixed(0)}% bobot musim</div>
          </div>
          <div class="factor-card">
            <div class="fc-label">Suhu Udara</div>
            <div class="fc-value">${w.main.temp.toFixed(1)}<span style="font-size:11px;font-weight:400;color:#94a3b8">°C</span></div>
            <div class="fc-sub">Kelembapan ${w.main.humidity}%</div>
          </div>
          <div class="factor-card">
            <div class="fc-label">Kondisi</div>
            <div class="fc-value" style="font-size:11px;text-transform:capitalize">${w.weather[0].description}</div>
            <div class="fc-sub">Realtime OWM API</div>
          </div>
        </div>

        <div class="risk-rec ${rl.key}">${riskRec(rl.key, rain, new Date().toLocaleString('id',{month:'long'}))}</div>

        <div style="margin-top:10px;font-size:9.5px;color:#94a3b8;text-align:right">
          Diperbarui: ${new Date().toLocaleTimeString('id',{hour:'2-digit',minute:'2-digit'})} WIB
          &nbsp;·&nbsp; Sumber: OWM API + Data QGIS Bandung
        </div>
      `;

      /* Animate bar */
      setTimeout(() => {
        const fill = document.getElementById("riskFill");
        if (fill) fill.style.width = score + "%";
      }, 100);
    })
    .catch(() => {
      dot.className     = "pred-dot safe";
      label.textContent = "Koneksi gagal";
    });
}

/* Open pred panel on badge click */
document.getElementById("predBadge").addEventListener("click", () => {
  document.getElementById("predPanel").classList.toggle("open");
});

/* Run on load and refresh every 10 min */
runPrediction();
setInterval(runPrediction, 10 * 60 * 1000);

/* ═══════════════════════════════════════════════════════════════
   LAYER TOGGLES
   ═══════════════════════════════════════════════════════════════ */
document.querySelectorAll(".toggle").forEach(toggle => {
  toggle.addEventListener("click", () => {
    const key  = toggle.dataset.layer;
    const isOn = toggle.classList.toggle("on");
    isOn ? map.addLayer(layers[key]) : map.removeLayer(layers[key]);
  });
});

/* ═══════════════════════════════════════════════════════════════
   BASEMAP SWITCHER
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════ */
const searchInput   = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  searchResults.innerHTML = "";
  if (q.length < 2) { searchResults.classList.remove("open"); return; }

  const matches = kelurahanIndex.filter(k => k.nama.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { searchResults.classList.remove("open"); return; }

  matches.forEach(({ nama, layer }) => {
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
        const bounds = layer.getBounds();
        map.flyToBounds(bounds, { padding:[60,60], maxZoom:15, duration:1 });
        updateInfoPanel(nama, bounds.getCenter());
      } catch(_) {}
    });
    searchResults.appendChild(item);
  });
  searchResults.classList.add("open");
});

document.addEventListener("click", e => {
  if (!e.target.closest(".search-wrap")) searchResults.classList.remove("open");
  if (!e.target.closest(".pred-badge") && !e.target.closest(".pred-panel"))
    document.getElementById("predPanel").classList.remove("open");
});

document.addEventListener("keydown", e => {
  if ((e.ctrlKey||e.metaKey) && e.key === "k") { e.preventDefault(); searchInput.focus(); }
  if (e.key === "Escape") {
    closeInfoPanel();
    searchResults.classList.remove("open");
    document.getElementById("predPanel").classList.remove("open");
    searchInput.blur();
  }
});
