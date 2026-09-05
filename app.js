// Futterassi, lokale Rezept- und Wochenplan-App.
// Datenquelle: rezepte.json, wird im Chat gepflegt und hier nur gelesen.
// Dateinamen stehen nur hier oben und im Service Worker, sonst nirgends.

const DATA_FILE = "rezepte.json";
const SW_FILE = "service-worker.js";

const FILTER_TAGS = ["vegetarisch", "vegan", "High Protein", "Low Carb", "LEBER", "BLUTDRUCK", "SÄTTIGUNG", "SPORT"];
const TYP_LABEL = { abendessen: "Abendessen", mittag: "Mittag", fruehstueck: "Frühstück", snack: "Snack", basis: "Basis" };
const TYP_RANG = { abendessen: 0, mittag: 1, snack: 2, fruehstueck: 3, basis: 4 };
const PREP_ZIEL = 10;
const STANDARD_PORTIONEN = 2;   // zwei Erwachsene, das Kind kommt über 2,5 dazu
const SCHNELL_GRENZE = 20;   // Minuten von Anfang bis Teller, für den Notfall-Filter

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
const LS_TIMER = "futterassi_timer_v1";
const LS_ARCHIV = "futterassi_archiv_v1";

// Name des Kurzbefehls auf dem iPhone, an den der Timer übergeben wird.
const SHORTCUT_NAME = "Küchentimer";

// Felder, die in der App geändert werden dürfen. Alles andere bleibt so, wie es
// aus rezepte.json kommt. notiz_eigen ist das einzige neue Feld.
const PATCH_FELDER = ["zutaten", "schritte", "basis", "notiz_eigen", "gekocht_am", "urteil", "favorit", "portionen_real", "kind_isst", "_stempel"];

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
let geteilterPlan = null;
let archiv = loadArchiv();
let abschluss = null;   // { gerichte: [...], notiz }
let dateiStand = "";
let DATEI_WRAPPER = false;
let driftHinweis = [];
let speicherDefekt = false;

// ---------- Zustand laden und speichern ----------

function loadUi() {
  const d = { view: "katalog", search: "", tags: [], typen: [], showRaus: false, schnell: false, planAnsicht: "planen", textgroesse: "normal" };
  try {
    const raw = JSON.parse(localStorage.getItem(LS_UI));
    if (!raw || typeof raw !== "object") return d;
    return {
      view: ["planung", "daten"].includes(raw.view) ? raw.view : "katalog",
      search: typeof raw.search === "string" ? raw.search : "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => FILTER_TAGS.includes(t)) : [],
      typen: Array.isArray(raw.typen) ? raw.typen.filter(t => typeof t === "string") : [],
      showRaus: raw.showRaus === true,
      schnell: raw.schnell === true,
      textgroesse: ["normal", "gross", "riesig"].includes(raw.textgroesse) ? raw.textgroesse : "normal",
      planAnsicht: raw.planAnsicht === "woche" ? "woche" : "planen"
    };
  } catch (e) {
    return d;
  }
}

function loadPlan() {
  const leer = { tage: [] };
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(LS_PLAN));
  } catch (e) {
    return leer;
  }
  if (!raw || typeof raw !== "object") return leer;

  const slotAus = (x) => {
    if (!x || typeof x !== "object") return null;
    const art = ["reste", "brotzeit"].includes(x.art) ? x.art : "rezept";
    const recipeId = typeof x.recipeId === "string" ? x.recipeId : "";
    if (art === "rezept" && !recipeId) return null;
    return {
      art,
      recipeId,
      portionen: portionenNormal(x.portionen),
      notiz: typeof x.notiz === "string" ? x.notiz : ""
    };
  };

  // Neue Form: nach Tagen gruppiert, jede Mahlzeit ein Feld.
  if (Array.isArray(raw.tage)) {
    const tage = [];
    raw.tage.forEach(t => {
      if (!t || !istIso(t.datum)) return;
      const mahlzeiten = {};
      KATEGORIE_KEYS.forEach(k => {
        const slot = slotAus((t.mahlzeiten || {})[k]);
        if (slot) mahlzeiten[k] = slot;
      });
      tage.push({ datum: t.datum, sporttag: t.sporttag === true, mahlzeiten });
    });
    tage.sort((a, b) => (a.datum < b.datum ? -1 : 1));
    return { tage };
  }

  // Alte Form: flache Liste, eine Karte pro Mahlzeit. Wird einmalig umgebaut.
  const alt = Array.isArray(raw.days) ? raw.days : [];
  const tage = [];
  alt.forEach(x => {
    if (!x || typeof x !== "object") return;
    const datum = istIso(x.datum) ? x.datum : labelZuIso(x.label || "");
    if (!datum) return;
    const kat = KATEGORIE_KEYS.includes(x.kategorie) ? x.kategorie : "abendessen";
    let tag = tage.find(t => t.datum === datum);
    if (!tag) { tag = { datum, sporttag: false, mahlzeiten: {} }; tage.push(tag); }
    if (x.sporttag === true) tag.sporttag = true;
    if (tag.mahlzeiten[kat]) return;   // doppelte Mahlzeit, die erste gewinnt
    const slot = slotAus(x);
    if (slot) tag.mahlzeiten[kat] = slot;
  });
  tage.sort((a, b) => (a.datum < b.datum ? -1 : 1));
  return { tage };
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

function loadArchiv() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(LS_ARCHIV));
  } catch (e) {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(w => w && typeof w === "object" && Array.isArray(w.gerichte));
}

function saveArchiv() {
  speichern(LS_ARCHIV, archiv);
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
  const roh = ROH_RECIPES.find(r => r.id === id);
  const echteFelder = Object.keys(neu).filter(f => f !== "_stempel");
  if (echteFelder.length) {
    if (roh) neu._stempel = feldStempel(roh, echteFelder);
    patches[id] = neu;
  } else {
    delete patches[id];
  }
  savePatches();
  RECIPES = mergeRecipes();
}

function patchLoeschen(id) {
  delete patches[id];
  savePatches();
  RECIPES = mergeRecipes();
}

// Fingerabdruck der Originalfelder, die eine Anpassung überschreibt. Ändert
// der Chat später genau dieses Feld, fällt es beim nächsten Laden auf.
function feldStempel(rezept, felder) {
  const teile = felder.filter(f => f !== "urteil" && f !== "gekocht_am").map(f => `${f}:${JSON.stringify(rezept[f])}`);
  let hash = 0;
  const text = teile.join("|");
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function pruefePatchDrift() {
  driftHinweis = [];
  Object.keys(patches).forEach(id => {
    const roh = ROH_RECIPES.find(r => r.id === id);
    const p = patches[id];
    if (!roh || !p) return;
    const felder = Object.keys(p).filter(f => f !== "_stempel");
    const jetzt = feldStempel(roh, felder);
    if (p._stempel && p._stempel !== jetzt) driftHinweis.push(roh.name);
  });
}

function geaenderteRezepte() {
  return RECIPES.filter(r => patches[r.id]);
}

function speichern(key, wert) {
  try {
    if (wert === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(wert));
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

  // Zusammenkneifen zum Zoomen abfangen. Mit nassen Fingern verrutscht die
  // Ansicht sonst und lässt sich beim Kochen kaum zurückstellen.
  ["gesturestart", "gesturechange", "gestureend"].forEach(typ => {
    document.addEventListener(typ, (e) => e.preventDefault(), { passive: false });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (cook) closeCook();
    else if (ausbeute) ausbeuteSchliessen();
    else if (abschluss) abschlussSchliessen();
    else if (planSheet) planSheetSchliessen();
    else if (editor) editorAbbrechen();
    else if (detail) closeDetail();
  });

  // Der Service Worker wird unabhängig von den Daten registriert. Sonst gäbe es
  // nach einem einzigen fehlgeschlagenen Ladeversuch nie wieder Offline-Betrieb.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(SW_FILE).catch(() => {});
  }

  geteiltenPlanLesen();

  // Ein aus der alten Form umgebauter Plan wird einmal in der neuen Form
  // festgeschrieben, damit nicht bei jedem Start neu umgebaut wird.
  if (plan.tage.length) savePlan();

  // Ein laufender Timer überlebt das Schließen der App.
  timerLaden();
  zeichneTimer();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") timerPruefen();
  });
  window.addEventListener("pageshow", timerPruefen);
  window.addEventListener("focus", timerPruefen);

  const ok = await ladeDaten();
  if (ok) render();
}

async function ladeDaten() {
  try {
    const res = await fetch(DATA_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error("Server antwortet mit " + res.status);
    const roh = await res.json();

    // Zwei Formen sind erlaubt: die blanke Liste wie bisher, oder ein Objekt
    // mit den Feldern stand und rezepte. Damit lässt sich der Dateistand
    // mitliefern, ohne dass alte Dateien brechen.
    const daten = Array.isArray(roh) ? roh : (roh && Array.isArray(roh.rezepte) ? roh.rezepte : null);
    if (!daten) throw new Error("Datei enthält keine Rezeptliste");

    DATEI_WRAPPER = !Array.isArray(roh);
    const kopfDatum = (res.headers && typeof res.headers.get === "function") ? res.headers.get("Last-Modified") : null;
    dateiStand = (!Array.isArray(roh) && roh.stand) ? String(roh.stand) : (kopfDatum || "");
    ROH_RECIPES = daten.filter(r => r && r.id && r.name);
    RECIPES = mergeRecipes();
    pruefePlanBezuege();
    pruefePatchDrift();
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
  plan.tage.forEach(tag => {
    KATEGORIE_KEYS.forEach(k => {
      const slot = tag.mahlzeiten[k];
      if (slot && slot.art === "rezept" && slot.recipeId && !ids.has(slot.recipeId)) fehlend.add(slot.recipeId);
    });
  });
  planHinweis = fehlend.size
    ? `${fehlend.size} Eintrag/Einträge im Plan zeigen auf Rezepte, die es in ${DATA_FILE} nicht mehr gibt: ${[...fehlend].join(", ")}. Sie fehlen im Kopiertext.`
    : "";
}

function textgroesseAnwenden() {
  document.body.classList.toggle("text-gross", ui.textgroesse === "gross");
  document.body.classList.toggle("text-riesig", ui.textgroesse === "riesig");
}

function render() {
  textgroesseAnwenden();
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
  if (geteilterPlan) app.appendChild(renderGeteilt());
  else if (ui.view === "planung") app.appendChild(renderPlanung());
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
    chipbar.appendChild(chip(`unter ${SCHNELL_GRENZE} Min gesamt`, ui.schnell, () => {
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
      const min = gesamtMinuten(r);
      if (min == null || min > SCHNELL_GRENZE) return false;
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

// Zeiten. Wenn rezepte.json die Felder zeit_aktiv und zeit_gesamt mitbringt,
// gelten die. Sonst wird das Freitextfeld zeit gelesen:
// "15 Min. aktiv, 25 Min. Ofenzeit" ergibt 15 aktiv und 40 gesamt.
function minutenListe(text) {
  const treffer = [];
  const re = /(\d{1,3})\s*(?:bis|-|–)?\s*(\d{1,3})?\s*(min|std|stunde)/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const zahl = Number(m[2] || m[1]);
    treffer.push({ minuten: /^std|^stunde/i.test(m[3]) ? zahl * 60 : zahl, stelle: m.index, text: m[0] });
  }
  return treffer;
}

function aktivMinuten(r) {
  if (Number(r.zeit_aktiv) > 0) return Number(r.zeit_aktiv);
  const text = String(r.zeit || "");
  const treffer = minutenListe(text);
  if (!treffer.length) return null;
  const aktiv = treffer.find(t => /aktiv/i.test(text.slice(t.stelle, t.stelle + t.text.length + 8)));
  return aktiv ? aktiv.minuten : treffer[0].minuten;
}

function gesamtMinuten(r) {
  if (Number(r.zeit_gesamt) > 0) return Number(r.zeit_gesamt);
  const treffer = minutenListe(r.zeit);
  if (!treffer.length) return null;
  return treffer.reduce((a, t) => a + t.minuten, 0);
}

function zeitText(r) {
  if (Number(r.zeit_aktiv) > 0 || Number(r.zeit_gesamt) > 0) {
    const teile = [];
    if (Number(r.zeit_aktiv) > 0) teile.push(`${r.zeit_aktiv} Min aktiv`);
    if (Number(r.zeit_gesamt) > 0) teile.push(`${r.zeit_gesamt} Min gesamt`);
    return teile.join(", ");
  }
  return r.zeit || "";
}

// Salz pro Portion. Steht nur zur Verfügung, wenn rezepte.json das Feld salz_g
// mitbringt. Ohne Feld bleibt jede Aussage dazu eine Schätzung, deshalb null.
function salzWert(r) {
  const n = Number(r && r.salz_g);
  return isFinite(n) && n >= 0 && r.salz_g !== null && r.salz_g !== undefined && r.salz_g !== "" ? n : null;
}

function salzText(n) {
  return `${String(round1(n)).replace(".", ",")} g`;
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
  // Kein button-Element mehr, weil in der Fußzeile ein eigener Knopf sitzt und
  // ein Knopf im Knopf ungültiges Markup wäre.
  const card = document.createElement("div");
  card.className = "card card-button";
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  const cat = mapCategory(r);
  if (cat) card.setAttribute("data-category", cat);

  const badges = [`<span class="badge status ${statusClass(r.status)}">${escapeHtml(statusText(r.status))}</span>`];
  if (r.typ) badges.push(`<span class="badge typ" data-typ="${escapeAttr(r.typ)}">${escapeHtml(typLabel(r.typ))}</span>`);
  if (r._geaendert) badges.push(`<span class="badge geaendert">GEÄNDERT</span>`);
  if (r.ausnahme) badges.push(`<span class="badge exception">AUSNAHME</span>`);
  if ((r.tags || []).includes("SPORT")) badges.push(`<span class="badge sport">SPORT</span>`);
  if (r.rest) badges.push(`<span class="badge rest">REST</span>`);
  if (r.urteil === "kommt wieder") badges.push(`<span class="badge gut">KOMMT WIEDER</span>`);
  if (r.prep && r.prep.geeignet) badges.push(`<span class="badge">PREP</span>`);

  const metrics = [];
  if (r.kcal) metrics.push(`<span class="metric"><strong>${escapeHtml(r.kcal)}</strong>&nbsp;kcal</span>`);
  if (r.protein) metrics.push(`<span class="metric"><strong>${escapeHtml(r.protein)}</strong>&nbsp;g Eiweiß</span>`);
  if (r.fett) metrics.push(`<span class="metric"><strong>${escapeHtml(r.fett)}</strong>&nbsp;g Fett</span>`);
  if (salzWert(r) != null) metrics.push(`<span class="metric"><strong>${escapeHtml(salzText(salzWert(r)))}</strong>&nbsp;Salz</span>`);
  if (zeitText(r)) metrics.push(`<span class="metric">${escapeHtml(zeitText(r))}</span>`);

  card.innerHTML = `
    <h3>${escapeHtml(r.name)}</h3>
    <div class="card-meta">${badges.join("")}</div>
    <div class="card-footer">
      <div class="metrics">${metrics.join("")}</div>
      <button class="card-plan" type="button" aria-label="${escapeAttr(r.name)} einplanen">+ Einplanen</button>
    </div>
  `;
  card.addEventListener("click", () => openDetail(r.id));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(r.id); }
  });
  card.querySelector(".card-plan").addEventListener("click", (e) => {
    e.stopPropagation();
    planSheetOeffnen(r.id);
  });
  return card;
}

// ---------- EINPLANEN AUS DEM KATALOG ----------

let planSheet = null;   // { recipeId, datum, kat }

function planSheetOeffnen(recipeId, datum, kat) {
  const r = rezeptMitId(recipeId);
  if (!r) return;
  const vorschlag = KATEGORIE_KEYS.includes(r.typ) ? r.typ : "abendessen";
  planSheet = { recipeId, datum: datum || heuteIso(), kat: kat || vorschlag };
  scrollSperre(true);
  drawPlanSheet();
}

function planSheetSchliessen() {
  planSheet = null;
  const el = document.getElementById("plan-sheet");
  if (el) el.remove();
  if (!detail && !cook) scrollSperre(false);
}

function drawPlanSheet() {
  if (!planSheet) return;
  const r = rezeptMitId(planSheet.recipeId);
  if (!r) return planSheetSchliessen();

  // Scrollstände merken, das Blatt wird beim Umschalten neu aufgebaut.
  const altInhalt = document.querySelector("#plan-sheet .sheet-inhalt");
  const altTage = document.querySelector("#plan-sheet .sheet-tage");
  const standHoch = altInhalt ? altInhalt.scrollTop : 0;
  const standQuer = altTage ? altTage.scrollLeft : 0;

  let el = document.getElementById("plan-sheet");
  if (!el) {
    el = document.createElement("div");
    el.id = "plan-sheet";
    el.className = "sheet";
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target === el) planSheetSchliessen(); });
  }

  const start = new Date();
  const tage = [];
  for (let i = 0; i < 14; i++) tage.push(isoVon(plusTage(start, i)));

  const tag = tagObjekt(planSheet.datum, false);
  const belegt = tag && tag.mahlzeiten[planSheet.kat];
  const belegtName = belegt ? slotGericht(belegt) : "";

  el.innerHTML = `
    <div class="sheet-inhalt">
      <div class="sheet-kopf">
        <div>
          <span class="label">Einplanen</span>
          <div class="sheet-titel">${escapeHtml(r.name)}</div>
        </div>
        <button type="button" class="back" aria-label="Schließen">&times;</button>
      </div>

      <span class="label" style="display:block;margin:16px 0 8px">Tag</span>
      <div class="sheet-tage">
        ${tage.map(iso => {
          const d = dateVon(iso);
          const t = plan.tage.find(x => x.datum === iso);
          const anzahl = t ? KATEGORIE_KEYS.filter(k => slotGefuellt(t.mahlzeiten[k])).length : 0;
          return `<button type="button" class="sheet-tag${iso === planSheet.datum ? " aktiv" : ""}" data-iso="${iso}">
            <span class="sheet-wt">${WOCHENTAG_KURZ[d.getDay()]}</span>
            <span class="sheet-nr">${d.getDate()}</span>
            <span class="sheet-punkte">${Array.from({ length: anzahl }).map(() => "<i></i>").join("")}</span>
          </button>`;
        }).join("")}
      </div>

      <span class="label" style="display:block;margin:16px 0 8px">Mahlzeit</span>
      <div class="segmented">
        ${KATEGORIEN.map(k => `<button type="button" data-kat="${k.key}"${k.key === planSheet.kat ? ' class="aktiv"' : ""}>${escapeHtml(k.label)}</button>`).join("")}
      </div>

      ${belegtName ? `<p class="small-note" style="margin:12px 0 0">${escapeHtml(tagLabel(planSheet.datum))}, ${escapeHtml(katLabel(planSheet.kat))} ist schon belegt mit ${escapeHtml(belegtName)}. Einplanen ersetzt das.</p>` : ""}

      <button class="btn primary full" type="button" id="sheet-ok" style="margin-top:16px">
        Für ${escapeHtml(tagLabel(planSheet.datum))}, ${escapeHtml(katLabel(planSheet.kat))} einplanen
      </button>
    </div>
  `;

  const inhaltNeu = el.querySelector(".sheet-inhalt");
  const tageNeu = el.querySelector(".sheet-tage");
  if (inhaltNeu) inhaltNeu.scrollTop = standHoch;
  if (tageNeu) tageNeu.scrollLeft = standQuer;

  el.querySelector(".back").addEventListener("click", planSheetSchliessen);
  el.querySelectorAll("[data-iso]").forEach(b => {
    b.addEventListener("click", () => { planSheet.datum = b.dataset.iso; drawPlanSheet(); });
  });
  el.querySelectorAll("[data-kat]").forEach(b => {
    b.addEventListener("click", () => { planSheet.kat = b.dataset.kat; drawPlanSheet(); });
  });
  el.querySelector("#sheet-ok").addEventListener("click", () => {
    slotSetzen(planSheet.datum, planSheet.kat, { art: "rezept", recipeId: planSheet.recipeId, portionen: null, notiz: "" });
    const wohin = `${tagLabel(planSheet.datum)}, ${katLabel(planSheet.kat)}`;
    kalenderAnker = isoVon(montagVon(dateVon(planSheet.datum)));
    gewaehltesDatum = planSheet.datum;
    planSheetSchliessen();
    pruefePlanBezuege();
    render();
    meldung(`Eingeplant für ${wohin}`);
  });
}

// Kurze Rückmeldung am unteren Rand, verschwindet von allein.
function meldung(text) {
  const alt = document.getElementById("toast");
  if (alt) alt.remove();
  const el = document.createElement("div");
  el.id = "toast";
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 2600);
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

// Nur importierte Rezepte tragen ein Feld original mit der unangepassten
// Ausgangsversion. Umgeschaltet werden ausschließlich diese sechs Felder,
// alles andere am Rezept gilt weiter für die angepasste Fassung.
const ORIGINAL_FELDER = ["zutaten", "schritte", "kcal", "protein", "fett", "quelle"];

function hatOriginal(r) {
  return !!(r && r.original && typeof r.original === "object");
}

function variantenAnsicht(r, variante) {
  if (!hatOriginal(r) || variante !== "original") return r;
  const sicht = Object.assign({}, r);
  ORIGINAL_FELDER.forEach(f => {
    if (r.original[f] !== undefined) sicht[f] = r.original[f];
  });
  sicht._variante = "original";
  return sicht;
}

// Das ist die Fassung, die gerade auf dem Bildschirm steht. Kochmodus,
// Portionen und Zutaten kopieren hängen daran, der Wochenplan nie.
function detailAnsicht() {
  const r = detailRezept();
  if (!r) return null;
  return variantenAnsicht(r, detail.variante);
}

function openDetail(idOderRezept) {
  const id = typeof idOderRezept === "string" ? idOderRezept : (idOderRezept && idOderRezept.id);
  const r = rezeptMitId(id);
  if (!r) return;
  detail = { id, portionen: ergiebigkeit(r), erledigt: new Set(), variante: "angepasst" };
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
  const basisRezept = detailRezept();
  if (!basisRezept) return;
  const r = detailAnsicht();
  const overlay = document.getElementById("overlay");
  overlay.classList.remove("hidden");

  const metaBadges = [`<span class="badge status ${statusClass(r.status)}">${escapeHtml(statusText(r.status))}</span>`];
  if (r.typ) metaBadges.push(`<span class="badge typ" data-typ="${escapeAttr(r.typ)}">${escapeHtml(typLabel(r.typ))}</span>`);
  if (r._geaendert) metaBadges.push(`<span class="badge geaendert">GEÄNDERT</span>`);
  if (zeitText(r)) metaBadges.push(`<span class="badge">${escapeHtml(zeitText(r))}</span>`);
  if (salzWert(r) != null) metaBadges.push(`<span class="badge">${escapeHtml(salzText(salzWert(r)))} Salz</span>`);
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
  if (typeof r.kind_isst === "boolean") klapp.push(["Kind", r.kind_isst ? "hat gegessen" : "hat nicht gegessen"]);
  if (r.portionen_real) klapp.push(["Tatsächliche Portionen", portionenText(r.portionen_real)]);
  if (r.quelle) klapp.push(["Quelle", String(r.quelle)]);

  overlay.innerHTML = `
    <div class="overlay-head">
      <button class="back" type="button" aria-label="Zurück">&larr;</button>
      <button class="btn primary klein js-cook" type="button">Kochmodus</button>
    </div>
    <h1 class="detail-title">${escapeHtml(r.name)}</h1>
    <div class="recipe-meta">${metaBadges.join("")}</div>
    ${hatOriginal(basisRezept) ? `<div class="segmented klein variante">
      <button type="button" data-variante="angepasst"${detail.variante !== "original" ? ' class="aktiv"' : ""}>Angepasst</button>
      <button type="button" data-variante="original"${detail.variante === "original" ? ' class="aktiv"' : ""}>Original</button>
    </div>
    <p class="small-note" style="margin:8px 0 0">${detail.variante === "original"
      ? "Ausgangsrezept, nur zur Ansicht. Für Wochenplan, Einkaufsliste und Nährwerte zählt weiter die angepasste Fassung."
      : "Angepasste Fassung. Das Ausgangsrezept steht unter Original."}</p>` : ""}
    <div class="detail-chips">
      <button type="button" class="chip" id="btn-plan">Einplanen</button>
      <button type="button" class="chip" id="btn-edit">Anpassen</button>
    </div>
    ${naehrwertZeile(r)}

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
      <span class="small-note" style="margin:0">Rezeptbasis ${escapeHtml(r.basis || 2)}${r.portionen_real ? `, gemessen ${escapeHtml(portionenText(r.portionen_real))}` : ""}</span>
      <div class="portion-control">
        <button type="button" data-d="-1" aria-label="Weniger Portionen">−</button>
        <span class="portion-value">${escapeHtml(portionenText(detail.portionen))}</span>
        <button type="button" data-d="1" aria-label="Mehr Portionen">+</button>
      </div>
    </div>

    <span class="label" style="display:block;margin-bottom:4px">Zutaten</span>
    <p class="small-note" style="margin-top:0">Antippen streicht eine Zutat durch.</p>
    <ul class="ingredients" id="zutaten-list" style="margin-bottom:24px"></ul>

    <span class="label" style="display:block;margin-bottom:8px">Zubereitung</span>
    <ol class="steps" style="margin-bottom:28px">
      ${(r.schritte || []).map(s => `<li><p>${escapeHtml(schrittText(s))}</p></li>`).join("")}
    </ol>

    <div class="detail-actions">
      <button class="btn secondary full" type="button" id="btn-copy">Zutaten kopieren</button>
      <button class="btn primary full js-cook" type="button">Kochmodus</button>
    </div>
  `;

  overlay.querySelector(".back").addEventListener("click", closeDetail);
  overlay.querySelectorAll("[data-variante]").forEach(b => {
    b.addEventListener("click", () => {
      if (detail.variante === b.dataset.variante) return;
      detail.variante = b.dataset.variante;
      detail.portionen = ergiebigkeit(detailAnsicht());
      detail.erledigt = new Set();
      drawDetail();
    });
  });
  overlay.querySelector("#btn-edit").addEventListener("click", () => {
    // Bearbeitet wird immer die angepasste Fassung, nie das Original.
    detail.variante = "angepasst";
    editorOeffnen(r.id);
  });
  overlay.querySelector("#btn-plan").addEventListener("click", () => planSheetOeffnen(r.id));

  overlay.querySelectorAll(".portion-control button").forEach(b => {
    b.addEventListener("click", () => {
      const d = parseInt(b.dataset.d, 10);
      detail.portionen = Math.min(20, Math.max(0.5, detail.portionen + d * 0.5));
      overlay.querySelector(".portion-value").textContent = portionenText(detail.portionen);
      drawZutaten();
    });
  });

  overlay.querySelector("#btn-copy").addEventListener("click", (e) => {
    const factor = detail.portionen / ergiebigkeit(r);
    const lines = (r.zutaten || []).map(z => zutatLine(z, factor));
    copyToClipboard(lines.join("\n"), e.currentTarget, "Zutaten kopieren");
  });

  // Oben in der Kopfzeile und unten unter dem Rezept, beide starten dasselbe.
  overlay.querySelectorAll(".js-cook").forEach(b => {
    b.addEventListener("click", () => openCookMode(r, detail.portionen));
  });

  drawZutaten();
}

function naehrwertZeile(r) {
  const werte = [];
  if (r.kcal) werte.push(`<span class="metric"><strong>${escapeHtml(r.kcal)}</strong>&nbsp;kcal</span>`);
  if (r.protein) werte.push(`<span class="metric"><strong>${escapeHtml(r.protein)}</strong>&nbsp;g Eiweiß</span>`);
  if (r.fett) werte.push(`<span class="metric"><strong>${escapeHtml(r.fett)}</strong>&nbsp;g Fett</span>`);
  if (salzWert(r) != null) werte.push(`<span class="metric"><strong>${escapeHtml(salzText(salzWert(r)))}</strong>&nbsp;Salz</span>`);
  if (!werte.length) return "";
  return `<div class="metrics" style="margin-bottom:16px">${werte.join("")}</div>`;
}

function drawZutaten() {
  const r = detailAnsicht();
  if (!r) return;
  const factor = detail.portionen / ergiebigkeit(r);
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
    menge = `${String(round1(Number(z.menge) * factor)).replace(".", ",")}${z.einheit ? " " + z.einheit : ""}`;
  } else {
    menge = z.einheit || "";
  }
  if (onlyMenge) return menge;
  return `${menge ? menge + " " : ""}${z.name || ""}`.trim();
}

// Wie viele Portionen kommen bei den Mengen aus der Datei wirklich heraus.
// Sobald portionen_real gemessen ist, gilt der Wert, sonst die Rezeptbasis.
function ergiebigkeit(r) {
  const real = Number(r && r.portionen_real);
  if (isFinite(real) && real > 0) return real;
  return (r && r.basis) || 2;
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
    schritte: (r.schritte || []).slice(),   // Originalform, für den Erhalt der Verweise
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
    <textarea id="edit-schritte" class="edit-flaeche" aria-label="Zubereitungsschritte">${escapeHtml(editor.schritte.map(schrittText).join("\n"))}</textarea>

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
    // Unveränderte Zeilen behalten ihre Zutatenverweise, geänderte werden
    // wieder zu reinem Text.
    const alteSchritte = editor.schritte;
    editor.schritte = overlay.querySelector("#edit-schritte").value
      .split(/\n/).map(x => x.trim()).filter(Boolean)
      .map((zeile, i) => {
        const alt = alteSchritte[i];
        if (alt && typeof alt === "object" && schrittText(alt) === zeile) return alt;
        const passend = alteSchritte.find(a => schrittText(a) === zeile);
        return passend && typeof passend === "object" ? passend : zeile;
      });
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

// ---------- SCHRITTE ----------

// Ein Schritt ist entweder ein Text wie bisher oder ein Objekt
// { text, zutaten: [...] }. In der Liste zutaten stehen entweder die Positionen
// der Zutat (0 für die erste) oder ihr Feld ref, sonst ihr Name.
function schrittText(s) {
  if (typeof s === "string") return s;
  return s && typeof s === "object" ? String(s.text || "") : "";
}

function schrittRefs(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.zutaten)) return null;
  return s.zutaten;
}

function zutatZuRef(r, ref) {
  const liste = r.zutaten || [];
  if (typeof ref === "number") return liste[ref] || null;
  const gesucht = normName(ref);
  if (!gesucht) return null;
  return liste.find(z => z && (normName(z.ref) === gesucht || normName(z.name) === gesucht)) || null;
}

// ---------- KOCHMODUS ----------

function openCookMode(r, portionen) {
  const el = document.createElement("div");
  el.className = "cook fullscreen";
  document.body.appendChild(el);
  cook = { el, recipe: r, i: 0, portionen: portionen || ergiebigkeit(r), zutatenOffen: false, touchX: null };
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
  if (!timer) wakeLockAus();
  zeichneTimer();
  if (!detail) scrollSperre(false);
}

function drawCook() {
  if (!cook) return;
  const r = cook.recipe;
  const steps = r.schritte || [];
  const gesamt = steps.length;
  const anzeigeNr = gesamt ? cook.i + 1 : 0;
  const breite = gesamt ? Math.round(((cook.i + 1) / gesamt) * 100) : 0;
  const factor = cook.portionen / ergiebigkeit(r);

  cook.el.innerHTML = `
    <div>
      <div class="cook-progress">
        <button class="cook-close" type="button" aria-label="Kochmodus schließen">&times;</button>
        <span>${anzeigeNr} / ${gesamt}</span>
        <button class="cook-zutaten-btn" type="button">${cook.zutatenOffen ? "Schritt" : "Zutaten"}</button>
      </div>
      <div class="cook-progress-bar"><span style="width:${breite}%"></span></div>
      <div class="cook-title">${escapeHtml(r.name)} · ${escapeHtml(portionenText(cook.portionen))} Portionen${r._variante === "original" ? " · Original" : ""}</div>
      ${timerZeile(gesamt ? schrittText(steps[cook.i]) : "")}
    </div>
    ${cook.zutatenOffen
      ? `<div class="cook-zutaten"><ul>${(r.zutaten || []).map(z =>
          `<li><span>${escapeHtml(z && z.name)}</span><span>${escapeHtml(zutatLine(z, factor, true))}</span></li>`).join("")}</ul></div>`
      : `<div class="cook-step" id="cook-step">
           <div>
             <p>${escapeHtml(gesamt ? schrittText(steps[cook.i]) : "Für dieses Rezept sind keine Schritte hinterlegt.")}</p>
             ${gesamt ? (() => {
               const treffer = schrittZutaten(r, steps[cook.i]);
               return treffer.length
                 ? `<div class="cook-mengen">${treffer.map(z => `<span>${escapeHtml(zutatLine(z, factor))}</span>`).join("")}</div>`
                 : "";
             })() : ""}
           </div>
         </div>`}
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
      else if (wert === "uhr") {
        const zeiten = findeZeiten(schrittText((cook.recipe.schritte || [])[cook.i]));
        anUhrUebergeben(zeiten[0] || 10);
        return;
      } else timerStart(parseInt(wert, 10));
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

// Der Timer rechnet mit einem Endzeitpunkt, nicht mit einem herunterzählenden
// Zähler. Legt iOS die Seite bei ausgeschaltetem Display schlafen, steht danach
// trotzdem die richtige Zeit da. Ein Wecker bei dunklem Bildschirm ist damit
// nicht möglich, dafür fehlt dem Browser die Berechtigung, im Hintergrund zu laufen.
let timer = null;      // { ende: ms, gesamt: sek, alarm: bool }
let timerTickId = null;

function mmss(sek) {
  const negativ = sek < 0;
  const abs = Math.abs(sek);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${negativ ? "+" : ""}${m}:${pad2(s)}`;
}

function timerRest() {
  if (!timer) return 0;
  return Math.round((timer.ende - Date.now()) / 1000);
}

function timerLaden() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(LS_TIMER));
  } catch (e) {
    return;
  }
  if (!raw || !raw.ende) return;
  // Älter als eine Stunde über der Zeit: nicht mehr interessant.
  if (Date.now() - raw.ende > 3600000) {
    speichern(LS_TIMER, null);
    return;
  }
  timer = { ende: raw.ende, gesamt: raw.gesamt || 0, alarm: raw.ende <= Date.now() };
  timerLauf();
}

function timerStart(minuten) {
  if (!minuten || minuten <= 0) return;
  timer = { ende: Date.now() + minuten * 60000, gesamt: minuten * 60, alarm: false };
  speichern(LS_TIMER, timer);
  tonFreischalten();
  wakeLockAn();
  timerLauf();
  zeichneTimer();
}

function timerStopp() {
  timer = null;
  if (timerTickId) { clearInterval(timerTickId); timerTickId = null; }
  speichern(LS_TIMER, null);
  if (!cook) wakeLockAus();
  zeichneTimer();
}

function timerLauf() {
  if (timerTickId) clearInterval(timerTickId);
  timerTickId = setInterval(timerPruefen, 500);
}

function timerPruefen() {
  if (!timer) return;
  if (!timer.alarm && timerRest() <= 0) {
    timer.alarm = true;
    speichern(LS_TIMER, timer);
    piep();
    if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400, 200, 600]); } catch (e) { /* egal */ } }
  }
  zeichneTimer();
}

// Läuft ein Timer, zeigt eine Leiste am unteren Rand die Zeit, auch außerhalb
// des Kochmodus. Im Kochmodus steht die große Anzeige oben, dann bleibt sie weg.
function zeichneTimer() {
  const rest = timerRest();

  if (cook) {
    const gross = document.querySelector(".cook-timer-rest");
    if (gross) {
      gross.textContent = timer ? mmss(rest) : "";
      const box = gross.closest(".cook-timer");
      if (box) box.classList.toggle("fertig", !!(timer && timer.alarm));
      const knopf = box && box.querySelector('[data-timer="stop"]');
      if (knopf) knopf.textContent = timer && timer.alarm ? "Ok" : "Stopp";
    } else if (timer) {
      drawCook();
    }
  }

  let leiste = document.getElementById("timer-bar");
  if (!timer || cook) {
    if (leiste) leiste.remove();
    document.body.classList.remove("timer-an");
    return;
  }
  document.body.classList.add("timer-an");
  if (!leiste) {
    leiste = document.createElement("div");
    leiste.id = "timer-bar";
    leiste.className = "timer-bar";
    leiste.innerHTML = `
      <span class="timer-bar-rest"></span>
      <button type="button" class="timer-bar-stop">Stopp</button>
    `;
    leiste.querySelector(".timer-bar-stop").addEventListener("click", timerStopp);
    document.body.appendChild(leiste);
  }
  leiste.classList.toggle("fertig", !!timer.alarm);
  leiste.querySelector(".timer-bar-rest").textContent = timer.alarm ? `Zeit um ${mmss(rest)}` : mmss(rest);
  leiste.querySelector(".timer-bar-stop").textContent = timer.alarm ? "Ok" : "Stopp";
}

function timerZeile(schrittText) {
  if (timer) {
    const rest = timerRest();
    return `<div class="cook-timer${timer.alarm ? " fertig" : ""}">
      <span class="cook-timer-rest">${mmss(rest)}</span>
      <span class="cook-timer-label">${timer.alarm ? "Zeit um" : "läuft"}</span>
      <button type="button" class="cook-timer-btn" data-timer="stop">${timer.alarm ? "Ok" : "Stopp"}</button>
    </div>`;
  }
  const zeiten = findeZeiten(schrittText);
  if (!zeiten.length) return "";
  return `<div class="cook-timer">
    ${zeiten.slice(0, 3).map(m => `<button type="button" class="cook-timer-btn" data-timer="${m}">${m} Min</button>`).join("")}
    <button type="button" class="cook-timer-btn leise" data-timer="uhr">iPhone-Uhr</button>
  </div>`;
}

// Der Browser darf nur nach einer Berührung Ton abspielen. Beim Start des Timers
// wird deshalb einmal kurz und lautlos angeschubst, damit der Ton später kommt.
let audioCtx = null;
function tonFreischalten() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.03);
  } catch (e) {
    /* egal */
  }
}

function piep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    [0, 0.45, 0.9, 1.35].forEach(versatz => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + versatz);
      g.gain.exponentialRampToValueAtTime(0.35, audioCtx.currentTime + versatz + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + versatz + 0.3);
      o.start(audioCtx.currentTime + versatz);
      o.stop(audioCtx.currentTime + versatz + 0.32);
    });
  } catch (e) {
    /* kein Ton, kein Drama */
  }
}

// Übergabe an die Uhr des iPhones. Das geht nur über einen Kurzbefehl, den du
// selbst anlegst, der Name steht oben in SHORTCUT_NAME.
function anUhrUebergeben(minuten) {
  const url = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${minuten}`;
  try {
    window.location.href = url;
  } catch (e) {
    /* egal */
  }
}

// Welche Zutaten kommen in diesem Schritt vor? Verglichen werden die Wörter des
// Zutatennamens mit dem Schritttext, dazu eine grobe Endungsbereinigung, damit
// "Zwiebel" auch "Zwiebeln würfeln" trifft.
function schrittZutaten(r, schritt) {
  const refs = schrittRefs(schritt);
  if (refs) {
    const treffer = refs.map(ref => zutatZuRef(r, ref)).filter(Boolean);
    if (treffer.length) return treffer;
  }

  // Ohne gepflegte Verweise wird geraten: Wörter des Schritttextes gegen
  // Zutatennamen, mit grober Endungsbereinigung.
  const text = normName(schrittText(schritt));
  if (!text) return [];
  const stamm = w => w.replace(/(en|er|n|e|s)$/, "");
  const schrittWorte = text.split(" ").map(stamm).filter(w => w.length >= 4);
  const treffer = [];

  (r.zutaten || []).forEach(z => {
    if (!z || !z.name) return;
    const basis = normName(String(z.name).split("(")[0].split(",")[0]);
    const worte = basis.split(" ").filter(w => w.length >= 4).map(stamm);
    const passt = worte.some(w => schrittWorte.some(sw => w.includes(sw) || sw.includes(w)));
    if (passt && !treffer.includes(z)) treffer.push(z);
  });

  return treffer.slice(0, 6);
}

function schrittVor() {
  if (!cook) return;
  if (cook.zutatenOffen) { cook.zutatenOffen = false; drawCook(); return; }
  const gesamt = (cook.recipe.schritte || []).length;
  if (cook.i < gesamt - 1) { cook.i++; drawCook(); }
  else {
    const r = cook.recipe;
    const menge = cook.portionen;
    closeCook();
    // Nach dem Original wird nicht gefragt, die gemessene Ausbeute gehört
    // zur angepassten Fassung.
    if (!r._variante) mengeFragen(r, menge);
  }
}

// Direkt nach dem Kochen steht der Topf da, das ist der ehrlichste Moment für
// die Frage nach der Ausbeute. Übersprungen wird sie mit einem Tipper.
function mengeFragen(r, gekochteMenge) {
  ausbeute = {
    id: r.id,
    name: r.name,
    gekocht: gekochteMenge,
    wert: r.portionen_real ? Number(r.portionen_real) : ergiebigkeit(r)
  };
  scrollSperre(true);
  drawAusbeute();
}

let ausbeute = null;

function ausbeuteSchliessen() {
  ausbeute = null;
  const el = document.getElementById("ausbeute-sheet");
  if (el) el.remove();
  if (!detail && !cook) scrollSperre(false);
}

function drawAusbeute() {
  if (!ausbeute) return;
  let el = document.getElementById("ausbeute-sheet");
  if (!el) {
    el = document.createElement("div");
    el.id = "ausbeute-sheet";
    el.className = "sheet";
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target === el) ausbeuteSchliessen(); });
  }

  const r = rezeptMitId(ausbeute.id);
  const basis = r ? (r.basis || 2) : 2;

  el.innerHTML = `
    <div class="sheet-inhalt">
      <div class="sheet-kopf">
        <div>
          <span class="label">Fertig</span>
          <div class="sheet-titel">${escapeHtml(ausbeute.name)}</div>
        </div>
        <button type="button" class="back" aria-label="Schließen">&times;</button>
      </div>
      <p class="small-note">Wie viele Portionen sind aus den Mengen des Rezepts geworden? Der Wert landet als portionen_real im Rezept, danach rechnet die App alle Mengen darauf um statt auf die geschätzte Basis.</p>
      <div class="portions" style="margin:14px 0">
        <span class="small-note" style="margin:0">Rezeptbasis ${escapeHtml(basis)}</span>
        <div class="portion-control">
          <button type="button" data-a="-0.5" aria-label="Weniger">−</button>
          <span class="portion-value">${escapeHtml(portionenText(ausbeute.wert))}</span>
          <button type="button" data-a="0.5" aria-label="Mehr">+</button>
        </div>
      </div>
      <button class="btn primary full" type="button" id="aus-ok">Ausbeute merken</button>
      <button class="btn secondary full" type="button" id="aus-weg" style="margin-top:8px">Überspringen</button>
    </div>
  `;

  const anzeige = el.querySelector(".portion-value");
  el.querySelectorAll("[data-a]").forEach(b => {
    b.addEventListener("click", () => {
      ausbeute.wert = portionenNormal(ausbeute.wert + parseFloat(b.dataset.a));
      if (anzeige) anzeige.textContent = portionenText(ausbeute.wert);
    });
  });
  el.querySelector(".back").addEventListener("click", ausbeuteSchliessen);
  el.querySelector("#aus-weg").addEventListener("click", ausbeuteSchliessen);
  el.querySelector("#aus-ok").addEventListener("click", () => {
    patchSetzen(ausbeute.id, { portionen_real: ausbeute.wert, gekocht_am: heuteIso() });
    const wert = ausbeute.wert;
    ausbeuteSchliessen();
    if (detail) drawDetail();
    render();
    meldung(`Gemerkt: ergibt ${portionenText(wert)} Portionen`);
  });
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

const ART_LABEL = { reste: "Reste", brotzeit: "Brotzeit" };

// Halbe Portionen sind erlaubt, damit "Kind isst mit" mit 2,5 abgebildet ist.
function portionenNormal(wert) {
  const n = Number(wert);
  if (!isFinite(n) || n <= 0) return null;
  return Math.min(12, Math.max(0.5, Math.round(n * 2) / 2));
}

function portionenText(n) {
  return String(n).replace(".", ",");
}

function leererSlot() {
  return { art: "rezept", recipeId: "", portionen: null, notiz: "" };
}

function slotGefuellt(slot) {
  if (!slot) return false;
  if (slot.art !== "rezept") return true;
  return !!rezeptMitId(slot.recipeId);
}

function slotGericht(slot) {
  if (!slot) return "";
  if (slot.art !== "rezept") {
    const zusatz = String(slot.notiz || "").trim();
    return ART_LABEL[slot.art] + (zusatz ? " " + zusatz : "");
  }
  const r = rezeptMitId(slot.recipeId);
  return r ? r.name : "";
}

// Eine Mahlzeit ist standardmäßig für die beiden Erwachsenen. Die Rezeptbasis
// sagt nur, für wie viele Portionen die Mengen in der Datei gelten, nicht,
// wie viele davon auf den Tisch kommen.
function slotPortionen(slot) {
  if (!slot) return STANDARD_PORTIONEN;
  return slot.portionen || STANDARD_PORTIONEN;
}

function tagObjekt(datum, anlegenWennFehlt) {
  let tag = plan.tage.find(t => t.datum === datum);
  if (!tag && anlegenWennFehlt) {
    tag = { datum, sporttag: false, mahlzeiten: {} };
    plan.tage.push(tag);
  }
  return tag || null;
}

function tagHatInhalt(tag) {
  return KATEGORIE_KEYS.some(k => slotGefuellt(tag.mahlzeiten[k]));
}

// Alle belegten Mahlzeiten der Woche, sortiert nach Datum und Tageszeit.
function alleSlots(quelle) {
  const q = quelle || plan;
  const rang = k => Math.max(0, KATEGORIE_KEYS.indexOf(k));
  const raus = [];
  q.tage.forEach(tag => {
    KATEGORIE_KEYS.forEach(k => {
      const slot = tag.mahlzeiten[k];
      if (slotGefuellt(slot)) raus.push({ tag, kat: k, slot });
    });
  });
  return raus.sort((a, b) => (a.tag.datum < b.tag.datum ? -1 : a.tag.datum > b.tag.datum ? 1 :
    rang(a.kat) - rang(b.kat)));
}

function sortierteTage() {
  return plan.tage.slice().sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
}

// ---------- VORKOCHEN, ABGELEITET ----------

// Steht dasselbe Gericht an mehreren Stellen der Woche, wird es einmal gekocht,
// und zwar am frühesten Termin. Die Menge ist die Summe aller Portionen.
function vorkochGruppen(quelle) {
  const nachRezept = new Map();
  alleSlots(quelle).forEach(eintrag => {
    if (eintrag.slot.art !== "rezept") return;
    const id = eintrag.slot.recipeId;
    if (!nachRezept.has(id)) nachRezept.set(id, []);
    nachRezept.get(id).push(eintrag);
  });

  const gruppen = [];
  nachRezept.forEach((eintraege, id) => {
    if (eintraege.length < 2) return;
    const r = rezeptMitId(id);
    if (!r) return;
    const kochtag = eintraege[0].tag.datum;
    const portionen = eintraege.reduce((a, e) => a + slotPortionen(e.slot), 0);
    const haltbar = (r.prep && Number(r.prep.haltbar_tage)) || null;

    const nutzung = eintraege.map(e => {
      const abstand = Math.round((dateVon(e.tag.datum) - dateVon(kochtag)) / 86400000);
      let lagerung = "frisch";
      if (abstand > 0 && haltbar && abstand > haltbar) lagerung = r.prep && r.prep.einfrierbar ? "einfrieren" : "zu lang";
      return { eintrag: e, abstand, lagerung };
    });

    gruppen.push({ rezept: r, kochtag, portionen, nutzung, haltbar });
  });

  return gruppen.sort((a, b) => (a.kochtag < b.kochtag ? -1 : 1));
}

// Zu welcher Vorkoch-Gruppe gehört diese Mahlzeit, und ist sie der Kochtag?
function vorkochInfo(datum, kat, quelle) {
  for (const g of vorkochGruppen(quelle)) {
    const treffer = g.nutzung.find(n => n.eintrag.tag.datum === datum && n.eintrag.kat === kat);
    if (treffer) return { gruppe: g, kochtag: treffer.abstand === 0 && g.nutzung[0].eintrag.kat === kat, info: treffer };
  }
  return null;
}

function mittagPortionen() {
  return alleSlots()
    .filter(e => e.kat === "mittag" && e.slot.art === "rezept")
    .reduce((a, e) => a + slotPortionen(e.slot), 0);
}

// ---------- PLANUNG: ANSICHT ----------

let kalenderAnker = isoVon(montagVon(new Date()));
let gewaehltesDatum = null;
let offenerSlot = null;   // { datum, kat }

function renderPlanung() {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const um = document.createElement("div");
  um.className = "segmented";
  um.style.marginBottom = "16px";
  um.innerHTML = `
    <button type="button" data-ansicht="planen"${ui.planAnsicht !== "woche" ? ' class="aktiv"' : ""}>Planen</button>
    <button type="button" data-ansicht="woche"${ui.planAnsicht === "woche" ? ' class="aktiv"' : ""}>Wochenblatt</button>
  `;
  um.querySelectorAll("[data-ansicht]").forEach(b => {
    b.addEventListener("click", () => {
      ui.planAnsicht = b.dataset.ansicht;
      saveUi();
      render();
      window.scrollTo(0, 0);
    });
  });
  wrap.appendChild(um);

  if (ui.planAnsicht === "woche") {
    wrap.appendChild(renderWochenblatt());
    return wrap;
  }

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
      plan.tage.forEach(tag => {
        KATEGORIE_KEYS.forEach(k => {
          const slot = tag.mahlzeiten[k];
          if (slot && slot.art === "rezept" && slot.recipeId && !ids.has(slot.recipeId)) delete tag.mahlzeiten[k];
        });
      });
      plan.tage = plan.tage.filter(tagHatInhalt);
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
  const zuZeigen = sortierteTage().filter(tagHatInhalt).map(t => t.datum);
  if (gewaehltesDatum && !zuZeigen.includes(gewaehltesDatum)) zuZeigen.push(gewaehltesDatum);
  zuZeigen.sort();
  zuZeigen.forEach(datum => dayList.appendChild(renderTagKarte(datum)));

  if (!zuZeigen.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch nichts geplant. Oben einen Tag antippen, dann stehen die vier Mahlzeiten darunter.";
    dayList.appendChild(leer);
  }
  wrap.appendChild(dayList);

  wrap.appendChild(renderVorschlaege());
  wrap.appendChild(renderVorkochen());
  wrap.appendChild(renderWochenuebersicht());
  wrap.appendChild(renderKopiertext());

  if (plan.tage.length) {
    const ab = document.createElement("button");
    ab.type = "button";
    ab.className = "btn secondary full";
    ab.style.marginTop = "18px";
    ab.textContent = "Woche abschließen";
    ab.addEventListener("click", abschlussOeffnen);
    wrap.appendChild(ab);

    const hin = document.createElement("p");
    hin.className = "small-note";
    hin.textContent = "Bewerten, ins Archiv legen, Planung leeren. Geht auch ohne Bewertung.";
    wrap.appendChild(hin);
  }

  wrap.appendChild(renderImportPanel());

  return wrap;
}

// ---------- VORSCHLÄGE ----------

// Was kam gut an und ist lange her, dazu Kandidaten, die noch nie dran waren.
// Alles, was in dieser Planung schon steht, fällt raus.
function planVorschlaege() {
  const drin = new Set(alleSlots().filter(e => e.slot.art === "rezept").map(e => e.slot.recipeId));
  const frei = planbareRezepte().filter(r => !drin.has(r.id));

  const tageSeit = r => {
    if (!istIso(r.gekocht_am)) return null;
    return Math.round((new Date() - dateVon(r.gekocht_am)) / 86400000);
  };

  const bewaehrt = frei
    .filter(r => r.urteil === "kommt wieder" || r.favorit === true)
    .map(r => ({ r, tage: tageSeit(r) }))
    .filter(x => x.tage === null || x.tage >= 10)
    .sort((a, b) => (b.tage === null ? 9999 : b.tage) - (a.tage === null ? 9999 : a.tage))
    .map(x => ({ rezept: x.r, grund: x.tage === null ? "kam gut an" : `kam gut an, ${x.tage} Tage her` }));

  const neue = frei
    .filter(r => r.status === "kandidat" && !r.gekocht_am)
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map(r => ({ rezept: r, grund: "noch nie gekocht" }));

  return bewaehrt.slice(0, 3).concat(neue.slice(0, 2));
}

function renderVorschlaege() {
  const wrap = document.createElement("div");
  const liste = planVorschlaege();
  if (!liste.length) return wrap;

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.margin = "4px 0 8px";
  label.textContent = "Vorschläge";
  wrap.appendChild(label);

  const box = document.createElement("div");
  box.className = "vorschlaege";
  liste.forEach(v => {
    const knopf = document.createElement("button");
    knopf.type = "button";
    knopf.className = "vorschlag";
    knopf.innerHTML = `
      <span class="vorschlag-name">${escapeHtml(v.rezept.name)}</span>
      <span class="prep-info">${escapeHtml(v.grund)}</span>
    `;
    knopf.addEventListener("click", () => planSheetOeffnen(v.rezept.id, gewaehltesDatum || heuteIso()));
    box.appendChild(knopf);
  });
  wrap.appendChild(box);
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
        const tag = plan.tage.find(t => t.datum === iso);
        const anzahl = tag ? KATEGORIE_KEYS.filter(k => slotGefuellt(tag.mahlzeiten[k])).length : 0;
        const cls = ["kal-tag"];
        if (iso === heute) cls.push("heute");
        if (iso === gewaehltesDatum) cls.push("gewaehlt");
        if (anzahl) cls.push("belegt");
        if (tag && tag.sporttag) cls.push("sport");
        return `<button type="button" class="${cls.join(" ")}" data-iso="${iso}" aria-label="${escapeAttr(tagLabel(iso))}">
          <span class="kal-nr">${d.getDate()}</span>
          <span class="kal-punkte">${Array.from({ length: anzahl }).map(() => "<i></i>").join("")}</span>
        </button>`;
      }).join("")}
    </div>
    <p class="small-note" style="margin:10px 2px 0">Tag antippen, die vier Mahlzeiten stehen darunter.</p>
  `;

  box.querySelectorAll(".kal-nav").forEach(b => {
    b.addEventListener("click", () => {
      kalenderAnker = isoVon(plusTage(dateVon(kalenderAnker), parseInt(b.dataset.nav, 10)));
      render();
    });
  });

  box.querySelectorAll(".kal-tag").forEach(b => {
    b.addEventListener("click", () => {
      gewaehltesDatum = b.dataset.iso;
      offenerSlot = null;
      render();
      const karte = document.querySelector(`.day-card[data-datum="${gewaehltesDatum}"]`);
      if (karte && karte.scrollIntoView) karte.scrollIntoView({ block: "nearest" });
    });
  });

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

// ---------- TAGESKARTE MIT VIER MAHLZEITEN ----------

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

function planbareRezepte() {
  return RECIPES.filter(r => r.status !== "raus");
}

function slotSetzen(datum, kat, aenderung) {
  const tag = tagObjekt(datum, true);
  const slot = Object.assign(leererSlot(), tag.mahlzeiten[kat] || {}, aenderung);
  tag.mahlzeiten[kat] = slot;
  savePlan();
}

function slotLeeren(datum, kat) {
  const tag = tagObjekt(datum, false);
  if (!tag) return;
  delete tag.mahlzeiten[kat];
  if (!tagHatInhalt(tag) && !tag.sporttag) plan.tage = plan.tage.filter(t => t !== tag);
  savePlan();
}

function renderTagKarte(datum) {
  const tag = tagObjekt(datum, false) || { datum, sporttag: false, mahlzeiten: {} };
  const card = document.createElement("div");
  card.className = "day-card tag-karte" + (datum === gewaehltesDatum ? " gewaehlt" : "");
  card.dataset.datum = datum;

  const kopf = document.createElement("div");
  kopf.className = "day-card-header";
  kopf.innerHTML = `
    <div class="day-datum-wrap">
      <div class="day-datum">${escapeHtml(tagLabel(datum))}</div>
    </div>
    <div class="sport-switch">
      <span class="label">Sport</span>
      <button class="toggle${tag.sporttag ? " active" : ""}" type="button" aria-label="Sporttag" aria-pressed="${tag.sporttag ? "true" : "false"}"></button>
    </div>
  `;
  kopf.querySelector(".toggle").addEventListener("click", () => {
    const t = tagObjekt(datum, true);
    t.sporttag = !t.sporttag;
    if (!tagHatInhalt(t) && !t.sporttag) plan.tage = plan.tage.filter(x => x !== t);
    savePlan();
    render();
  });
  card.appendChild(kopf);

  KATEGORIEN.forEach(k => {
    card.appendChild(renderMahlzeit(datum, k, tag));
  });

  return card;
}

function renderMahlzeit(datum, kategorie, tag) {
  const kat = kategorie.key;
  const slot = tag.mahlzeiten[kat];
  const offen = offenerSlot && offenerSlot.datum === datum && offenerSlot.kat === kat;
  const gefuellt = slotGefuellt(slot);
  const r = slot && slot.art === "rezept" ? rezeptMitId(slot.recipeId) : null;

  const zeile = document.createElement("div");
  zeile.className = "mahlzeit" + (offen ? " offen" : "") + (gefuellt ? " belegt" : "");

  const vk = gefuellt && r ? vorkochInfo(datum, kat) : null;
  const kopfText = gefuellt
    ? `${escapeHtml(slotGericht(slot))}${r ? ` <span class="mahlzeit-menge">${escapeHtml(portionenText(slotPortionen(slot)))} P</span>` : ""}`
    : `<span class="mahlzeit-leer">wählen</span>`;

  const kopf = document.createElement("button");
  kopf.type = "button";
  kopf.className = "mahlzeit-kopf";
  kopf.innerHTML = `
    <span class="mahlzeit-name" data-typ="${escapeAttr(kat)}">${escapeHtml(kategorie.label)}</span>
    <span class="mahlzeit-gericht">${kopfText}</span>
    <span class="mahlzeit-pfeil">${offen ? "−" : "+"}</span>
  `;
  kopf.addEventListener("click", () => {
    offenerSlot = offen ? null : { datum, kat };
    render();
  });
  zeile.appendChild(kopf);

  if (vk && !vk.kochtag) {
    const hinweis = document.createElement("div");
    hinweis.className = "mahlzeit-vk";
    hinweis.textContent = `vorgekocht am ${tagLabel(vk.gruppe.kochtag)}${vk.info.lagerung === "einfrieren" ? ", aus dem Gefrierfach" : ""}`;
    zeile.appendChild(hinweis);
  }
  if (vk && vk.kochtag && vk.gruppe.nutzung.length > 1) {
    const hinweis = document.createElement("div");
    hinweis.className = "mahlzeit-vk";
    hinweis.textContent = `hier ${portionenText(vk.gruppe.portionen)} Portionen kochen, deckt ${vk.gruppe.nutzung.length} Mahlzeiten`;
    zeile.appendChild(hinweis);
  }

  if (!offen) return zeile;

  const auf = document.createElement("div");
  auf.className = "mahlzeit-auf";

  const art = slot ? slot.art : "rezept";
  if (art === "rezept") {
    const { passend, weitere } = passendeRezepte(kat, tag.sporttag);
    const opt = x => `<option value="${escapeAttr(x.id)}"${slot && x.id === slot.recipeId ? " selected" : ""}>${escapeHtml(x.name + ((x.tags || []).includes("SPORT") ? " · SPORT" : ""))}</option>`;
    const fehlend = slot && slot.recipeId && !r;

    auf.innerHTML = `
      <select aria-label="Rezept für ${escapeAttr(kategorie.label)}">
        <option value="">Rezept wählen</option>
        ${fehlend ? `<option value="${escapeAttr(slot.recipeId)}" selected>Unbekannt: ${escapeHtml(slot.recipeId)}</option>` : ""}
        ${passend.length ? `<optgroup label="Passend zu ${escapeAttr(kategorie.label)}">${passend.map(opt).join("")}</optgroup>` : ""}
        ${weitere.length ? `<optgroup label="Weitere Rezepte">${weitere.map(opt).join("")}</optgroup>` : ""}
      </select>
      ${r ? `<div class="row-between portionen-zeile">
        <span class="prep-info">Portionen${r.portionen_real ? `, Rezept ergibt ${escapeHtml(portionenText(r.portionen_real))}` : `, Rezeptbasis ${r.basis || 2}`}</span>
        <div class="stepper">
          <button type="button" data-p="-0.5" aria-label="Weniger Portionen">−</button>
          <span class="val">${escapeHtml(portionenText(slotPortionen(slot)))}</span>
          <button type="button" data-p="0.5" aria-label="Mehr Portionen">+</button>
        </div>
      </div>` : ""}
      ${r ? `<div class="day-info">${[
        r.kcal ? r.kcal + " kcal" : "",
        r.protein ? r.protein + " g Eiweiß" : "",
        salzWert(r) != null ? salzText(salzWert(r)) + " Salz" : "",
        zeitText(r)
      ].filter(Boolean).map(escapeHtml).join(" · ")}</div>` : ""}
      ${r && tag.sporttag && (r.tags || []).includes("Low Carb") ? `<div class="warn-lowcarb">Low Carb an einem Sporttag, laut Vorgabe eigentlich nicht vorgesehen.</div>` : ""}
      ${r && r.rest ? `<div class="day-rest">Bleibt übrig: ${escapeHtml(String(r.rest))}</div>` : ""}
      <div class="mahlzeit-chips">
        <button type="button" class="chip" data-art="reste">Reste</button>
        <button type="button" class="chip" data-art="brotzeit">Brotzeit</button>
        ${r ? `<button type="button" class="chip" data-act="open">Rezept öffnen</button>` : ""}
        ${r ? `<button type="button" class="chip${istGekochtSlot(datum, r) ? " active" : ""}" data-act="gekocht">${istGekochtSlot(datum, r) ? "gekocht ✓" : "gekocht"}</button>` : ""}
        ${gefuellt ? `<button type="button" class="chip" data-act="leeren">Leeren</button>` : ""}
      </div>
    `;

    auf.querySelector("select").addEventListener("change", (e) => {
      if (!e.target.value) slotLeeren(datum, kat);
      else slotSetzen(datum, kat, { art: "rezept", recipeId: e.target.value, portionen: null, notiz: "" });
      render();
    });
    auf.querySelectorAll("[data-p]").forEach(b => {
      b.addEventListener("click", () => {
        slotSetzen(datum, kat, { portionen: portionenNormal(slotPortionen(slot) + parseFloat(b.dataset.p)) });
        render();
      });
    });
  } else {
    auf.innerHTML = `
      <div class="tag-art">${escapeHtml(ART_LABEL[art])}</div>
      <input type="text" class="tag-notiz" value="${escapeAttr(slot.notiz || "")}"
        placeholder="${art === "reste" ? "woher, zum Beispiel von Montag" : "was dazu, zum Beispiel Brot und Aufstriche"}"
        aria-label="Notiz">
      <div class="mahlzeit-chips">
        <button type="button" class="chip${art === "reste" ? " active" : ""}" data-art="reste">Reste</button>
        <button type="button" class="chip${art === "brotzeit" ? " active" : ""}" data-art="brotzeit">Brotzeit</button>
        <button type="button" class="chip" data-art="rezept">Rezept</button>
        <button type="button" class="chip" data-act="leeren">Leeren</button>
      </div>
    `;
    auf.querySelector(".tag-notiz").addEventListener("input", (e) => {
      slotSetzen(datum, kat, { notiz: e.target.value });
      aktualisiereKopiertext();
    });
  }

  auf.querySelectorAll("[data-art]").forEach(b => {
    b.addEventListener("click", () => {
      const neu = b.dataset.art;
      if (neu === "rezept") slotSetzen(datum, kat, { art: "rezept", notiz: "" });
      else slotSetzen(datum, kat, { art: neu, recipeId: "", portionen: null });
      render();
    });
  });
  const openBtn = auf.querySelector('[data-act="open"]');
  if (openBtn) openBtn.addEventListener("click", () => openDetail(r.id));
  const gekochtBtn = auf.querySelector('[data-act="gekocht"]');
  if (gekochtBtn) {
    gekochtBtn.addEventListener("click", () => {
      patchSetzen(r.id, { gekocht_am: istGekochtSlot(datum, r) ? undefined : datum });
      render();
    });
  }
  const leerBtn = auf.querySelector('[data-act="leeren"]');
  if (leerBtn) {
    leerBtn.addEventListener("click", () => {
      slotLeeren(datum, kat);
      offenerSlot = null;
      render();
    });
  }

  zeile.appendChild(auf);
  return zeile;
}

function istGekochtSlot(datum, r) {
  if (!r) return false;
  const p = patches[r.id];
  return !!(p && p.gekocht_am === datum);
}

// ---------- VORKOCHEN, ANZEIGE ----------

function renderVorkochen() {
  const wrap = document.createElement("div");

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.margin = "26px 0 8px";
  label.textContent = "Vorkochen";
  wrap.appendChild(label);

  const gruppen = vorkochGruppen();
  const mittag = mittagPortionen();

  const summe = document.createElement("div");
  summe.className = "meal-prep";
  summe.innerHTML = `
    <div class="meal-prep-header">
      <span class="label" style="color:#B4B6B0">Mittagessen der Woche</span>
      <span class="meal-prep-value">${escapeHtml(portionenText(mittag))} / ${PREP_ZIEL}</span>
    </div>
    <div class="progress"><span style="width:${Math.min(100, (mittag / PREP_ZIEL) * 100)}%"></span></div>
    <div class="meal-prep-split">
      <span>${gruppen.length} Gericht(e) mehrfach eingeplant</span>
      <span>${escapeHtml(portionenText(gruppen.reduce((a, g) => a + g.portionen, 0)))} Portionen daraus</span>
    </div>
  `;
  wrap.appendChild(summe);

  if (!gruppen.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Steht dasselbe Gericht an zwei Stellen der Woche, rechnet die App hier automatisch zusammen, wie viel du am ersten Termin kochen musst.";
    wrap.appendChild(leer);
    return wrap;
  }

  const liste = document.createElement("div");
  liste.className = "prep-liste";
  gruppen.forEach(g => {
    const karte = document.createElement("div");
    karte.className = "prep-karte";
    const warnung = g.nutzung.find(n => n.lagerung === "zu lang");
    const frieren = g.nutzung.filter(n => n.lagerung === "einfrieren").reduce((a, n) => a + slotPortionen(n.eintrag.slot), 0);

    karte.innerHTML = `
      <div class="prep-kopf">
        <span class="prep-name">${escapeHtml(g.rezept.name)}</span>
        <span class="meal-prep-value" style="color:var(--text)">${escapeHtml(portionenText(g.portionen))} P</span>
      </div>
      <div class="prep-info">Kochen am ${escapeHtml(tagLabel(g.kochtag))}${g.haltbar ? `, hält ${g.haltbar} Tage` : ""}${frieren ? `, davon ${escapeHtml(portionenText(frieren))} einfrieren` : ""}</div>
      <div class="vk-nutzung">
        ${g.nutzung.map(n => `<div class="vk-zeile">
          <span>${escapeHtml(tagLabel(n.eintrag.tag.datum))} · ${escapeHtml(katLabel(n.eintrag.kat))}</span>
          <span class="prep-info">${escapeHtml(portionenText(slotPortionen(n.eintrag.slot)))} P · ${escapeHtml(n.abstand === 0 ? "am Kochtag" : n.lagerung === "einfrieren" ? "Gefrierfach" : n.lagerung === "zu lang" ? "zu spät" : "frisch")}</span>
        </div>`).join("")}
      </div>
      ${warnung ? `<div class="warn-lowcarb">Zwischen Kochtag und ${escapeHtml(tagLabel(warnung.eintrag.tag.datum))} liegen ${warnung.abstand} Tage, laut Rezept hält es ${g.haltbar}. Näher zusammenlegen oder einfrieren.</div>` : ""}
    `;
    liste.appendChild(karte);
  });
  wrap.appendChild(liste);

  return wrap;
}

// ---------- WOCHENÜBERSICHT ----------

function renderWochenuebersicht() {
  const wrap = document.createElement("div");
  const slots = alleSlots();
  if (!slots.length) return wrap;

  const gruppen = [];
  slots.forEach(({ tag, kat, slot }) => {
    let g = gruppen.find(x => x.datum === tag.datum);
    if (!g) { g = { datum: tag.datum, zeilen: [], kcal: 0, protein: 0, salz: 0, hatSalz: false, sport: tag.sporttag }; gruppen.push(g); }
    g.zeilen.push(`${katLabel(kat)}: ${slotGericht(slot)}`);
    const r = slot.art === "rezept" ? rezeptMitId(slot.recipeId) : null;
    if (r) {
      g.kcal += Number(r.kcal) || 0;
      g.protein += Number(r.protein) || 0;
      if (salzWert(r) != null) { g.salz += salzWert(r); g.hatSalz = true; }
    }
  });

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.margin = "26px 0 8px";
  label.textContent = "Übersicht";
  wrap.appendChild(label);

  const box = document.createElement("div");
  box.className = "day-card";
  box.innerHTML = gruppen.map(g => `
    <div class="uebersicht-tag">
      <div class="uebersicht-kopf">
        <span>${escapeHtml(tagLabel(g.datum))}${g.sport ? " · Sport" : ""}</span>
        <span class="uebersicht-zahlen">${g.kcal || g.protein ? `${g.kcal} kcal · ${g.protein} g EW` : ""}${g.hatSalz ? ` · ${salzText(g.salz)} Salz` : ""}</span>
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
  note.textContent = "Summen aus rezepte.json, jeweils eine Portion pro Person.";
  wrap.appendChild(note);

  return wrap;
}

// ---------- WOCHENBLATT ----------

// Alles, was in der geplanten Woche zu tun ist, von der ersten bis zur letzten
// Mahlzeit, in Tagesreihenfolge und mit den Zutaten in der geplanten Menge.
function renderWochenblatt(quelle) {
  const wrap = document.createElement("div");
  const slots = alleSlots(quelle);

  if (!slots.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch nichts geplant. Wechsel auf Planen oder tipp im Katalog bei einem Rezept auf Einplanen.";
    wrap.appendChild(leer);
    return wrap;
  }

  const von = slots[0].tag.datum;
  const bis = slots[slots.length - 1].tag.datum;
  const gerichte = new Set(slots.filter(e => e.slot.art === "rezept").map(e => e.slot.recipeId));
  const tageAnzahl = new Set(slots.map(e => e.tag.datum)).size;

  const kopf = document.createElement("div");
  kopf.className = "wb-kopf";
  kopf.innerHTML = `
    <div class="wb-zeitraum">${escapeHtml(tagLabel(von))} bis ${escapeHtml(tagLabel(bis))}</div>
    <div class="wb-zahlen">${slots.length} Mahlzeiten · ${gerichte.size} Gerichte · ${tageAnzahl} Tage</div>
  `;
  wrap.appendChild(kopf);

  const gruppen = vorkochGruppen(quelle);
  if (gruppen.length) {
    const vk = document.createElement("div");
    vk.className = "note-box";
    vk.style.marginBottom = "16px";
    vk.innerHTML = `<strong>Vorkochen</strong>${gruppen.map(g =>
      `<p>${escapeHtml(tagLabel(g.kochtag))}: ${escapeHtml(g.rezept.name)}, ${escapeHtml(portionenText(g.portionen))} Portionen für ${g.nutzung.length} Mahlzeiten</p>`).join("")}`;
    wrap.appendChild(vk);
  }

  let letzterTag = "";
  slots.forEach(({ tag, kat, slot }) => {
    if (tag.datum !== letzterTag) {
      letzterTag = tag.datum;
      const kopfzeile = document.createElement("div");
      kopfzeile.className = "wb-tag";
      kopfzeile.innerHTML = `<span>${escapeHtml(tagLabel(tag.datum))}</span>${tag.sporttag ? `<span class="wb-sport">Sporttag</span>` : ""}`;
      wrap.appendChild(kopfzeile);
    }
    wrap.appendChild(renderWochenblattKarte(tag, kat, slot, quelle));
  });

  const hinweis = document.createElement("p");
  hinweis.className = "small-note";
  hinweis.style.marginTop = "18px";
  hinweis.textContent = "Die Zutatenmengen sind auf die geplanten Portionen umgerechnet, nicht auf die Rezeptbasis.";
  wrap.appendChild(hinweis);

  return wrap;
}

function renderWochenblattKarte(tag, kat, slot, quelle) {
  const karte = document.createElement("div");
  karte.className = "wb-karte";

  if (slot.art !== "rezept") {
    karte.classList.add("schlicht");
    karte.innerHTML = `
      <span class="mahlzeit-name" data-typ="${escapeAttr(kat)}">${escapeHtml(katLabel(kat))}</span>
      <span class="wb-name">${escapeHtml(slotGericht(slot))}</span>
    `;
    return karte;
  }

  const r = rezeptMitId(slot.recipeId);
  if (!r) return karte;

  const portionen = slotPortionen(slot);
  const factor = portionen / ergiebigkeit(r);
  const vk = vorkochInfo(tag.datum, kat, quelle);

  const infos = [
    `${portionenText(portionen)} Portionen`,
    zeitText(r),
    r.kcal ? `${r.kcal} kcal` : "",
    r.protein ? `${r.protein} g Eiweiß` : "",
    salzWert(r) != null ? `${salzText(salzWert(r))} Salz` : ""
  ].filter(Boolean);

  karte.innerHTML = `
    <div class="wb-kartenkopf">
      <span class="mahlzeit-name" data-typ="${escapeAttr(kat)}">${escapeHtml(katLabel(kat))}</span>
      <span class="wb-name">${escapeHtml(r.name)}</span>
    </div>
    <div class="wb-infos">${infos.map(escapeHtml).join(" · ")}</div>
    ${vk && vk.gruppe.nutzung.length > 1 ? `<div class="mahlzeit-vk">${vk.kochtag
      ? `hier ${escapeHtml(portionenText(vk.gruppe.portionen))} Portionen kochen, deckt ${vk.gruppe.nutzung.length} Mahlzeiten`
      : `vorgekocht am ${escapeHtml(tagLabel(vk.gruppe.kochtag))}${vk.info.lagerung === "einfrieren" ? ", aus dem Gefrierfach" : ""}`}</div>` : ""}
    ${r.ausnahme && r.leichter ? `<div class="warn-lowcarb">Ausnahmegericht. ${escapeHtml(r.leichter)}</div>` : ""}
    ${r.varianten ? `<div class="day-rest">Varianten: ${escapeHtml(r.varianten)}</div>` : ""}
    <details class="klapp wb-klapp">
      <summary>Zutaten für ${escapeHtml(portionenText(portionen))} Portionen</summary>
      <div class="klapp-inhalt">
        <ul class="ingredients">
          ${(r.zutaten || []).map(z => `<li><span>${escapeHtml(z && z.name)}</span><span class="amount">${escapeHtml(zutatLine(z, factor, true))}</span></li>`).join("")}
        </ul>
      </div>
    </details>
    <div class="wb-aktionen">
      <button type="button" class="chip" data-act="detail">Rezept</button>
      <button type="button" class="chip stark" data-act="kochen">Kochmodus</button>
    </div>
  `;

  karte.querySelector('[data-act="detail"]').addEventListener("click", () => openDetail(r.id));
  karte.querySelector('[data-act="kochen"]').addEventListener("click", () => {
    const menge = vk && vk.kochtag ? vk.gruppe.portionen : portionen;
    openCookMode(r, menge);
  });

  return karte;
}

// ---------- WOCHE ABSCHLIESSEN ----------

const URTEILE = ["kommt wieder", "war ok", "fliegt raus"];

function abschlussOeffnen() {
  const gesehen = new Map();
  alleSlots().forEach(({ tag, slot }) => {
    if (slot.art !== "rezept") return;
    const r = rezeptMitId(slot.recipeId);
    if (!r) return;
    const vorhanden = gesehen.get(r.id);
    const portionen = slotPortionen(slot);
    if (vorhanden) {
      vorhanden.portionen += portionen;
      if (tag.datum > vorhanden.datum) vorhanden.datum = tag.datum;
    } else {
      gesehen.set(r.id, {
        id: r.id,
        name: r.name,
        datum: tag.datum,
        portionen,
        urteil: r.urteil && URTEILE.includes(r.urteil) ? r.urteil : "",
        kind: typeof r.kind_isst === "boolean" ? r.kind_isst : null,
        real: null
      });
    }
  });

  abschluss = { gerichte: [...gesehen.values()], notiz: "" };
  scrollSperre(true);
  drawAbschluss();
}

function abschlussSchliessen() {
  abschluss = null;
  const el = document.getElementById("abschluss-sheet");
  if (el) el.remove();
  if (!detail && !cook) scrollSperre(false);
}

function drawAbschluss() {
  if (!abschluss) return;
  let el = document.getElementById("abschluss-sheet");
  if (!el) {
    el = document.createElement("div");
    el.id = "abschluss-sheet";
    el.className = "sheet";
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target === el) abschlussSchliessen(); });
  }

  const slots = alleSlots();
  const von = slots.length ? tagLabel(slots[0].tag.datum) : "";
  const bis = slots.length ? tagLabel(slots[slots.length - 1].tag.datum) : "";

  el.innerHTML = `
    <div class="sheet-inhalt">
      <div class="sheet-kopf">
        <div>
          <span class="label">Woche abschließen</span>
          <div class="sheet-titel">${escapeHtml(von)} bis ${escapeHtml(bis)}</div>
        </div>
        <button type="button" class="back" aria-label="Schließen">&times;</button>
      </div>
      <p class="small-note">Kurz durchgehen, dann wird die Planung geleert und landet im Archiv. Die Urteile schreibt die App in deine Rezepte, im Reiter Daten steht danach der Rückblick für den Chat.</p>

      <div class="ab-liste">
        ${abschluss.gerichte.map((g, i) => `
          <div class="ab-karte" data-i="${i}">
            <div class="ab-name">${escapeHtml(g.name)}</div>
            <div class="prep-info">${escapeHtml(tagLabel(g.datum))} · ${escapeHtml(portionenText(g.portionen))} Portionen geplant</div>
            <div class="segmented winzig">
              ${URTEILE.map(u => `<button type="button" data-urteil="${escapeAttr(u)}"${g.urteil === u ? ' class="aktiv"' : ""}>${escapeHtml(u)}</button>`).join("")}
            </div>
            <div class="row-between">
              <span class="prep-info">Kind hat gegessen</span>
              <div class="segmented winzig">
                <button type="button" data-kind="ja"${g.kind === true ? ' class="aktiv"' : ""}>ja</button>
                <button type="button" data-kind="nein"${g.kind === false ? ' class="aktiv"' : ""}>nein</button>
                <button type="button" data-kind="egal"${g.kind === null ? ' class="aktiv"' : ""}>keine Angabe</button>
              </div>
            </div>
            <div class="row-between">
              <span class="prep-info">Tatsächliche Portionen</span>
              <div class="stepper">
                <button type="button" data-real="-0.5" aria-label="Weniger">−</button>
                <span class="val">${g.real == null ? "–" : escapeHtml(portionenText(g.real))}</span>
                <button type="button" data-real="0.5" aria-label="Mehr">+</button>
              </div>
            </div>
          </div>`).join("")}
        ${abschluss.gerichte.length ? "" : `<p class="small-note">In dieser Woche steht kein Rezept, es gibt also nichts zu bewerten.</p>`}
      </div>

      <span class="label" style="display:block;margin:18px 0 8px">Notiz zur Woche</span>
      <textarea id="ab-notiz" placeholder="Was lief gut, was nicht. Hat das Vorkochen gereicht, hat das Vorratsfach gereicht.">${escapeHtml(abschluss.notiz)}</textarea>

      <button class="btn primary full" type="button" id="ab-ok" style="margin-top:14px">Abschließen und Planung leeren</button>
      <button class="btn secondary full" type="button" id="ab-leer" style="margin-top:8px">Nur leeren, ohne Bewertung</button>
      <button class="btn secondary full" type="button" id="ab-abbruch" style="margin-top:8px">Abbrechen</button>
    </div>
  `;

  const notizFeld = el.querySelector("#ab-notiz");
  notizFeld.addEventListener("input", (e) => { abschluss.notiz = e.target.value; });

  // Beim Antippen wird nur die betroffene Karte angepasst. Ein Neuaufbau des
  // ganzen Blattes würde den Bildschirm jedes Mal nach oben springen lassen.
  el.querySelectorAll(".ab-karte").forEach(karte => {
    const g = abschluss.gerichte[parseInt(karte.dataset.i, 10)];

    const markiere = (knoepfe, treffer) => {
      knoepfe.forEach(b => b.classList.toggle("aktiv", b === treffer));
    };

    const urteilKnoepfe = [...karte.querySelectorAll("[data-urteil]")];
    urteilKnoepfe.forEach(b => {
      b.addEventListener("click", () => {
        g.urteil = g.urteil === b.dataset.urteil ? "" : b.dataset.urteil;
        markiere(urteilKnoepfe, g.urteil ? b : null);
      });
    });

    const kindKnoepfe = [...karte.querySelectorAll("[data-kind]")];
    kindKnoepfe.forEach(b => {
      b.addEventListener("click", () => {
        g.kind = b.dataset.kind === "ja" ? true : b.dataset.kind === "nein" ? false : null;
        markiere(kindKnoepfe, b);
      });
    });

    const wert = karte.querySelector(".stepper .val");
    karte.querySelectorAll("[data-real]").forEach(b => {
      b.addEventListener("click", () => {
        const start = g.real == null ? g.portionen : g.real;
        g.real = portionenNormal(start + parseFloat(b.dataset.real));
        if (wert) wert.textContent = portionenText(g.real);
      });
    });
  });

  el.querySelector(".back").addEventListener("click", abschlussSchliessen);
  el.querySelector("#ab-abbruch").addEventListener("click", abschlussSchliessen);
  el.querySelector("#ab-leer").addEventListener("click", () => {
    if (!confirm("Planung ohne Bewertung leeren?")) return;
    planLeeren();
    abschlussSchliessen();
    render();
    meldung("Planung geleert");
  });
  el.querySelector("#ab-ok").addEventListener("click", abschlussSpeichern);
}

function planLeeren() {
  plan = { tage: [] };
  savePlan();
  gewaehltesDatum = null;
  offenerSlot = null;
  pruefePlanBezuege();
}

function abschlussSpeichern() {
  const slots = alleSlots();
  const eintrag = {
    id: "w" + Date.now(),
    von: slots.length ? slots[0].tag.datum : heuteIso(),
    bis: slots.length ? slots[slots.length - 1].tag.datum : heuteIso(),
    abgeschlossen: heuteIso(),
    notiz: abschluss.notiz || "",
    gerichte: abschluss.gerichte.map(g => ({
      id: g.id, name: g.name, urteil: g.urteil, kind: g.kind, portionen: g.portionen, real: g.real
    })),
    tage: JSON.parse(JSON.stringify(plan.tage))
  };

  // Urteile wandern in die Rezeptebene, damit sie im Katalog und im Export stehen.
  abschluss.gerichte.forEach(g => {
    const felder = { gekocht_am: g.datum };
    if (g.urteil) felder.urteil = g.urteil;
    if (g.kind !== null) felder.kind_isst = g.kind;
    if (g.real != null) felder.portionen_real = g.real;
    patchSetzen(g.id, felder);
  });

  archiv.unshift(eintrag);
  if (archiv.length > 30) archiv = archiv.slice(0, 30);
  saveArchiv();

  planLeeren();
  abschlussSchliessen();
  render();
  meldung("Woche abgeschlossen und archiviert");
}

function wochenRueckblickText(eintrag) {
  const zeilen = [`Rückblick ${tagLabel(eintrag.von)} bis ${tagLabel(eintrag.bis)}`];
  eintrag.gerichte.forEach(g => {
    const teile = [];
    if (g.urteil) teile.push(g.urteil);
    if (g.kind === true) teile.push("Kind hat gegessen");
    if (g.kind === false) teile.push("Kind hat nicht gegessen");
    if (g.real != null) teile.push(`${portionenText(g.real)} statt ${portionenText(g.portionen)} Portionen`);
    zeilen.push(`${g.name}: ${teile.length ? teile.join(", ") : "kein Urteil"}`);
  });
  if (eintrag.notiz) {
    zeilen.push("");
    zeilen.push(`Notiz: ${eintrag.notiz}`);
  }
  return zeilen.join("\n");
}

// ---------- PLAN TEILEN ----------

// Der Plan wird in einen kurzen Code gepackt, der als Text weitergegeben oder
// an die Adresse der App gehängt werden kann. Kein Server, alles im Link.
const CODE_PRAEFIX = "futterassi1:";
const ART_CODE = ["rezept", "reste", "brotzeit"];

function b64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64Decode(code) {
  const roh = String(code).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(roh + "=".repeat((4 - roh.length % 4) % 4));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function planCode(quelle) {
  const q = quelle || plan;
  const daten = {
    v: 1,
    t: q.tage.filter(tagHatInhalt).map(tag => [
      tag.datum,
      tag.sporttag ? 1 : 0,
      KATEGORIE_KEYS.map((k, i) => {
        const slot = tag.mahlzeiten[k];
        if (!slotGefuellt(slot)) return null;
        return [i, ART_CODE.indexOf(slot.art), slot.art === "rezept" ? slot.recipeId : (slot.notiz || ""), slot.portionen || 0];
      }).filter(Boolean)
    ])
  };
  return CODE_PRAEFIX + b64Encode(JSON.stringify(daten));
}

function planAusCode(text) {
  const roh = String(text || "").trim();
  const stelle = roh.indexOf(CODE_PRAEFIX);
  if (stelle < 0) return null;
  const code = roh.slice(stelle + CODE_PRAEFIX.length).split(/[\s"'<>]/)[0];
  let daten;
  try {
    daten = JSON.parse(b64Decode(code));
  } catch (e) {
    return null;
  }
  if (!daten || daten.v !== 1 || !Array.isArray(daten.t)) return null;

  const tage = [];
  daten.t.forEach(eintrag => {
    if (!Array.isArray(eintrag) || !istIso(eintrag[0])) return;
    const mahlzeiten = {};
    (Array.isArray(eintrag[2]) ? eintrag[2] : []).forEach(m => {
      if (!Array.isArray(m)) return;
      const kat = KATEGORIE_KEYS[m[0]];
      const art = ART_CODE[m[1]] || "rezept";
      if (!kat) return;
      mahlzeiten[kat] = {
        art,
        recipeId: art === "rezept" ? String(m[2] || "") : "",
        portionen: portionenNormal(m[3]),
        notiz: art === "rezept" ? "" : String(m[2] || "")
      };
    });
    tage.push({ datum: eintrag[0], sporttag: eintrag[1] === 1, mahlzeiten });
  });
  tage.sort((a, b) => (a.datum < b.datum ? -1 : 1));
  return { tage };
}

function teilenLink(quelle) {
  const basis = location.origin + location.pathname;
  return `${basis}#plan=${planCode(quelle).slice(CODE_PRAEFIX.length)}`;
}

// Beim Start prüfen, ob die Adresse einen geteilten Plan mitbringt.
function geteiltenPlanLesen() {
  const treffer = String(location.hash || "").match(/[#&]plan=([^&]+)/);
  if (!treffer) return;
  const geteilt = planAusCode(CODE_PRAEFIX + treffer[1]);
  if (!geteilt || !geteilt.tage.length) return;
  geteilterPlan = geteilt;
  ui.view = "planung";
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (e) {
    /* egal */
  }
}

function renderGeteilt() {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const banner = document.createElement("div");
  banner.className = "note-box geteilt";
  banner.innerHTML = `
    <strong>Geteilter Plan</strong>
    <p>Diese Woche kommt aus einem Link, deine eigene Planung ist unberührt. Rezepte, Zutaten und Kochmodus funktionieren hier ganz normal.</p>
  `;

  const uebernehmen = document.createElement("button");
  uebernehmen.className = "btn primary full";
  uebernehmen.type = "button";
  uebernehmen.style.marginTop = "10px";
  uebernehmen.textContent = "Als meine Planung übernehmen";
  uebernehmen.addEventListener("click", () => {
    if (plan.tage.length && !confirm("Deine eigene Planung auf diesem Gerät ersetzen?")) return;
    plan = { tage: geteilterPlan.tage };
    savePlan();
    geteilterPlan = null;
    pruefePlanBezuege();
    render();
    meldung("Planung übernommen");
  });
  banner.appendChild(uebernehmen);

  const code = document.createElement("button");
  code.className = "btn secondary full";
  code.type = "button";
  code.style.marginTop = "8px";
  code.textContent = "Code kopieren, für die App vom Homescreen";
  code.addEventListener("click", () => copyToClipboard(planCode(geteilterPlan), code, "Code kopieren, für die App vom Homescreen"));
  banner.appendChild(code);

  const weg = document.createElement("button");
  weg.className = "btn secondary full";
  weg.type = "button";
  weg.style.marginTop = "8px";
  weg.textContent = "Zurück zu meiner Planung";
  weg.addEventListener("click", () => {
    geteilterPlan = null;
    render();
  });
  banner.appendChild(weg);

  wrap.appendChild(banner);
  wrap.appendChild(renderWochenblatt(geteilterPlan));
  return wrap;
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
      Ein geteilter Link oder Code aus der App funktioniert hier ebenfalls.
      Ersetzt die aktuelle Wochenplanung auf diesem Gerät.
    </p>
    <div class="copy-panel">
      <textarea id="import-text" placeholder="Mi 19.08.: Griechischer Kritharaki-Salat (Sporttag)
Do 20.08. (Mittag): Linsen-Bolognese
Fr 21.08.: Reste von Mittwoch"></textarea>
    </div>
    <button class="btn primary full" type="button" id="import-btn" style="margin-top:8px">Übernehmen</button>
    <div id="import-result" class="small-note" style="margin-bottom:0"></div>
  `;

  const resultEl = box.querySelector("#import-result");
  if (importErgebnis) resultEl.textContent = importErgebnis;

  box.querySelector("#import-btn").addEventListener("click", () => {
    const text = box.querySelector("#import-text").value;
    if (!text.trim()) return;
    if (plan.tage.length && !confirm("Aktuelle Wochenplanung auf diesem Gerät ersetzen?")) return;
    const ausCode = planAusCode(text);
    if (ausCode) {
      plan = { tage: ausCode.tage };
      savePlan();
      pruefePlanBezuege();
      importErgebnis = `Geteilte Planung übernommen: ${ausCode.tage.length} Tag(e).`;
      offenerSlot = null;
      if (ausCode.tage.length) kalenderAnker = isoVon(montagVon(dateVon(ausCode.tage[0].datum)));
      render();
      return;
    }
    const result = parseImportText(text);
    plan.tage = result.tage;
    savePlan();
    pruefePlanBezuege();
    importErgebnis = importMeldung(result);
    if (result.tage.length) kalenderAnker = isoVon(montagVon(dateVon(result.tage[0].datum)));
    offenerSlot = null;
    render();
  });

  return box;
}

function importMeldung(result) {
  const anzahl = result.tage.reduce((a, t) => a + KATEGORIE_KEYS.filter(k => t.mahlzeiten[k]).length, 0);
  const parts = [`${anzahl} Mahlzeit(en) an ${result.tage.length} Tag(en) übernommen`];
  if (result.prepZeilen) parts.push(`${result.prepZeilen} Meal-Prep-Zeile(n) übersprungen, das Vorkochen rechnet die App jetzt selbst aus`);
  if (result.ohneDatum) parts.push(`${result.ohneDatum} Zeile(n) ohne erkennbares Datum übersprungen`);
  if (result.unmatched.length) parts.push(`nicht erkannt: ${result.unmatched.map(l => `"${l}"`).join(", ")}`);
  return parts.join(", ") + ".";
}

// Format bleibt kompatibel: "Tag: Rezeptname (Sporttag)", Kategorie in Klammern
// hinter dem Tag, Portionen als xN hinter dem Namen.
function parseImportText(text) {
  const tage = [];
  const unmatched = [];
  let ohneDatum = 0;
  let prepZeilen = 0;
  let prepModus = false;

  const holeTag = (datum) => {
    let t = tage.find(x => x.datum === datum);
    if (!t) { t = { datum, sporttag: false, mahlzeiten: {} }; tage.push(t); }
    return t;
  };

  String(text).replace(/^\uFEFF/, "").split(/\r?\n/).forEach(raw => {
    const line = raw.trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ");
    if (!line) { prepModus = false; return; }

    if (/^meal\s*prep\s*:?\s*$/i.test(line)) { prepModus = true; return; }
    if (/^[^:]{1,40}:\s*$/.test(line)) return;

    if (/^meal\s*prep\s*:/i.test(line) || prepModus) { prepZeilen++; return; }

    const dayMatch = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (!dayMatch) { unmatched.push(line); return; }

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

    let portionen = null;
    const mengeMatch = name.match(/^(.*?)\s*[x×]\s*(\d+(?:[.,]\d)?)\s*$/i);
    if (mengeMatch) {
      name = mengeMatch[1].trim();
      portionen = portionenNormal(String(mengeMatch[2]).replace(",", "."));
    }

    const datum = labelZuIso(labelTeil);
    if (!datum) { ohneDatum++; return; }

    const tag = holeTag(datum);
    if (sporttag) tag.sporttag = true;

    const artMatch = name.match(/^(reste|brotzeit)\b[,:]?\s*(.*)$/i);
    if (artMatch) {
      tag.mahlzeiten[kategorie] = { art: artMatch[1].toLowerCase(), recipeId: "", portionen: null, notiz: artMatch[2].trim() };
      return;
    }

    const r = findRecipeByName(name);
    if (r) tag.mahlzeiten[kategorie] = { art: "rezept", recipeId: r.id, portionen, notiz: "" };
    else unmatched.push(line);
  });

  tage.sort((a, b) => (a.datum < b.datum ? -1 : 1));
  return { tage, unmatched, ohneDatum, prepZeilen };
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
    const sortiert = teil.slice().sort((a, b) => a.name.length - b.name.length);
    return sortiert[0].name.length < sortiert[1].name.length ? sortiert[0] : null;
  }

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
    const url = teilenLink();
    if (navigator.share) navigator.share({ title: "Essensplan", text, url }).catch(() => {});
    else copyToClipboard(`${text}\n\n${url}`, teilen, "Woche teilen");
  });
  wrap.appendChild(teilen);

  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "btn secondary full";
  linkBtn.style.marginTop = "8px";
  linkBtn.textContent = "Link zur Woche kopieren";
  linkBtn.addEventListener("click", () => copyToClipboard(teilenLink(), linkBtn, "Link zur Woche kopieren"));
  wrap.appendChild(linkBtn);

  const zutaten = rohliste();
  if (zutaten.length) {
    const det = document.createElement("details");
    det.className = "klapp";
    det.style.marginTop = "14px";
    det.innerHTML = `
      <summary>Zutaten der ganzen Woche, ${zutaten.length} Posten</summary>
      <div class="klapp-inhalt">
        <p class="small-note" style="margin-top:0">
          Rohe Summe aus allen geplanten Mahlzeiten, alphabetisch.
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
  let letzterTag = "";
  alleSlots().forEach(({ tag, kat, slot }) => {
    if (tag.datum !== letzterTag) {
      zeilen.push(`${tagLabel(tag.datum)}${tag.sporttag ? " (Sport)" : ""}`);
      letzterTag = tag.datum;
    }
    zeilen.push(`  ${katLabel(kat)}: ${slotGericht(slot)}`);
  });
  return zeilen.join("\n");
}

function aktualisiereKopiertext() {
  const out = document.getElementById("kopiertext");
  if (out) out.value = buildKopiertext();
}

function buildKopiertext() {
  const lines = [];
  alleSlots().forEach(({ tag, kat, slot }) => {
    const gericht = slotGericht(slot);
    if (!gericht) return;
    const katTeil = kat !== "abendessen" ? ` (${katLabel(kat)})` : "";
    const r = slot.art === "rezept" ? rezeptMitId(slot.recipeId) : null;
    const menge = r && slotPortionen(slot) !== STANDARD_PORTIONEN ? ` x${portionenText(slotPortionen(slot))}` : "";
    lines.push(`${tagLabel(tag.datum)}${katTeil}: ${gericht}${menge}${tag.sporttag ? " (Sporttag)" : ""}`);
  });

  // Vorkochen im gewohnten Format, damit der Chat es unverändert lesen kann.
  const prep = vorkochGruppen().map(g => `Meal Prep: ${g.rezept.name} x${portionenText(g.portionen)}`);
  if (prep.length) {
    lines.push("");
    lines.push(...prep);
  }
  return lines.join("\n");
}

// ---------- WÄCHTER ----------

// Die Prüfungen arbeiten mit dem, was in rezepte.json steht. Eine Salzangabe
// gibt es dort nicht, deshalb läuft der Salzblick über die Tags, nicht über Zahlen.
function wochenHinweise() {
  const hinweise = [];
  const gerichte = alleSlots()
    .filter(e => e.slot.art === "rezept")
    .map(e => ({ tag: e.tag, kat: e.kat, r: rezeptMitId(e.slot.recipeId) }))
    .filter(x => x.r);

  const ausnahmen = gerichte.filter(x => x.r.ausnahme);
  if (ausnahmen.length > 1) {
    hinweise.push(`${ausnahmen.length} Ausnahmegerichte in dieser Planung: ${ausnahmen.map(x => x.r.name).join(", ")}. Vorgesehen ist eines pro Woche.`);
  }

  const salzig = gerichte.filter(x => (x.r.tags || []).some(t => String(t).toLowerCase().includes("salzig")));
  if (salzig.length > 1) {
    hinweise.push(`${salzig.length} salzig-herzhafte Gerichte: ${salzig.map(x => x.r.name).join(", ")}. In rezepte.json steht kein Salzwert, das ist nur der Tag-Blick.`);
  }

  const mitSalz = gerichte.filter(x => salzWert(x.r) != null);
  if (mitSalz.length) {
    const tage = new Set(gerichte.map(x => x.tag.datum)).size || 1;
    const proTag = mitSalz.reduce((a, x) => a + salzWert(x.r), 0) / tage;
    hinweise.push(`Salz aus den geplanten Gerichten: im Schnitt ${salzText(proTag)} pro Tag und Person, ohne Frühstück, Brotzeit und Vorratsfach. Einen Zielwert gibt keine Projektdatei vor, den setzt ihr mit dem Arzt.`);
  }

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
  alleSlots().forEach(({ tag, slot }) => {
    if (slot.art !== "rezept") return;
    const r = rezeptMitId(slot.recipeId);
    if (r && r.rest) reste.push({ tag: tagLabel(tag.datum), rest: String(r.rest), quelle: r.name });
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

  alleSlots().forEach(({ slot }) => {
    if (slot.art !== "rezept") return;
    const r = rezeptMitId(slot.recipeId);
    if (r) addiere(r, slotPortionen(slot) / ergiebigkeit(r));
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

  if (driftHinweis.length) {
    const warn = document.createElement("div");
    warn.className = "note-box exception";
    warn.style.marginBottom = "14px";
    warn.innerHTML = `<strong>Original hat sich geändert</strong><p>Bei ${escapeHtml(driftHinweis.join(", "))} sieht das Feld in ${escapeHtml(DATA_FILE)} inzwischen anders aus als zu dem Zeitpunkt, als du es angepasst hast. Prüf, ob deine Änderung noch stimmt, oder setz sie zurück.</p>`;
    wrap.appendChild(warn);
  }

  const kopf = document.createElement("div");
  kopf.className = "day-card";
  kopf.style.marginBottom = "18px";
  kopf.innerHTML = `
    <span class="label">Datenstand</span>
    <div class="daten-zahlen">
      <div><strong>${ROH_RECIPES.length}</strong><span>Rezepte in ${escapeHtml(DATA_FILE)}</span></div>
      <div><strong>${geaendert.length}</strong><span>davon lokal angepasst</span></div>
    </div>
    <p class="small-note" style="margin:4px 0 10px">Stand der Datei: ${escapeHtml(dateiStand || "unbekannt, der Server liefert kein Datum")}</p>
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
    if (driftHinweis.includes(r.name)) felder.push("Original geändert");

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

  // Archiv abgeschlossener Wochen
  const labelA = document.createElement("span");
  labelA.className = "label";
  labelA.style.display = "block";
  labelA.style.margin = "24px 0 8px";
  labelA.textContent = "Abgeschlossene Wochen";
  wrap.appendChild(labelA);

  if (!archiv.length) {
    const leer = document.createElement("p");
    leer.className = "small-note";
    leer.textContent = "Noch keine. In der Planung unten auf Woche abschließen tippen.";
    wrap.appendChild(leer);
  }

  archiv.forEach(eintrag => {
    const karte = document.createElement("div");
    karte.className = "day-card";
    karte.style.marginBottom = "10px";
    const mitUrteil = eintrag.gerichte.filter(g => g.urteil).length;
    karte.innerHTML = `
      <div class="prep-kopf">
        <span class="prep-name">${escapeHtml(tagLabel(eintrag.von))} bis ${escapeHtml(tagLabel(eintrag.bis))}</span>
        <span class="prep-info">${eintrag.gerichte.length} Gerichte</span>
      </div>
      <span class="prep-info">${mitUrteil} bewertet${eintrag.notiz ? " · Notiz vorhanden" : ""}</span>
      <div class="ab-gerichte">
        ${eintrag.gerichte.map(g => `<div class="vk-zeile">
          <span>${escapeHtml(g.name)}</span>
          <span class="prep-info">${escapeHtml(g.urteil || "kein Urteil")}${g.kind === true ? " · Kind ja" : g.kind === false ? " · Kind nein" : ""}</span>
        </div>`).join("")}
      </div>
      ${eintrag.notiz ? `<div class="day-rest">${escapeHtml(eintrag.notiz)}</div>` : ""}
      <div class="day-actions">
        <button class="btn secondary" type="button" data-act="kopieren">Rückblick kopieren</button>
        <button class="btn secondary" type="button" data-act="zurueck">Wiederherstellen</button>
        <button class="btn secondary" type="button" data-act="weg">Löschen</button>
      </div>
    `;
    karte.querySelector('[data-act="kopieren"]').addEventListener("click", (e) =>
      copyToClipboard(wochenRueckblickText(eintrag), e.currentTarget, "Rückblick kopieren"));
    karte.querySelector('[data-act="zurueck"]').addEventListener("click", () => {
      if (plan.tage.length && !confirm("Aktuelle Planung ersetzen?")) return;
      plan = { tage: JSON.parse(JSON.stringify(eintrag.tage || [])) };
      savePlan();
      plan = loadPlan();
      pruefePlanBezuege();
      ui.view = "planung";
      saveUi();
      render();
      meldung("Woche wiederhergestellt");
    });
    karte.querySelector('[data-act="weg"]').addEventListener("click", () => {
      if (!confirm("Diesen Eintrag aus dem Archiv löschen?")) return;
      archiv = archiv.filter(x => x !== eintrag);
      saveArchiv();
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

  // Darstellung
  const labelD = document.createElement("span");
  labelD.className = "label";
  labelD.style.display = "block";
  labelD.style.margin = "24px 0 8px";
  labelD.textContent = "Darstellung";
  wrap.appendChild(labelD);

  const dar = document.createElement("div");
  dar.className = "day-card";
  dar.style.marginBottom = "18px";
  dar.innerHTML = `
    <p class="small-note" style="margin-top:0">Schriftgröße für Rezepte, Zutaten und Kochmodus. Die Seite selbst bleibt fest, damit beim Kochen nichts verrutscht.</p>
    <div class="segmented">
      ${[["normal", "Normal"], ["gross", "Groß"], ["riesig", "Riesig"]].map(([k, t]) =>
        `<button type="button" data-groesse="${k}"${ui.textgroesse === k ? ' class="aktiv"' : ""}>${t}</button>`).join("")}
    </div>
  `;
  dar.querySelectorAll("[data-groesse]").forEach(b => {
    b.addEventListener("click", () => {
      ui.textgroesse = b.dataset.groesse;
      saveUi();
      render();
    });
  });
  wrap.appendChild(dar);

  // Sicherung
  const label4 = document.createElement("span");
  label4.className = "label";
  label4.style.display = "block";
  label4.style.margin = "24px 0 8px";
  label4.textContent = "Sicherung";
  wrap.appendChild(label4);

  const sich = document.createElement("div");
  sich.className = "day-card";
  sich.innerHTML = `
    <p class="small-note" style="margin-top:0">
      Wochenplanung und eigene Anpassungen liegen im Speicher des Browsers.
      Löschst du die App vom Homescreen oder räumt Safari auf, sind sie weg.
      Die Sicherung enthält beides, nicht die Rezepte selbst.
    </p>
  `;

  const sdl = document.createElement("button");
  sdl.className = "btn primary full";
  sdl.type = "button";
  sdl.textContent = "Sicherung herunterladen";
  sdl.addEventListener("click", () => datenDownload(`futterassi-sicherung-${heuteIso()}.json`, sicherungJson(), "application/json"));
  sich.appendChild(sdl);

  const scp = document.createElement("button");
  scp.className = "btn secondary full";
  scp.type = "button";
  scp.style.marginTop = "8px";
  scp.textContent = "Sicherung kopieren";
  scp.addEventListener("click", () => copyToClipboard(sicherungJson(), scp, "Sicherung kopieren"));
  sich.appendChild(scp);

  const det = document.createElement("details");
  det.className = "klapp";
  det.style.marginTop = "12px";
  det.innerHTML = `
    <summary>Sicherung einlesen</summary>
    <div class="klapp-inhalt">
      <p class="small-note" style="margin-top:0">Ersetzt die aktuelle Planung und alle Anpassungen auf diesem Gerät.</p>
      <div class="copy-panel"><textarea id="sicherung-text" placeholder="Inhalt der Sicherungsdatei hier einfügen"></textarea></div>
    </div>
  `;
  const einlesen = document.createElement("button");
  einlesen.className = "btn secondary full";
  einlesen.type = "button";
  einlesen.style.marginTop = "8px";
  einlesen.textContent = "Einlesen";
  einlesen.addEventListener("click", () => {
    const text = det.querySelector("#sicherung-text").value;
    if (!text.trim()) return;
    if (!confirm("Planung und Anpassungen auf diesem Gerät ersetzen?")) return;
    const meldung = sicherungEinlesen(text);
    alert(meldung);
    render();
  });
  det.querySelector(".klapp-inhalt").appendChild(einlesen);
  sich.appendChild(det);
  wrap.appendChild(sich);

  return wrap;
}

function sicherungJson() {
  return JSON.stringify({
    typ: "futterassi-sicherung",
    version: 1,
    erstellt: heuteIso(),
    plan,
    patches,
    archiv
  }, null, 2);
}

function sicherungEinlesen(text) {
  let daten;
  try {
    daten = JSON.parse(text);
  } catch (e) {
    return "Das war kein gültiges JSON, nichts geändert.";
  }
  if (!daten || daten.typ !== "futterassi-sicherung") return "Das sieht nicht nach einer Futterassi-Sicherung aus, nichts geändert.";

  if (daten.patches && typeof daten.patches === "object") {
    speichern(LS_PATCH, daten.patches);
    patches = loadPatches();
    RECIPES = mergeRecipes();
    pruefePatchDrift();
  }
  if (daten.plan && typeof daten.plan === "object") {
    speichern(LS_PLAN, daten.plan);
    plan = loadPlan();
    pruefePlanBezuege();
  }
  if (Array.isArray(daten.archiv)) {
    speichern(LS_ARCHIV, daten.archiv);
    archiv = loadArchiv();
  }
  return `Eingelesen: ${plan.tage.length} Tag(e), ${Object.keys(patches).length} angepasste Rezepte, ${archiv.length} archivierte Woche(n).`;
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
    const sauber = Object.assign({}, p);
    delete sauber._stempel;
    return Object.assign({}, r, sauber);
  });
  const inhalt = DATEI_WRAPPER ? { stand: heuteIso(), rezepte: daten } : daten;
  return JSON.stringify(inhalt, null, 2);
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
      p.schritte.forEach((x, i) => zeilen.push(`  ${i + 1}. ${schrittText(x)}`));
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
