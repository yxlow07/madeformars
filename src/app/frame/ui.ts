// Frame mode DOM UI: location cards drawer, route planner right rail, elevation profile, view toolbar.
import type { RouteResult, Limits } from "./route";
import { diffText, fmtDur } from "./route";
import type { FrameScene, PoisData } from "./frame";
import { store } from "../store";
import { doseModel, type RadiationCfg } from "../layers";
import { LegendPanel, legendHtml, keyHtml, SYM } from "../legend";
import { VIRIDIS_STOPS, BIN_COLORS as ROUTE_COLORS } from "./frame";
import { globalSiteTexture, siteElevation, siteLatLon } from "./sitelayers";
import type { LayerStore } from "../layers";
import type { LegendSpec } from "../legend";
import { SITE_BASE } from "../site";
import { siteSignal } from "../site";
import { fmtLtst } from "../sun";

const MAX_STOPS = 10; // >6 stops are ordered by nearest-neighbour + 2-opt (route.ts)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BIN_COLORS = ["#2ea043", "#e6c828", "#eb781e", "#d21e1e"];

export interface CustomMarker {
  id: string;
  name: string;
  x: number;
  z: number;
  lat: number;
  lon: number;
}

export class FrameUI {
  private worker: Worker;
  private selectedStops: string[] = []; // IDs of selected POIs / custom markers (in order)
  private customMarkers: CustomMarker[] = [];
  private customCount = 0;
  private addMarkerMode = false;
  // ---- planning notes (in memory only: gone on reload, Reset, site switch; hidden during the walk)
  private noteMode = false;
  private notes: { id: string; x: number; z: number; text: string }[] = [];
  private noteCount = 0;
  private openNoteId: string | null = null;
  private noteRaf = 0;
  private noteCard!: HTMLDivElement;
  private noteTip!: HTMLDivElement;
  static readonly NOTE_MAX = 140;

  private lambda = 0.5;
  private alts: [number, number] = [0.2, 0.8];
  private lambdaTimer = 0;
  private limits: Limits;
  private slopeBins: number[];

  private homeCell: number;
  private homeTime: Float32Array | null = null;
  private reqId = 0;

  private lastResult: RouteResult | null = null;
  private prevResult: RouteResult | null = null;

  // DOM containers
  private locDrawer!: HTMLDivElement;
  private rightPanel!: HTMLDivElement;
  private profileWrap!: HTMLDivElement;
  private toolbar!: HTMLDivElement;

  constructor(
    private frame: FrameScene,
    private poisData: PoisData,
    private plannerConfig: any,
    private meta: any,
    private costBuf: Float32Array,
    private slopeBuf: Float32Array,
    private heightBuf: Float32Array,
    radiation: RadiationCfg,
  ) {
    this.slopeBins = plannerConfig.slope_bins_deg || [8, 15, 25];
    this.limits = {
      suitHours: plannerConfig.planner.suit_hours || 8.0,
      reserveMin: plannerConfig.planner.reserve_min || 30,
      doseBudgetMsv: plannerConfig.planner.dose_budget_msv || 0.5,
      // labelled model: surface GCR dose at this site's elevation (Curiosity RAD-calibrated, see layers.ts)
      doseRateMsvH: doseModel(meta.origin_elev_m, radiation) / 24,
      hazardSlopeDeg: plannerConfig.planner.hazard_slope_deg || 15,
    };
    this.lambda = plannerConfig.planner.lambda_default ?? 0.5;
    this.alts = plannerConfig.planner.lambda_alternatives ?? [0.2, 0.8];

    // Habitat cell
    this.homeCell = this.cellOf(poisData.habitat.x, poisData.habitat.z);

    // Init worker
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.initWorker();

    this.createDom();
    ($("fr-suit-h") as HTMLInputElement).value = String(this.limits.suitHours);
    $("fr-reserve").textContent = `− ${this.limits.reserveMin} min reserve`;
    $("alt-fast-t").textContent = `Fast · λ ${this.alts[0]}`;
    $("alt-safe-t").textContent = `Safe · λ ${this.alts[1]}`;
    this.bindEvents();
  }

  private cellOf(x: number, z: number): number {
    const j = Math.max(0, Math.min(this.meta.width - 1, Math.round((x - this.meta.extent_x_m[0]) / this.meta.res_x_m)));
    const i = Math.max(0, Math.min(this.meta.height - 1, Math.round((z - this.meta.extent_z_m[0]) / this.meta.res_z_m)));
    return i * this.meta.width + j;
  }

  private initWorker() {
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "ready") {
        this.homeTime = m.homeTime;
        this.drawEnvelope();
        this.renderCardsList();
      } else if (m.type === "result") {
        this.handlePlanResult(m.id, m.res);
      }
    };

    this.worker.postMessage({
      type: "init",
      grid: {
        w: this.meta.width,
        h: this.meta.height,
        dx: this.meta.res_x_m,
        dz: this.meta.res_z_m,
        cost: this.costBuf,
        height: this.heightBuf,
        slope: this.slopeBuf,
      },
      params: {
        climbWeight: this.plannerConfig.planner.climb_weight || 4,
        walkSpeed: this.plannerConfig.planner.walk_speed_mps || 0.9,
        slopeBins: this.slopeBins,
        smoothPasses: this.plannerConfig.planner.smooth_passes || 3,
        maxStops: this.plannerConfig.planner.max_stops || 6,
      },
      home: this.homeCell,
    });
  }

  private computeHazardRating(x: number, z: number, radiusM = 20): number {
    const ci = Math.round((z - this.meta.extent_z_m[0]) / this.meta.res_z_m);
    const cj = Math.round((x - this.meta.extent_x_m[0]) / this.meta.res_x_m);
    const rCells = Math.ceil(radiusM / Math.min(this.meta.res_x_m, this.meta.res_z_m));
    let sumRisk = 0, count = 0;
    const w = this.meta.width, h = this.meta.height;

    for (let di = -rCells; di <= rCells; di++) {
      for (let dj = -rCells; dj <= rCells; dj++) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= h || nj >= w) continue;
        const dist = Math.hypot(dj * this.meta.res_x_m, di * this.meta.res_z_m);
        if (dist > radiusM) continue;
        const c = this.costBuf[ni * w + nj];
        const risk = Number.isFinite(c) ? Math.min(1.0, (c - 1) / 9.7) : 1.0;
        sumRisk += risk;
        count++;
      }
    }
    return count > 0 ? sumRisk / count : 0;
  }

  private createDom() {
    // 1. View Toolbar in #centre
    this.toolbar = document.createElement("div");
    this.toolbar.id = "frame-toolbar";
    this.toolbar.className = "frame-toolbar";
    this.toolbar.hidden = true;
    this.toolbar.innerHTML = `
      <div class="ft-group">
        <button id="ft-back" class="ft-btn exit" title="Zoom back out to the Planet view">Globe</button>
        <span class="ft-sep"></span>
        <button id="ft-topdown" class="ft-btn" title="Top-down 2D map view">2D</button>
        <button id="ft-tilt" class="ft-btn on" title="3D perspective view (tilted)">3D</button>
        <button id="ft-reset" class="ft-btn" title="Start over: remove every stop and your own pins, clear the route and reset the view">Reset</button>
        <button id="ft-track" class="ft-btn" title="Show Perseverance's actual drive track (reference only, not part of your plan)">Track</button>
        <button id="fl-add-custom" class="ft-btn" title="Then click the terrain to drop your own stop">Add pin</button>
        <button id="fl-add-note" class="ft-btn" title="Then click the terrain to leave a short planning note (140 characters)">Add note</button>
      </div>
      <div class="ft-group layers">
        <span class="ft-label">Layer</span>
        <select id="ft-layer-sel" class="ft-select">
          <optgroup label="Site (HiRISE, 1 m)">
            <option value="0">Ortho (base)</option>
            <option value="elev">Elevation</option>
            <option value="1">Slope bins</option>
            <option value="2">Hazard / risk</option>
            <option value="3">Science targets</option>
          </optgroup>
        </select>
        <input type="range" id="ft-opacity" min="0.1" max="1" step="0.05" value="0.65" title="Layer opacity" style="width: 60px;">
      </div>
    `;
    $("centre").appendChild(this.toolbar);
    // the legend docks under the toolbar, whatever height it wraps to
    new ResizeObserver(() => $("centre").style.setProperty("--toolbar-h", `${this.toolbar.offsetHeight}px`)).observe(this.toolbar);

    // 2. Pin card: details of one pin, shown only after clicking it (follows the pin on screen)
    this.locDrawer = document.createElement("div");
    this.locDrawer.id = "pin-card";
    this.locDrawer.className = "pin-card";
    this.locDrawer.hidden = true;
    $("centre").appendChild(this.locDrawer);

    // 2b. Legend (active terrain layer + route / marker key)
    this.legend = new LegendPanel($("centre"), "frame-legend");

    // 3. Elevation Profile container along bottom of #centre
    this.profileWrap = document.createElement("div");
    this.profileWrap.id = "frame-profile-wrap";
    this.profileWrap.className = "frame-profile-wrap";
    this.profileWrap.hidden = true;
    this.profileWrap.innerHTML = `
      <div class="fp-header">
        <span class="label small">Elevation profile and walk-back envelope</span>
        <span id="fp-hover-info" class="num small">Hover route to inspect</span>
      </div>
      <canvas id="frame-profile-canvas"></canvas>
    `;
    $("centre").appendChild(this.profileWrap);

    // 4. Right-rail panel for Frame mode
    this.rightPanel = document.createElement("div");
    this.rightPanel.id = "frame-right";
    this.rightPanel.className = "frame-right";
    this.rightPanel.hidden = true;
    this.rightPanel.innerHTML = `
      <section class="dashed fr-section">
        <div class="fr-stops-head"><span class="label small">Route stops</span><button id="fl-clear-stops" class="fl-btn-xs" hidden>Clear</button></div>
        <div id="fl-drop-hint" class="fr-hint warn" hidden>Click the terrain to place your pin. Esc cancels.</div>
        <div id="fl-status" class="fr-hint warn" hidden></div>
        <div id="fl-stops-summary" class="fl-stops-list"></div>
      </section>

      <section class="dashed fr-section">
        <div class="label small">Route planner</div>
        <div class="fr-lambda-wrap">
          <div class="fr-lambda-labels"><span>Fastest</span><span id="fr-lambda-val" class="num">λ 0.50</span><span>Safest</span></div>
          <input type="range" id="fr-lambda-slider" min="0" max="1" step="0.05" value="0.5" class="fr-slider">
        </div>
        <div class="fr-suit"><label for="fr-suit-h">Suit O₂</label>
          <input type="text" inputmode="decimal" id="fr-suit-h" value="8" class="num" title="Suit O₂ supply in hours (0.25 to 12); type a value, then Enter" autocomplete="off" spellcheck="false" /> h
          <span class="hint" id="fr-reserve">− 30 min reserve</span></div>
        <div class="fr-sun" id="fr-sun"></div>
        <div class="fr-alts">
          <button id="fr-alt-fast" class="fr-alt-btn" title="Use fastest route (λ = 0.2)">
            <span class="alt-t" id="alt-fast-t">Fast · λ 0.2</span>
            <span class="alt-v num" id="alt-fast-val">--</span>
          </button>
          <button id="fr-alt-safe" class="fr-alt-btn" title="Use safest route (λ = 0.8)">
            <span class="alt-t" id="alt-safe-t">Safe · λ 0.8</span>
            <span class="alt-v num" id="alt-safe-val">--</span>
          </button>
        </div>
      </section>

      <section class="fr-section dashed">
        <div class="label small">Route summary</div>
        <div id="fr-summary-table" class="fr-summary-table">
          <p class="hint">Click a pin on the map, then Add to route</p>
        </div>
      </section>

      <div id="fr-violations" class="fr-violations" hidden></div>

      <div id="fr-diff" class="fr-diff" hidden>
        <div class="label small">Change from last route</div>
        <p id="fr-diff-text" class="num small"></p>
      </div>

      <div class="fr-actions">
        <button id="fr-go-btn" class="fr-btn go" disabled>Go · simulate</button>
      </div>
    `;
    $("right").appendChild(this.rightPanel);
  }

  private bindEvents() {
    // Toolbar buttons
    $("ft-topdown").addEventListener("click", () => {
      $("ft-topdown").classList.add("on");
      $("ft-tilt").classList.remove("on");
      this.frame.setTopDown();
    });
    $("ft-tilt").addEventListener("click", () => {
      $("ft-tilt").classList.add("on");
      $("ft-topdown").classList.remove("on");
      this.frame.setTilt3D();
    });
    $("ft-reset").addEventListener("click", () => this.resetPlan());
    $("ft-back").addEventListener("click", () => {
      this.exitToPlanet();
    });

    // Layer selector
    $("ft-track").addEventListener("click", () => {
      this.showTrack = !this.showTrack;
      this.frame.traverseGroup.visible = this.showTrack;
      $("ft-track").classList.toggle("on", this.showTrack);
      this.refreshLegend();
    });
    $("ft-layer-sel").addEventListener("change", (e) => this.selectLayer((e.target as HTMLSelectElement).value));
    $("ft-opacity").addEventListener("input", (e) => {
      const op = Number((e.target as HTMLInputElement).value);
      this.frame.setLayer(this.layer, op);
    });

    // Add Custom Marker mode
    $("fl-add-custom").addEventListener("click", () => {
      this.setNoteMode(false);
      this.addMarkerMode = !this.addMarkerMode;
      $("fl-add-custom").classList.toggle("on", this.addMarkerMode);
      $("fl-drop-hint").textContent = "Click the terrain to place your pin. Esc cancels.";
      $("fl-drop-hint").hidden = !this.addMarkerMode;
    });
    $("fl-add-note").addEventListener("click", () => {
      if (this.addMarkerMode) { this.addMarkerMode = false; $("fl-add-custom").classList.remove("on"); }
      this.setNoteMode(!this.noteMode);
    });
    // note card + hover preview (in the centre view, styled like the pin card)
    this.noteCard = document.createElement("div");
    this.noteCard.id = "note-card";
    this.noteCard.className = "pin-card note-card";
    this.noteCard.hidden = true;
    $("centre").appendChild(this.noteCard);
    this.noteTip = document.createElement("div");
    this.noteTip.id = "note-tip";
    this.noteTip.hidden = true;
    $("centre").appendChild(this.noteTip);

    // Canvas click on terrain (for dropping custom marker or picking POIs)
    const sceneCanvas = $("scene");
    let downPos = { x: 0, y: 0 };
    sceneCanvas.addEventListener("pointerdown", (e) => {
      downPos = { x: e.clientX, y: e.clientY };
    }, { signal: siteSignal() });
    sceneCanvas.addEventListener("pointerup", (e) => {
      if (store.state.mode !== "FRAME") return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;

      if (this.noteMode) {
        const pt = this.frame.pickTerrain(e.clientX, e.clientY);
        if (pt) { this.setNoteMode(false); this.dropNote(pt.x, pt.z); }
        return;
      }
      if (this.addMarkerMode) {
        const pt = this.frame.pickTerrain(e.clientX, e.clientY);
        if (pt) {
          this.dropCustomMarker(pt.x, pt.z);
          this.addMarkerMode = false;
          $("fl-add-custom").classList.remove("on");
          $("fl-drop-hint").hidden = true;
        }
        return;
      }

      // A pin shows its card; clicking empty ground closes it
      const markerHit = this.frame.pickMarker(e.clientX, e.clientY);
      if (markerHit?.type === "note") { this.closePin(); this.openNote(markerHit.id); return; }
      this.closeNote();
      if (markerHit) this.openPin(markerHit.id);
      else this.closePin();
    }, { signal: siteSignal() });
    // hovering a note shows its text (small, beside the bubble)
    sceneCanvas.addEventListener("pointermove", (e) => {
      if (store.state.mode !== "FRAME" || !this.notes.length) { this.noteTip.hidden = true; return; }
      const hit = this.frame.pickMarker(e.clientX, e.clientY);
      const n = hit?.type === "note" && hit.id !== this.openNoteId ? this.notes.find((q) => q.id === hit.id) : null;
      if (!n || !n.text) { this.noteTip.hidden = true; return; }
      const c = $("centre").getBoundingClientRect();
      this.noteTip.textContent = n.text;
      this.noteTip.hidden = false;
      const w = this.noteTip.offsetWidth;
      this.noteTip.style.left = `${Math.min(c.width - w - 8, e.clientX - c.left + 14)}px`;
      this.noteTip.style.top = `${e.clientY - c.top - 10}px`;
    }, { signal: siteSignal() });
    window.addEventListener("keydown", (e) => {
      if (store.state.mode !== "FRAME" || e.key !== "Escape") return;
      if (this.addMarkerMode) { this.addMarkerMode = false; $("fl-add-custom").classList.remove("on"); $("fl-drop-hint").hidden = true; }
      this.setNoteMode(false);
      this.closeNote();
      this.closePin();
    }, { signal: siteSignal() });
    $("fl-clear-stops").addEventListener("click", () => {
      this.selectedStops = [];
      this.frame.updateMarkerBadges(this.selectedStops);
      this.renderCardsList();
      this.renderStopsSummary();
      this.frame.clearRoute();
      this.renderSummary(null);
    });

    // Lambda slider
    $("fr-lambda-slider").addEventListener("input", (e) => {
      this.lambda = Number((e.target as HTMLInputElement).value);
      $("fr-lambda-val").textContent = `λ ${this.lambda.toFixed(2)}`;
      // debounce: dragging the slider must not queue dozens of plans in the worker
      clearTimeout(this.lambdaTimer);
      this.lambdaTimer = window.setTimeout(() => this.planRoute(false), 140);
    });

    // Suit O2 budget: redraw the safe-return envelope and re-plan
    // focusing the suit field selects its value, so typing replaces it (typing into "8" made "80.25" -> clamped to 12 h)
    $("fr-suit-h").addEventListener("focus", (e) => (e.target as HTMLInputElement).select());
    $("fr-suit-h").addEventListener("mouseup", (e) => e.preventDefault()); // keep the selection made on focus
    $("fr-suit-h").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") (e.target as HTMLInputElement).blur(); }); // Enter applies
    $("fr-suit-h").addEventListener("change", (e) => {
      // typed only (no spinner): accept "6", "6.5" or "6,5"; anything else keeps the current value
      const typed = Number((e.target as HTMLInputElement).value.trim().replace(",", "."));
      const v = Math.max(0.25, Math.min(12, Number.isFinite(typed) && typed > 0 ? typed : this.limits.suitHours));
      (e.target as HTMLInputElement).value = String(v);
      this.limits = { ...this.limits, suitHours: v };
      this.drawEnvelope();
      this.planRoute();
    });

    // Alternatives buttons
    const useLambda = (v: number) => {
      this.lambda = v;
      ($("fr-lambda-slider") as HTMLInputElement).value = String(v);
      $("fr-lambda-val").textContent = `λ ${v.toFixed(2)}`;
      this.planRoute(false);
    };
    $("fr-alt-fast").addEventListener("click", () => useLambda(this.alts[0]));
    $("fr-alt-safe").addEventListener("click", () => useLambda(this.alts[1]));


    // Go button -> transition to Sim mode
    // Go: a route that breaks a limit (O2 budget, walk-back, dose) is flagged and needs a second, explicit click.
    let armed = 0;
    $("fr-go-btn").addEventListener("click", () => {
      const r = this.lastResult;
      if (!r || !r.ok) return;
      if (r.flags.length && Date.now() - armed > 4000) {
        armed = Date.now();
        $("fr-go-btn").textContent = "Go anyway?"; // short: the limit warnings box above says why
        this.status("This route breaks a limit (see the warnings). Click GO again to run it anyway.");
        return;
      }
      store.set({ routeExists: true });
      location.hash = "#sim"; // main.ts enterSim() takes it from here
    });

    // Elevation profile hover scrub
    const profCanvas = $("frame-profile-canvas") as HTMLCanvasElement;
    profCanvas.addEventListener("pointermove", (e) => {
      if (!this.lastResult || !this.lastResult.profile.length) return;
      const r = profCanvas.getBoundingClientRect();
      const xNorm = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const totalDist = this.lastResult.stats?.distance_m || 1;
      const targetD = xNorm * totalDist;

      // Find closest profile point
      let bestP = this.lastResult.profile[0];
      let bestIdx = 0;
      let minDiff = Infinity;
      this.lastResult.profile.forEach((p, idx) => {
        const diff = Math.abs(p.d - targetD);
        if (diff < minDiff) {
          minDiff = diff;
          bestP = p;
          bestIdx = idx;
        }
      });

      const sm = this.lastResult.smooth[bestIdx] || [0, 0];
      this.frame.setScrubber({ x: sm[0], y: bestP.y, z: sm[1] });

      const info = $("fp-hover-info");
      info.textContent = `D: ${bestP.d.toFixed(0)}m | Elev: ${(this.meta.origin_elev_m + bestP.y).toFixed(1)}m | Slope: ${bestP.s.toFixed(1)}° | O₂ margin: ${fmtDur(bestP.margin)}`;
    });

    profCanvas.addEventListener("pointerleave", () => {
      this.frame.setScrubber(null);
      $("fp-hover-info").textContent = "Hover route to inspect";
    });
  }

  /** Ground under (x, z): mean and max slope over a 5 x 5 m window of the 1 m DTM; no-go = the cell actually stood on
   *  (a planned path never enters a no-go cell, but it may pass within 2 m of one). */
  terrainAt(x: number, z: number) {
    const w = this.meta.width, h = this.meta.height;
    const cj = Math.round((x - this.meta.extent_x_m[0]) / this.meta.res_x_m), ci = Math.round((z - this.meta.extent_z_m[0]) / this.meta.res_z_m);
    let sum = 0, n = 0, max = 0, nogo = false;
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= h || j >= w) continue;
      const s = this.slopeBuf[i * w + j];
      sum += s; n++; if (s > max) max = s;
    }
    if (ci >= 0 && cj >= 0 && ci < h && cj < w) nogo = !Number.isFinite(this.costBuf[ci * w + cj]);
    return { slope: n ? sum / n : 0, maxSlope: max, nogo };
  }

  /** Everything Sim mode needs from the planned route (null until a valid route and the home field exist). */
  simContext() {
    const r = this.lastResult;
    if (!r || !r.ok || !this.homeTime) return null;
    const stops = r.order.map((i) => {
      const id = this.selectedStops[i];
      const p = this.poisData.pois.find((q) => q.id === id) || this.customMarkers.find((q) => q.id === id)!;
      return { name: p.name, x: p.x, z: p.z, type: (p as any).type, description: (p as any).description,
        image: (p as any).image?.file ? { file: (p as any).image.file, credit: (p as any).image.credit } : undefined,
        fact: (p as any).facts?.[0] ? { text: (p as any).facts[0].text, source: (p as any).facts[0].source } : undefined };
    });
    return { res: r, stops, homeTime: this.homeTime, limits: { ...this.limits }, worker: this.worker, cellOf: (x: number, z: number) => this.cellOf(x, z),
      terrainAt: (x: number, z: number) => this.terrainAt(x, z), slopeBins: this.slopeBins,
      layers: { options: () => this.layerOptionsHtml(), current: () => this.currentLayer, select: (k: string) => this.selectLayer(k), legend: () => this.layerLegendHtml() }, stopIds: r.order.map((i) => this.selectedStops[i]) };
  }

  show() {
    this.toolbar.hidden = false;
    this.frame.setSunTime(this.frame.sunStartMs); // (model lights arrive after the scene is built)
    const sn = this.frame.sunNow, late = this.frame.sunStartMs > Date.now() + 60000;
    $("fr-sun").textContent = `Walk starts ${late ? "at the next" : "now,"} ${fmtLtst(sn.ltst)} local solar time · sun ${sn.elev.toFixed(0)}° up${late ? " (it is night at the site now)" : ""}`;
    this.closePin();
    this.frame.showOnlyPins(null); // planning: every suggested location is back
    this.refreshLegend();
    this.profileWrap.hidden = false;
    this.rightPanel.hidden = false;

    // Hide Planet mode specific panels
    $("addlayers").style.display = "none";
    $("stats").style.display = "none";
    $("sitecard").hidden = true;
    $("drawer").hidden = true;
    $("coords").hidden = true;

    this.frame.controls.enabled = true;
    this.frame.traverseGroup.visible = this.showTrack;
    this.renderCardsList();
    this.renderStopsSummary();
    if (this.selectedStops.length > 0) {
      this.planRoute();
    }
  }

  /** Remove this site's planning UI (switching site in-page). Window/canvas listeners go with the site scope. */
  dispose() {
    this.hide();
    cancelAnimationFrame(this.pinRaf);
    this.worker.terminate();
    cancelAnimationFrame(this.noteRaf);
    for (const el of [this.toolbar, this.locDrawer, this.legend.el, this.profileWrap, this.rightPanel, this.noteCard, this.noteTip]) el.remove();
  }

  hide() {
    this.toolbar.hidden = true;
    this.closePin();
    this.setNoteMode(false);
    this.closeNote();
    if (this.noteTip) this.noteTip.hidden = true;
    this.legend.show(false);
    this.profileWrap.hidden = true;
    this.rightPanel.hidden = true;

    // Restore Planet mode panels
    $("addlayers").style.display = "";
    $("stats").style.display = "";
    $("coords").hidden = false;

    this.frame.controls.enabled = false;
  }

  /** Safe-return envelope: cells you can walk to and still get back with the reserve intact
   *  (fastest return time <= half the usable O2: out and back). */
  private drawEnvelope() {
    if (!this.homeTime) return;
    const usable = this.limits.suitHours * 3600 - this.limits.reserveMin * 60;
    this.frame.updateEnvelope(this.homeTime, Math.max(0, usable / 2));
  }

  private showTrack = false;
  private legend!: LegendPanel;
  private layer = 0;                       // shader slot: 0 ortho, 1 slope, 2 hazard, 3 science targets, 4 generated
  private layerKey = "0";                  // selected option value
  private overlayLegend: { title: string; spec: LegendSpec; opts?: { lowLabel?: string; highLabel?: string } } | null = null;
  private overlayCache = new Map<string, { tex: import("three").Texture; title: string; spec: LegendSpec; opts?: any }>();
  private globalLayers: LayerStore | null = null;

  /** Global data layers (from the Planet screen's LayerStore) become available in the site view's layer picker. */
  setGlobalLayers(L: LayerStore) {
    if (this.globalLayers) return;
    this.globalLayers = L;
    const sel = $<HTMLSelectElement>("ft-layer-sel");
    const opt = (id: string, label: string) => `<option value="g:${id}">${label}</option>`;
    const named = [["geology", "Geologic units"], ["ti", "Thermal inertia"], ["albedo", "Albedo"], ["dust", "Dust"], ["science", "Science score"]]
      .filter(([id]) => L.meta(id)?.png).map(([id, label]) => opt(id, label)).join("");
    const minerals = L.minerals().map((m) => opt(m.id, `Mineral: ${m.mineral ?? m.id}`)).join("");
    const weather = L.weather().map((m) => opt(m.id, m.name.replace(" (MCD)", ""))).join("");
    sel.insertAdjacentHTML("beforeend", `<optgroup label="Global (km-scale)">${named}</optgroup><optgroup label="Minerals (TES, km-scale)">${minerals}</optgroup>` +
      (weather ? `<optgroup label="Weather this season (MCD, ~300 km)">${weather}</optgroup>` : ""));
  }

  /** Switch the site overlay: built-in site layers, site elevation, or a global layer sampled over the site. */
  async selectLayer(key: string) {
    this.layerKey = key;
    $<HTMLSelectElement>("ft-layer-sel").value = key;
    const op = Number(($("ft-opacity") as HTMLInputElement).value);
    if (/^\d$/.test(key)) {
      this.layer = Number(key); this.overlayLegend = null;
      this.frame.setLayer(this.layer, op);
      this.refreshLegend();
      return;
    }
    let o = this.overlayCache.get(key);
    if (!o) {
      if (key === "elev") {
        const stops = (this.globalLayers?.meta("elevation")?.legend as any)?.stops
          ?? [[0, [40, 30, 120]], [0.25, [40, 110, 200]], [0.5, [60, 180, 120]], [0.75, [220, 210, 90]], [1, [250, 250, 250]]];
        const r = siteElevation(this.meta, this.heightBuf, stops);
        o = { tex: r.tex, title: "Elevation (site)", spec: r.legend };
      } else {
        const L = this.globalLayers!, id = key.slice(2), m = L.meta(id)!;
        const r = await globalSiteTexture(this.meta, m);
        const c = siteLatLon(this.meta, 0, 0);
        const v = L.value(id, c.lat, c.lon);
        const cover = m.group === "weather"
          ? `Climate model cells are ~300 km wide, so this whole 1 km site has one value (${L.seasonLabel()}).`
          : r.cells > 1
          ? `Global pixels here are ${r.pixelKm.toFixed(0)} km wide; this 1 km site straddles ${r.cells} of them, so the overlay shows ${r.cells} flat values.`
          : `One ${r.pixelKm.toFixed(0)}-km global pixel covers this whole 1 km site, so the overlay is a single value.`;
        let spec: LegendSpec;
        let title = `${m.name} · this site`;
        if (m.legend?.type === "categories") {
          const u = L.unit(v as number);
          spec = { ...m.legend, note: `${cover} This site: ${u ? `${u.code}, ${u.name} (${u.age})` : "no unit mapped"}.` } as LegendSpec;
        } else {
          const fmt = v === null ? "no data" : /fraction/.test(m.units) ? `${(v * 100).toFixed(1)}%` : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
          spec = { ...(m.legend as any), mark: v, note: `${cover} Value here: ${fmt} (dashed tick).` };
        }
        o = { tex: r.tex, title, spec };
      }
      this.overlayCache.set(key, o);
    }
    if (this.layerKey !== key) return; // a newer selection won while the image loaded
    this.layer = 4; this.overlayLegend = { title: o.title, spec: o.spec, opts: o.opts };
    this.frame.setOverlayTexture(o.tex, op);
    this.refreshLegend();
  }

  /** Legend for the terrain layer on screen + what the route, outline and pins mean. */
  /** Legend of the terrain overlay on screen ("" for the plain ortho). Also shown under the walk's minimap. */
  layerLegendHtml() {
    const L = this.plannerConfig.legends ?? {};
    if (this.layer === 1 && L.slope) return legendHtml("Slope", L.slope);
    if (this.layer === 2 && L.hazard) return legendHtml("Walk hazard", L.hazard);
    if (this.layer === 3) return legendHtml("Science value (model)", { type: "ramp", stops: VIRIDIS_STOPS as any, min: 0, max: 1, units: "relative",
      note: "Density of science targets weighted by their star rating (σ 60 m)." }, { lowLabel: "low", highLabel: "high" });
    if (this.layer === 4 && this.overlayLegend) return legendHtml(this.overlayLegend.title, this.overlayLegend.spec, this.overlayLegend.opts);
    return "";
  }
  /** Options of the site LAYER picker (site + global groups), for the walk's own picker. */
  layerOptionsHtml() { return $<HTMLSelectElement>("ft-layer-sel").innerHTML; }
  get currentLayer() { return this.layerKey; }

  private refreshLegend() {
    const parts: string[] = [];
    const lg = this.layerLegendHtml();
    if (lg) parts.push(lg);
    const b = this.slopeBins;
    parts.push(keyHtml("Route", [
      { sym: SYM.line(ROUTE_COLORS[0], 4), label: `Route, slope under ${b[0]}°` },
      { sym: SYM.line(ROUTE_COLORS[1], 4), label: `${b[0]}–${b[1]}°` },
      { sym: SYM.line(ROUTE_COLORS[2], 4), label: `${b[1]}–${b[2]}°` },
      { sym: SYM.line(ROUTE_COLORS[3], 4), label: `over ${b[2]}°` },
      { sym: SYM.line("#5ef2c2", 2), label: "Safe-return limit (half the usable O₂)" },
      ...(this.showTrack ? [{ sym: SYM.line("#ffffff", 1.5), label: "Perseverance drive track" }] : []),
    ]));
    parts.push(keyHtml("Pins", [
      { sym: SYM.badge("#5ef2c2", "H"), label: "Habitat: start and shelter" },
      { sym: SYM.badge("#f7b257", "3", "#0e0f13", "#3a3a40"), label: "Science target" },
      { sym: SYM.badge("#f26d4a", "1", "#fff", "#5ef2c2"), label: "Stop in your route (visit order)" },
      { sym: SYM.badge("#ff4f26", "M", "#fff"), label: "Your own pin" },
      { sym: SYM.note(), label: "Your note (hover to read)" },
    ]));
    this.legend.set(parts.join(""));
    this.legend.show(!this.toolbar.hidden); // the walk shows its own layer legend under the minimap
  }
  private statusTimer = 0;
  private status(text: string) {
    const el = $("fl-status");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => (el.hidden = true), 3500);
  }

  /** Leave via the hash route: main.ts's exitFrame() fades out, hides these panels and restores Planet mode.
   *  (Setting the mode here first made exitFrame() think we had already left, leaving the panels on screen.) */
  private exitToPlanet() {
    location.hash = "#planet";
  }

  private dropCustomMarker(x: number, z: number) {
    this.customCount++;
    const id = `custom-${this.customCount}`;
    const name = `Custom Marker ${this.customCount}`;
    const marker: CustomMarker = {
      id,
      name,
      x,
      z,
      lat: this.meta.origin_lat - (z / 3396190) * (180 / Math.PI), // site z grows southward
      lon: this.meta.origin_lon + (x / (3396190 * this.meta.kx_cos_lat)) * (180 / Math.PI),
    };
    this.customMarkers.push(marker);
    this.frame.addCustomMarker(id, x, z, `M${this.customCount}`);
    this.toggleStop(id);
    this.openPin(id);
  }

  /** Start over: no stops, no custom pins, no route (and no "change from last route"), default 3D view. */
  resetPlan() {
    this.closePin();
    if (this.addMarkerMode) { this.addMarkerMode = false; $("fl-add-custom").classList.remove("on"); $("fl-drop-hint").hidden = true; }
    for (const m of [...this.customMarkers]) this.frame.removeCustomMarker(m.id);
    this.customMarkers = [];
    this.setNoteMode(false);
    this.closeNote();
    for (const n of this.notes) this.frame.removeNote(n.id);
    this.notes = [];
    this.selectedStops = [];
    this.lastResult = null;
    this.prevResult = null;
    this.frame.updateMarkerBadges(this.selectedStops);
    this.renderCardsList();
    this.renderStopsSummary();
    this.frame.clearRoute();
    this.renderSummary(null);
    $("fr-diff").hidden = true;
    $("alt-fast-val").textContent = "--";
    $("alt-safe-val").textContent = "--";
    $("ft-tilt").classList.add("on");
    $("ft-topdown").classList.remove("on");
    this.frame.resetView();
  }

  removeCustomMarker(id: string) {
    this.customMarkers = this.customMarkers.filter((m) => m.id !== id);
    this.selectedStops = this.selectedStops.filter((s) => s !== id);
    this.frame.removeCustomMarker(id);
    this.renderCardsList();
    this.renderStopsSummary();
    this.planRoute();
  }

  toggleStop(id: string) {
    const idx = this.selectedStops.indexOf(id);
    if (idx >= 0) {
      this.selectedStops.splice(idx, 1);
    } else {
      if (this.selectedStops.length >= MAX_STOPS) {
        this.status(`At most ${MAX_STOPS} stops per walk.`);
        return;
      }
      this.selectedStops.push(id);
    }
    this.frame.updateMarkerBadges(this.selectedStops);
    this.renderCardsList();
    this.renderStopsSummary();
    this.planRoute();
  }

  moveStop(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= this.selectedStops.length) return;
    const temp = this.selectedStops[index];
    this.selectedStops[index] = this.selectedStops[target];
    this.selectedStops[target] = temp;
    this.frame.updateMarkerBadges(this.selectedStops);
    this.renderCardsList();
    this.renderStopsSummary();
    this.planRoute();
  }

  private renderStopsSummary() {
    const wrap = $("fl-stops-summary");
    $("fl-clear-stops").hidden = !this.selectedStops.length;
    if (!this.selectedStops.length) {
      wrap.innerHTML = `<p class="hint">No stops yet. Click a pin on the map to see it and add it.</p>`;
      return;
    }
    const n = this.selectedStops.length;
    const rows = this.selectedStops.map((id, idx) => {
      const poi = this.poisData.pois.find((p) => p.id === id) || this.customMarkers.find((m) => m.id === id);
      return `
        <div class="fl-stop-item">
          <span class="badge orange">${idx + 1}</span>
          <button class="fl-stop-name" data-open="${id}" title="Show this pin">${esc(poi ? poi.name : id)}</button>
          <span class="fl-stop-btns">
            <button class="fl-btn-xs" data-move="${idx}" data-dir="-1" title="Move earlier" ${idx === 0 ? "disabled" : ""}>▲</button>
            <button class="fl-btn-xs" data-move="${idx}" data-dir="1" title="Move later" ${idx === n - 1 ? "disabled" : ""}>▼</button>
            <button class="fl-btn-xs del" data-remove="${id}" title="Remove stop">×</button>
          </span>
        </div>`;
    }).join("");
    wrap.innerHTML = `<div class="fl-stop-item home"><span class="badge mint">H</span><span class="fl-stop-name">Habitat (start)</span></div>` + rows +
      `<div class="fl-stop-item home"><span class="badge mint">H</span><span class="fl-stop-name">Habitat (return)</span></div>`;
    wrap.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((btn) =>
      btn.addEventListener("click", () => this.moveStop(Number(btn.dataset.move), Number(btn.dataset.dir) as -1 | 1)));
    wrap.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => btn.addEventListener("click", () => this.toggleStop(btn.dataset.remove!)));
    wrap.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((btn) => btn.addEventListener("click", () => this.openPin(btn.dataset.open!)));
  }

  // ---------------------------------------------------------------- planning notes
  private setNoteMode(on: boolean) {
    this.noteMode = on;
    document.getElementById("fl-add-note")?.classList.toggle("on", on);
    const hint = document.getElementById("fl-drop-hint");
    if (!hint) return;
    if (on) { hint.textContent = "Click the terrain to place your note. Esc cancels."; hint.hidden = false; }
    else if (!this.addMarkerMode) hint.hidden = true;
  }

  private dropNote(x: number, z: number) {
    const id = `note-${++this.noteCount}`;
    this.notes.push({ id, x, z, text: "" });
    this.frame.addNote(id, x, z);
    this.closePin();
    this.openNote(id, true);
  }

  private removeNote(id: string) {
    if (this.openNoteId === id) { this.openNoteId = null; cancelAnimationFrame(this.noteRaf); this.noteCard.hidden = true; }
    this.notes = this.notes.filter((n) => n.id !== id);
    this.frame.removeNote(id);
  }

  /** The note card: a 140-character text box with a counter, Delete and Close; follows its bubble. */
  openNote(id: string, fresh = false) {
    const n = this.notes.find((q) => q.id === id);
    if (!n) return;
    if (this.openNoteId && this.openNoteId !== id) this.closeNote();
    this.openNoteId = id;
    this.noteTip.hidden = true;
    const max = FrameUI.NOTE_MAX;
    this.noteCard.innerHTML = `
      <div class="pc-body">
        <div class="pc-top"><span class="badge">note</span><span class="nc-count num" id="nc-count">${n.text.length} / ${max}</span>
          <button class="pc-btn pc-close" id="nc-close" title="Close (an empty note is removed)">×</button></div>
        <textarea id="nc-text" class="nc-text" maxlength="${max}" rows="6" placeholder="Short note for this spot" spellcheck="true"></textarea>
        <div class="pc-actions"><button class="pc-btn danger" id="nc-delete">Delete note</button></div>
      </div>`;
    const ta = this.noteCard.querySelector<HTMLTextAreaElement>("#nc-text")!;
    ta.value = n.text;
    ta.addEventListener("input", () => {
      if (ta.value.length > max) ta.value = ta.value.slice(0, max);
      n.text = ta.value;
      this.noteCard.querySelector("#nc-count")!.textContent = `${ta.value.length} / ${max}`;
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); this.closeNote(); } });
    this.noteCard.querySelector("#nc-close")!.addEventListener("click", () => this.closeNote());
    this.noteCard.querySelector("#nc-delete")!.addEventListener("click", () => this.removeNote(id));
    this.noteCard.hidden = false;
    cancelAnimationFrame(this.noteRaf);
    const follow = () => {
      if (this.openNoteId !== id) return;
      this.placeCardAt(this.noteCard, this.frame.noteSprites.get(id));
      this.noteRaf = requestAnimationFrame(follow);
    };
    follow();
    if (fresh || !n.text) ta.focus();
  }

  /** Close the note card; a note left empty is removed (no stray blank bubbles). */
  closeNote() {
    const id = this.openNoteId;
    if (!id) return;
    this.openNoteId = null;
    cancelAnimationFrame(this.noteRaf);
    this.noteCard.hidden = true;
    const n = this.notes.find((q) => q.id === id);
    if (n && !n.text.trim()) this.removeNote(id);
  }

  /** Keep a card beside its marker inside the free part of the centre view (below the toolbar, above the profile). */
  private placeCardAt(card: HTMLElement, sp: { position: { clone(): any } } | undefined) {
    if (!sp) return;
    const c = $("centre").getBoundingClientRect();
    const v = sp.position.clone().project(this.frame.camera);
    const x = ((v.x + 1) / 2) * innerWidth - c.left, y = ((1 - v.y) / 2) * innerHeight - c.top;
    const W = card.offsetWidth, H = card.offsetHeight, top = 60, bottom = c.height - 140;
    let left = x + 24;
    if (left + W > c.width - 10) left = x - 24 - W;
    left = Math.max(10, Math.min(c.width - W - 10, left));
    let ty = Math.max(top, Math.min(bottom - H, y - H / 2));
    if (v.z > 1) { left = 10; ty = top; }
    card.style.left = `${left}px`;
    card.style.top = `${ty}px`;
  }

  private openPinId: string | null = null;
  private pinRaf = 0;

  /** Show the card for one pin (POI, habitat or custom marker). */
  openPin(id: string) {
    this.openPinId = id;
    this.renderCardsList();
    this.locDrawer.hidden = false;
    cancelAnimationFrame(this.pinRaf);
    const follow = () => {
      if (!this.openPinId) return;
      this.placePinCard();
      this.pinRaf = requestAnimationFrame(follow);
    };
    follow();
  }

  closePin() {
    this.openPinId = null;
    cancelAnimationFrame(this.pinRaf);
    if (this.locDrawer) this.locDrawer.hidden = true;
  }

  /** Keep the card beside its pin, inside the free part of the centre view (below the toolbar, above the profile). */
  private placePinCard() {
    const id = this.openPinId!;
    const sp = this.frame.poiSprites.get(id) || this.frame.customSprites.get(id);
    const card = this.locDrawer;
    if (!sp) return;
    const c = $("centre").getBoundingClientRect();
    const v = sp.position.clone().project(this.frame.camera);
    const x = ((v.x + 1) / 2) * innerWidth - c.left, y = ((1 - v.y) / 2) * innerHeight - c.top;
    const W = card.offsetWidth, H = card.offsetHeight, top = 60, bottom = c.height - 140;
    let left = x + 24;
    if (left + W > c.width - 10) left = x - 24 - W; // flip to the left of the pin
    left = Math.max(10, Math.min(c.width - W - 10, left));
    let ty = Math.max(top, Math.min(bottom - H, y - H / 2));
    if (v.z > 1) { left = 10; ty = top; } // pin behind the camera
    card.style.left = `${left}px`;
    card.style.top = `${ty}px`;
  }

  private renderCardsList() {
    const id = this.openPinId;
    if (!id) return;
    const card = this.locDrawer;
    const hab = this.poisData.habitat;
    const poi = id === "habitat" ? hab : this.poisData.pois.find((p) => p.id === id);
    const custom = poi ? null : this.customMarkers.find((m) => m.id === id);
    const p = poi || custom;
    if (!p) { this.closePin(); return; }
    const isSelected = this.selectedStops.includes(id);
    const orderIdx = this.selectedStops.indexOf(id);
    const walk = this.homeTime ? this.homeTime[this.cellOf(p.x, p.z)] : NaN;
    const walkStr = id === "habitat" ? "start" : Number.isFinite(walk) ? `${Math.round(walk / 60)} min walk` : "-- min";
    const elev = (this.meta.origin_elev_m + this.frame.hf.sample(p.x, p.z)).toFixed(0);
    const hazard = Math.round(this.computeHazardRating(p.x, p.z) * 100);
    const P = poi as any;
    const img = P?.image?.file ? `${SITE_BASE}${P.image.file}` : "";
    const type = id === "habitat" ? "start and shelter" : poi ? P.type : "your pin";
    card.className = `pin-card ${id === "habitat" ? "habitat" : custom ? "custom" : ""} ${isSelected ? "selected" : ""}`;
    const stars = P?.science_weight ? `<div class="pc-stars" title="Science rating ${P.science_weight}/5">${"★".repeat(P.science_weight)}${"☆".repeat(5 - P.science_weight)}</div>` : "";
    const actions = id === "habitat" ? `<p class="pc-desc">Every walk starts and ends here.</p>${this.frame.splat ? `<div class="pc-actions"><button class="pc-btn primary" id="pc-scan" title="Fly down to the rover stop, where the 3D scan (Gaussian splat) from the rover's own photos looks right">VIEW 3D SCAN</button></div>` : ""}` : `<div class="pc-actions">
          <button class="pc-btn ${isSelected ? "on" : "primary"}" id="pc-toggle" data-toggle-poi="${id}">${isSelected ? "In route · remove" : "Add to route"}</button>
          ${custom ? `<button class="pc-btn danger" id="pc-delete">Delete pin</button>` : ""}
        </div>`;
    card.innerHTML = `
      ${img ? `<div class="pc-thumb"><img src="${img}" alt="" onerror="this.parentElement.remove()" /></div>` : ""}
      <div class="pc-body">
        <div class="pc-top"><span class="badge ${id === "habitat" ? "mint" : "amber"}">${esc(type)}</span>
          ${isSelected ? `<span class="badge orange">Stop ${orderIdx + 1}</span>` : ""}
          <button class="fl-btn-xs pc-close" id="pc-close" title="Close (Esc)">×</button></div>
        <div class="pc-name">${esc(p.name)}</div>
        ${stars}
        ${P?.description ? `<p class="pc-desc">${esc(P.description)}</p>` : ""}
        <div class="pc-stats num"><span>▲ ${elev} m</span><span>⏱ ${walkStr}</span><span>⚠ ${hazard}% steep</span></div>
        ${P?.facts?.[0] ? `<a class="pc-fact" href="${P.facts[0].source}" target="_blank" rel="noopener">${esc(P.facts[0].text)}</a>` : ""}
        ${actions}
      </div>`;
    $("pc-close").addEventListener("click", () => this.closePin());
    card.querySelector("#pc-scan")?.addEventListener("click", () => { this.closePin(); this.frame.viewSplat(); });
    card.querySelector("#pc-toggle")?.addEventListener("click", () => this.toggleStop(id));
    card.querySelector("#pc-delete")?.addEventListener("click", () => { this.closePin(); this.removeCustomMarker(id); });
  }

  /** Plan the current walk; `withAlternatives` also recomputes the λ = 0.2 / 0.8 options (only needed when the stops change). */
  planRoute(withAlternatives = true) {
    if (!this.selectedStops.length) {
      this.frame.clearRoute();
      this.renderSummary(null);
      return;
    }

    const stops = this.selectedStops.map((id) => {
      const p = this.poisData.pois.find((x) => x.id === id) || this.customMarkers.find((x) => x.id === id);
      return p ? this.cellOf(p.x, p.z) : this.homeCell;
    });

    const id = ++this.reqId;
    this.worker.postMessage({
      type: "plan",
      id,
      home: this.homeCell,
      stops,
      lambda: this.lambda,
      limits: this.limits,
      optimise: true,
      maxBrute: 6,
    });

    if (!withAlternatives) return;
    // Also compute fast (0.2) and safe (0.8) alternatives in background
    this.worker.postMessage({
      type: "plan",
      id: -100, // special ID for altFast
      home: this.homeCell,
      stops,
      lambda: this.alts[0],
      limits: this.limits,
      optimise: true,
      maxBrute: 6,
    });
    this.worker.postMessage({
      type: "plan",
      id: -200, // special ID for altSafe
      home: this.homeCell,
      stops,
      lambda: this.alts[1],
      limits: this.limits,
      optimise: true,
      maxBrute: 6,
    });
  }

  private handlePlanResult(id: number, res: RouteResult) {
    if (id === -100) {
      $("alt-fast-val").textContent = res.ok && res.stats
        ? `${(res.stats.distance_m / 1000).toFixed(2)} km · ${fmtDur(res.stats.time_s)} · safety ${res.stats.safety}` : "no route";
      return;
    }
    if (id === -200) {
      $("alt-safe-val").textContent = res.ok && res.stats
        ? `${(res.stats.distance_m / 1000).toFixed(2)} km · ${fmtDur(res.stats.time_s)} · safety ${res.stats.safety}` : "no route";
      return;
    }
    if (id !== this.reqId) return;

    this.prevResult = this.lastResult;
    this.lastResult = res;

    this.frame.updateRoute(res, this.slopeBins);
    this.renderSummary(res);
    this.renderProfile(res);

    // Update danger level in right rail (100 - safety)
    const dangerMarker = $("danger-marker");
    if (res.ok && res.stats) {
      const hazard = (100 - res.stats.safety) / 100;
      dangerMarker.hidden = false;
      dangerMarker.style.left = `calc(${(hazard * 100).toFixed(1)}% - 1px)`;
      dangerMarker.title = `Route risk ${(hazard * 100).toFixed(0)}% (100 - safety)`;
    }

    // Refine diff
    const diffWrap = $("fr-diff");
    if (this.prevResult?.stats && res.stats) {
      const diff = diffText(this.prevResult.stats, res.stats);
      if (diff) {
        $("fr-diff-text").textContent = diff;
        diffWrap.hidden = false;
      } else {
        diffWrap.hidden = true;
      }
    } else {
      diffWrap.hidden = true;
    }

    // Update Go button
    const goBtn = $("fr-go-btn") as HTMLButtonElement;
    goBtn.disabled = !res.ok;
    goBtn.classList.toggle("warn", res.ok && res.flags.length > 0);
    goBtn.textContent = res.ok && res.flags.length ? "Go · limits exceeded" : "Go · simulate";
    store.set({ routeExists: res.ok });
  }

  private renderSummary(res: RouteResult | null) {
    const table = $("fr-summary-table");
    const viol = $("fr-violations");

    if (!res) {
      table.innerHTML = `<p class="hint">Click a pin on the map, then Add to route</p>`;
      viol.hidden = true;
      ($("fr-go-btn") as HTMLButtonElement).disabled = true;
      return;
    }

    if (!res.ok) {
      table.innerHTML = `<p class="warn" style="color:var(--risk)">${res.message || "Route calculation failed."}</p>`;
      viol.hidden = true;
      return;
    }

    const s = res.stats!;
    table.innerHTML = `
      <div class="fr-stat-row"><span>Distance</span><span class="num">${(s.distance_m / 1000).toFixed(2)} km</span></div>
      <div class="fr-stat-row"><span>Est. time</span><span class="num">${fmtDur(s.time_s)}</span></div>
      <div class="fr-stat-row"><span>Climb / descent</span><span class="num">+${s.climb_m.toFixed(0)} / −${s.descent_m.toFixed(0)} m</span></div>
      <div class="fr-stat-row"><span>Max slope</span><span class="num ${s.max_slope_deg > 25 ? "risk" : ""}">${s.max_slope_deg.toFixed(1)}°</span></div>
      <div class="fr-stat-row"><span>Return O₂</span><span class="num">${s.o2_return_pct.toFixed(0)}% (${fmtDur(s.o2_return_min * 60)})</span></div>
      <div class="fr-stat-row"><span>Radiation dose</span><span class="num">${s.dose_msv.toFixed(3)} mSv</span></div>
      <div class="fr-stat-row"><span>Hazards</span><span class="num">${s.hazards} (${s.hazard_m.toFixed(0)} m)</span></div>
      <div class="fr-stat-row highlight"><span>Safety score</span><span class="num mint big">${s.safety} / 100</span></div>
    `;

    // Limit violations
    if (res.flags && res.flags.length) {
      viol.hidden = false;
      viol.innerHTML = `
        <div class="label small" style="color:var(--risk)">Limit warnings</div>
        <ul>${res.flags.map((f) => `<li>${f}</li>`).join("")}</ul>
      `;
    } else {
      viol.hidden = true;
    }
  }

  private renderProfile(res: RouteResult) {
    const cv = $("frame-profile-canvas") as HTMLCanvasElement;
    if (!res.ok || !res.profile.length) {
      const g = cv.getContext("2d")!;
      g.clearRect(0, 0, cv.width, cv.height);
      return;
    }

    const pr = res.profile;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = cv.clientWidth * dpr);
    const H = (cv.height = cv.clientHeight * dpr);
    const g = cv.getContext("2d")!;

    const padL = 36 * dpr, padR = 24 * dpr, padT = 16 * dpr, padB = 22 * dpr;
    const dMax = pr[pr.length - 1].d || 1;

    let yMin = Infinity, yMax = -Infinity;
    pr.forEach((p) => {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    });
    if (yMax - yMin < 5) {
      yMax += 2.5;
      yMin -= 2.5;
    }

    const X = (d: number) => padL + (d / dMax) * (W - padL - padR);
    const Y = (y: number) => H - padB - ((y - yMin) / (yMax - yMin)) * (H - padT - padB);

    g.clearRect(0, 0, W, H);

    // Background grid lines
    g.strokeStyle = "rgba(86, 71, 92, 0.4)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, Y(yMin));
    g.lineTo(W - padR, Y(yMin));
    g.moveTo(padL, Y((yMin + yMax) / 2));
    g.lineTo(W - padR, Y((yMin + yMax) / 2));
    g.moveTo(padL, Y(yMax));
    g.lineTo(W - padR, Y(yMax));
    g.stroke();

    // Axis labels
    g.font = `${10 * dpr}px JetBrains Mono, monospace`;
    g.fillStyle = "#85808a";
    g.textAlign = "right";
    g.fillText(`${(this.meta.origin_elev_m + yMax).toFixed(0)}m`, padL - 4, Y(yMax) + 4);
    g.fillText(`${(this.meta.origin_elev_m + yMin).toFixed(0)}m`, padL - 4, Y(yMin));
    g.textAlign = "center";
    g.fillText("0m", padL, H - 4);
    g.fillText(`${(dMax / 1000).toFixed(2)}km`, W - padR, H - 4);

    // Elevation line colored by slope bins
    g.lineWidth = 3 * dpr;
    const binOf = (s: number) => {
      let b = 0;
      while (b < this.slopeBins.length && s >= this.slopeBins[b]) b++;
      return Math.min(b, BIN_COLORS.length - 1);
    };

    for (let k = 1; k < pr.length; k++) {
      g.strokeStyle = BIN_COLORS[binOf(pr[k].s)];
      g.beginPath();
      g.moveTo(X(pr[k - 1].d), Y(pr[k - 1].y));
      g.lineTo(X(pr[k].d), Y(pr[k].y));
      g.stroke();
    }

    // Mark point of no return if any
    if (res.stats && res.stats.pnr_index >= 0) {
      const pnrP = pr[res.stats.pnr_index];
      g.fillStyle = "#ff4f26";
      g.beginPath();
      g.arc(X(pnrP.d), Y(pnrP.y), 4 * dpr, 0, Math.PI * 2);
      g.fill();
      g.fillText("PNR", X(pnrP.d), Y(pnrP.y) - 6 * dpr);
    }
  }
}

function esc(v: string) {
  return String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
