// Futterassi, lokale Rezept- und Wochenplan-App.
// Datenquelle: rezepte.json, wird im Chat gepflegt und hier nur gelesen.
// Dateinamen stehen nur hier oben und im Service Worker, sonst nirgends.

const DATA_FILE = "rezepte.json";
const SW_FILE = "service-worker.js";

const FILTER_TAGS = ["vegetarisch", "vegan", "High Protein", "Low Carb", "LEBER", "BLUTDRUCK", "SÄTTIGUNG", "SPORT"];
const TYP_LABEL = { abendessen: "Abendessen", mittag: "Mittag", fruehstueck: "Frühstück", snack: "Snack", basis: "Basis" };
const TYP_RANG = { abendessen: 0, mittag: 1, snack: 2, fruehstueck: 3, basis: 4 };
const PREP_ZIEL = 10;

const LS_PLAN = "futterassi_plan_v1";
const LS_UI = "futterassi_ui_v1";

let RECIPES = [];
let ui = loadUi();
let plan = loadPlan();

let detail = null;          // { recipe, portionen, erledigt: Set }
let cook = null;            // { el, recipe, i, portionen, zutatenOffen, touchX }
let importErgebnis = null;  // bleibt über das Neuzeichnen hinweg sichtbar
let planHinweis = "";
let speicherDefekt = false;

// ---------- Zustand laden und speichern ----------

function loadUi() {
  const d = { view: "katalog", search: "", tags: [], typen: [], showRaus: false };
  try {
    const raw = JSON.parse(localStorage.getItem(LS_UI));
    if (!raw || typeof raw !== "object") return d;
    return {
      view: raw.view === "planung" ? "planung" : "katalog",
      search: typeof raw.search === "string" ? raw.search : "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => FILTER_TAGS.includes(t)) : [],
      typen: Array.isArray(raw.typen) ? raw.typen.filter(t => typeof t === "string") : [],
      showRaus: raw.showRaus === true
    };
  } catch (e) {
    return d;
  }
}

function loadPlan() {
  const d = { days: [], prep: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PLAN));
    if (!raw || typeof raw !== "object") return d;
    const days = Array.isArray(raw.days) ? raw.days : [];
    const prep = Array.isArray(raw.prep) ? raw.prep : [];
    return {
      days: days.filter(x => x && typeof x === "object").map(x => ({
        label: typeof x.label === "string" ? x.label : "",
        recipeId: typeof x.recipeId === "string" ? x.recipeId : "",
        sporttag: x.sporttag === true
      })),
      prep: prep.filter(x => x && typeof x === "object" && x.id).map(x => ({
        id: String(x.id),
        portionen: Math.max(0, parseInt(x.portionen, 10) || 0)
      }))
    };
  } catch (e) {
    return d;
  }
}

function speichern(key, wert) {
  try {
    localStorage.setItem(key, JSON.stringify(wert));
  } catch (e) {
    // Privater Safari-Modus oder voller Speicher. Die App läuft weiter,
    // nur ohne Sicherung über den Neustart hinweg.
    speicherDefekt = true;
  }
}
function saveUi() { speichern(LS_UI, ui); }
function savePlan() { speichern(LS_PLAN, plan); }

// ---------- Start ----------

async function init() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.view = btn.dataset.view;
      saveUi();
      render();
      window.scrollTo(0, 0);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (cook) closeCook();
    else if (detail) closeDetail();
  });

  // Der Service Worker wird unabhängig von den Daten registriert. Sonst gäbe es
  // nach einem einzigen fehlgeschlagenen Ladeversuch nie wieder Offline-Betrieb.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(SW_FILE).catch(() => {});
  }

  const ok = await ladeDaten();
  if (ok) render();
}

async function ladeDaten() {
  try {
    const res = await fetch(DATA_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error("Server antwortet mit " + res.status);
    const daten = await res.json();
    if (!Array.isArray(daten)) throw new Error("Datei enthält keine Rezeptliste");
    RECIPES = daten.filter(r => r && r.id && r.name);
    pruefePlanBezuege();
    return true;
  } catch (e) {
    zeigeLadefehler(e);
    return false;
  }
}

function zeigeLadefehler(e) {
  const lokal = location.protocol === "file:";
  const offline = typeof navigator.onLine === "boolean" && !navigator.onLine;

  let grund;
  if (lokal) {
    grund = "Die Seite läuft als lokal geöffnete Datei (file://). So lassen sich die Rezeptdaten nicht laden, die App braucht einen Webserver, zum Beispiel GitHub Pages.";
  } else if (offline) {
    grund = "Das Gerät ist offline und im Cache liegen noch keine Rezepte. Einmal mit Netz öffnen, danach geht es auch offline.";
  } else {
    grund = "Die Datei " + DATA_FILE + " wurde nicht gefunden oder ist beschädigt. Liegt sie im selben Verzeichnis wie index.html und ist sie gültiges JSON?";
  }

  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="empty">
      <p><strong>Rezepte konnten nicht geladen werden.</strong></p>
      <p class="small-note">${escapeHtml(grund)}</p>
      <p class="small-note">Technische Meldung: ${escapeHtml(e && e.message ? e.message : String(e))}</p>
    </div>`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn primary";
  btn.textContent = "Nochmal versuchen";
  btn.addEventListener("click", async () => {
    const ok = await ladeDaten();
    if (ok) render();
  });
  app.querySelector(".empty").appendChild(btn);
}

// Nach einem Update von rezepte.json können Plan-Einträge auf Rezepte zeigen,
// die es nicht mehr gibt. Nicht stillschweigend löschen, sondern anzeigen.
function pruefePlanBezuege() {
  const ids = new Set(RECIPES.map(r => r.id));
  const fehlend = new Set();
  plan.days.forEach(d => { if (d.recipeId && !ids.has(d.recipeId)) fehlend.add(d.recipeId); });
  plan.prep.forEach(p => { if (p.portionen > 0 && !ids.has(p.id)) fehlend.add(p.id); });
  planHinweis = fehlend.size
    ? `${fehlend.size} Eintrag/Einträge im Plan zeigen auf Rezepte, die es in ${DATA_FILE} nicht mehr gibt: ${[...fehlend].join(", ")}. Sie fehlen im Kopiertext.`
    : "";
}

function render() {
  document.querySelectorAll(".tab").forEach(b => {
    const aktiv = b.dataset.view === ui.view;
    b.classList.toggle("active", aktiv);
    b.setAttribute("aria-selected", aktiv ? "true" : "false");
  });
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (speicherDefekt) {
    const w = document.createElement("p");
    w.className = "small-note";
    w.textContent = "Dieses Gerät speichert gerade nichts dauerhaft, die Planung ist nach dem Schließen weg. Privater Safari-Modus oder voller Speicher.";
    app.appendChild(w);
  }
  app.appendChild(ui.view === "katalog" ? renderKatalog() : renderPlanung());
}

// ---------- KATALOG ----------

function renderKatalog() {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const sb = document.createElement("div");
  sb.className = "search";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Rezept oder Zutat suchen";
  input.value = ui.search;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("enterkeyhint", "done");
  sb.appendChild(input);
  wrap.appendChild(sb);

  const chipbar = document.createElement("div");
  chipbar.className = "chips";
  wrap.appendChild(chipbar);

  const zeile = document.createElement("div");
  zeile.className = "list-head";
  wrap.appendChild(zeile);

  const grid = document.createElement("div");
  grid.className = "recipe-list";
  wrap.appendChild(grid);

  function chip(text, aktiv, onClick) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip" + (aktiv ? " active" : "");
    c.textContent = text;
    c.setAttribute("aria-pressed", aktiv ? "true" : "false");
    c.addEventListener("click", () => { onClick(); saveUi(); update(); });
    return c;
  }

  // Nur Chips und Liste werden neu gezeichnet, das Suchfeld bleibt stehen.
  // Sonst schließt sich auf dem iPhone bei jedem Filterklick die Tastatur.
  function update() {
    chipbar.innerHTML = "";
    vorhandeneTypen().forEach(t => {
      chipbar.appendChild(chip(typLabel(t), ui.typen.includes(t), () => {
        ui.typen = ui.typen.includes(t) ? ui.typen.filter(x => x !== t) : ui.typen.concat(t);
      }));
    });
    FILTER_TAGS.forEach(tag => {
      chipbar.appendChild(chip(tag, ui.tags.includes(tag), () => {
        ui.tags = ui.tags.includes(tag) ? ui.tags.filter(x => x !== tag) : ui.tags.concat(tag);
      }));
    });
    chipbar.appendChild(chip(ui.showRaus ? "raus: eingeblendet" : "raus ausgeblendet", ui.showRaus, () => {
      ui.showRaus = !ui.showRaus;
    }));

    const liste = filteredRecipes();
    zeile.innerHTML = "";
    const zahl = document.createElement("span");
    zahl.className = "small-note";
    zahl.style.margin = "0";
    zahl.textContent = `${liste.length} von ${RECIPES.length} Rezepten`;
    zeile.appendChild(zahl);
    if (ui.tags.length || ui.typen.length || ui.search || ui.showRaus) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "linkbtn";
      reset.textContent = "Filter zurücksetzen";
      reset.addEventListener("click", () => {
        ui.tags = []; ui.typen = []; ui.search = ""; ui.showRaus = false;
        input.value = "";
        saveUi();
        update();
      });
      zeile.appendChild(reset);
    }

    grid.innerHTML = "";
    if (!liste.length) {
      grid.innerHTML = `<div class="empty">Nichts gefunden. Filter oder Suche anpassen.</div>`;
      return;
    }
    liste.forEach(r => grid.appendChild(renderCard(r)));
  }

  input.addEventListener("input", (e) => {
    ui.search = e.target.value;
    saveUi();
    update();
  });

  update();
  return wrap;
}

// Kategorien kommen aus den Daten, nicht aus einer festen Liste. Taucht in
// rezepte.json ein neuer typ auf, erscheint er automatisch als Filter.
function typLabel(t) {
  if (!t) return "";
  return TYP_LABEL[t] || (String(t).charAt(0).toUpperCase() + String(t).slice(1));
}

function vorhandeneTypen() {
  const rang = t => (TYP_RANG[t] != null ? TYP_RANG[t] : 9);
  return [...new Set(RECIPES.map(r => r.typ).filter(Boolean))]
    .sort((a, b) => rang(a) - rang(b) || String(a).localeCompare(String(b), "de"));
}

function suchtext(r) {
  const zutaten = (r.zutaten || []).map(z => (z && z.name) ? z.name : "").join(" ");
  return `${r.name} ${(r.tags || []).join(" ")} ${zutaten}`.toLowerCase();
}

function filteredRecipes() {
  const s = ui.search.trim().toLowerCase();
  return RECIPES.filter(r => {
    if (!ui.showRaus && r.status === "raus") return false;
    if (ui.typen.length && !ui.typen.includes(r.typ)) return false;
    if (s && !suchtext(r).includes(s)) return false;
    if (ui.tags.length) {
      const rtags = r.tags || [];
      if (!ui.tags.every(t => rtags.includes(t))) return false;
    }
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

// Priorität, falls mehrere Kategorien zutreffen: vegan vor vegetarisch vor
// Low Carb vor High Protein vor Sport. Passt keine, bleibt der Rand ohne Farbe.
function mapCategory(r) {
  const t = r.tags || [];
  if (t.includes("vegan")) return "vegan";
  if (t.includes("vegetarisch")) return "vegetarian";
  if (t.includes("Low Carb")) return "lowcarb";
  if (t.includes("High Protein")) return "protein";
  if (t.includes("SPORT")) return "sport";
  return "";
}

function statusClass(status) {
  if (status === "stamm") return "stamm";
  if (status === "raus") return "out";
  return "candidate";
}
function statusText(status) {
  return String(status || "kandidat").toUpperCase();
}

function renderCard(r) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card card-button";
  const cat = mapCategory(r);
  if (cat) card.setAttribute("data-category", cat);

  const badges = [`<span class="badge status ${statusClass(r.status)}">${escapeHtml(statusText(r.status))}</span>`];
  if (r.typ) badges.push(`<span class="badge">${escapeHtml(typLabel(r.typ))}</span>`);
  if (r.ausnahme) badges.push(`<span class="badge exception">AUSNAHME</span>`);
  if ((r.tags || []).includes("SPORT")) badges.push(`<span class="badge sport">SPORT</span>`);
  if (r.rest) badges.push(`<span class="badge rest">REST</span>`);
  if (r.prep && r.prep.geeignet) badges.push(`<span class="badge">PREP</span>`);

  const metrics = [];
  if (r.kcal) metrics.push(`<span class="metric"><strong>${escapeHtml(r.kcal)}</strong>&nbsp;kcal</span>`);
  if (r.protein) metrics.push(`<span class="metric"><strong>${escapeHtml(r.protein)}</strong>&nbsp;g Eiweiß</span>`);
  if (r.fett) metrics.push(`<span class="metric"><strong>${escapeHtml(r.fett)}</strong>&nbsp;g Fett</span>`);
  if (r.zeit) metrics.push(`<span class="metric">${escapeHtml(r.zeit)}</span>`);

  card.innerHTML = `
    <h3>${escapeHtml(r.name)}</h3>
    <div class="card-meta">${badges.join("")}</div>
    <div class="card-footer"><div class="metrics">${metrics.join("")}</div></div>
  `;
  card.addEventListener("click", () => openDetail(r));
  return card;
}

// ---------- DETAIL ----------

function scrollSperre(an) {
  document.body.classList.toggle("locked", an);
}

function openDetail(r) {
  detail = { recipe: r, portionen: r.basis || 2, erledigt: new Set() };
  scrollSperre(true);
  drawDetail();
  const overlay = document.getElementById("overlay");
  overlay.scrollTop = 0;
}

function closeDetail() {
  detail = null;
  const overlay = document.getElementById("overlay");
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
  if (!cook) scrollSperre(false);
}

function drawDetail() {
  if (!detail) return;
  const r = detail.recipe;
  const overlay = document.getElementById("overlay");
  overlay.classList.remove("hidden");

  const metaBadges = [`<span class="badge status ${statusClass(r.status)}">${escapeHtml(statusText(r.status))}</span>`];
  if (r.typ) metaBadges.push(`<span class="badge">${escapeHtml(typLabel(r.typ))}</span>`);
  if (r.zeit) metaBadges.push(`<span class="badge">${escapeHtml(r.zeit)}</span>`);
  if (r.geraete) metaBadges.push(`<span class="badge">${escapeHtml(r.geraete)}</span>`);

  const notizen = [];
  if (r.notiz) notizen.push(["Notiz", r.notiz]);
  if (r.notizen) notizen.push(["Ergänzt", r.notizen]);
  if (r.varianten) notizen.push(["Varianten", r.varianten]);
  if (r.rest) notizen.push(["Rest", String(r.rest)]);
  if (r.prep && r.prep.geeignet) {
    const teile = ["geeignet"];
    if (r.prep.haltbar_tage) teile.push(`${r.prep.haltbar_tage} Tage haltbar`);
    if (r.prep.aufwaermen) teile.push(String(r.prep.aufwaermen));
    if (r.prep.einfrierbar) teile.push("einfrierbar");
    notizen.push(["Meal Prep", teile.join(", ")]);
  }
  if (r.quelle) notizen.push(["Quelle", String(r.quelle)]);

  overlay.innerHTML = `
    <div class="overlay-head">
      <button class="back" type="button" aria-label="Zurück">&larr;</button>
    </div>
    <h1 class="detail-title">${escapeHtml(r.name)}</h1>
    <div class="recipe-meta" style="margin-bottom:18px">${metaBadges.join("")}</div>

    ${r.ausnahme && r.leichter ? `<div class="note-box exception" style="margin-bottom:10px"><strong>Leichter gebaut</strong><p>${escapeHtml(r.leichter)}</p></div>` : ""}
    ${notizen.map(([t, v]) => `<div class="note-box" style="margin-bottom:10px"><strong>${escapeHtml(t)}</strong><p>${escapeHtml(v)}</p></div>`).join("")}

    <span class="label" style="display:block;margin:22px 0 8px">Portionen</span>
    <div class="portions" style="margin-bottom:24px">
      <span class="small-note" style="margin:0">Rezeptbasis ${escapeHtml(r.basis || 2)}</span>
      <div class="portion-control">
        <button type="button" data-d="-1" aria-label="Weniger Portionen">−</button>
        <span class="portion-value">${detail.portionen}</span>
        <button type="button" data-d="1" aria-label="Mehr Portionen">+</button>
      </div>
    </div>

    <span class="label" style="display:block;margin-bottom:4px">Zutaten</span>
    <p class="small-note" style="margin-top:0">Antippen streicht eine Zutat durch.</p>
    <ul class="ingredients" id="zutaten-list" style="margin-bottom:24px"></ul>

    <span class="label" style="display:block;margin-bottom:8px">Zubereitung</span>
    <ol class="steps" style="margin-bottom:28px">
      ${(r.schritte || []).map(s => `<li><p>${escapeHtml(s)}</p></li>`).join("")}
    </ol>

    <div class="detail-actions">
      <button class="btn secondary full" type="button" id="btn-copy">Zutaten kopieren</button>
      <button class="btn primary full" type="button" id="btn-cook">Kochmodus</button>
    </div>
  `;

  overlay.querySelector(".back").addEventListener("click", closeDetail);

  overlay.querySelectorAll(".portion-control button").forEach(b => {
    b.addEventListener("click", () => {
      const d = parseInt(b.dataset.d, 10);
      detail.portionen = Math.min(20, Math.max(1, detail.portionen + d));
      overlay.querySelector(".portion-value").textContent = detail.portionen;
      drawZutaten();
    });
  });

  overlay.querySelector("#btn-copy").addEventListener("click", (e) => {
    const factor = detail.portionen / (r.basis || 2);
    const lines = (r.zutaten || []).map(z => zutatLine(z, factor));
    copyToClipboard(lines.join("\n"), e.currentTarget, "Zutaten kopieren");
  });

  overlay.querySelector("#btn-cook").addEventListener("click", () => openCookMode(r, detail.portionen));

  drawZutaten();
}

function drawZutaten() {
  if (!detail) return;
  const r = detail.recipe;
  const factor = detail.portionen / (r.basis || 2);
  const el = document.getElementById("zutaten-list");
  if (!el) return;
  el.innerHTML = (r.zutaten || []).map((z, i) => {
    const done = detail.erledigt.has(i) ? " done" : "";
    return `<li class="tapbar${done}" data-i="${i}"><span>${escapeHtml(z && z.name)}</span><span class="amount">${escapeHtml(zutatLine(z, factor, true))}</span></li>`;
  }).join("");
  el.querySelectorAll("li").forEach(li => {
    li.addEventListener("click", () => {
      const i = parseInt(li.dataset.i, 10);
      if (detail.erledigt.has(i)) detail.erledigt.delete(i);
      else detail.erledigt.add(i);
      li.classList.toggle("done");
    });
  });
}

function zutatLine(z, factor, onlyMenge) {
  if (!z) return "";
  let menge = "";
  if (z.menge != null && !isNaN(Number(z.menge))) {
    menge = `${round1(Number(z.menge) * factor)}${z.einheit ? " " + z.einheit : ""}`;
  } else {
    menge = z.einheit || "";
  }
  if (onlyMenge) return menge;
  return `${menge ? menge + " " : ""}${z.name || ""}`.trim();
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------- KOCHMODUS ----------

function openCookMode(r, portionen) {
  const el = document.createElement("div");
  el.className = "cook fullscreen";
  document.body.appendChild(el);
  cook = { el, recipe: r, i: 0, portionen: portionen || r.basis || 2, zutatenOffen: false, touchX: null };
  scrollSperre(true);
  wakeLockAn();

  el.addEventListener("touchstart", (e) => {
    cook.touchX = e.changedTouches[0].clientX;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (!cook || cook.touchX == null) return;
    const dx = e.changedTouches[0].clientX - cook.touchX;
    cook.touchX = null;
    if (Math.abs(dx) < 60) return;
    if (dx < 0) schrittVor(); else schrittZurueck();
  }, { passive: true });

  drawCook();
}

function closeCook() {
  if (!cook) return;
  cook.el.remove();
  cook = null;
  wakeLockAus();
  if (!detail) scrollSperre(false);
}

function drawCook() {
  if (!cook) return;
  const r = cook.recipe;
  const steps = r.schritte || [];
  const gesamt = steps.length;
  const anzeigeNr = gesamt ? cook.i + 1 : 0;
  const breite = gesamt ? Math.round(((cook.i + 1) / gesamt) * 100) : 0;
  const factor = cook.portionen / (r.basis || 2);

  cook.el.innerHTML = `
    <div>
      <div class="cook-progress">
        <button class="cook-close" type="button" aria-label="Kochmodus schließen">&times;</button>
        <span>${anzeigeNr} / ${gesamt}</span>
        <button class="cook-zutaten-btn" type="button">${cook.zutatenOffen ? "Schritt" : "Zutaten"}</button>
      </div>
      <div class="cook-progress-bar"><span style="width:${breite}%"></span></div>
      <div class="cook-title">${escapeHtml(r.name)} · ${cook.portionen} Portionen</div>
    </div>
    ${cook.zutatenOffen
      ? `<div class="cook-zutaten"><ul>${(r.zutaten || []).map(z =>
          `<li><span>${escapeHtml(z && z.name)}</span><span>${escapeHtml(zutatLine(z, factor, true))}</span></li>`).join("")}</ul></div>`
      : `<div class="cook-step" id="cook-step"><p>${escapeHtml(gesamt ? steps[cook.i] : "Für dieses Rezept sind keine Schritte hinterlegt.")}</p></div>`}
    <div class="cook-actions">
      <button class="btn secondary" type="button" id="cook-prev" ${cook.i === 0 ? "disabled" : ""}>Zurück</button>
      <button class="btn primary" type="button" id="cook-next">${cook.i < gesamt - 1 ? "Weiter" : "Fertig"}</button>
    </div>
  `;

  cook.el.querySelector(".cook-close").addEventListener("click", closeCook);
  cook.el.querySelector(".cook-zutaten-btn").addEventListener("click", () => {
    cook.zutatenOffen = !cook.zutatenOffen;
    drawCook();
  });
  cook.el.querySelector("#cook-prev").addEventListener("click", schrittZurueck);
  cook.el.querySelector("#cook-next").addEventListener("click", schrittVor);

  const stepEl = cook.el.querySelector("#cook-step");
  if (stepEl) stepEl.addEventListener("click", schrittVor);
}

function schrittVor() {
  if (!cook) return;
  if (cook.zutatenOffen) { cook.zutatenOffen = false; drawCook(); return; }
  const gesamt = (cook.recipe.schritte || []).length;
  if (cook.i < gesamt - 1) { cook.i++; drawCook(); }
  else closeCook();
}

function schrittZurueck() {
  if (!cook) return;
  if (cook.zutatenOffen) { cook.zutatenOffen = false; drawCook(); return; }
  if (cook.i === 0) return;
  cook.i--;
  drawCook();
}

// Bildschirmsperre im Kochmodus verhindern. Wird nicht überall unterstützt,
// deshalb vollständig abgesichert. Ohne Unterstützung passiert schlicht nichts.
let wakeLock = null;
async function wakeLockAn() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (e) {
    wakeLock = null;
  }
}
function wakeLockAus() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* egal */ }
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && cook && !wakeLock) wakeLockAn();
});

// ---------- PLANUNG ----------

function renderPlanung() {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const info = document.createElement("p");
  info.className = "small-note";
  info.textContent = "Auswahl liegt nur auf diesem Gerät. Für Rezeptkarten, Einkaufsliste und Kalender den Kopiertext unten in den Chat einfügen.";
  wrap.appendChild(info);

  if (planHinweis) {
    const w = document.createElement("div");
    w.className = "note-box exception";
    w.style.marginBottom = "14px";
    w.innerHTML = `<strong>Plan prüfen</strong><p>${escapeHtml(planHinweis)}</p>`;
    const clean = document.createElement("button");
    clean.type = "button";
    clean.className = "btn secondary full";
    clean.style.marginTop = "10px";
    clean.textContent = "Verwaiste Einträge entfernen";
    clean.addEventListener("click", () => {
      const ids = new Set(RECIPES.map(r => r.id));
      plan.days = plan.days.filter(d => !d.recipeId || ids.has(d.recipeId));
      plan.prep = plan.prep.filter(p => ids.has(p.id));
      savePlan();
      pruefePlanBezuege();
      render();
    });
    w.appendChild(clean);
    wrap.appendChild(w);
  }

  wrap.appendChild(renderImportPanel());

  const dayList = document.createElement("div");
  wrap.appendChild(dayList);
  plan.days.forEach((d, idx) => dayList.appendChild(renderDayCard(d, idx)));

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn secondary full";
  addBtn.style.marginBottom = "18px";
  addBtn.textContent = "+ Kochtag hinzufügen";
  addBtn.addEventListener("click", () => {
    plan.days.push({ label: "", recipeId: "", sporttag: false });
    savePlan();
    render();
  });
  wrap.appendChild(addBtn);

  wrap.appendChild(renderPrepPanel());
  wrap.appendChild(renderKopiertext());

  return wrap;
}

function planbareRezepte() {
  return RECIPES.filter(r => r.status !== "raus");
}

function renderDayCard(day, idx) {
  const card = document.createElement("div");
  card.className = "day-card";
  card.style.marginBottom = "12px";

  // Alle nicht ausgemusterten Rezepte stehen zur Wahl. An Sporttagen stehen
  // SPORT-Rezepte oben, danach Abendessen vor Mittag vor Snack vor Frühstück.
  const sorted = planbareRezepte().sort((a, b) => {
    if (day.sporttag) {
      const aS = (a.tags || []).includes("SPORT");
      const bS = (b.tags || []).includes("SPORT");
      if (aS !== bS) return aS ? -1 : 1;
    }
    const ra = TYP_RANG[a.typ] != null ? TYP_RANG[a.typ] : 9;
    const rb = TYP_RANG[b.typ] != null ? TYP_RANG[b.typ] : 9;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, "de");
  });

  const selected = RECIPES.find(r => r.id === day.recipeId);
  const fehlend = day.recipeId && !selected;
  const lowCarbWarn = day.sporttag && selected && (selected.tags || []).includes("Low Carb");

  const optionen = sorted.map(r => {
    const zusatz = [];
    if ((r.tags || []).includes("SPORT")) zusatz.push("SPORT");
    if (r.typ && r.typ !== "abendessen") zusatz.push(typLabel(r.typ));
    const suffix = zusatz.length ? " · " + zusatz.join(" · ") : "";
    return `<option value="${escapeAttr(r.id)}"${r.id === day.recipeId ? " selected" : ""}>${escapeHtml(r.name + suffix)}</option>`;
  }).join("");

  const infoZeile = selected ? [
    selected.kcal ? selected.kcal + " kcal" : "",
    selected.protein ? selected.protein + " g Eiweiß" : "",
    selected.zeit || ""
  ].filter(Boolean).map(escapeHtml).join(" · ") : "";

  card.innerHTML = `
    <div class="day-card-header">
      <input type="text" class="day-label" placeholder="z.B. Mi 19.08." value="${escapeAttr(day.label)}">
      <div class="sport-switch">
        <span class="label">Sport</span>
        <button class="toggle${day.sporttag ? " active" : ""}" type="button" aria-label="Sporttag" aria-pressed="${day.sporttag ? "true" : "false"}"></button>
      </div>
    </div>
    <select aria-label="Rezept für diesen Tag">
      <option value="">Rezept wählen</option>
      ${fehlend ? `<option value="${escapeAttr(day.recipeId)}" selected>Unbekannt: ${escapeHtml(day.recipeId)}</option>` : ""}
      ${optionen}
    </select>
    ${infoZeile ? `<div class="day-info">${infoZeile}</div>` : ""}
    ${lowCarbWarn ? `<div class="warn-lowcarb">Low Carb an einem Sporttag, laut Vorgabe eigentlich nicht vorgesehen.</div>` : ""}
    <div class="day-actions">
      ${selected ? `<button class="btn secondary" type="button" data-act="open">Rezept öffnen</button>` : ""}
      <button class="btn secondary" type="button" data-act="del">Entfernen</button>
    </div>
  `;

  card.querySelector("input.day-label").addEventListener("input", (e) => {
    day.label = e.target.value;
    savePlan();
    aktualisiereKopiertext();
  });
  card.querySelector(".toggle").addEventListener("click", () => {
    day.sporttag = !day.sporttag;
    savePlan();
    render();
  });
  card.querySelector("select").addEventListener("change", (e) => {
    day.recipeId = e.target.value;
    savePlan();
    render();
  });
  const openBtn = card.querySelector('[data-act="open"]');
  if (openBtn) openBtn.addEventListener("click", () => openDetail(selected));
  card.querySelector('[data-act="del"]').addEventListener("click", () => {
    plan.days.splice(idx, 1);
    savePlan();
    render();
  });

  return card;
}

// ---------- MEAL PREP ----------

function prepKandidaten() {
  const mitEintrag = new Set(plan.prep.filter(p => p.portionen > 0).map(p => p.id));
  return planbareRezepte()
    .filter(r => (r.prep && r.prep.geeignet) || r.typ === "mittag" || mitEintrag.has(r.id))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function prepWert(id) {
  const e = plan.prep.find(p => p.id === id);
  return e ? e.portionen : 0;
}

function prepSetzen(id, wert) {
  let entry = plan.prep.find(p => p.id === id);
  if (!entry) { entry = { id, portionen: 0 }; plan.prep.push(entry); }
  entry.portionen = Math.max(0, Math.min(20, wert));
  savePlan();
}

function renderPrepPanel() {
  const wrap = document.createElement("div");

  const list = document.createElement("div");
  list.className = "day-card";
  list.style.marginBottom = "12px";

  const head = document.createElement("span");
  head.className = "label";
  head.style.display = "block";
  head.style.marginBottom = "8px";
  head.textContent = "Meal Prep";
  list.appendChild(head);

  const summary = document.createElement("div");
  summary.className = "meal-prep";
  summary.style.marginBottom = "18px";
  summary.innerHTML = `
    <div class="meal-prep-header">
      <span class="label" style="color:#B4B6B0">Ziel ${PREP_ZIEL} Portionen</span>
      <span class="meal-prep-value" id="prep-value">0 / ${PREP_ZIEL}</span>
    </div>
    <div class="progress"><span id="prep-fill" style="width:0%"></span></div>
  `;

  function updateBar() {
    const s = plan.prep.reduce((a, p) => a + (p.portionen || 0), 0);
    summary.querySelector("#prep-fill").style.width = Math.min(100, (s / PREP_ZIEL) * 100) + "%";
    summary.querySelector("#prep-value").textContent = `${s} / ${PREP_ZIEL}`;
  }

  const kandidaten = prepKandidaten();
  if (!kandidaten.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Kein Rezept ist als prep-geeignet markiert.";
    list.appendChild(leer);
  }

  kandidaten.forEach(r => {
    const row = document.createElement("div");
    row.className = "row-between";

    const name = document.createElement("span");
    name.textContent = r.name;

    const stepper = document.createElement("div");
    stepper.className = "stepper";
    stepper.innerHTML = `
      <button type="button" data-d="-1" aria-label="Weniger Portionen">−</button>
      <span class="val">${prepWert(r.id)}</span>
      <button type="button" data-d="1" aria-label="Mehr Portionen">+</button>
    `;
    stepper.querySelectorAll("button").forEach(b => {
      b.addEventListener("click", () => {
        prepSetzen(r.id, prepWert(r.id) + parseInt(b.dataset.d, 10));
        stepper.querySelector(".val").textContent = prepWert(r.id);
        row.classList.toggle("aktiv", prepWert(r.id) > 0);
        updateBar();
        aktualisiereKopiertext();
      });
    });

    if (prepWert(r.id) > 0) row.classList.add("aktiv");
    row.appendChild(name);
    row.appendChild(stepper);
    list.appendChild(row);
  });

  updateBar();
  wrap.appendChild(list);
  wrap.appendChild(summary);
  return wrap;
}

// ---------- IMPORT ----------

function renderImportPanel() {
  const box = document.createElement("div");
  box.className = "day-card";
  box.style.marginBottom = "18px";

  box.innerHTML = `
    <span class="label" style="display:block;margin-bottom:8px">Aus dem Chat übernehmen</span>
    <p class="small-note" style="margin-top:0">
      Plan-Text aus dem Chat hier einfügen, gleiches Format wie der Kopiertext unten.
      Ersetzt die aktuelle Wochenplanung auf diesem Gerät.
    </p>
    <div class="copy-panel">
      <textarea id="import-text" placeholder="Mi 19.08.: Griechischer Kritharaki-Salat (Sporttag)
Fr 21.08.: Sandwich mit veganem Chicken

Meal Prep: Weißer Bohnensalat x4"></textarea>
    </div>
    <button class="btn primary full" type="button" id="import-btn" style="margin-top:8px">Übernehmen</button>
    <div id="import-result" class="small-note" style="margin-bottom:0"></div>
  `;

  const resultEl = box.querySelector("#import-result");
  if (importErgebnis) resultEl.textContent = importErgebnis;

  box.querySelector("#import-btn").addEventListener("click", () => {
    const text = box.querySelector("#import-text").value;
    if (!text.trim()) return;
    const hatPlan = plan.days.length || plan.prep.some(p => p.portionen > 0);
    if (hatPlan && !confirm("Aktuelle Wochenplanung auf diesem Gerät ersetzen?")) return;
    const result = parseImportText(text);
    plan.days = result.days;
    plan.prep = result.prep;
    savePlan();
    pruefePlanBezuege();
    importErgebnis = importMeldung(result);
    render();
  });

  return box;
}

function importMeldung(result) {
  const parts = [`${result.days.length} Kochtag(e) übernommen`];
  if (result.prep.length) parts.push(`${result.prep.length} Meal-Prep-Eintrag/Einträge übernommen`);
  if (result.unmatched.length) parts.push(`nicht erkannt: ${result.unmatched.map(l => `"${l}"`).join(", ")}`);
  let s = parts.join(", ") + ".";
  if (result.unmatched.length) s += " Nicht erkannte Zeilen bitte in den Kochtag-Karten manuell zuordnen.";
  return s;
}

// Format bleibt unverändert: "Tag: Rezeptname (Sporttag)" und "Meal Prep: Rezeptname xN".
// Robuster wurde nur das Drumherum: Aufzählungszeichen, Sternchen, das Zeichen ×,
// und "Meal Prep:" als eigene Überschrift mit darunterstehender Liste.
function parseImportText(text) {
  const days = [];
  const prep = [];
  const unmatched = [];
  let prepModus = false;

  String(text).replace(/^\uFEFF/, "").split(/\r?\n/).forEach(raw => {
    const line = raw.trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ");
    if (!line) { prepModus = false; return; }

    if (/^meal\s*prep\s*:?\s*$/i.test(line)) { prepModus = true; return; }

    // Überschriften ohne Inhalt ("Wochenplan:", "Kochtage:") sind kein Fehler.
    if (/^[^:]{1,32}:\s*$/.test(line)) return;

    const prepPrefix = line.match(/^meal\s*prep\s*:\s*(.+)$/i);
    const prepInhalt = prepPrefix ? prepPrefix[1] : (prepModus ? line : null);

    if (prepInhalt != null) {
      const m = prepInhalt.match(/^(.+?)\s*[x×]\s*(\d+)\s*(?:portionen)?$/i);
      const name = m ? m[1] : prepInhalt;
      const anzahl = m ? parseInt(m[2], 10) : 1;
      const r = findRecipeByName(name);
      if (r) {
        const vorhanden = prep.find(p => p.id === r.id);
        if (vorhanden) vorhanden.portionen += anzahl;
        else prep.push({ id: r.id, portionen: anzahl });
      } else {
        unmatched.push(line);
      }
      return;
    }

    // Label vor dem Doppelpunkt bleibt kurz, sonst ist es keine Tageszeile.
    const dayMatch = line.match(/^([^:]{1,32}):\s*(.+)$/);
    if (dayMatch) {
      let name = dayMatch[2].trim();
      let sporttag = false;
      const sportMatch = name.match(/^(.*?)\s*\((?:sporttag|sport)\)\s*$/i);
      if (sportMatch) { name = sportMatch[1].trim(); sporttag = true; }
      const r = findRecipeByName(name);
      if (r) days.push({ label: dayMatch[1].trim(), recipeId: r.id, sporttag });
      else unmatched.push(line);
      return;
    }

    unmatched.push(line);
  });

  return { days, prep, unmatched };
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-zäöü0-9]+/g, " ")
    .trim();
}

function findRecipeByName(name) {
  const n = normName(name);
  if (!n) return null;

  const exakt = RECIPES.filter(r => normName(r.name) === n);
  if (exakt.length === 1) return exakt[0];

  const teil = RECIPES.filter(r => {
    const rn = normName(r.name);
    return rn.includes(n) || n.includes(rn);
  });
  if (teil.length === 1) return teil[0];
  if (teil.length > 1) {
    // Bei mehreren Treffern gewinnt der kürzeste Name, aber nur wenn er
    // eindeutig kürzer ist. Sonst lieber nicht raten.
    const sortiert = teil.slice().sort((a, b) => a.name.length - b.name.length);
    return sortiert[0].name.length < sortiert[1].name.length ? sortiert[0] : null;
  }

  // Letzter Versuch über Wortüberschneidung, nur bei klarem Vorsprung.
  const worte = n.split(" ").filter(w => w.length > 3);
  if (!worte.length) return null;
  const bewertet = RECIPES.map(r => {
    const rw = normName(r.name).split(" ");
    return { r, score: worte.filter(w => rw.some(x => x.startsWith(w) || w.startsWith(x))).length };
  }).sort((a, b) => b.score - a.score);
  if (bewertet.length && bewertet[0].score >= 2 && (!bewertet[1] || bewertet[0].score > bewertet[1].score)) {
    return bewertet[0].r;
  }
  return null;
}

// ---------- KOPIERTEXT ----------

function renderKopiertext() {
  const wrap = document.createElement("div");

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.marginBottom = "8px";
  label.textContent = "Kopiertext für den Chat";
  wrap.appendChild(label);

  const offen = plan.days.filter(d => !RECIPES.find(r => r.id === d.recipeId)).length;
  if (offen) {
    const hint = document.createElement("p");
    hint.className = "small-note";
    hint.style.marginTop = "0";
    hint.textContent = `${offen} Kochtag(e) ohne gültiges Rezept, sie stehen nicht im Kopiertext.`;
    wrap.appendChild(hint);
  }

  const panel = document.createElement("div");
  panel.className = "copy-panel";
  const out = document.createElement("textarea");
  out.readOnly = true;
  out.id = "kopiertext";
  out.value = buildKopiertext();
  panel.appendChild(out);
  wrap.appendChild(panel);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn primary full";
  btn.style.marginTop = "8px";
  btn.textContent = "Kopiertext kopieren";
  btn.addEventListener("click", () => copyToClipboard(out.value, btn, "Kopiertext kopieren"));
  wrap.appendChild(btn);

  return wrap;
}

function aktualisiereKopiertext() {
  const out = document.getElementById("kopiertext");
  if (out) out.value = buildKopiertext();
}

function buildKopiertext() {
  const lines = [];
  plan.days.forEach(d => {
    const r = RECIPES.find(x => x.id === d.recipeId);
    if (!r) return;
    lines.push(`${d.label || "Kochtag"}: ${r.name}${d.sporttag ? " (Sporttag)" : ""}`);
  });
  const prepLines = plan.prep.filter(p => p.portionen > 0).map(p => {
    const r = RECIPES.find(x => x.id === p.id);
    return r ? `Meal Prep: ${r.name} x${p.portionen}` : null;
  }).filter(Boolean);
  if (prepLines.length) {
    lines.push("");
    lines.push(...prepLines);
  }
  return lines.join("\n");
}

// ---------- Utils ----------

function copyToClipboard(text, btn, originalText) {
  const melde = (ok) => flash(btn, ok ? "Kopiert" : "Kopieren ging nicht", originalText);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => melde(true), () => melde(fallbackCopy(text)));
  } else {
    melde(fallbackCopy(text));
  }
}

// Rückfalllösung, wenn die Zwischenablage-API blockiert ist.
// document.execCommand gilt als veraltet, funktioniert in Safari aber weiterhin.
function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, String(text).length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function flash(btn, msg, originalText) {
  if (!btn) return;
  const alt = originalText != null ? originalText : btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = alt; }, 1400);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

init();
