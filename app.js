// Futterassi - lokale Rezept-App
// Datenquelle: data/rezepte.json (wird im Chat gepflegt, hier nur gelesen)

const FILTER_TAGS = ["vegetarisch", "vegan", "High Protein", "Low Carb", "LEBER", "BLUTDRUCK", "SÄTTIGUNG", "SPORT"];
const LS_PLAN = "futterassi_plan_v1";
const LS_UI = "futterassi_ui_v1";

let RECIPES = [];
let ui = loadUi();
let plan = loadPlan();

function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(LS_UI)) || { view: "katalog", search: "", tags: [], showRaus: false };
  } catch (e) {
    return { view: "katalog", search: "", tags: [], showRaus: false };
  }
}
function saveUi() { localStorage.setItem(LS_UI, JSON.stringify(ui)); }

function loadPlan() {
  try {
    return JSON.parse(localStorage.getItem(LS_PLAN)) || { days: [], prep: [] };
  } catch (e) {
    return { days: [], prep: [] };
  }
}
function savePlan() { localStorage.setItem(LS_PLAN, JSON.stringify(plan)); }

async function init() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.view = btn.dataset.view;
      saveUi();
      render();
    });
  });

  try {
    const res = await fetch("data/rezepte.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    RECIPES = await res.json();
  } catch (e) {
    document.getElementById("app").innerHTML = `
      <div class="empty">
        <p><strong>Rezepte konnten nicht geladen werden.</strong></p>
        <p class="small-note">
          Diese App muss über einen echten Webserver laufen, zum Beispiel GitHub Pages,
          nicht als lokal geöffnete Datei. Wenn die URL mit file:// beginnt statt mit
          https://, ist das der Grund. Fehler: ${escapeHtml(e.message)}
        </p>
      </div>`;
    return;
  }

  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

function render() {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === ui.view));
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (ui.view === "katalog") app.appendChild(renderKatalog());
  else app.appendChild(renderPlanung());
}

// ---------- KATALOG ----------

function renderKatalog() {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const sb = document.createElement("div");
  sb.className = "search";
  sb.innerHTML = `<input type="text" placeholder="Rezept suchen" value="${escapeAttr(ui.search)}">`;
  sb.querySelector("input").addEventListener("input", (e) => {
    ui.search = e.target.value;
    saveUi();
    renderGridInto(grid);
  });
  wrap.appendChild(sb);

  const chipbar = document.createElement("div");
  chipbar.className = "chips";
  FILTER_TAGS.forEach(tag => {
    const c = document.createElement("button");
    c.className = "chip" + (ui.tags.includes(tag) ? " active" : "");
    c.textContent = tag;
    c.addEventListener("click", () => {
      if (ui.tags.includes(tag)) ui.tags = ui.tags.filter(t => t !== tag);
      else ui.tags.push(tag);
      saveUi();
      render();
    });
    chipbar.appendChild(c);
  });
  const rausChip = document.createElement("button");
  rausChip.className = "chip" + (ui.showRaus ? " active" : "");
  rausChip.textContent = ui.showRaus ? "raus: eingeblendet" : "raus ausgeblendet";
  rausChip.addEventListener("click", () => {
    ui.showRaus = !ui.showRaus;
    saveUi();
    render();
  });
  chipbar.appendChild(rausChip);
  wrap.appendChild(chipbar);

  const grid = document.createElement("div");
  grid.className = "recipe-list";
  wrap.appendChild(grid);
  renderGridInto(grid);

  return wrap;
}

function filteredRecipes() {
  return RECIPES.filter(r => {
    if (!ui.showRaus && r.status === "raus") return false;
    if (ui.search) {
      const s = ui.search.toLowerCase();
      if (!r.name.toLowerCase().includes(s)) return false;
    }
    if (ui.tags.length) {
      const rtags = r.tags || [];
      if (!ui.tags.every(t => rtags.includes(t))) return false;
    }
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function renderGridInto(grid) {
  const list = filteredRecipes();
  grid.innerHTML = "";
  if (!list.length) {
    grid.innerHTML = `<div class="empty">Nichts gefunden. Filter oder Suche anpassen.</div>`;
    return;
  }
  list.forEach(r => grid.appendChild(renderCard(r)));
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

function renderCard(r) {
  const card = document.createElement("button");
  card.className = "card";
  card.style.width = "100%";
  card.style.textAlign = "left";
  card.style.border = "1px solid var(--line)";
  const cat = mapCategory(r);
  if (cat) card.setAttribute("data-category", cat);
  card.addEventListener("click", () => openDetail(r));

  const badges = [`<span class="badge status ${statusClass(r.status)}">${r.status.toUpperCase()}</span>`];
  if (r.ausnahme) badges.push(`<span class="badge exception">AUSNAHME</span>`);
  if ((r.tags || []).includes("SPORT")) badges.push(`<span class="badge sport">SPORT</span>`);
  if (r.rest) badges.push(`<span class="badge rest">REST</span>`);

  const metrics = [];
  if (r.kcal) metrics.push(`<span class="metric"><strong>${r.kcal}</strong>&nbsp;kcal</span>`);
  if (r.protein) metrics.push(`<span class="metric"><strong>${r.protein}</strong>&nbsp;g Eiweiß</span>`);
  if (r.fett) metrics.push(`<span class="metric"><strong>${r.fett}</strong>&nbsp;g Fett</span>`);

  card.innerHTML = `
    <h3>${escapeHtml(r.name)}</h3>
    <div class="card-meta">${badges.join("")}</div>
    <div class="card-footer"><div class="metrics">${metrics.join("")}</div></div>
  `;
  return card;
}

// ---------- DETAIL / KOCHMODUS ----------

function openDetail(r) {
  const overlay = document.getElementById("overlay");
  overlay.classList.remove("hidden");
  overlay.innerHTML = "";
  overlay.style.background = "var(--bg)";
  overlay.style.padding = "16px";

  let portionen = r.basis || 2;

  const head = document.createElement("div");
  head.className = "recipe-header";
  head.innerHTML = `<button class="back">&larr;</button><h1>${escapeHtml(r.name)}</h1>`;
  head.querySelector(".back").addEventListener("click", closeOverlay);
  overlay.appendChild(head);

  const body = document.createElement("div");
  overlay.appendChild(body);

  function draw() {
    const metaBadges = [`<span class="badge status ${statusClass(r.status)}">${r.status.toUpperCase()}</span>`];
    if (r.zeit) metaBadges.push(`<span class="badge">${escapeHtml(r.zeit)}</span>`);
    if (r.geraete) metaBadges.push(`<span class="badge">${escapeHtml(r.geraete)}</span>`);

    body.innerHTML = `
      <div class="recipe-meta" style="margin-bottom:18px">${metaBadges.join("")}</div>

      ${r.notiz ? `<div class="note-box" style="margin-bottom:14px"><strong>Notiz</strong><p>${escapeHtml(r.notiz)}</p></div>` : ""}
      ${r.ausnahme && r.leichter ? `<div class="note-box exception" style="margin-bottom:14px"><strong>Leichter gebaut</strong><p>${escapeHtml(r.leichter)}</p></div>` : ""}

      <span class="label" style="display:block;margin-bottom:8px">Portionen</span>
      <div class="portions" style="margin-bottom:24px">
        <span></span>
        <div class="portion-control">
          <button data-d="-1">−</button>
          <span class="portion-value" id="portion-count">${portionen}</span>
          <button data-d="1">+</button>
        </div>
      </div>

      <span class="label" style="display:block;margin-bottom:8px">Zutaten</span>
      <ul class="ingredients" id="zutaten-list" style="margin-bottom:24px"></ul>

      <span class="label" style="display:block;margin-bottom:8px">Zubereitung</span>
      <ol class="steps" style="margin-bottom:28px">
        ${(r.schritte || []).map(s => `<li><p>${escapeHtml(s)}</p></li>`).join("")}
      </ol>

      <div style="display:flex;gap:10px">
        <button class="btn secondary full" id="btn-copy">Zutaten kopieren</button>
        <button class="btn primary full" id="btn-cook">Kochmodus</button>
      </div>
    `;

    body.querySelectorAll(".portion-control button").forEach(b => {
      b.addEventListener("click", () => {
        const d = parseInt(b.dataset.d, 10);
        portionen = Math.max(1, portionen + d);
        draw();
      });
    });

    drawZutaten();

    body.querySelector("#btn-copy").addEventListener("click", () => {
      const factor = portionen / (r.basis || 2);
      const lines = (r.zutaten || []).map(z => zutatLine(z, factor));
      copyToClipboard(lines.join("\n"));
      flash(body.querySelector("#btn-copy"), "Kopiert");
    });

    body.querySelector("#btn-cook").addEventListener("click", () => openCookMode(r));
  }

  function drawZutaten() {
    const factor = portionen / (r.basis || 2);
    const el = body.querySelector("#zutaten-list");
    el.innerHTML = (r.zutaten || []).map(z => {
      return `<li><span>${escapeHtml(z.name)}</span><span class="amount">${zutatLine(z, factor, true)}</span></li>`;
    }).join("");
    const pc = body.querySelector("#portion-count");
    if (pc) pc.textContent = portionen;
  }

  draw();
}

function zutatLine(z, factor, onlyMenge) {
  let menge = "";
  if (z.menge != null) {
    const val = round1(z.menge * factor);
    menge = `${val}${z.einheit ? " " + z.einheit : ""}`;
  } else {
    menge = z.einheit || "";
  }
  if (onlyMenge) return menge;
  return `${menge ? menge + " " : ""}${z.name}`.trim();
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function closeOverlay() {
  document.getElementById("overlay").classList.add("hidden");
}

function openCookMode(r) {
  const steps = r.schritte || [];
  let i = 0;
  const cook = document.createElement("div");
  cook.className = "cook";
  cook.style.position = "fixed";
  cook.style.inset = "0";
  cook.style.zIndex = "1000";
  cook.style.paddingTop = "max(18px, env(safe-area-inset-top))";
  cook.style.paddingBottom = "max(20px, env(safe-area-inset-bottom))";
  document.body.appendChild(cook);

  function draw() {
    cook.innerHTML = `
      <div class="cook-progress">
        <button class="back" style="background:none;border:none;color:#fff;font-size:20px">&times;</button>
        <span>${i + 1} / ${steps.length}</span>
        <span>${escapeHtml(r.name)}</span>
      </div>
      <div class="cook-progress-bar"><span style="width:${Math.round(((i + 1) / Math.max(1, steps.length)) * 100)}%"></span></div>
      <div class="cook-step"><p>${escapeHtml(steps[i] || "Fertig.")}</p></div>
      <div class="cook-actions">
        <button class="btn secondary" ${i === 0 ? "disabled" : ""}>Zurück</button>
        <button class="btn primary">${i < steps.length - 1 ? "Weiter" : "Fertig"}</button>
      </div>
    `;
    cook.querySelector(".back").addEventListener("click", () => cook.remove());
    cook.querySelector(".btn.secondary").addEventListener("click", () => { i = Math.max(0, i - 1); draw(); });
    cook.querySelector(".btn.primary").addEventListener("click", () => {
      if (i < steps.length - 1) { i++; draw(); } else cook.remove();
    });
  }
  draw();
}

// ---------- PLANUNG ----------

function renderPlanung() {
  const wrap = document.createElement("div");
  wrap.className = "section";
  wrap.innerHTML = `<p class="small-note">Auswahl liegt nur auf diesem Gerät. Für Rezeptkarten, Einkaufsliste und Kalender den Kopiertext unten in den Chat einfügen.</p>`;

  wrap.appendChild(renderImportPanel());

  const dayList = document.createElement("div");
  wrap.appendChild(dayList);
  plan.days.forEach((d, idx) => dayList.appendChild(renderDayCard(d, idx)));

  const addBtn = document.createElement("button");
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

function renderDayCard(day, idx) {
  const card = document.createElement("div");
  card.className = "day-card";
  card.style.marginBottom = "12px";

  const abendessen = RECIPES.filter(r => r.status !== "raus" && (r.typ === "abendessen" || r.typ === "mittag"));
  const sorted = [...abendessen].sort((a, b) => {
    if (day.sporttag) {
      const aS = (a.tags || []).includes("SPORT");
      const bS = (b.tags || []).includes("SPORT");
      if (aS !== bS) return aS ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "de");
  });

  const selected = RECIPES.find(r => r.id === day.recipeId);
  const lowCarbWarn = day.sporttag && selected && (selected.tags || []).includes("Low Carb");

  card.innerHTML = `
    <div class="day-card-header">
      <input type="text" class="day-label" placeholder="z.B. Mi 19.08." value="${escapeAttr(day.label)}">
      <button class="toggle${day.sporttag ? " active" : ""}" type="button" title="Sporttag"></button>
    </div>
    <select>
      <option value="">Rezept wählen</option>
      ${sorted.map(r => `<option value="${r.id}" ${r.id === day.recipeId ? "selected" : ""}>${escapeHtml(r.name)}${(r.tags||[]).includes("SPORT") ? " · SPORT" : ""}</option>`).join("")}
    </select>
    ${lowCarbWarn ? `<div class="warn-lowcarb">Low Carb an einem Sporttag, laut Vorgabe eigentlich nicht vorgesehen.</div>` : ""}
    <button class="btn secondary full" style="margin-top:10px">Kochtag entfernen</button>
  `;

  card.querySelector("input.day-label").addEventListener("input", (e) => {
    day.label = e.target.value; savePlan();
  });
  card.querySelector(".toggle").addEventListener("click", () => {
    day.sporttag = !day.sporttag; savePlan(); render();
  });
  card.querySelector("select").addEventListener("change", (e) => {
    day.recipeId = e.target.value; savePlan(); render();
  });
  card.querySelector("button.btn.secondary").addEventListener("click", () => {
    plan.days.splice(idx, 1); savePlan(); render();
  });

  return card;
}

function renderPrepPanel() {
  const wrap = document.createElement("div");

  const mittag = RECIPES.filter(r => r.status !== "raus" && r.typ === "mittag");
  const target = 10;

  const list = document.createElement("div");
  list.className = "day-card";
  list.style.marginBottom = "12px";
  list.innerHTML = `
    <span class="label" style="display:block;margin-bottom:8px">Meal Prep Mittag</span>
    ${mittag.map(r => {
      const entry = plan.prep.find(p => p.id === r.id);
      const val = entry ? entry.portionen : 0;
      return `<div class="row-between">
        <span>${escapeHtml(r.name)}</span>
        <input type="number" min="0" step="1" value="${val}" data-id="${r.id}" style="width:60px;text-align:right;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg)">
      </div>`;
    }).join("")}
  `;

  const summary = document.createElement("div");
  summary.className = "meal-prep";
  summary.style.marginBottom = "18px";
  summary.innerHTML = `
    <div class="meal-prep-header">
      <span class="label" style="color:#B4B6B0">Ziel ${target} Portionen</span>
      <span class="meal-prep-value" id="prep-value">0 / ${target}</span>
    </div>
    <div class="progress"><span id="prep-fill" style="width:0%"></span></div>
  `;

  function sum() { return plan.prep.reduce((a, p) => a + (p.portionen || 0), 0); }
  function updateBar() {
    const s = sum();
    summary.querySelector("#prep-fill").style.width = Math.min(100, (s / target) * 100) + "%";
    summary.querySelector("#prep-value").textContent = `${s} / ${target}`;
  }

  list.querySelectorAll("input[type=number]").forEach(inp => {
    inp.addEventListener("input", () => {
      const id = inp.dataset.id;
      const v = parseInt(inp.value, 10) || 0;
      let entry = plan.prep.find(p => p.id === id);
      if (!entry) { entry = { id, portionen: 0 }; plan.prep.push(entry); }
      entry.portionen = v;
      savePlan();
      updateBar();
    });
  });

  updateBar();
  wrap.appendChild(list);
  wrap.appendChild(summary);
  return wrap;
}

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
    <button class="btn primary full" id="import-btn" style="margin-top:8px">Übernehmen</button>
    <div id="import-result" class="small-note" style="margin-bottom:0"></div>
  `;

  box.querySelector("#import-btn").addEventListener("click", () => {
    const text = box.querySelector("#import-text").value;
    if (!text.trim()) return;
    if (plan.days.length && !confirm("Aktuelle Wochenplanung auf diesem Gerät ersetzen?")) return;
    const result = parseImportText(text);
    plan.days = result.days;
    plan.prep = result.prep;
    savePlan();
    renderImportResult(box.querySelector("#import-result"), result);
    render();
  });

  return box;
}

function parseImportText(text) {
  const days = [];
  const prep = [];
  const unmatched = [];

  text.split("\n").forEach(raw => {
    const line = raw.trim();
    if (!line) return;

    const prepMatch = line.match(/^Meal Prep:\s*(.+?)\s*x(\d+)\s*$/i);
    if (prepMatch) {
      const r = findRecipeByName(prepMatch[1]);
      if (r) prep.push({ id: r.id, portionen: parseInt(prepMatch[2], 10) });
      else unmatched.push(line);
      return;
    }

    const dayMatch = line.match(/^(.+?):\s*(.+)$/);
    if (dayMatch) {
      let name = dayMatch[2].trim();
      let sporttag = false;
      const sportMatch = name.match(/^(.*?)\s*\(Sporttag\)\s*$/i);
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

function findRecipeByName(name) {
  const n = name.toLowerCase().trim();
  let match = RECIPES.find(r => r.name.toLowerCase() === n);
  if (match) return match;
  const candidates = RECIPES.filter(r => r.name.toLowerCase().includes(n) || n.includes(r.name.toLowerCase()));
  if (candidates.length === 1) return candidates[0];
  return null;
}

function renderImportResult(el, result) {
  const parts = [];
  parts.push(`${result.days.length} Kochtag(e) übernommen`);
  if (result.prep.length) parts.push(`${result.prep.length} Meal-Prep-Eintrag/Einträge übernommen`);
  if (result.unmatched.length) {
    parts.push(`nicht erkannt: ${result.unmatched.map(l => `"${l}"`).join(", ")}`);
  }
  el.textContent = parts.join(", ") + ". Nicht erkannte Zeilen bitte oben in den Kochtag-Karten manuell zuordnen.";
}

function renderKopiertext() {
  const wrap = document.createElement("div");

  const label = document.createElement("span");
  label.className = "label";
  label.style.display = "block";
  label.style.marginBottom = "8px";
  label.textContent = "Kopiertext für den Chat";
  wrap.appendChild(label);

  const panel = document.createElement("div");
  panel.className = "copy-panel";
  const out = document.createElement("textarea");
  out.readOnly = true;
  out.value = buildKopiertext();
  panel.appendChild(out);
  wrap.appendChild(panel);

  const btn = document.createElement("button");
  btn.className = "btn primary full";
  btn.style.marginTop = "8px";
  btn.textContent = "Kopiertext kopieren";
  btn.addEventListener("click", () => {
    copyToClipboard(out.value);
    flash(btn, "Kopiert");
  });
  wrap.appendChild(btn);

  return wrap;
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

function copyToClipboard(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text);
}

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

init();
