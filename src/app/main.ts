import "./style.css";
import { BUST } from "./bust";
import * as THREE from "three";
import { Globe, type MolaMeta } from "./globe";
import { wordmarkSVG } from "./wordmark";
import { fmtCoords, gcDistance, lon360 } from "./geo";
import { SearchIndex, bindSearch, escapeHtml, type Place } from "./search";
import { store, type Mode } from "./store";
import { initM2 } from "./m2";
import { FrameScene, buildScienceTexture, type PoisData } from "./frame/frame";
import { SimUI, type RunLog } from "./sim/ui";
import { DebriefUI } from "./debrief/ui";
import { SITE_ID, SITE_BASE, SITE_ENTER, JEZERO, loadSites, setSite, endSiteScope, type SiteInfo } from "./site";
import { placeHome, besideAway } from "./models";
import { FrameUI } from "./frame/ui";
import type { TerrainMeta, Traverse } from "../data";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Framings in px of a 720-px-high reference (the mockups are 1280x720).
const SPLASH = { dist: 1.89, offX: 540, offY: -700 };          // Mars limb at lower left
const PLANET = { dist: 5.3, offX: 0, offY: -29 };              // centred in the centre panel (below the 58-px top bar)
/** Opening view: the day side, with the real Sun to the upper left (set from the subsolar point once the globe exists). */
let START_VIEW = { lat: 12, lon: -30 };
/** The site whose terrain this page loads (?site=, default Jezero); updated from the registry at start. */
let ACTIVE: SiteInfo = JEZERO;
let SITES: SiteInfo[] = [JEZERO];

async function loadBinary(url: string) {
  const r = await fetch(url + BUST);
  if (!r.ok) throw new Error(`missing ${url} (HTTP ${r.status})`);
  return r.arrayBuffer();
}
async function loadJSON<T>(url: string): Promise<T> {
  const r = await fetch(url + BUST);
  if (!r.ok) throw new Error(`missing ${url} (HTTP ${r.status})`);
  return r.json();
}

/** Planet framing with Mars centred between the side panels (they can be collapsed). */
function planetFraming() {
  if (document.body.classList.contains("mobile")) return { ...PLANET, offX: 0 }; // phone: the panels are drawers over the view
  const s = window.innerHeight / 720, lw = document.getElementById("left")!.offsetWidth, rw = document.getElementById("right")!.offsetWidth;
  return { ...PLANET, offX: -(lw - rw) / 2 / s };
}

/** Phones: side panels become slide-over drawers (closed at start), legends start collapsed, text has a minimum size. */
function applyMobileLayout() {
  const small = window.matchMedia("(max-width: 899px), (max-height: 499px)").matches;
  document.body.classList.toggle("mobile", small);
  if (!small) return;
  document.body.classList.add("left-collapsed", "right-collapsed");
  const l = document.getElementById("toggle-left"), r = document.getElementById("toggle-right");
  if (l) { l.textContent = "▶"; l.title = "Open the left panel"; l.setAttribute("aria-label", "Open the left panel"); }
  if (r) { r.textContent = "◀"; r.title = "Open the right panel"; r.setAttribute("aria-label", "Open the right panel"); }
}

async function start() {
  applyMobileLayout();
  document.querySelectorAll(".wordmark").forEach((el) => (el.innerHTML = wordmarkSVG()));
  // MAP / SIM card titles in the wordmark's lettering (stroke follows the card state colour)
  document.querySelectorAll<HTMLElement>(".card-title").forEach((el) => {
    const txt = el.textContent!.trim();
    el.setAttribute("aria-label", txt);
    el.innerHTML = wordmarkSVG("currentColor", txt);
  });
  const status = $("splash-text");
  // Every load / reload starts at the splash. Deep links (#planet, #frame, ...) are honoured only with the
  // dev flag ?direct (used by the automated checks); otherwise the address is reset to the plain page.
  // ?direct = dev deep link; ?enter = chosen on the globe -> straight into that site's map (the flag is dropped, so a reload shows the splash)
  const direct = new URLSearchParams(location.search).has("direct") || SITE_ENTER;
  if (SITE_ENTER) history.replaceState(null, "", location.pathname + `?site=${SITE_ID}` + location.hash);
  const initialHash = direct ? location.hash.replace("#", "").toUpperCase() : "";
  const skipSplash = direct && location.hash.length > 1 && location.hash !== "#splash";
  if (!direct && location.hash) history.replaceState(null, "", location.pathname + location.search);

  let globe: Globe;
  let landmarks: Place[] = [];
  try {
    status.textContent = "Loading Mars…";
    const [meta, molaBuf, colorTex, lm] = await Promise.all([
      loadJSON<MolaMeta>("/global/mola.json"),
      loadBinary("/global/mola_4k.i16"),
      new THREE.TextureLoader().loadAsync("/global/viking_2k.jpg"),
      loadJSON<any[]>("/global/landmarks.json"),
    ]);
    landmarks = lm.map((f) => ({
      name: f.name,
      kind: "landmark",
      type: f.type,
      lat: f.lat,
      lon: f.lon,
      diameter_km: f.diameter_km,
      link: f.link,
      source: "IAU/USGS Gazetteer of Planetary Nomenclature",
    }));
    globe = new Globe($("scene") as HTMLCanvasElement, colorTex, new Int16Array(molaBuf), meta);
    START_VIEW = { lat: 12, lon: ((globe.sun.subLonE + 55 + 540) % 360) - 180 }; // Sun 55 deg to the left: terminator and relief shadows in view
  } catch (e) {
    status.textContent = String(e);
    $("splash-status").style.color = "var(--risk)";
    throw e;
  }
  (window as any).marswalk = { globe, store, THREE };

  // splash framing first; the 8k texture streams in afterwards
  globe.lookAt(START_VIEW.lat + 8, START_VIEW.lon - 25, SPLASH.dist);
  globe.setFraming(SPLASH);
  document.body.classList.add("ready");
  status.textContent = window.matchMedia("(pointer: coarse)").matches ? "Tap to start" : "Click to start"; // touch-first devices tap
  new THREE.TextureLoader().loadAsync("/global/viking_8k.jpg").then((t) => globe.setColor(t)).catch(() => {});

  // --- search index ---
  const index = new SearchIndex();
  index.add(landmarks);
  bindSearch($("search-input") as HTMLInputElement, $("search-results") as HTMLUListElement, index, (p) => {
    if (store.state.mode === "FRAME") exitFrame();
    select({ ...p, elev: globe.elevation.at(p.lat, p.lon) });
    globe.flyTo(p.lat, p.lon, flyDistance(p.diameter_km));
  });

  // --- M2: data layers, points, STATS, score ---
  let m2: Awaited<ReturnType<typeof initM2>> | null = null;
  SITES = await loadSites();
  ACTIVE = SITES.find((s) => s.id === SITE_ID) ?? JEZERO;
  (window as any).marswalk.site = ACTIVE;
  const terrainSites = SITES.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })); // explorable (baked terrain)
  initM2({ globe, landmarks, index, select: (p) => select({ ...p, elev: globe.elevation.at(p.lat, p.lon) }), terrainSites })
    .then((m) => {
      m2 = m;
      (window as any).marswalk.m2 = m;
      frameUI?.setGlobalLayers(m.layers);
      if (store.state.selected) m.onSelect(store.state.selected);
      m.showLegend(store.state.mode === "PLANET");
    })
    .catch((e) => {
      console.error(e);
      $("loading-layers").textContent = `Data layers failed: ${e}`;
    });

  // --- M3: Frame mode setup (prefetch in background) ---
  let frameScene: FrameScene | null = null;
  let frameUI: FrameUI | null = null;
  let simUI: SimUI | null = null;
  let debriefUI: DebriefUI | null = null;
  let framePromise: Promise<{ frameScene: FrameScene; frameUI: FrameUI }> | null = null;

  async function getFrame() {
    if (framePromise) return framePromise;
    framePromise = (async () => {
      const [meta, hbuf, sbuf, cbuf, trav, layersCfg, poisData] = await Promise.all([
        loadJSON<TerrainMeta>(SITE_BASE + "terrain.json"),
        loadBinary(SITE_BASE + "height.f32"),
        loadBinary(SITE_BASE + "slope.f32"),
        loadBinary(SITE_BASE + "cost.f32"),
        loadJSON<Traverse>(SITE_BASE + "traverse.json"),
        loadJSON<any>(SITE_BASE + "layers.json"),
        loadJSON<PoisData>(SITE_BASE + "pois.json"),
      ]);
      const radiation = (await loadJSON<any>("/global/score_config.json")).radiation;

      const loader = new THREE.TextureLoader();
      const [ortho, slope, hazard] = await Promise.all([
        loader.loadAsync(SITE_BASE + "ortho.jpg"),
        loader.loadAsync(SITE_BASE + "slope.png"),
        loader.loadAsync(SITE_BASE + "hazard.png"),
      ]);
      ortho.colorSpace = THREE.SRGBColorSpace;
      ortho.anisotropy = globe.renderer.capabilities.getMaxAnisotropy();
      for (const t of [slope, hazard]) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
      }
      const science = buildScienceTexture(poisData.pois, 512, 512, meta);

      const fScene = new FrameScene(
        globe.renderer,
        $("scene") as HTMLCanvasElement,
        meta,
        new Float32Array(hbuf),
        { ortho, slope, hazard, science },
        trav,
        poisData,
      );

      const fUI = new FrameUI(
        fScene,
        poisData,
        layersCfg,
        meta,
        new Float32Array(cbuf),
        new Float32Array(sbuf),
        new Float32Array(hbuf),
        radiation,
      );

      // the rover shelter: this site's pick (pois.json shelter_poi) or the config default (Jezero)
      const shelters = (poisData as any).shelter_poi ? [{ id: "rover", name: "Pressurised rover", poi: (poisData as any).shelter_poi }] : layersCfg.sim.shelters ?? [];
      simUI = new SimUI(fScene, layersCfg.sim, shelters, poisData, layersCfg.planner.walk_speed_mps ?? 0.9);
      if (ACTIVE.splat) fScene.loadSplat(SITE_BASE).catch((e) => console.warn("splat:", e));
      (window as any).marswalk.simUI = simUI;
      debriefUI = new DebriefUI(fScene);
      debriefUI.terrainAt = (x, z) => fUI.terrainAt(x, z);
      debriefUI.slopeBins = layersCfg.params?.slope_bins_deg;
      // NASA Habitat Demonstration Unit as the home base, beside the walk start (not on the walking line)
      placeHome(fScene, besideAway(poisData.habitat, poisData.pois, 9)).then((m) => {
        const h = fScene.poiSprites.get("habitat");
        if (h) h.position.set(m.position.x, m.position.y + m.userData.size.y + 0.8, m.position.z); // H above the roof
      }).catch((e) => console.warn("habitat model:", e));
      (window as any).marswalk.debrief = debriefUI;
      frameScene = fScene;
      frameUI = fUI;
      if (m2) fUI.setGlobalLayers(m2.layers);
      (window as any).marswalk.frameScene = fScene;
      (window as any).marswalk.frameUI = fUI;
      return { frameScene: fScene, frameUI: fUI };
    })();
    return framePromise;
  }

  /** Switch to another explorable site in-page (no reload): tear down this site's scene and UI, then the
   *  next getFrame() loads the new site's data. */
  async function switchSite(s: SiteInfo) {
    if (s.id === ACTIVE.id) return;
    if (framePromise) await framePromise.catch(() => null); // let a pre-load finish before freeing it
    simUI?.dispose();
    debriefUI?.dispose();
    frameUI?.dispose();
    frameScene?.dispose();
    simUI = null; debriefUI = null; frameUI = null; frameScene = null; framePromise = null;
    store.set({ routeExists: false }); // the planned route belonged to the old site
    endSiteScope();
    setSite(s.id);
    ACTIVE = s;
    (window as any).marswalk.site = s;
  }

  // Pre-load frame scene in background
  getFrame().catch((e) => console.warn("Frame mode pre-load notice:", e));

  // --- splash -> planet ---
  let started = false;
  const enterPlanet = async (instant = false) => {
    if (started && store.state.mode === "PLANET") return;
    started = true;
    document.body.classList.remove("splash");
    $("shell").removeAttribute("aria-hidden");
    if (frameUI) frameUI.hide();
    $("card-map").classList.remove("active");
    if (instant) {
      globe.lookAt(START_VIEW.lat, START_VIEW.lon, PLANET.dist);
      globe.setFraming(planetFraming());
    } else {
      await globe.animateTo({ ...planetFraming(), ...START_VIEW }, 1400);
    }
    globe.controls.enabled = true;
    store.set({ mode: "PLANET" });
    (window as any).marswalk.readyMs = Math.round(performance.now());
    if (location.hash !== "#planet") history.replaceState(null, "", "#planet");
  };

  const enterFrame = async (instant = false) => {
    if (store.state.mode === "FRAME") return;
    if (store.state.mode === "SIM" || store.state.mode === "DEBRIEF") {
      const { frameScene: fs, frameUI: fu } = await getFrame();
      // back to planning from the walk: same site, no globe flight
      await fade(true);
      simUI?.stop();
      debriefUI?.hide();
      fs.resetView();
      fu.show();
      store.set({ mode: "FRAME" });
      fade(false);
      if (location.hash !== "#frame") history.replaceState(null, "", "#frame");
      return;
    }

    started = true;
    document.body.classList.remove("splash");
    $("shell").removeAttribute("aria-hidden");

    globe.controls.enabled = false;
    const loading = getFrame(); // (a site just switched to loads while the globe flies down)
    if (!instant) {
      // fly down to ~50 km altitude over the site, then cross-fade to the site terrain (PRD)
      await globe.flyTo(ACTIVE.lat, ACTIVE.lon, 1 + FADE_ALT_KM / 3396.19);
      await fade(true);
    }
    const { frameScene: fs, frameUI: fu } = await loading;
    fs.resetView();
    fu.show();
    store.set({ mode: "FRAME" });
    if (!instant) fade(false);
    $("card-map").classList.add("active");
    ($("card-map") as HTMLButtonElement).disabled = false;
    if (location.hash !== "#frame") history.replaceState(null, "", "#frame");
  };

  const exitFrame = async () => {
    if (store.state.mode !== "FRAME" && store.state.mode !== "SIM" && store.state.mode !== "DEBRIEF") return;
    await fade(true);
    simUI?.stop();
    debriefUI?.hide();
    if (frameUI) frameUI.hide();
    store.set({ mode: "PLANET" });
    $("card-map").classList.remove("active");
    globe.setFraming(planetFraming()); // also when the page was opened directly at #frame (globe still in splash framing)
    // keep the site we just left selected, so the MAP card can take us straight back
    select({ name: ACTIVE.name, kind: "site", type: "Explorable site · detailed HiRISE terrain", lat: ACTIVE.lat, lon: ACTIVE.lon,
      elev: globe.elevation.at(ACTIVE.lat, ACTIVE.lon) });
    globe.lookAt(ACTIVE.lat, ACTIVE.lon, 1 + FADE_ALT_KM / 3396.19);
    fade(false);
    await globe.flyTo(ACTIVE.lat, ACTIVE.lon, 2.2);
    globe.controls.enabled = true;
    if (location.hash !== "#planet") history.replaceState(null, "", "#planet");
  };

  /** GO (Frame) -> walk the planned route. Without a planned route, #sim falls back to Frame. */
  const enterSim = async () => {
    if (store.state.mode === "SIM") return;
    const { frameUI: fu } = await getFrame();
    const ctx = fu.simContext();
    if (!ctx || !simUI) {
      toast("Plan a route in MAP mode first, then press GO.");
      if (store.state.mode !== "FRAME") enterFrame(true); else history.replaceState(null, "", "#frame");
      return;
    }
    await fade(true);
    fu.hide();
    store.set({ mode: "SIM", routeExists: true });
    $("card-map").classList.remove("active");
    simUI.start(ctx);
    fade(false);
    if (location.hash !== "#sim") history.replaceState(null, "", "#sim");
  };

  /** Sim end -> debrief of that run; opened directly, #debrief shows the latest saved run. */
  const enterDebrief = async () => {
    if (store.state.mode === "DEBRIEF") return;
    await getFrame();
    let run: RunLog | null = simUI?.lastRun ?? null;
    if (!run) {
      try {
        const list = (await (await fetch("/api/runs")).json()).filter((r: any) => !r.site || r.site === frameScene?.poisData.site); // this site's runs only
        if (list.length) run = await (await fetch(`/api/runs/${encodeURIComponent(list[0].file)}`)).json();
      } catch { /* no runs api */ }
    }
    if (!run || !debriefUI) {
      toast("No walk to debrief yet. Plan a route and press GO.");
      if (store.state.mode !== "FRAME") enterFrame(true); else history.replaceState(null, "", "#frame");
      return;
    }
    started = true;
    document.body.classList.remove("splash");
    $("shell").removeAttribute("aria-hidden");
    globe.controls.enabled = false;
    await fade(true);
    simUI?.stop();
    frameUI?.hide();
    store.set({ mode: "DEBRIEF" });
    $("card-map").classList.remove("active");
    debriefUI.show(run);
    fade(false);
    if (location.hash !== "#debrief") history.replaceState(null, "", "#debrief");
  };

  if (skipSplash) {
    if (initialHash === "DEBRIEF") enterDebrief();
    else if (initialHash === "FRAME" || initialHash === "SIM") enterFrame(true);
    else enterPlanet(true);
  } else {
    // a left mouse click, a tap or a pen leaves the splash; keys and right-clicks do not
    // (a click made with the keyboard reports detail 0; right-click never fires "click")
    const go = (e: MouseEvent) => {
      const type = (e as PointerEvent).pointerType;
      if (e.button !== 0 || e.detail === 0 || (type && !["mouse", "touch", "pen"].includes(type))) return;
      window.removeEventListener("click", go);
      enterPlanet();
    };
    window.addEventListener("click", go);
  }

  // --- hover coordinates + click selection on the globe ---
  const canvas = $("scene") as HTMLCanvasElement;
  const ndc = (e: PointerEvent) => new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  const coords = $("coords-value");
  // docked windows stack on COORDINATES: keep its height in a CSS variable for the legend's offset
  new ResizeObserver(() => $("centre").style.setProperty("--coords-h", `${$("coords").getBoundingClientRect().height}px`)).observe($("coords"));
  canvas.addEventListener("pointermove", (e) => {
    if (store.state.mode !== "PLANET") return;
    const hit = globe.pick(ndc(e));
    if (hit) {
      coords.textContent = fmtCoords(hit.lat, hit.lon);
      m2?.hover(hit.lat, hit.lon);
    } else if (store.state.selected) {
      coords.textContent = fmtCoords(store.state.selected.lat, store.state.selected.lon);
      m2?.hover(store.state.selected.lat, store.state.selected.lon);
    }
  });
  canvas.addEventListener("pointerleave", () => {
    const s = store.state.selected;
    if (s && store.state.mode === "PLANET") m2?.hover(s.lat, s.lon);
  });

  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
    if (store.state.mode === "PLANET" && started) globe.stopSpin(); // the user takes over: the idle spin ends
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || store.state.mode !== "PLANET" || !started) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5) return;

    const pt = m2?.pickScreen(e.clientX, e.clientY);
    if (pt) {
      select({ ...pt.p, elev: globe.elevation.at(pt.p.lat, pt.p.lon) });
      return;
    }
    const hit = globe.pick(ndc(e));
    if (!hit) return;

    const ctxName = featureContext(landmarks, hit.lat, hit.lon);
    select({
      name: ctxName ? `Point · ${ctxName.label}` : "Selected point",
      kind: "point",
      type: ctxName ? ctxName.type : "Selected point",
      lat: hit.lat,
      lon: hit.lon,
      elev: hit.elev,
    });
  });

  function select(s: Place & { elev?: number; nearest?: string; clicked?: { lat: number; lon: number } }) {
    store.set({ selected: s });
    const c = s.clicked ?? s;
    coords.textContent = fmtCoords(c.lat, c.lon);
    globe.setMarker(s.lat, s.lon);
    m2?.onSelect(s);
  }

  // closing the site card (× or Esc) clears the selection: ring marker, name tag, danger reading
  function deselect() {
    if (!store.state.selected) return;
    globe.setMarker(null);
    m2?.onDeselect();
    coords.textContent = "--.-----, ---.-----";
    store.set({ selected: null });
  }
  window.addEventListener("marswalk:deselect", deselect);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && store.state.mode === "PLANET" && !(e.target as HTMLElement)?.closest?.("input")) deselect();
  });

  // --- collapsible side panels: tabs on the rails' inner edges; Mars stays centred in the space between them ---
  for (const side of ["left", "right"] as const) {
    $(`toggle-${side}`).addEventListener("click", () => {
      const on = document.body.classList.toggle(`${side}-collapsed`);
      if (!on && document.body.classList.contains("mobile")) {   // phone: one drawer at a time
        const other = side === "left" ? "right" : "left";
        if (!document.body.classList.contains(`${other}-collapsed`)) $(`toggle-${other}`).click();
      }
      const btn = $(`toggle-${side}`);
      btn.textContent = (side === "left") === on ? "▶" : "◀";
      const label = `${on ? "Open" : "Collapse"} the ${side} panel`;
      btn.title = label; btn.setAttribute("aria-label", label);
    });
  }
  new ResizeObserver(() => { if (store.state.mode === "PLANET" && !globe.animating) globe.setFraming(planetFraming()); }).observe($("centre"));

  // --- reflect state in the shell ---
  store.on((s, prev) => {
    if (s.mode !== prev.mode) m2?.showLegend(s.mode === "PLANET");
    // phone: a new screen starts with the drawers closed, so the view is not covered
    if (s.mode !== prev.mode && document.body.classList.contains("mobile"))
      for (const side of ["left", "right"] as const) if (!document.body.classList.contains(`${side}-collapsed`)) $(`toggle-${side}`).click();
    if (s.mode !== prev.mode) {
      $("mode-value").textContent = ({ SPLASH: "Planet", PLANET: "Planet", FRAME: "Map", SIM: "Walk", DEBRIEF: "Debrief" } as Record<string, string>)[s.mode] ?? s.mode;
    }
    if (s.mode === "FRAME") {
      ($("card-map") as HTMLButtonElement).disabled = false;
      $("card-map").classList.add("active");
    } else {
      ($("card-map") as HTMLButtonElement).disabled = !s.selected;
      $("card-map").classList.remove("active");
    }
    ($("card-sim") as HTMLButtonElement).disabled = !s.routeExists;
    if (s.mode === "SIM" || s.mode === "DEBRIEF") { // the debrief is the walk's result: SIM stays selected
      $("card-sim").classList.add("active");
    } else {
      $("card-sim").classList.remove("active");
    }

    const lab = $("selection");
    if (s.selected && s.mode === "PLANET") {
      lab.innerHTML = `${escapeHtml(s.selected.name)}<span class="t">${s.selected.type ? escapeHtml(s.selected.type) + " · " : ""}` +
        `${s.selected.lat.toFixed(2)}, ${lon360(s.selected.lon).toFixed(2)}${s.selected.elev !== undefined ? ` · ${(s.selected.elev / 1000).toFixed(1)} km` : ""}</span>`;
      lab.hidden = false;
    } else {
      lab.hidden = true;
    }
  });

  $("card-map").addEventListener("click", async () => {
    if (store.state.mode === "FRAME") {
      exitFrame();
    } else {
      const sel = store.state.selected;
      // Only baked sites are walkable (PRD); elsewhere the score card stays and we say so.
      const near = sel ? SITES.map((s) => ({ s, d: gcDistance(sel.lat, sel.lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d)[0] : null;
      if (!near || near.d > 100e3) {
        toast(`No detailed terrain yet for this spot. Explorable sites (the mint "!" badges): ${SITES.map((s) => s.name).join(", ")}.`);
        return;
      }
      if (near.s.id !== ACTIVE.id) await switchSite(near.s); // other site: swap the site scene in-page
      enterFrame();
    }
  });

  $("card-sim").addEventListener("click", () => {
    if (store.state.routeExists && store.state.mode !== "SIM") location.hash = "#sim";
  });

  // --- dataset tooltips ([data-src]) ---
  const tip = $("tooltip");
  document.addEventListener("pointerover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-src]");
    if (!el) {
      tip.hidden = true;
      return;
    }
    tip.textContent = `Source: ${el.dataset.src}`;
    tip.hidden = false;
  });
  document.addEventListener("pointermove", (e) => {
    if (tip.hidden) return;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 300)}px`;
    tip.style.top = `${e.clientY + 16}px`;
  });

  // --- frame loop ---
  const selLabel = $("selection");
  let frames = 0, t0 = performance.now(), lastNow = performance.now();
  (window as any).marswalk.fps = 0;
  renderLoop();
  function renderLoop() {
    requestAnimationFrame(function loop(now) {
      if ((store.state.mode === "FRAME" || store.state.mode === "SIM" || store.state.mode === "DEBRIEF") && frameScene) {
        // zooming far out of the site returns to the globe (PRD: back the same way on zoom-out)
        if (store.state.mode === "FRAME" && frameScene.camera.position.distanceTo(frameScene.controls.target) > EXIT_DIST_M) exitFrame();
        if (store.state.mode === "SIM") simUI?.update((now - lastNow) / 1000);
        if (store.state.mode === "DEBRIEF") debriefUI?.update((now - lastNow) / 1000);
        lastNow = now;
        frameScene.render(now);
      } else {
        frameScene?.hideOverlays();
        m2?.update(Math.min(0.1, (now - lastNow) / 1000));
        lastNow = now;
        globe.render(now);
        const sel = store.state.selected;
        if (sel && !selLabel.hidden) {
          const p = globe.project(globe.surfacePoint(sel.lat, sel.lon));
          const c = $("centre").getBoundingClientRect();
          if (p && p.x > c.left && p.x < c.right && p.y > c.top && p.y < c.bottom) {
            selLabel.style.visibility = "visible";
            // keep the tag inside the globe view (the stem still points at the spot)
            const x = p.x - c.left, half = selLabel.offsetWidth / 2;
            // and clear of the docked site card on the left
            const card = $("sitecard"), drawer = $("drawer");
            const lo = (card.hidden ? 0 : card.getBoundingClientRect().right - c.left) + 8;
            const hi = (drawer.hidden ? c.width : drawer.getBoundingClientRect().left - c.left) - 8;
            selLabel.style.maxWidth = `${Math.max(120, hi - lo)}px`; // and between the open LAYERS MENU on the right
            const cx = Math.max(lo + half, Math.min(hi - half, x));
            selLabel.style.left = `${cx}px`;
            selLabel.style.top = `${p.y - c.top}px`;
            selLabel.style.setProperty("--stem", `${x - cx}px`);
          } else {
            selLabel.style.visibility = "hidden";
          }
        }
      }
      frames++;
      if (now - t0 > 1000) {
        (window as any).marswalk.fps = (frames * 1000) / (now - t0);
        frames = 0;
        t0 = now;
      }
      requestAnimationFrame(loop);
    });
  }

  window.addEventListener("hashchange", () => {
    const m = location.hash.replace("#", "").toUpperCase() as Mode;
    if (m === "FRAME") enterFrame();
    else if (m === "SIM") enterSim();
    else if (m === "DEBRIEF") enterDebrief();
    else if (m === "PLANET") {
      if (store.state.mode === "FRAME" || store.state.mode === "SIM" || store.state.mode === "DEBRIEF") exitFrame();
      else if (!started) enterPlanet(true);
    }
  });
}

const FADE_ALT_KM = 50;   // cross-fade between globe and site terrain below this altitude
const EXIT_DIST_M = 3300; // zooming the site camera out past this returns to the globe

function fade(on: boolean): Promise<void> {
  const el = document.getElementById("fade")!;
  el.classList.toggle("on", on);
  return new Promise((r) => setTimeout(r, 380));
}

let toastTimer = 0;
function toast(text: string) {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

function featureContext(lms: Place[], lat: number, lon: number): { label: string; type: string } | null {
  let inside: Place | null = null, near: Place | null = null, nd = 50;
  for (const p of lms) {
    const d = gcDistance(lat, lon, p.lat, p.lon) / 1000;
    const r = (p.diameter_km ?? 0) / 2;
    if (d <= r && (!inside || (p.diameter_km ?? 0) < (inside.diameter_km ?? 0))) inside = p;
    if (d < nd) {
      nd = d;
      near = p;
    }
  }
  if (inside) return { label: `in ${inside.name}`, type: `${inside.type || "feature"} (context)` };
  if (near) return { label: `near ${near.name}`, type: `${Math.round(nd)} km from ${near.type || "feature"}` };
  return null;
}

function flyDistance(diamKm?: number) {
  const d = diamKm ?? 100;
  return Math.min(5, Math.max(1.12, 1 + (d / 3396) * 2.2));
}

// ---------------------------------------------------------------- small screens
// The planner needs a desktop-size screen (two side rails, a 3D view, map tools). On a phone it shows a notice
// instead of starting, so nothing heavy is downloaded; "Try anyway" (remembered for the session) starts it.
const SMALL = window.matchMedia("(max-width: 899px), (max-height: 499px)");
const TRY_KEY = "mfm-try-small-screen";
let launched = false;
function launch() {
  if (launched) return;
  launched = true;
  document.getElementById("small-screen")?.remove();
  start();
}
function showSmallScreen() {
  const el = document.createElement("div");
  el.id = "small-screen";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-labelledby", "ss-title");
  el.innerHTML = `
    <div class="ss-box">
      <div class="ss-brand"><span class="logo-icon" aria-hidden="true"></span><span class="ss-wordmark" aria-label="MadeForMars">${wordmarkSVG()}</span></div>
      <h1 id="ss-title">Works best on a larger screen</h1>
      <p>MadeForMars plans walks on a 3D globe and detailed terrain maps. On a phone the side panels open as drawers from the edge tabs.</p>
      <p>For the full view, use a laptop, desktop or tablet in landscape.</p>
      <button type="button" id="ss-try" class="ss-try">Continue</button>
      <p class="ss-note">Downloads tens of megabytes of map data and may run slowly.</p>
    </div>`;
  document.body.appendChild(el);
  el.querySelector("#ss-try")!.addEventListener("click", () => {
    try { sessionStorage.setItem(TRY_KEY, "1"); } catch { /* private mode: just this time */ }
    launch();
  });
  // rotated or resized to a big-enough screen: start normally
  SMALL.addEventListener("change", (e) => { if (!e.matches) launch(); });
}
let tried = false;
try { tried = sessionStorage.getItem(TRY_KEY) === "1"; } catch { /* storage blocked */ }
if (SMALL.matches && !tried) showSmallScreen();
else launch();
