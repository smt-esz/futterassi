// Futterassi, lokale Rezept- und Wochenplan-App.
// Datenquelle: rezepte.json, wird im Chat gepflegt und hier nur gelesen.
// Dateinamen stehen nur hier oben und im Service Worker, sonst nirgends.

const DATA_FILE = "rezepte.json";
const SW_FILE = "service-worker.js";

const FILTER_TAGS = ["vegetarisch", "vegan", "High Protein", "Low Carb", "LEBER", "BLUTDRUCK", "SÄTTIGUNG", "SPORT"];
const TYP_LABEL = { abendessen: "Abendessen", mittag: "Mittag", fruehstueck: "Frühstück", snack: "Snack", basis: "Basis" };
const TYP_RANG = { abendessen: 0, mittag: 1, snack: 2, fruehstueck: 3, basis: 4 };
const PREP_ZIEL = 10;

const WOCHENTAG_KURZ = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONAT_NAME = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

// Die Schlüssel entsprechen dem Feld typ in rezepte.json, damit die
// Kategorie eines Kochtags direkt die passenden Rezepte vorsortiert.
const KATEGORIEN = [
  { key: "fruehstueck", label: "Frühstück" },
  { key: "mittag", label: "Mittag" },
  { key: "abendessen", label: "Abend" },
  { key: "snack", label: "Snack" }
];
const KATEGORIE_KEYS = KATEGORIEN.map(k => k.key);

// Verwandte Kategorien: Mittag und Abendessen sind im Haushalt austauschbar,
// beim Vorsortieren zählen sie deshalb beide als passend.
const KATEGORIE_NAH = { mittag: ["abendessen"], abendessen: ["mittag"], fruehstueck: [], snack: [] };

function katLabel(key) {
  const k = KATEGORIEN.find(x => x.key === key);
  return k ? k.label : "Abend";
}

const LS_PLAN = "futterassi_plan_v1";
const LS_UI = "futterassi_ui_v1";
const LS_PATCH = "futterassi_patch_v1";

// Felder, die in der App geändert werden dürfen. Alles andere bleibt so, wie es
// aus rezepte.json kommt. notiz_eigen ist das einzige neue Feld.
const PATCH_FELDER = ["zutaten", "schritte", "basis", "notiz_eigen", "gekocht_am", "urteil", "favorit"];

let ROH_RECIPES = [];   // exakt so, wie sie aus rezepte.json kommen
let RECIPES = [];       // mit den lokalen Änderungen darübergelegt
let patches = loadPatches();
let ui = loadUi();
let plan = loadPlan();

let detail = null;          // { id, portionen, erledigt: Set }
let editor = null;          // { id, basis, zutaten, schritte, notiz_eigen }
let cook = null;            // { el, recipe, i, portionen, zutatenOffen, touchX }
let importErgebnis = null;  // bleibt über das Neuzeichnen hinweg sichtbar
let planHinweis = "";
let speicherDefekt = false;

// ---------- Zustand laden und speichern ----------

function loadUi() {
  const d = { view: "katalog", search: "", tags: [], typen: [], showRaus: false, schnell: false };
  try {
    const raw = JSON.parse(localStorage.getItem(LS_UI));
    if (!raw || typeof raw !== "object") return d;
    return {
      view: ["planung", "daten"].includes(raw.view) ? raw.view : "katalog",
      search: typeof raw.search === "string" ? raw.search : "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => FILTER_TAGS.includes(t)) : [],
      typen: Array.isArray(raw.typen) ? raw.typen.filter(t => typeof t === "string") : [],
      showRaus: raw.showRaus === true,
      schnell: raw.schnell === true
    };
  } catch (e) {
    return d;
  }
}

function loadPlan() {
  const d = { days: [], prep: [] };
  let raw = null;
  // Nur das Lesen und Parsen wird abgesichert. Ein Fehler beim Umformen wäre
  // ein Programmierfehler und darf nicht stillschweigend den Plan löschen.
  try {
    raw = JSON.parse(localStorage.getItem(LS_PLAN));
  } catch (e) {
    return d;
  }
  if (!raw || typeof raw !== "object") return d;
  const days = Array.isArray(raw.days) ? raw.days : [];
  const prep = Array.isArray(raw.prep) ? raw.prep : [];
  return {
      days: days.filter(x => x && typeof x === "object").map(x => {
        const label = typeof x.label === "string" ? x.label : "";
        const datum = istIso(x.datum) ? x.datum : labelZuIso(label);
        return {
          datum: datum || null,
          label: datum ? tagLabel(datum) : label,
          kategorie: KATEGORIE_KEYS.includes(x.kategorie) ? x.kategorie : "abendessen",
          recipeId: typeof x.recipeId === "string" ? x.recipeId : "",
          sporttag: x.sporttag === true
        };
      }),
      prep: prep.filter(x => x && typeof x === "object" && x.id).map(x => ({
        id: String(x.id),
        portionen: Math.max(0, parseInt(x.portionen, 10) || 0),
        modus: x.modus === "frieren" ? "frieren" : "frisch"
      }))
  };
}

function loadPatches() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(LS_PATCH));
  } catch (e) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const sauber = {};
  Object.keys(raw).forEach(id => {
    const p = raw[id];
    if (!p || typeof p !== "object") return;
    const eintrag = {};
    PATCH_FELDER.forEach(f => { if (p[f] !== undefined) eintrag[f] = p[f]; });
    if (Object.keys(eintrag).length) sauber[id] = eintrag;
  });
  return sauber;
}

function savePatches() {
  speichern(LS_PATCH, patches);
}

// Lokale Änderungen werden nie in die Rezeptliste hineingeschrieben, sondern
// beim Laden darübergelegt. So bleibt rezepte.json die Quelle und eine neue
// Datei aus dem Chat kann jederzeit darunter ausgetauscht werden.
function mergeRecipes() {
  return ROH_RECIPES.map(r => {
    const p = patches[r.id];
    if (!p || !Object.keys(p).length) return r;
    return Object.assign({}, r, p, { _geaendert: true });
  });
}

function patchSetzen(id, felder) {
  const alt = patches[id] || {};
  const neu = Object.assign({}, alt, felder);
  Object.keys(neu).forEach(k => {
    if (neu[k] === undefined || !PATCH_FELDER.includes(k)) delete neu[k];
  });
  if (Object.keys(neu).length) patches[id] = neu;
  else delete patches[id];
  savePatches();
  RECIPES = mergeRecipes();
}

function patchLoeschen(id) {
  delete patches[id];
  savePatches();
  RECIPES = mergeRecipes();
}

function geaenderteRezepte() {
  return RECIPES.filter(r => patches[r.id]);
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
    else if (editor) editorAbbrechen();
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
    ROH_RECIPES = daten.filter(r => r && r.id && r.name);
    RECIPES = mergeRecipes();
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
  if (ui.view === "planung") app.appendChild(renderPlanung());
  else if (ui.view === "daten") app.appendChild(renderDaten());
  else app.appendChild(renderKatalog());
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
    chipbar.appendChild(chip("unter 20 Min", ui.schnell, () => {
      ui.schnell = !ui.schnell;
    }));
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
    if (ui.tags.length || ui.typen.length || ui.search || ui.showRaus || ui.schnell) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "linkbtn";
      reset.textContent = "Filter zurücksetzen";
      reset.addEventListener("click", () => {
        ui.tags = []; ui.typen = []; ui.search = ""; ui.showRaus = false; ui.schnell = false;
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
    if (ui.schnell) {
      const min = aktivMinuten(r);
      if (min == null || min > 20) return false;
    }
    if (ui.tags.length) {
      const rtags = r.tags || [];
      if (!ui.tags.every(t => rtags.includes(t))) return false;
    }
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

// Der farbige Streifen an der Karte steht für die Mahlzeit, nicht für Tags.
// Frühstück bernstein, Mittag petrol, Abend dunkelrot, Snack grün, Basis grau.
function mapCategory(r) {
  return r.typ || "";
}

// Aktive Zeit aus dem Freitextfeld zeit, für den Schnell-Filter.
// "15 Min. aktiv, 25 Min. Ofenzeit" liefert 15.
function aktivMinuten(r) {
  const m = String(r.zeit || "").match(/(\d{1,3})\s*Min/i);
  return m ? Number(m[1]) : null;
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
  if (r.typ) badges.push(`<span class="badge typ" data-typ="${escapeAttr(r.typ)}">${escapeHtml(typLabel(r.typ))}</span>`);
  if (r._geaendert) badges.push(`<span class="badge geaendert">GEÄNDERT</span>`);
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
  card.addEventListener("click", () => openDetail(r.id));
  return card;
}

// ---------- DETAIL ----------

function scrollSperre(an) {
  document.body.classList.toggle("locked", an);
}

function rezeptMitId(id) {
  return RECIPES.find(r => r.id === id) || null;
}

function detailRezept() {
  return detail ? rezeptMitId(detail.id) : null;
}

function openDetail(idOderRezept) {
  const id = typeof idOderRezept === "string" ? idOderRezept : (idOderRezept && idOderRezept.id);
  const r = rezeptMitId(id);
  if (!r) return;
  detail = { id, portionen: r.basis || 2, erledigt: new Set() };
  scrollSperre(true);
  drawDetail();
  const overlay = document.getElementById("overlay");
  overlay.scrollTop = 0;
}

function closeDetail() {
  detail = null;
  editor = null;
  const overlay = document.getElementById("overlay");
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
  if (!cook) scrollSperre(false);
}

function drawDetail() {
  const r = detailRezept();
  if (!r) return;
  const overlay = document.getElementById("overlay");
  overlay.classList.remove("hidden");

  const metaBadges = [`<span class="badge status ${statusClass(r.status)}">${escapeHtml(statusText(r.status))}</span>`];
  if (r.typ) metaBadges.push(`<span class="badge typ" data-typ="${escapeAttr(r.typ)}">${escapeHtml(typLabel(r.typ))}</span>`);
  if (r._geaendert) metaBadges.push(`<span class="badge geaendert">GEÄNDERT</span>`);
  if (r.zeit) metaBadges.push(`<span class="badge">${escapeHtml(r.zeit)}</span>`);
  if (r.geraete) metaBadges.push(`<span class="badge">${escapeHtml(r.geraete)}</span>`);

  // Eingeklappt liegt alles, was beim Kochen nicht in der Hand gebraucht wird.
  // Offen bleiben Umbauhinweis, Varianten und die eigene Notiz.
  const klapp = [];
  if (r.notiz) klapp.push(["Notiz", r.notiz]);
  if (r.notizen) klapp.push(["Ergänzt gegenüber dem Original", r.notizen]);
  if (r.rest) klapp.push(["Rest", String(r.rest)]);
  if (r.prep && r.prep.geeignet) {
    const teile = ["geeignet"];
    if (r.prep.haltbar_tage) teile.push(`${r.prep.haltbar_tage} Tage haltbar`);
    if (r.prep.aufwaermen) teile.push(String(r.prep.aufwaermen));
    if (r.prep.einfrierbar) teile.push("einfrierbar");
    klapp.push(["Meal Prep", teile.join(", ")]);
  }
  if (r.gekocht_am) klapp.push(["Zuletzt gekocht", String(r.gekocht_am) + (r.urteil ? `, ${r.urteil}` : "")]);
  if (r.quelle) klapp.push(["Quelle", String(r.quelle)]);

  overlay.innerHTML = `
    <div class="overlay-head">
      <button class="back" type="button" aria-label="Zurück">&larr;</button>
      <button class="btn secondary klein" type="button" id="btn-edit">Anpassen</button>
    </div>
    <h1 class="detail-title">${escapeHtml(r.name)}</h1>
    <div class="recipe-meta" style="margin-bottom:18px">${metaBadges.join("")}</div>

    ${r.ausnahme && r.leichter ? `<div class="note-box exception" style="margin-bottom:10px"><strong>Leichter gebaut</strong><p>${escapeHtml(r.leichter)}</p></div>` : ""}
    ${r.varianten ? `<div class="note-box" style="margin-bottom:10px"><strong>Varianten</strong><p>${escapeHtml(r.varianten)}</p></div>` : ""}
    ${r.notiz_eigen ? `<div class="note-box eigen" style="margin-bottom:10px"><strong>Meine Notiz</strong><p>${escapeHtml(r.notiz_eigen)}</p></div>` : ""}

    ${klapp.length ? `<details class="klapp">
      <summary>Notizen, Quelle und Prep</summary>
      <div class="klapp-inhalt">
        ${klapp.map(([t, v]) => `<div class="klapp-zeile"><strong>${escapeHtml(t)}</strong><span>${escapeHtml(v)}</span></div>`).join("")}
      </div>
    </details>` : ""}

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
  overlay.querySelector("#btn-edit").addEventListener("click", () => editorOeffnen(r.id));

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
  const r = detailRezept();
  if (!r) return;
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
  if (z.menge != null && z.menge !== "" && !isNaN(Number(z.menge))) {
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

// ---------- REZEPT ANPASSEN ----------

const EINHEITEN = ["g", "ml", "Stück", "EL", "TL", "Bund", "Scheiben", ""];

function editorOeffnen(id) {
  const r = rezeptMitId(id);
  if (!r) return;
  editor = {
    id,
    basis: r.basis || 2,
    zutaten: (r.zutaten || []).map(z => ({
      menge: z.menge == null ? "" : z.menge,
      einheit: z.einheit || "",
      name: z.name || ""
    })),
    schritte: (r.schritte || []).slice(),
    notiz_eigen: r.notiz_eigen || ""
  };
  scrollSperre(true);
  drawEditor();
  document.getElementById("overlay").scrollTop = 0;
}

function editorAbbrechen() {
  editor = null;
  if (detail) drawDetail();
  else closeDetail();
}

function drawEditor() {
  if (!editor) return;
  const roh = ROH_RECIPES.find(x => x.id === editor.id);
  const r = rezeptMitId(editor.id);
  const overlay = document.getElementById("overlay");
  overlay.classList.remove("hidden");

  overlay.innerHTML = `
    <div class="overlay-head">
      <button class="back" type="button" aria-label="Abbrechen">&larr;</button>
      <span class="label">Anpassen</span>
    </div>
    <h1 class="detail-title">${escapeHtml(r.name)}</h1>
    <p class="small-note">
      Änderungen liegen nur auf diesem Gerät und legen sich über ${escapeHtml(DATA_FILE)}.
      Im Reiter Daten kannst du sie als vollständige Datei herunterladen oder als kurzen Textblock in den Chat geben.
    </p>

    <span class="label" style="display:block;margin:20px 0 8px">Rezeptbasis</span>
    <div class="portions" style="margin-bottom:20px">
      <span class="small-note" style="margin:0">Für wie viele Portionen gelten die Mengen</span>
      <div class="portion-control">
        <button type="button" data-basis="-1" aria-label="Weniger">−</button>
        <span class="portion-value">${editor.basis}</span>
        <button type="button" data-basis="1" aria-label="Mehr">+</button>
      </div>
    </div>

    <span class="label" style="display:block;margin-bottom:8px">Zutaten</span>
    <div class="edit-zutaten">
      ${editor.zutaten.map((z, i) => `
        <div class="edit-zeile" data-i="${i}">
          <input class="edit-menge" type="text" inputmode="decimal" value="${escapeAttr(z.menge)}" aria-label="Menge" placeholder="Menge">
          <select class="edit-einheit" aria-label="Einheit">
            ${EINHEITEN.concat(EINHEITEN.includes(z.einheit) ? [] : [z.einheit]).map(e =>
              `<option value="${escapeAttr(e)}"${e === z.einheit ? " selected" : ""}>${escapeHtml(e || "ohne")}</option>`).join("")}
          </select>
          <input class="edit-name" type="text" value="${escapeAttr(z.name)}" aria-label="Zutat" placeholder="Zutat">
          <button type="button" class="edit-weg" data-weg="${i}" aria-label="Zutat entfernen">×</button>
        </div>`).join("")}
    </div>
    <button class="btn secondary full" type="button" id="edit-plus" style="margin-top:10px">+ Zutat</button>

    <span class="label" style="display:block;margin:24px 0 8px">Zubereitung</span>
    <p class="small-note" style="margin-top:0">Ein Schritt pro Zeile. Leere Zeilen fallen weg.</p>
    <textarea id="edit-schritte" class="edit-flaeche" aria-label="Zubereitungsschritte">${escapeHtml(editor.schritte.join("\n"))}</textarea>

    <span class="label" style="display:block;margin:24px 0 8px">Meine Notiz</span>
    <textarea id="edit-notiz" aria-label="Eigene Notiz" placeholder="Was beim nächsten Mal anders soll">${escapeHtml(editor.notiz_eigen)}</textarea>

    <div class="detail-actions" style="margin-top:24px">
      <button class="btn secondary full" type="button" id="edit-abbruch">Abbrechen</button>
      <button class="btn primary full" type="button" id="edit-speichern">Speichern</button>
    </div>
    ${patches[editor.id] ? `<button class="btn secondary full" type="button" id="edit-reset" style="margin-top:10px">Auf ${escapeHtml(DATA_FILE)} zurücksetzen</button>` : ""}
    <p class="small-note">Original: ${escapeHtml((roh && (roh.zutaten || []).length) || 0)} Zutaten, ${escapeHtml((roh && (roh.schritte || []).length) || 0)} Schritte.</p>
  `;

  const uebernehmen = () => {
    overlay.querySelectorAll(".edit-zeile").forEach(zeile => {
      const i = parseInt(zeile.dataset.i, 10);
      if (!editor.zutaten[i]) return;
      editor.zutaten[i].menge = zeile.querySelector(".edit-menge").value.trim();
      editor.zutaten[i].einheit = zeile.querySelector(".edit-einheit").value;
      editor.zutaten[i].name = zeile.querySelector(".edit-name").value;
    });
    editor.schritte = overlay.querySelector("#edit-schritte").value.split(/\n/).map(x => x.trim()).filter(Boolean);
    editor.notiz_eigen = overlay.querySelector("#edit-notiz").value.trim();
  };

  overlay.querySelector(".back").addEventListener("click", editorAbbrechen);
  overlay.querySelector("#edit-abbruch").addEventListener("click", editorAbbrechen);

  overlay.querySelectorAll("[data-basis]").forEach(b => {
    b.addEventListener("click", () => {
      uebernehmen();
      editor.basis = Math.min(20, Math.max(1, editor.basis + parseInt(b.dataset.basis, 10)));
      drawEditor();
    });
  });

  overlay.querySelectorAll("[data-weg]").forEach(b => {
    b.addEventListener("click", () => {
      uebernehmen();
      editor.zutaten.splice(parseInt(b.dataset.weg, 10), 1);
      drawEditor();
    });
  });

  overlay.querySelector("#edit-plus").addEventListener("click", () => {
    uebernehmen();
    editor.zutaten.push({ menge: "", einheit: "g", name: "" });
    drawEditor();
  });

  overlay.querySelector("#edit-speichern").addEventListener("click", () => {
    uebernehmen();
    editorSpeichern();
  });

  const reset = overlay.querySelector("#edit-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      if (!confirm("Alle eigenen Änderungen an diesem Rezept verwerfen?")) return;
      patchLoeschen(editor.id);
      editor = null;
      drawDetail();
      render();
    });
  }
}

// Gespeichert wird nur, was wirklich vom Original abweicht. Damit bleibt der
// Patch klein und eine neue rezepte.json überschreibt unveränderte Felder.
function editorSpeichern() {
  const roh = ROH_RECIPES.find(x => x.id === editor.id);
  if (!roh) return;

  const zutaten = editor.zutaten
    .filter(z => String(z.name || "").trim())
    .map(z => {
      const zahl = String(z.menge).replace(",", ".").trim();
      return {
        menge: zahl === "" || isNaN(Number(zahl)) ? null : Number(zahl),
        einheit: z.einheit || "",
        name: String(z.name).trim()
      };
    });

  const felder = {};
  const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  if (!gleich(zutaten, roh.zutaten || [])) felder.zutaten = zutaten;
  if (!gleich(editor.schritte, roh.schritte || [])) felder.schritte = editor.schritte;
  if (editor.basis !== (roh.basis || 2)) felder.basis = editor.basis;
  if (editor.notiz_eigen !== (roh.notiz_eigen || "")) felder.notiz_eigen = editor.notiz_eigen || undefined;

  // Felder, die jetzt wieder dem Original entsprechen, fallen aus dem Patch.
  const alt = patches[editor.id] || {};
  const zusammen = {};
  ["zutaten", "schritte", "basis", "notiz_eigen"].forEach(f => {
    zusammen[f] = felder[f] !== undefined ? felder[f] : undefined;
  });
  ["gekocht_am", "urteil", "favorit"].forEach(f => {
    if (alt[f] !== undefined) zusammen[f] = alt[f];
  });

  patches[editor.id] = {};
  savePatches();
  patchSetzen(editor.id, zusammen);

  const id = editor.id;
  editor = null;
  if (detail) detail.id = id;
  drawDetail();
  render();
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
  timerStopp();
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
      ${timerZeile(gesamt ? steps[cook.i] : "")}
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

  cook.el.querySelectorAll("[data-timer]").forEach(b => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const wert = b.dataset.timer;
      if (wert === "stop") timerStopp();
      else timerStart(parseInt(wert, 10));
      drawCook();
    });
  });
}

// ---------- TIMER ----------

// Zeitangaben aus dem Schritttext ziehen, damit der Timer ohne Tippen startet.
// Bei Spannen wie "20 bis 25 Minuten" gilt der obere Wert.
function findeZeiten(text) {
  const gefunden = [];
  const re = /(\d{1,3})\s*(?:bis|-|–|—)?\s*(\d{1,3})?\s*(minuten|minute|min\.?|stunden|stunde|std\.?)/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const zahl = Number(m[2] || m[1]);
    const stunden = /^(stunden|stunde|std)/i.test(m[3]);
    const minuten = stunden ? zahl * 60 : zahl;
    if (minuten > 0 && minuten <= 240) gefunden.push(minuten);
  }
  return [...new Set(gefunden)];
}

let timer = null; // { restSek, tickId, gesamtSek }

function mmss(sek) {
  const m = Math.floor(Math.max(0, sek) / 60);
  const s = Math.max(0, sek) % 60;
  return `${m}:${pad2(s)}`;
}

function timerZeile(schrittText) {
  if (timer) {
    const fertig = timer.restSek <= 0;
    return `<div class="cook-timer${fertig ? " fertig" : ""}">
      <span class="cook-timer-rest">${fertig ? "Zeit um" : mmss(timer.restSek)}</span>
      <button type="button" class="cook-timer-btn" data-timer="stop">${fertig ? "Ok" : "Stopp"}</button>
    </div>`;
  }
  const zeiten = findeZeiten(schrittText);
  if (!zeiten.length) return "";
  return `<div class="cook-timer">
    ${zeiten.slice(0, 3).map(m => `<button type="button" class="cook-timer-btn" data-timer="${m}">${m} Min Timer</button>`).join("")}
  </div>`;
}

function timerStart(minuten) {
  timerStopp();
  if (!minuten || minuten <= 0) return;
  timer = { restSek: minuten * 60, gesamtSek: minuten * 60, tickId: null };
  timer.tickId = setInterval(() => {
    if (!timer) return;
    timer.restSek -= 1;
    const el = document.querySelector(".cook-timer-rest");
    if (timer.restSek <= 0) {
      clearInterval(timer.tickId);
      timer.tickId = null;
      piep();
      if (cook) drawCook();
      return;
    }
    if (el) el.textContent = mmss(timer.restSek);
  }, 1000);
}

function timerStopp() {
  if (timer && timer.tickId) clearInterval(timer.tickId);
  timer = null;
}

// Kurzer Ton am Ende. Ohne Audio-Unterstützung passiert nichts.
function piep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [0, 0.45, 0.9].forEach(versatz => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + versatz);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + versatz + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + versatz + 0.3);
      o.start(ctx.currentTime + versatz);
      o.stop(ctx.currentTime + versatz + 0.32);
    });
  } catch (e) {
    /* kein Ton, kein Drama */
  }
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

// ---------- PLANUNG: DATUM UND KATEGORIEN ----------

function pad2(n) { return String(n).padStart(2, "0"); }
function isoVon(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function dateVon(iso) { const p = String(iso).split("-").map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
function istIso(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function heuteIso() { return isoVon(new Date()); }
function tagLabel(iso) {
  const d = dateVon(iso);
  return `${WOCHENTAG_KURZ[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
}
function montagVon(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function plusTage(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

// "Mi 19.08." aus dem Chat-Text zurück in ein echtes Datum. Das Jahr steht dort
// nie, deshalb wird das nächstliegende genommen, Fenster ein halbes Jahr.
function labelZuIso(label) {
  const m = String(label || "").match(/(\d{1,2})\s*\.\s*(\d{1,2})\s*\./);
  if (!m) return null;
  const tag = Number(m[1]);
  const monat = Number(m[2]);
  if (monat < 1 || monat > 12 || tag < 1 || tag > 31) return null;
  const heute = new Date();
  let jahr = heute.getFullYear();
  const diff = (new Date(jahr, monat - 1, tag) - heute) / 86400000;
  if (diff < -180) jahr += 1;
  else if (diff > 185) jahr -= 1;
  const d = new Date(jahr, monat - 1, tag);
  if (d.getMonth() !== monat - 1) return null;
  return isoVon(d);
}

function tagAnzeige(day) {
  return day.datum ? tagLabel(day.datum) : (day.label || "Kochtag");
}

function sortierteTage() {
  const rang = k => Math.max(0, KATEGORIE_KEYS.indexOf(k));
  return plan.days
    .map((d, idx) => ({ d, idx }))
    .sort((a, b) => {
      if (!a.d.datum && !b.d.datum) return a.idx - b.idx;
      if (!a.d.datum) return 1;
      if (!b.d.datum) return -1;
      if (a.d.datum !== b.d.datum) return a.d.datum < b.d.datum ? -1 : 1;
      return rang(a.d.kategorie) - rang(b.d.kategorie);
    });
}

// ---------- PLANUNG: ANSICHT ----------

let kalenderAnker = isoVon(montagVon(new Date()));
let gewaehltesDatum = null;
let prepSuche = "";

function renderPlanung() {
  const wrap = document.createElement("div");
  wrap.className = "section";

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

  const hinweise = wochenHinweise();
  if (hinweise.length) {
    const box = document.createElement("div");
    box.className = "note-box";
    box.style.marginBottom = "14px";
    box.innerHTML = `<strong>Was auffällt</strong>${hinweise.map(h => `<p>${escapeHtml(h)}</p>`).join("")}`;
    wrap.appendChild(box);
  }

  wrap.appendChild(renderKalender());

  const dayList = document.createElement("div");
  dayList.className = "day-list";
  sortierteTage().forEach(({ d, idx }) => dayList.appendChild(renderDayCard(d, idx)));
  if (!plan.days.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch keine Mahlzeit geplant. Oben einen Tag antippen, dann die Kategorie wählen.";
    dayList.appendChild(leer);
  }
  wrap.appendChild(dayList);

  wrap.appendChild(renderPrepPanel());
  wrap.appendChild(renderWochenuebersicht());
  wrap.appendChild(renderKopiertext());
  wrap.appendChild(renderImportPanel());

  return wrap;
}

// ---------- KALENDER ----------

function renderKalender() {
  const box = document.createElement("div");
  box.className = "kal";

  const start = dateVon(kalenderAnker);
  const tage = [];
  for (let i = 0; i < 14; i++) tage.push(plusTage(start, i));

  const monate = [...new Set(tage.map(d => d.getMonth()))];
  const titel = monate.map(m => MONAT_NAME[m]).join(" / ") + " " + tage[13].getFullYear();

  const belegung = {};
  plan.days.forEach(d => {
    if (!d.datum) return;
    if (!belegung[d.datum]) belegung[d.datum] = [];
    belegung[d.datum].push(d);
  });

  const heute = heuteIso();

  box.innerHTML = `
    <div class="kal-head">
      <button type="button" class="kal-nav" data-nav="-7" aria-label="Zwei Wochen zurück">‹</button>
      <div class="kal-titel">${escapeHtml(titel)}</div>
      <button type="button" class="kal-nav" data-nav="7" aria-label="Zwei Wochen vor">›</button>
    </div>
    <div class="kal-grid">
      ${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map(t => `<div class="kal-wt">${t}</div>`).join("")}
      ${tage.map(d => {
        const iso = isoVon(d);
        const eintraege = belegung[iso] || [];
        const cls = ["kal-tag"];
        if (iso === heute) cls.push("heute");
        if (iso === gewaehltesDatum) cls.push("gewaehlt");
        if (eintraege.length) cls.push("belegt");
        return `<button type="button" class="${cls.join(" ")}" data-iso="${iso}" aria-label="${escapeAttr(tagLabel(iso))}">
          <span class="kal-nr">${d.getDate()}</span>
          <span class="kal-punkte">${eintraege.slice(0, 3).map(() => "<i></i>").join("")}</span>
        </button>`;
      }).join("")}
    </div>
  `;

  box.querySelectorAll(".kal-nav").forEach(b => {
    b.addEventListener("click", () => {
      kalenderAnker = isoVon(plusTage(dateVon(kalenderAnker), parseInt(b.dataset.nav, 10)));
      render();
    });
  });

  box.querySelectorAll(".kal-tag").forEach(b => {
    b.addEventListener("click", () => {
      gewaehltesDatum = gewaehltesDatum === b.dataset.iso ? null : b.dataset.iso;
      render();
    });
  });

  if (gewaehltesDatum) {
    const add = document.createElement("div");
    add.className = "kal-add";
    add.innerHTML = `
      <div class="kal-add-titel">${escapeHtml(tagLabel(gewaehltesDatum))} planen</div>
      <div class="segmented">
        ${KATEGORIEN.map(k => `<button type="button" data-kat="${k.key}">${escapeHtml(k.label)}</button>`).join("")}
      </div>
      <p class="small-note" style="margin:8px 0 0">Kategorie antippen, dann unten das Rezept wählen. Mehrere Mahlzeiten pro Tag sind möglich.</p>
    `;
    add.querySelectorAll("[data-kat]").forEach(b => {
      b.addEventListener("click", () => {
        plan.days.push({
          datum: gewaehltesDatum,
          label: tagLabel(gewaehltesDatum),
          kategorie: b.dataset.kat,
          recipeId: "",
          sporttag: false
        });
        savePlan();
        render();
      });
    });
    box.appendChild(add);
  } else {
    const hint = document.createElement("p");
    hint.className = "small-note";
    hint.style.margin = "10px 2px 0";
    hint.textContent = "Tag antippen, um eine Mahlzeit zu planen.";
    box.appendChild(hint);
  }

  const heuteBtn = document.createElement("button");
  heuteBtn.type = "button";
  heuteBtn.className = "linkbtn";
  heuteBtn.textContent = "Zur aktuellen Woche";
  heuteBtn.addEventListener("click", () => {
    kalenderAnker = isoVon(montagVon(new Date()));
    render();
  });
  box.appendChild(heuteBtn);

  return box;
}

// ---------- KOCHTAG-KARTE ----------

function planbareRezepte() {
  return RECIPES.filter(r => r.status !== "raus");
}


function passendeRezepte(kategorie, sporttag) {
  const nah = KATEGORIE_NAH[kategorie] || [];
  const passt = r => r.typ === kategorie || nah.includes(r.typ);
  const sortiere = (a, b) => {
    if (sporttag) {
      const aS = (a.tags || []).includes("SPORT");
      const bS = (b.tags || []).includes("SPORT");
      if (aS !== bS) return aS ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "de");
  };
  const alle = planbareRezepte();
  return {
    passend: alle.filter(passt).sort(sortiere),
    weitere: alle.filter(r => !passt(r)).sort(sortiere)
  };
}

// Gekocht heißt: für dieses Rezept liegt lokal ein gekocht_am, das zum Tag passt.
function istGekocht(day, r) {
  if (!r) return false;
  const p = patches[r.id];
  if (!p || !p.gekocht_am) return false;
  return !day.datum || p.gekocht_am === day.datum;
}

function renderDayCard(day, idx) {
  const card = document.createElement("div");
  card.className = "day-card";

  const selected = RECIPES.find(r => r.id === day.recipeId);
  const fehlend = day.recipeId && !selected;
  const lowCarbWarn = day.sporttag && selected && (selected.tags || []).includes("Low Carb");
  const { passend, weitere } = passendeRezepte(day.kategorie, day.sporttag);

  const opt = r => `<option value="${escapeAttr(r.id)}"${r.id === day.recipeId ? " selected" : ""}>${escapeHtml(r.name + ((r.tags || []).includes("SPORT") ? " · SPORT" : ""))}</option>`;

  const infoZeile = selected ? [
    selected.kcal ? selected.kcal + " kcal" : "",
    selected.protein ? selected.protein + " g Eiweiß" : "",
    selected.zeit || ""
  ].filter(Boolean).map(escapeHtml).join(" · ") : "";

  card.innerHTML = `
    <div class="day-card-header">
      <div class="day-datum-wrap">
        <div class="day-datum">${escapeHtml(tagAnzeige(day))}</div>
        <input type="date" class="day-datum-input" value="${escapeAttr(day.datum || "")}" aria-label="Datum ändern">
      </div>
      <div class="sport-switch">
        <span class="label">Sport</span>
        <button class="toggle${day.sporttag ? " active" : ""}" type="button" aria-label="Sporttag" aria-pressed="${day.sporttag ? "true" : "false"}"></button>
      </div>
    </div>
    <div class="segmented klein">
      ${KATEGORIEN.map(k => `<button type="button" data-kat="${k.key}"${k.key === day.kategorie ? ' class="aktiv"' : ""}>${escapeHtml(k.label)}</button>`).join("")}
    </div>
    <select aria-label="Rezept für diese Mahlzeit">
      <option value="">Rezept wählen</option>
      ${fehlend ? `<option value="${escapeAttr(day.recipeId)}" selected>Unbekannt: ${escapeHtml(day.recipeId)}</option>` : ""}
      ${passend.length ? `<optgroup label="Passend zu ${escapeAttr(katLabel(day.kategorie))}">${passend.map(opt).join("")}</optgroup>` : ""}
      ${weitere.length ? `<optgroup label="Weitere Rezepte">${weitere.map(opt).join("")}</optgroup>` : ""}
    </select>
    ${infoZeile ? `<div class="day-info">${infoZeile}</div>` : ""}
    ${lowCarbWarn ? `<div class="warn-lowcarb">Low Carb an einem Sporttag, laut Vorgabe eigentlich nicht vorgesehen.</div>` : ""}
    ${selected && selected.rest ? `<div class="day-rest">Bleibt übrig: ${escapeHtml(String(selected.rest))}</div>` : ""}
    <div class="day-actions">
      ${selected ? `<button class="btn secondary" type="button" data-act="open">Rezept öffnen</button>` : ""}
      ${selected ? `<button class="btn secondary${istGekocht(day, selected) ? " an" : ""}" type="button" data-act="gekocht">${istGekocht(day, selected) ? "gekocht ✓" : "gekocht"}</button>` : ""}
      <button class="btn secondary" type="button" data-act="del">Entfernen</button>
    </div>
  `;

  card.querySelectorAll("[data-kat]").forEach(b => {
    b.addEventListener("click", () => {
      day.kategorie = b.dataset.kat;
      savePlan();
      render();
    });
  });
  card.querySelector(".day-datum-input").addEventListener("change", (e) => {
    const wert = e.target.value;
    if (!istIso(wert)) return;
    day.datum = wert;
    day.label = tagLabel(wert);
    savePlan();
    kalenderAnker = isoVon(montagVon(dateVon(wert)));
    render();
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
  if (openBtn) openBtn.addEventListener("click", () => openDetail(selected.id));
  const gekochtBtn = card.querySelector('[data-act="gekocht"]');
  if (gekochtBtn) {
    gekochtBtn.addEventListener("click", () => {
      const datum = day.datum || heuteIso();
      patchSetzen(selected.id, { gekocht_am: istGekocht(day, selected) ? undefined : datum });
      render();
    });
  }
  card.querySelector('[data-act="del"]').addEventListener("click", () => {
    plan.days.splice(idx, 1);
    savePlan();
    render();
  });

  return card;
}

// ---------- WOCHENÜBERSICHT ----------

function renderWochenuebersicht() {
  const wrap = document.createElement("div");
  const mitRezept = plan.days.filter(d => RECIPES.find(r => r.id === d.recipeId));
  if (!mitRezept.length) return wrap;

  const gruppen = [];
  sortierteTage().forEach(({ d }) => {
    const r = RECIPES.find(x => x.id === d.recipeId);
    if (!r) return;
    const key = tagAnzeige(d);
    let g = gruppen.find(x => x.key === key);
    if (!g) { g = { key, zeilen: [], kcal: 0, protein: 0 }; gruppen.push(g); }
    g.zeilen.push(`${katLabel(d.kategorie)}: ${r.name}${d.sporttag ? " (Sport)" : ""}`);
    g.kcal += Number(r.kcal) || 0;
    g.protein += Number(r.protein) || 0;
  });

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.margin = "26px 0 8px";
  label.textContent = "Übersicht";
  wrap.appendChild(label);

  const box = document.createElement("div");
  box.className = "day-card";
  box.style.marginBottom = "18px";
  box.innerHTML = gruppen.map(g => `
    <div class="uebersicht-tag">
      <div class="uebersicht-kopf">
        <span>${escapeHtml(g.key)}</span>
        <span class="uebersicht-zahlen">${g.kcal} kcal · ${g.protein} g EW</span>
      </div>
      ${g.zeilen.map(z => `<div class="uebersicht-zeile">${escapeHtml(z)}</div>`).join("")}
    </div>
  `).join("");
  wrap.appendChild(box);

  const reste = offeneReste();
  if (reste.length) {
    const rbox = document.createElement("div");
    rbox.className = "note-box";
    rbox.style.marginTop = "10px";
    rbox.innerHTML = `<strong>Reste im Kühlschrank</strong>${reste.map(x =>
      `<p>${escapeHtml(x.tag)}: ${escapeHtml(x.rest)} aus ${escapeHtml(x.quelle)}</p>`).join("")}`;
    const suchen = document.createElement("button");
    suchen.type = "button";
    suchen.className = "linkbtn";
    suchen.textContent = "Rezepte dazu suchen";
    suchen.addEventListener("click", () => {
      ui.search = String(reste[0].rest).replace(/^[½1-9/\s]+/, "").trim();
      ui.view = "katalog";
      saveUi();
      render();
      window.scrollTo(0, 0);
    });
    rbox.appendChild(suchen);
    wrap.appendChild(rbox);
  }

  const note = document.createElement("p");
  note.className = "small-note";
  note.style.marginTop = "10px";
  note.textContent = "Summen aus rezepte.json, jeweils eine Portion pro Person. Frühstück und Snacks nur, wenn du sie eingeplant hast.";
  wrap.appendChild(note);

  return wrap;
}

// ---------- MEAL PREP ----------

function prepEintraege() {
  return plan.prep.filter(p => p.portionen > 0);
}

function prepWert(id) {
  const e = plan.prep.find(p => p.id === id);
  return e ? e.portionen : 0;
}

function prepModus(id) {
  const e = plan.prep.find(p => p.id === id);
  return e && e.modus === "frieren" ? "frieren" : "frisch";
}

function prepSetzen(id, wert, modus) {
  let entry = plan.prep.find(p => p.id === id);
  if (!entry) { entry = { id, portionen: 0, modus: "frisch" }; plan.prep.push(entry); }
  entry.portionen = Math.max(0, Math.min(20, wert));
  if (modus) entry.modus = modus;
  if (entry.portionen === 0) plan.prep = plan.prep.filter(p => p !== entry);
  savePlan();
}

function prepSummen() {
  let frisch = 0, frieren = 0;
  prepEintraege().forEach(p => {
    if (p.modus === "frieren") frieren += p.portionen;
    else frisch += p.portionen;
  });
  return { frisch, frieren, gesamt: frisch + frieren };
}

function renderPrepPanel() {
  const wrap = document.createElement("div");

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.margin = "26px 0 8px";
  label.textContent = "Meal Prep";
  wrap.appendChild(label);

  const s = prepSummen();
  const summary = document.createElement("div");
  summary.className = "meal-prep";
  summary.innerHTML = `
    <div class="meal-prep-header">
      <span class="label" style="color:#B4B6B0">Ziel ${PREP_ZIEL} Portionen</span>
      <span class="meal-prep-value">${s.gesamt} / ${PREP_ZIEL}</span>
    </div>
    <div class="progress"><span style="width:${Math.min(100, (s.gesamt / PREP_ZIEL) * 100)}%"></span></div>
    <div class="meal-prep-split">
      <span>Frisch ${s.frisch}</span>
      <span>Einfrieren ${s.frieren}</span>
      <span>${s.gesamt < PREP_ZIEL ? (PREP_ZIEL - s.gesamt) + " fehlen" : "Ziel erreicht"}</span>
    </div>
  `;
  wrap.appendChild(summary);

  const gewaehlt = document.createElement("div");
  gewaehlt.className = "prep-liste";
  const eintraege = prepEintraege();

  if (!eintraege.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch nichts vorgekocht geplant. Unten suchen oder einen Vorschlag antippen.";
    gewaehlt.appendChild(leer);
  }

  eintraege.forEach(p => {
    const r = RECIPES.find(x => x.id === p.id);
    if (!r) return;
    const karte = document.createElement("div");
    karte.className = "prep-karte";

    const prep = r.prep || {};
    const infos = [];
    if (prep.haltbar_tage) infos.push(`hält ${prep.haltbar_tage} Tage`);
    if (prep.einfrierbar) infos.push("einfrierbar");
    if (r.protein) infos.push(`${r.protein} g Eiweiß`);
    if (!prep.geeignet) infos.push("nicht als prep markiert");

    const warnung = p.modus === "frieren" && !prep.einfrierbar
      ? "In rezepte.json steht nichts von einfrierbar."
      : "";

    karte.innerHTML = `
      <div class="prep-kopf">
        <span class="prep-name">${escapeHtml(r.name)}</span>
        <div class="stepper">
          <button type="button" data-d="-1" aria-label="Weniger Portionen">−</button>
          <span class="val">${p.portionen}</span>
          <button type="button" data-d="1" aria-label="Mehr Portionen">+</button>
        </div>
      </div>
      <div class="prep-fuss">
        <div class="segmented winzig">
          <button type="button" data-modus="frisch"${p.modus !== "frieren" ? ' class="aktiv"' : ""}>Frisch</button>
          <button type="button" data-modus="frieren"${p.modus === "frieren" ? ' class="aktiv"' : ""}>Einfrieren</button>
        </div>
        <span class="prep-info">${escapeHtml(infos.join(" · "))}</span>
      </div>
      ${warnung ? `<div class="warn-lowcarb">${escapeHtml(warnung)}</div>` : ""}
    `;

    karte.querySelectorAll(".stepper button").forEach(b => {
      b.addEventListener("click", () => {
        prepSetzen(p.id, prepWert(p.id) + parseInt(b.dataset.d, 10));
        render();
      });
    });
    karte.querySelectorAll("[data-modus]").forEach(b => {
      b.addEventListener("click", () => {
        prepSetzen(p.id, prepWert(p.id), b.dataset.modus);
        render();
      });
    });

    gewaehlt.appendChild(karte);
  });

  wrap.appendChild(gewaehlt);
  wrap.appendChild(renderPrepAuswahl());
  return wrap;
}

function renderPrepAuswahl() {
  const box = document.createElement("div");
  box.className = "prep-auswahl";

  const gewaehlteIds = new Set(prepEintraege().map(p => p.id));
  const alle = planbareRezepte().filter(r => !gewaehlteIds.has(r.id));

  // Vorschläge: als prep geeignet, viel Eiweiß, noch nicht gewählt.
  const vorschlaege = alle
    .filter(r => r.prep && r.prep.geeignet)
    .sort((a, b) => (Number(b.protein) || 0) - (Number(a.protein) || 0))
    .slice(0, 4);

  const suche = prepSuche.trim().toLowerCase();
  const treffer = suche
    ? alle.filter(r => suchtext(r).includes(suche)).slice(0, 6)
    : [];

  box.innerHTML = `
    ${vorschlaege.length ? `<div class="prep-vorschlaege">
      ${vorschlaege.map(r => `<button type="button" class="chip" data-add="${escapeAttr(r.id)}">+ ${escapeHtml(r.name)}</button>`).join("")}
    </div>` : ""}
    <div class="search" style="margin-bottom:8px">
      <input type="search" id="prep-suche" placeholder="Anderes Gericht suchen" value="${escapeAttr(prepSuche)}" autocomplete="off">
    </div>
    <div class="prep-treffer">
      ${suche && !treffer.length ? `<p class="small-note" style="margin:0">Nichts gefunden.</p>` : ""}
      ${treffer.map(r => `<button type="button" class="prep-treffer-zeile" data-add="${escapeAttr(r.id)}">
        <span>${escapeHtml(r.name)}</span>
        <span class="prep-info">${escapeHtml([typLabel(r.typ), r.prep && r.prep.geeignet ? "prep" : "", r.protein ? r.protein + " g EW" : ""].filter(Boolean).join(" · "))}</span>
      </button>`).join("")}
    </div>
  `;

  box.querySelectorAll("[data-add]").forEach(b => {
    b.addEventListener("click", () => {
      const r = RECIPES.find(x => x.id === b.dataset.add);
      prepSetzen(b.dataset.add, 2, r && r.prep && r.prep.einfrierbar && !(r.prep && r.prep.geeignet) ? "frieren" : "frisch");
      prepSuche = "";
      render();
    });
  });

  const inp = box.querySelector("#prep-suche");
  inp.addEventListener("input", (e) => {
    prepSuche = e.target.value;
    const neu = renderPrepAuswahl();
    box.replaceWith(neu);
    const feld = neu.querySelector("#prep-suche");
    if (feld) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }
  });

  return box;
}

// ---------- IMPORT ----------

function renderImportPanel() {
  const box = document.createElement("div");
  box.className = "day-card";
  box.style.marginTop = "18px";

  box.innerHTML = `
    <span class="label" style="display:block;margin-bottom:8px">Aus dem Chat übernehmen</span>
    <p class="small-note" style="margin-top:0">
      Plan-Text aus dem Chat hier einfügen, gleiches Format wie der Kopiertext oben.
      Ersetzt die aktuelle Wochenplanung auf diesem Gerät.
    </p>
    <div class="copy-panel">
      <textarea id="import-text" placeholder="Mi 19.08.: Griechischer Kritharaki-Salat (Sporttag)
Do 20.08. (Mittag): Linsen-Bolognese
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
    const hatPlan = plan.days.length || prepEintraege().length;
    if (hatPlan && !confirm("Aktuelle Wochenplanung auf diesem Gerät ersetzen?")) return;
    const result = parseImportText(text);
    plan.days = result.days;
    plan.prep = result.prep;
    savePlan();
    pruefePlanBezuege();
    importErgebnis = importMeldung(result);
    const erstes = result.days.find(d => d.datum);
    if (erstes) kalenderAnker = isoVon(montagVon(dateVon(erstes.datum)));
    render();
  });

  return box;
}

function importMeldung(result) {
  const parts = [`${result.days.length} Mahlzeit(en) übernommen`];
  if (result.prep.length) parts.push(`${result.prep.length} Meal-Prep-Eintrag/Einträge übernommen`);
  if (result.ohneDatum) parts.push(`${result.ohneDatum} ohne erkennbares Datum`);
  if (result.unmatched.length) parts.push(`nicht erkannt: ${result.unmatched.map(l => `"${l}"`).join(", ")}`);
  let s = parts.join(", ") + ".";
  if (result.unmatched.length) s += " Nicht erkannte Zeilen bitte manuell nachtragen.";
  return s;
}

// Format bleibt kompatibel: "Tag: Rezeptname (Sporttag)" und "Meal Prep: Rezeptname xN".
// Neu ist nur eine Kategorie in Klammern hinter dem Tag, die nur dann auftaucht,
// wenn es nicht Abendessen ist. Alte Texte ohne Kategorie werden weiter gelesen.
function parseImportText(text) {
  const days = [];
  const prep = [];
  const unmatched = [];
  let ohneDatum = 0;
  let prepModus = false;

  String(text).replace(/^\uFEFF/, "").split(/\r?\n/).forEach(raw => {
    const line = raw.trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ");
    if (!line) { prepModus = false; return; }

    if (/^meal\s*prep\s*:?\s*$/i.test(line)) { prepModus = true; return; }

    // Überschriften ohne Inhalt ("Wochenplan:", "Kochtage:") sind kein Fehler.
    if (/^[^:]{1,40}:\s*$/.test(line)) return;

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
        else prep.push({ id: r.id, portionen: anzahl, modus: "frisch" });
      } else {
        unmatched.push(line);
      }
      return;
    }

    const dayMatch = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (dayMatch) {
      let labelTeil = dayMatch[1].trim();
      let kategorie = "abendessen";
      const katMatch = labelTeil.match(/^(.*?)\s*\((frühstück|fruehstueck|mittag|abend|abendessen|snack)\)\s*$/i);
      if (katMatch) {
        labelTeil = katMatch[1].trim();
        const k = katMatch[2].toLowerCase();
        kategorie = k.startsWith("fr") ? "fruehstueck" : k === "mittag" ? "mittag" : k === "snack" ? "snack" : "abendessen";
      }

      let name = dayMatch[2].trim();
      let sporttag = false;
      const sportMatch = name.match(/^(.*?)\s*\((?:sporttag|sport)\)\s*$/i);
      if (sportMatch) { name = sportMatch[1].trim(); sporttag = true; }

      const r = findRecipeByName(name);
      if (r) {
        const datum = labelZuIso(labelTeil);
        if (!datum) ohneDatum++;
        days.push({ datum, label: datum ? tagLabel(datum) : labelTeil, kategorie, recipeId: r.id, sporttag });
      } else {
        unmatched.push(line);
      }
      return;
    }

    unmatched.push(line);
  });

  return { days, prep, unmatched, ohneDatum };
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
  label.style.margin = "26px 0 8px";
  label.textContent = "Kopiertext für den Chat";
  wrap.appendChild(label);

  const offen = plan.days.filter(d => !RECIPES.find(r => r.id === d.recipeId)).length;
  if (offen) {
    const hint = document.createElement("p");
    hint.className = "small-note";
    hint.style.marginTop = "0";
    hint.textContent = `${offen} Mahlzeit(en) ohne gültiges Rezept, sie stehen nicht im Kopiertext.`;
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

  const teilen = document.createElement("button");
  teilen.type = "button";
  teilen.className = "btn secondary full";
  teilen.style.marginTop = "8px";
  teilen.textContent = "Woche teilen";
  teilen.addEventListener("click", () => {
    const text = wochenText();
    if (navigator.share) {
      navigator.share({ title: "Essensplan", text }).catch(() => {});
    } else {
      copyToClipboard(text, teilen, "Woche teilen");
    }
  });
  wrap.appendChild(teilen);

  const zutaten = rohliste();
  if (zutaten.length) {
    const det = document.createElement("details");
    det.className = "klapp";
    det.style.marginTop = "14px";
    det.innerHTML = `
      <summary>Zutaten der ganzen Woche, ${zutaten.length} Posten</summary>
      <div class="klapp-inhalt">
        <p class="small-note" style="margin-top:0">
          Rohe Summe aus allen geplanten Gerichten und Prep-Portionen, alphabetisch.
          Vorrat und Vorratsfach sind darin nicht berücksichtigt, die eigentliche Einkaufsliste kommt weiter aus dem Chat.
        </p>
        <div class="copy-panel"><textarea readonly id="rohliste">${escapeHtml(zutaten.join("\n"))}</textarea></div>
      </div>
    `;
    const kopf = document.createElement("button");
    kopf.type = "button";
    kopf.className = "btn secondary full";
    kopf.style.marginTop = "8px";
    kopf.textContent = "Zutatenliste kopieren";
    kopf.addEventListener("click", () => copyToClipboard(zutaten.join("\n"), kopf, "Zutatenliste kopieren"));
    det.querySelector(".klapp-inhalt").appendChild(kopf);
    wrap.appendChild(det);
  }

  return wrap;
}

// Kurzfassung für die Partnerin, ohne die Chat-Formalitäten.
function wochenText() {
  const zeilen = [];
  sortierteTage().forEach(({ d }) => {
    const r = rezeptMitId(d.recipeId);
    if (!r) return;
    zeilen.push(`${tagAnzeige(d)}, ${katLabel(d.kategorie)}: ${r.name}`);
  });
  const prep = plan.prep.filter(p => p.portionen > 0).map(p => {
    const r = rezeptMitId(p.id);
    return r ? `${r.name} (${p.portionen} Portionen)` : null;
  }).filter(Boolean);
  if (prep.length) {
    zeilen.push("");
    zeilen.push("Vorgekocht: " + prep.join(", "));
  }
  return zeilen.join("\n");
}

function aktualisiereKopiertext() {
  const out = document.getElementById("kopiertext");
  if (out) out.value = buildKopiertext();
}

function buildKopiertext() {
  const lines = [];
  sortierteTage().forEach(({ d }) => {
    const r = RECIPES.find(x => x.id === d.recipeId);
    if (!r) return;
    const kat = d.kategorie && d.kategorie !== "abendessen" ? ` (${katLabel(d.kategorie)})` : "";
    lines.push(`${tagAnzeige(d)}${kat}: ${r.name}${d.sporttag ? " (Sporttag)" : ""}`);
  });
  const prepLines = prepEintraege().map(p => {
    const r = RECIPES.find(x => x.id === p.id);
    return r ? `Meal Prep: ${r.name} x${p.portionen}` : null;
  }).filter(Boolean);
  if (prepLines.length) {
    lines.push("");
    lines.push(...prepLines);
  }
  return lines.join("\n");
}

// ---------- WÄCHTER ----------

// Die Prüfungen arbeiten mit dem, was in rezepte.json steht. Eine Salzangabe
// gibt es dort nicht, deshalb läuft der Salzblick über die Tags, nicht über Zahlen.
function wochenHinweise() {
  const hinweise = [];
  const gerichte = plan.days
    .map(d => ({ d, r: rezeptMitId(d.recipeId) }))
    .filter(x => x.r);

  const ausnahmen = gerichte.filter(x => x.r.ausnahme);
  if (ausnahmen.length > 1) {
    hinweise.push(`${ausnahmen.length} Ausnahmegerichte in dieser Planung: ${ausnahmen.map(x => x.r.name).join(", ")}. Vorgesehen ist eines pro Woche.`);
  }

  const salzig = gerichte.filter(x => (x.r.tags || []).some(t => String(t).toLowerCase().includes("salzig")));
  if (salzig.length > 1) {
    hinweise.push(`${salzig.length} salzig-herzhafte Gerichte: ${salzig.map(x => x.r.name).join(", ")}. In rezepte.json steht kein Salzwert, das ist nur der Tag-Blick.`);
  }

  const zaehler = {};
  gerichte.forEach(x => { zaehler[x.r.id] = (zaehler[x.r.id] || 0) + 1; });
  const doppelt = Object.keys(zaehler).filter(id => zaehler[id] > 1).map(id => rezeptMitId(id).name);
  if (doppelt.length) hinweise.push(`Doppelt eingeplant: ${doppelt.join(", ")}.`);

  const heute = new Date();
  const kuerzlich = gerichte.filter(x => {
    if (!istIso(x.r.gekocht_am)) return false;
    const tage = (heute - dateVon(x.r.gekocht_am)) / 86400000;
    return tage >= 0 && tage <= 7;
  });
  if (kuerzlich.length) {
    hinweise.push(`Erst vor Kurzem gekocht: ${kuerzlich.map(x => `${x.r.name} (${x.r.gekocht_am})`).join(", ")}.`);
  }

  return hinweise;
}

// ---------- RESTE ----------

function offeneReste() {
  const reste = [];
  plan.days.forEach(d => {
    const r = rezeptMitId(d.recipeId);
    if (r && r.rest) reste.push({ tag: tagAnzeige(d), rest: String(r.rest), quelle: r.name });
  });
  return reste;
}

// ---------- ZUTATEN-ROHLISTE ----------

function rohliste() {
  const summe = new Map();
  const ohneMenge = new Set();

  const addiere = (r, factor) => {
    (r.zutaten || []).forEach(z => {
      if (!z || !z.name) return;
      const key = `${z.name}||${z.einheit || ""}`;
      if (z.menge == null || isNaN(Number(z.menge))) {
        ohneMenge.add(z.name + (z.einheit ? ` (${z.einheit})` : ""));
        return;
      }
      summe.set(key, (summe.get(key) || 0) + Number(z.menge) * factor);
    });
  };

  plan.days.forEach(d => {
    const r = rezeptMitId(d.recipeId);
    if (r) addiere(r, 1);
  });
  plan.prep.filter(p => p.portionen > 0).forEach(p => {
    const r = rezeptMitId(p.id);
    if (r) addiere(r, p.portionen / (r.basis || 2));
  });

  const zeilen = [...summe.entries()]
    .map(([key, menge]) => {
      const [name, einheit] = key.split("||");
      return { name, einheit, menge: round1(menge) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map(z => `${z.menge}${z.einheit ? " " + z.einheit : ""} ${z.name}`);

  [...ohneMenge].sort((a, b) => a.localeCompare(b, "de")).forEach(n => zeilen.push(`nach Bedarf ${n}`));
  return zeilen;
}

// ---------- DATEN-REITER ----------

function renderDaten() {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const geaendert = geaenderteRezepte();

  const kopf = document.createElement("div");
  kopf.className = "day-card";
  kopf.style.marginBottom = "18px";
  kopf.innerHTML = `
    <span class="label">Datenstand</span>
    <div class="daten-zahlen">
      <div><strong>${ROH_RECIPES.length}</strong><span>Rezepte in ${escapeHtml(DATA_FILE)}</span></div>
      <div><strong>${geaendert.length}</strong><span>davon lokal angepasst</span></div>
    </div>
    <p class="small-note" style="margin-bottom:0">
      Änderungen aus der App liegen getrennt auf diesem Gerät und legen sich beim Laden über die Datei.
      Wird ${escapeHtml(DATA_FILE)} im Repo ausgetauscht, bleiben sie bestehen und greifen weiter, solange die Rezept-ID gleich bleibt.
    </p>
  `;
  wrap.appendChild(kopf);

  // Liste der Änderungen
  const label1 = document.createElement("span");
  label1.className = "label";
  label1.style.display = "block";
  label1.style.margin = "24px 0 8px";
  label1.textContent = "Meine Änderungen";
  wrap.appendChild(label1);

  if (!geaendert.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch nichts angepasst. Im Katalog ein Rezept öffnen und oben rechts auf Anpassen tippen.";
    wrap.appendChild(leer);
  }

  geaendert.forEach(r => {
    const p = patches[r.id] || {};
    const felder = [];
    if (p.zutaten) felder.push("Zutaten");
    if (p.schritte) felder.push("Schritte");
    if (p.basis) felder.push("Basis");
    if (p.notiz_eigen) felder.push("eigene Notiz");
    if (p.gekocht_am) felder.push("gekocht am");
    if (p.urteil) felder.push("Urteil");

    const karte = document.createElement("div");
    karte.className = "day-card";
    karte.style.marginBottom = "10px";
    karte.innerHTML = `
      <div class="prep-kopf">
        <span class="prep-name">${escapeHtml(r.name)}</span>
      </div>
      <span class="prep-info">${escapeHtml(felder.join(" · ") || "keine Felder")}</span>
      <div class="day-actions">
        <button class="btn secondary" type="button" data-act="open">Öffnen</button>
        <button class="btn secondary" type="button" data-act="reset">Zurücksetzen</button>
      </div>
    `;
    karte.querySelector('[data-act="open"]').addEventListener("click", () => openDetail(r.id));
    karte.querySelector('[data-act="reset"]').addEventListener("click", () => {
      if (!confirm(`Änderungen an "${r.name}" verwerfen?`)) return;
      patchLoeschen(r.id);
      render();
    });
    wrap.appendChild(karte);
  });

  // Rückblick
  const label2 = document.createElement("span");
  label2.className = "label";
  label2.style.display = "block";
  label2.style.margin = "24px 0 8px";
  label2.textContent = "Rückblick";
  wrap.appendChild(label2);

  const gekocht = RECIPES.filter(r => patches[r.id] && patches[r.id].gekocht_am);
  if (!gekocht.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch nichts als gekocht markiert. Das geht in der Planung auf der Tageskarte.";
    wrap.appendChild(leer);
  }

  gekocht.forEach(r => {
    const karte = document.createElement("div");
    karte.className = "day-card";
    karte.style.marginBottom = "10px";
    const urteile = ["kommt wieder", "war ok", "fliegt raus"];
    karte.innerHTML = `
      <div class="prep-kopf">
        <span class="prep-name">${escapeHtml(r.name)}</span>
        <span class="prep-info">${escapeHtml(r.gekocht_am)}</span>
      </div>
      <div class="segmented winzig urteil">
        ${urteile.map(u => `<button type="button" data-urteil="${escapeAttr(u)}"${r.urteil === u ? ' class="aktiv"' : ""}>${escapeHtml(u)}</button>`).join("")}
      </div>
    `;
    karte.querySelectorAll("[data-urteil]").forEach(b => {
      b.addEventListener("click", () => {
        const wert = b.dataset.urteil;
        patchSetzen(r.id, { urteil: r.urteil === wert ? undefined : wert });
        render();
      });
    });
    wrap.appendChild(karte);
  });

  if (gekocht.length) {
    wrap.appendChild(textBlock("Rückblick für den Chat", rueckblickText(),
      "Der Chat trägt gekocht_am und urteil in rezepte.json nach und entscheidet mit dir über stamm oder raus."));
  }

  // Export
  const label3 = document.createElement("span");
  label3.className = "label";
  label3.style.display = "block";
  label3.style.margin = "24px 0 8px";
  label3.textContent = "Export";
  wrap.appendChild(label3);

  const exp = document.createElement("div");
  exp.className = "day-card";
  exp.innerHTML = `
    <p class="small-note" style="margin-top:0">
      Zwei Wege zurück in das Projekt. Der kurze Textblock ist der übliche, die vollständige Datei brauchst du nur,
      wenn du ${escapeHtml(DATA_FILE)} direkt im Repo ersetzen willst.
    </p>
  `;
  const dl = document.createElement("button");
  dl.className = "btn primary full";
  dl.type = "button";
  dl.textContent = `${DATA_FILE} herunterladen`;
  dl.addEventListener("click", () => {
    datenDownload(DATA_FILE, exportJson(), "application/json");
  });
  exp.appendChild(dl);

  const cp = document.createElement("button");
  cp.className = "btn secondary full";
  cp.type = "button";
  cp.style.marginTop = "8px";
  cp.textContent = "Vollständiges JSON kopieren";
  cp.addEventListener("click", () => copyToClipboard(exportJson(), cp, "Vollständiges JSON kopieren"));
  exp.appendChild(cp);

  const hinweis = document.createElement("p");
  hinweis.className = "small-note";
  hinweis.style.marginBottom = "0";
  hinweis.textContent = "Auf dem iPhone landet der Download in Dateien. Ob das in der installierten App genauso zuverlässig läuft wie in Safari, konnte ich nicht prüfen, im Zweifel den Kopierknopf nehmen.";
  exp.appendChild(hinweis);
  wrap.appendChild(exp);

  if (geaendert.length) {
    wrap.appendChild(textBlock("Änderungen für den Chat", aenderungsText(),
      "Reicht dem Chat, um rezepte.json im Projekt nachzuziehen. Danach die neue Datei ins Repo legen und hier zurücksetzen."));
  }

  return wrap;
}

function textBlock(titel, text, notiz) {
  const wrap = document.createElement("div");
  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.margin = "24px 0 8px";
  label.textContent = titel;
  wrap.appendChild(label);

  if (notiz) {
    const n = document.createElement("p");
    n.className = "small-note";
    n.style.marginTop = "0";
    n.textContent = notiz;
    wrap.appendChild(n);
  }

  const panel = document.createElement("div");
  panel.className = "copy-panel";
  const ta = document.createElement("textarea");
  ta.readOnly = true;
  ta.value = text;
  panel.appendChild(ta);
  wrap.appendChild(panel);

  const btn = document.createElement("button");
  btn.className = "btn secondary full";
  btn.type = "button";
  btn.style.marginTop = "8px";
  btn.textContent = "Kopieren";
  btn.addEventListener("click", () => copyToClipboard(ta.value, btn, "Kopieren"));
  wrap.appendChild(btn);
  return wrap;
}

function exportJson() {
  const daten = ROH_RECIPES.map(r => {
    const p = patches[r.id];
    if (!p || !Object.keys(p).length) return r;
    return Object.assign({}, r, p);
  });
  return JSON.stringify(daten, null, 2);
}

function aenderungsText() {
  const zeilen = [`Änderungen aus der App, Stand ${tagLabel(heuteIso())}`];
  geaenderteRezepte().forEach(r => {
    const p = patches[r.id];
    zeilen.push("");
    zeilen.push(`${r.id}: ${r.name}`);
    if (p.basis) zeilen.push(`Basis neu: ${p.basis} Portionen`);
    if (p.zutaten) {
      zeilen.push("Zutaten neu:");
      p.zutaten.forEach(z => zeilen.push(`  ${zutatLine(z, 1)}`));
    }
    if (p.schritte) {
      zeilen.push("Schritte neu:");
      p.schritte.forEach((x, i) => zeilen.push(`  ${i + 1}. ${x}`));
    }
    if (p.notiz_eigen) zeilen.push(`notiz_eigen: ${p.notiz_eigen}`);
    if (p.gekocht_am) zeilen.push(`gekocht_am: ${p.gekocht_am}`);
    if (p.urteil) zeilen.push(`urteil: ${p.urteil}`);
  });
  return zeilen.join("\n");
}

function rueckblickText() {
  const zeilen = ["Rückblick"];
  RECIPES.filter(r => patches[r.id] && patches[r.id].gekocht_am).forEach(r => {
    zeilen.push(`${r.name}: gekocht am ${r.gekocht_am}${r.urteil ? `, ${r.urteil}` : ", noch kein Urteil"}`);
  });
  return zeilen.join("\n");
}

// Download ohne Server, über einen erzeugten Link im Speicher.
function datenDownload(name, text, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert("Der Download hat nicht funktioniert. Nimm den Kopierknopf darunter.");
  }
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
