// Right-rail STATS, LAYERS MENU drawer, score breakdown card, EVENT ALERT and credits panel.
import { doseModel, type LayerStore, type RadiationCfg } from "./layers";
import { escapeHtml } from "./search";
import { lon360 } from "./geo";
import type { Scored } from "./score/score";

const $ = (id: string) => document.getElementById(id)!;
const NA = "[--]";

// ---------------------------------------------------------------- STATS

export function updateStats(L: LayerStore, rad: RadiationCfg, lat: number, lon: number) {
  const set = (id: string, text: string, src: string, model = false) => {
    const el = $(id);
    el.textContent = text;
    el.dataset.src = src;
    el.classList.toggle("model", model && text !== NA);
  };
  const cite = (id: string) => { const m = L.meta(id); return m ? `${m.name} — ${m.citation}. ${m.source}` : id; };

  const alb = L.value("albedo", lat, lon);
  set("st-optical", alb === null ? NA : `albedo ${alb.toFixed(3)}`, cite("albedo"));

  const elev = L.value("elevation", lat, lon);
  set("st-radiation", elev === null ? NA : `${doseModel(elev, rad).toFixed(2)} mSv/day`,
    `MODEL: surface galactic-cosmic-ray dose vs atmospheric column, calibrated to Curiosity RAD 0.67 mSv/day at Gale ` +
    `(Hassler et al. 2014, Science 343) and 1.84 mSv/day in cruise (Zeitlin et al. 2013, Science 340); column from MOLA elevation ` +
    `${elev === null ? "" : `(${(elev / 1000).toFixed(2)} km)`}, scale height ${rad.scale_height_m / 1000} km. Solar particle events are not included.`, true);


  const mins = L.minerals().map((m) => ({ m, v: L.value(m.id, lat, lon) })).filter((x) => x.v !== null) as { m: any; v: number }[];
  if (!mins.length) set("st-minerals", NA, "MGS TES mineral maps (Bandfield 2002): no retrieval at this location (dusty or polar areas are masked).");
  else {
    const ranked = mins.map((x) => ({ ...x, r: x.v / (x.m.midrange || 1) })).sort((a, b) => b.r - a.r);
    const show = ranked.filter((x) => x.r >= 1).slice(0, 2);
    const list = (show.length ? show : ranked.slice(0, 1)).map((x) => `${short(x.m.mineral)} ${x.v.toFixed(2)}`).join(" · ");
    set("st-minerals", list, `MGS TES mineral abundances (Bandfield 2002, JGR 107; 16 km). Shown: minerals above their global mid-range ` +
      `(else the strongest). All here: ${ranked.map((x) => `${x.m.mineral} ${x.v.toFixed(3)}`).join(", ")}. ${L.minerals()[0]?.source ?? ""}`);
  }

  const ti = L.value("ti", lat, lon);
  const tmax = L.value("wx_tmax", lat, lon), tmin = L.value("wx_tmin", lat, lon);
  if (tmax !== null && tmin !== null)
    set("st-temperature", `${tmax.toFixed(0)} / ${tmin.toFixed(0)} °C day / night`,
      `MODEL: ground temperature, daily maximum / nightly minimum for ${L.seasonLabel()}. ${cite("wx_tmax")}` +
      (ti === null ? "" : ` Thermal inertia here: ${ti.toFixed(0)} (${tiClass(ti)}; ${cite("ti")}).`), true);
  else set("st-temperature", ti === null ? NA : `TI ${ti.toFixed(0)} · ${tiClass(ti)}`,
    `${cite("ti")}. Thermal inertia sets how fast the ground heats and cools (low = dust, swings widely; high = rock).`);
}

function short(n: string) {
  return ({ "Sheet silicates / glass": "Clay/glass", Clinopyroxene: "Cpx", Orthopyroxene: "Opx", Plagioclase: "Plag", "K-feldspar": "K-fsp" } as Record<string, string>)[n] ?? n;
}
function tiClass(ti: number) { return ti < 150 ? "dust" : ti < 400 ? "sand" : ti < 800 ? "rocky" : "bedrock"; }

// ---------------------------------------------------------------- danger bar
export function setDanger(h: number | null) {
  const m = $("danger-marker");
  if (h === null) { m.hidden = true; return; }
  m.hidden = false;
  m.style.left = `calc(${(Math.max(0, Math.min(1, h)) * 100).toFixed(1)}% - 1px)`;
  m.title = `site hazard ${(h * 100).toFixed(0)}% (1 − safety term)`;
}

// ---------------------------------------------------------------- site score card
export function renderSiteCard(s: Scored & { approximate?: boolean; location_method?: string; source?: string },
                               rank: number, of: number, w: { science: number; safety: number; access: number }, hasTerrain: boolean) {
  const f = s.features, t = s.terms, c = s.contrib;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const wsum = w.science + w.safety + w.access;
  const row = (k: string, term: number, wt: number, con: number) =>
    `<tr><td>${k}</td><td class="num">${term.toFixed(2)}</td><td class="num">× ${(wt / wsum).toFixed(2)}</td><td class="num">= ${con.toFixed(3)}</td></tr>`;
  const card = $("sitecard");
  card.innerHTML = `
    <div class="sc-head">
      <div class="sc-title"><span class="sc-name">${escapeHtml(s.name)}</span><span class="sc-rank">#${rank} of ${of}</span></div>
      <div class="sc-btns"><button class="x min" id="sitecard-min" title="Collapse / expand">–</button><button class="x" id="sitecard-close" title="Close (Esc)">×</button></div>
    </div>
    <div class="sc-coords num">${s.lat.toFixed(3)}, ${lon360(s.lon).toFixed(3)} ${s.approximate ? '<span class="badge" title="' + escapeHtml(s.location_method ?? "") + '">approx. location</span>' : ""}</div>
    <div class="sc-score"><span class="label">Score</span><span class="num big">${s.score.toFixed(3)}</span></div>
    <table class="sc-terms"><tr class="h"><td>term</td><td>value</td><td>weight</td><td>contribution</td></tr>
      ${row("Science", t.science, w.science, c.science)}${row("Safety", t.safety, w.safety, c.safety)}${row("Access", t.access, w.access, c.access)}
      <tr class="sum"><td>Total</td><td></td><td></td><td class="num">= ${(c.science + c.safety + c.access).toFixed(3)}</td></tr></table>
    <details open><summary>Inputs (100 km radius, ${f.samples} samples)</summary>
      <ul class="sc-inputs">
        <li><b>Science</b>: ${f.units} geologic units <i data-src="Tanaka et al. 2014, USGS SIM 3292">(SIM 3292: ${f.unitCodes.slice(0, 8).join(", ")}${f.unitCodes.length > 8 ? "…" : ""})</i>;
          ${f.minerals.length} TES minerals above mid-range <i data-src="Bandfield 2002, JGR 107; ASU Mars Global Data Sets">(${f.minerals.join(", ") || "none"})</i>;
          ${f.names} named features <i data-src="IAU/USGS Gazetteer of Planetary Nomenclature">(Gazetteer)</i></li>
        <li><b>Safety</b>: ${pct(f.steepShare)} of cells steeper than 15° <i data-src="MGS MOLA 463 m, decimated to ~5 km cells">(MOLA)</i>;
          ${pct(f.dustShare)} bright + low-thermal-inertia dust <i data-src="TES albedo (Christensen et al. 2001) + TES thermal inertia (Putzig & Mellon 2007)">(TES)</i></li>
        <li><b>Access</b>: median elevation ${(f.elev_m / 1000).toFixed(2)} km <i data-src="MGS MOLA">(MOLA)</i>; |latitude| ${f.absLat.toFixed(1)}°</li>
      </ul></details>
    <p class="sc-note">Global data is km-scale and ranks regions only; walk safety comes from the site DTM.</p>
    ${s.source ? `<p class="sc-src">Location source: ${escapeHtml(s.location_method ?? "")}<br/><span class="num">${escapeHtml(s.source)}</span></p>` : ""}
    <p class="sc-terrain">${hasTerrain ? "Detailed HiRISE terrain is available here → MAP card." : "No detailed terrain yet for this site."}</p>`;
  card.hidden = false;
  // closing the card ends the selection: main.ts clears the globe marker and the name tag too
  $("sitecard-close").addEventListener("click", () => { card.hidden = true; window.dispatchEvent(new CustomEvent("marswalk:deselect")); });
  $("sitecard-min").addEventListener("click", () => card.classList.toggle("collapsed"));
}

// ---------------------------------------------------------------- drawer
export interface DrawerHandlers {
  onLayer(id: string, on: boolean, opacity: number): void;
  onOpacity(id: string, opacity: number): void;
  onMineral(id: string): void;
  onWeights(w: { science: number; safety: number; access: number }): void;
  onExag(v: number): void;
  onTopPick(id: string): void;
  onCredits(): void;
}

export function buildDrawer(L: LayerStore, weights: { science: number; safety: number; access: number }, h: DrawerHandlers) {
  const d = $("drawer");
  const mins = L.minerals();
  const rows = [
    { id: "elevation", name: "Elevation (MOLA)" }, { id: "geology", name: "Geology (SIM 3292)" },
    { id: "ti", name: "Thermal inertia (TES)" }, { id: "mineral", name: "Minerals (TES)" },
    { id: "dust", name: "Dust (TES)" }, { id: "albedo", name: "Albedo (TES)" },
    { id: "science", name: "Science score heatmap (model)" },
  ];
  d.innerHTML = `
    <div class="dr-head"><span class="label">Layers menu</span><button class="x" id="drawer-close">×</button></div>
    <section><div class="label small">Global data layers</div>
      ${rows.map((r) => `
        <div class="dr-row" data-id="${r.id}">
          <label><input type="checkbox" data-layer="${r.id}" /> ${r.name}</label>
          ${r.id === "mineral" ? `<select id="dr-mineral">${mins.map((m) => `<option value="${m.id}">${escapeHtml(m.mineral ?? m.id)}</option>`).join("")}</select>` : ""}
          <input type="range" min="0" max="1" step="0.05" value="0.7" data-op="${r.id}" />
          <span class="dr-src" data-src="${escapeHtml(srcOf(L, r.id === "mineral" ? mins[0]?.id : r.id))}">i</span>
        </div>`).join("")}
      <div class="dr-row"><label>Relief ×</label><input type="range" id="dr-exag" min="1" max="30" step="1" value="4" /><span class="num" id="dr-exag-v">4×</span></div>
    </section>
    <section><div class="label small">Weather this season <span class="dr-note-inline">${escapeHtml(L.seasonLabel())}</span></div>
      ${L.weather().map((m) => `
        <div class="dr-row" data-id="${m.id}">
          <label><input type="checkbox" data-layer="${m.id}" /> ${escapeHtml(m.name.replace(" (MCD)", ""))}</label>
          <input type="range" min="0" max="1" step="0.05" value="0.7" data-op="${m.id}" />
          <span class="dr-src" data-src="${escapeHtml(srcOf(L, m.id))}">i</span>
        </div>`).join("")}
      <p class="dr-note">Mars Climate Database v6.2 (LMD / ESA / CNES): model climatology for today's season, ~300 km cells.</p>
    </section>
    <section><div class="label small">Best-spot score weights</div>
      ${(["science", "safety", "access"] as const).map((k) => `
        <div class="dr-row"><label class="w">${k[0].toUpperCase() + k.slice(1)}</label><input type="range" min="0" max="3" step="0.1" value="${weights[k]}" data-w="${k}" /><span class="num" data-wv="${k}">${weights[k].toFixed(1)}</span></div>`).join("")}
      <p class="dr-note">Global data is km-scale and ranks regions only; walk safety comes from the site DTM.</p>
      <div class="label small">Top sites <span class="num" id="dr-rank-ms"></span></div>
      <ol id="dr-top"></ol>
    </section>
    <button class="dr-credits" id="dr-credits">Credits and data sources</button>`;
  $("drawer-close").addEventListener("click", () => (d.hidden = true));
  d.querySelectorAll<HTMLInputElement>("input[data-layer]").forEach((cb) => cb.addEventListener("change", () => {
    const op = Number(d.querySelector<HTMLInputElement>(`input[data-op="${cb.dataset.layer}"]`)!.value);
    h.onLayer(cb.dataset.layer!, cb.checked, op);
  }));
  d.querySelectorAll<HTMLInputElement>("input[data-op]").forEach((r) => r.addEventListener("input", () => h.onOpacity(r.dataset.op!, Number(r.value))));
  $("dr-mineral").addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    d.querySelector<HTMLElement>('.dr-row[data-id="mineral"] .dr-src')!.dataset.src = srcOf(L, id);
    h.onMineral(id);
  });
  const w = { ...weights };
  d.querySelectorAll<HTMLInputElement>("input[data-w]").forEach((r) => r.addEventListener("input", () => {
    (w as any)[r.dataset.w!] = Number(r.value);
    d.querySelector<HTMLElement>(`[data-wv="${r.dataset.w}"]`)!.textContent = Number(r.value).toFixed(1);
    h.onWeights({ ...w });
  }));
  $("dr-exag").addEventListener("input", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    $("dr-exag-v").textContent = `${v}×`;
    h.onExag(v);
  });
  $("dr-top").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (li) h.onTopPick(li.dataset.id!);
  });
  $("dr-credits").addEventListener("click", () => h.onCredits());
}

function srcOf(L: LayerStore, id?: string) {
  const m = id ? L.meta(id) : undefined;
  return m ? `${m.name} — ${m.citation}. ${m.source}` : "";
}

export function renderTop(ranked: Scored[], n: number, ms: number) {
  $("dr-rank-ms").textContent = `(re-ranked in ${ms.toFixed(1)} ms)`;
  $("dr-top").innerHTML = ranked.slice(0, n).map((s) =>
    `<li data-id="${s.id}"><span>${escapeHtml(s.name)}</span><span class="num">${s.score.toFixed(3)}</span></li>`).join("");
}

// ---------------------------------------------------------------- events
export function renderEvents(ev: any) {
  const el = $("event-text");
  const box = $("event");
  const fetched = (ev?.fetched ?? "").slice(0, 10);
  const src = `NASA DONKI (CCMC) space-weather database, cached ${fetched}; window ${ev?.window?.join(" – ") ?? "?"}. https://api.nasa.gov/DONKI/`;
  box.dataset.src = src;
  const lines: string[] = [];
  // several CMEs can be modelled to arrive at the same time: one line per distinct arrival
  const arrivals = [...new Map((ev?.mars_arrivals ?? []).map((a: any) => [`${String(a.arrival).slice(0, 16)}${a.glancing ? "g" : ""}`, a])).values()].slice(-2) as any[];
  for (const a of arrivals) lines.push(`CME arrival at Mars (model): ${String(a.arrival).replace("T", " ").slice(0, 16)}Z${a.glancing ? " · glancing" : ""}`);
  const cmes = (Array.isArray(ev?.CMEAnalysis) ? ev.CMEAnalysis : []).filter((c: any) => c.isMostAccurate);
  const last = cmes.sort((a: any, b: any) => String(b.time21_5).localeCompare(String(a.time21_5)))[0];
  if (last) lines.push(`Latest CME: ${String(last.time21_5).replace("T", " ").slice(0, 16)}Z · ${Math.round(last.speed)} km/s${last.type ? " · type " + last.type : ""}`);
  const ips = (Array.isArray(ev?.IPS) ? ev.IPS : []).filter((i: any) => /mars/i.test(i.location ?? ""));
  if (ips.length) lines.push(`Shock at Mars (MAVEN): ${String(ips[ips.length - 1].eventTime).replace("T", " ").slice(0, 16)}Z`);
  const seps = Array.isArray(ev?.SEP) ? ev.SEP.length : 0;
  lines.push(`Solar particle events (60 d): ${seps}`);
  el.innerHTML = lines.map((l) => `<span class="ev">${escapeHtml(l)}</span>`).join("") + `<span class="ev dim">cached ${escapeHtml(fetched)} · NASA DONKI</span>`;
}

// ---------------------------------------------------------------- credits
export function renderCredits(L: LayerStore) {
  const items: [string, string, string][] = [
    ["Viking MDIM 2.1 colour mosaic (globe texture)", "NASA/JPL-Caltech, USGS Astrogeology; tiles via NASA Mars Trek", "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars"],
    ...L.metas.map((m) => [m.name, m.citation, m.source] as [string, string, string]),
    ["Gazetteer of Planetary Nomenclature (Landmarks, search)", "IAU / USGS", "https://planetarynames.wr.usgs.gov/Page/MARS/target"],
    ["Landing sites (Missions)", "USGS SIM 3292 Global_Landing_sites; Perseverance: NASA/JPL MMGIS waypoints; InSight: Golombek et al. 2020", "https://pubs.usgs.gov/sim/3292/"],
    ["Exploration Zones (Bases)", "NASA First Landing Site/Exploration Zone Workshop (2015) abstracts", "https://www.nasa.gov/journeytomars/mars-exploration-zones/"],
    ["Space weather (event alert)", "NASA CCMC DONKI", "https://api.nasa.gov/"],
    ["Radiation model calibration", "Hassler et al. 2014 (Science 343, Curiosity RAD); Zeitlin et al. 2013 (Science 340)", "https://doi.org/10.1126/science.1244797"],
    ["Sun position, day / night and local solar time", "NASA GISS Mars24 algorithm (Allison & McEwen 2000, Planet. Space Sci. 48, 215): solar longitude, subsolar point, Sun distance, LTST", "https://www.giss.nasa.gov/tools/mars24/help/algorithm.html"],
    ["Background stars", "Yale Bright Star Catalogue, 5th rev. ed. (Hoffleit & Warren 1991) via NASA HEASARC; oriented with the IAU Mars pole and rotation (Archinal et al. 2011)", "https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html"],
    ["3D models: Habitat Demonstration Unit, Space Exploration Vehicle", "NASA 3D Resources (free to use, no copyright; NASA media usage guidelines)", "https://github.com/nasa/NASA-3D-Resources"],
    ["Walking astronaut (rigged, MarsWalk walk cycle)", "Astronaut_MarsWalk.glb, supplied by the project team", "project asset: data/processed/models/astronaut_marswalk.glb"],
    ["Site photos (location cards)", "NASA/JPL-Caltech/ASU/MSSS (Mastcam-Z), NASA/JPL-Caltech (Navcam, WATSON); per-image credit in the card", "https://mars.nasa.gov/mars2020/multimedia/raw-images/"],
    ["Site terrain (Phase 1)", "NASA/JPL-Caltech/University of Arizona (HiRISE), USGS Astrogeology, NASA/JPL-Caltech (Perseverance images)", "https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_hirise_dtm_mosaic"],
    ["Gale sites terrain (Yellowknife Bay, Gediz Vallis)", "MSL Gale Merged DEM 1 m and Orthophoto 25 cm mosaics (v3): NASA/JPL-Caltech/University of Arizona (HiRISE), USGS Astrogeology", "https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_digital_elevation_model_and_orthophoto"],
    ["Home Plate and Cape York terrain", "HiRISE DTMs DTEEC_001513_1655_001777_1650 (Gusev) and DTEEC_018701_1775_018846_1775 (Endeavour) with orthoimages: NASA/JPL-Caltech/University of Arizona", "https://www.uahirise.org/dtm/"],
    ["Spirit and Opportunity 3D scans and stops", "MER Navcam EDRs with CAHVOR camera models (NASA/JPL-Caltech, PDS Imaging Node); corrected rover traverses: MER Analyst's Notebook (PDS Geosciences Node, T. Parker)", "https://planetarydata.jpl.nasa.gov/img/data/mer/"],
    ["Gale 3D scans and stops","Curiosity Navcam raw images with CAHVOR camera models (NASA/JPL-Caltech); traverse: MSL MMGIS waypoints", "https://mars.nasa.gov/msl/multimedia/raw-images/"],
  ];
  $("credits").innerHTML = `<div class="cr-box"><div class="dr-head"><span class="label">Credits and data sources</span><button class="x" id="credits-close">×</button></div>
    <ul>${items.map(([n, c, u]) => /^https?:\/\//.test(u)
      ? `<li><b>${escapeHtml(n)}</b><br/>${escapeHtml(c)}<br/><a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a></li>`
      : `<li class="derived"><b>${escapeHtml(n)}</b> <span class="badge">derived in this app</span><br/>${escapeHtml(c)}<br/><i>${escapeHtml(u)}</i></li>`).join("")}</ul>
    <p class="dr-note">Credits: NASA/JPL-Caltech, USGS Astrogeology, NASA/JPL-Caltech/University of Arizona (HiRISE), NASA/JPL-Caltech/ASU (THEMIS, TES maps), NASA GSFC (MOLA), NASA CCMC (DONKI), IAU/USGS (nomenclature).</p></div>`;
  $("credits").hidden = false;
  $("credits-close").addEventListener("click", () => ($("credits").hidden = true));
}
