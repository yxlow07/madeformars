// Debrief and replay (PRD Screen 5): site map with the walked trail and event markers, timeline scrubber
// with play / speed, O2 / work-rate / dose small multiples that follow the scrubber, outcome + rule summary.
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { FrameScene } from "../frame/frame";
import { labelSprite } from "../frame/frame";
import { fmt, type Tick } from "../sim/engine";
import type { RunLog } from "../sim/ui";
import { summarise, type Summary } from "./summary";
import { LegendPanel, keyHtml, SYM } from "../legend";
import { siteSignal } from "../site";
import { dangerAt, type LocalTerrain } from "../sim/danger";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const C = { mint: "#5ef2c2", amber: "#f7b257", risk: "#f05a3c", cream: "#ece6dc", muted: "#85808a", line: "#3a3a40", bg: "#0e0f13" };
const SEV: Record<string, string> = { critical: C.risk, warn: C.amber, info: C.muted };

interface Marker { t: number; i: number; kind: string; text: string; sev: string }

export class DebriefUI {
  private frame: FrameScene;
  private run: RunLog | null = null;
  private sum: Summary | null = null;
  private markers: Marker[] = [];
  private idx = 0;
  private playing = false;
  private speed = 60;
  private hoverI: number | null = null;
  private group = new THREE.Group();
  private markerGroup = new THREE.Group();
  private lines: Line2[] = [];
  readonly cursor: THREE.Group;
  private dom!: { bottom: HTMLDivElement; right: HTMLElement; canvas: HTMLCanvasElement };
  private legend!: LegendPanel;
  /** Ground sampler from the Frame planner (set by main.ts): the danger bar follows the replayed spot. */
  terrainAt: ((x: number, z: number) => LocalTerrain) | null = null;
  slopeBins: number[] | undefined;

  constructor(frame: FrameScene) {
    this.frame = frame;
    this.cursor = makeCursor();
    this.group.add(this.markerGroup, this.cursor);
    this.group.visible = false;
    frame.scene.add(this.group);
    this.createDom();
    this.bind();
    window.addEventListener("resize", () => {
      for (const l of this.lines) (l.material as LineMaterial).resolution.set(innerWidth, innerHeight);
      if (this.run) this.drawCharts();
    }, { signal: siteSignal() });
  }

  get active() { return !!this.run; }
  get current() { return this.run; }

  show(run: RunLog) {
    this.run = run;
    this.sum = summarise(run);
    this.frame.clearRoute();
    this.frame.traverseGroup.visible = false;
    const ids: string[] = [];
    for (const [id, sp] of this.frame.poiSprites) if (run.plan.stops.some((s) => Math.hypot(s.x - sp.position.x, s.z - sp.position.z) < 2)) ids.push(id);
    this.frame.showOnlyPins(ids); // the debrief draws this run's own plan; Frame re-plans its route on return
    this.buildScene();
    this.fitCamera();
    this.renderRight();
    this.dom.bottom.hidden = false; this.dom.right.hidden = false;
    this.legend.show(true);
    $("addlayers").style.display = "none";
    $("stats").style.display = "none";
    $("event").style.display = "none";
    $("coords").hidden = true;
    $("danger-marker").hidden = false;
    this.frame.controls.enabled = true;
    const slider = $<HTMLInputElement>("db-slider");
    slider.max = String(run.log.length - 1);
    this.playing = false;
    this.seek(run.log.length - 1); // open on the end state
    this.setPlaying(false);
    this.loadRunList();
  }

  /** Remove this site's debrief UI (switching site in-page). */
  dispose() {
    this.hide();
    for (const el of [this.dom.bottom, this.dom.right, this.legend.el]) el.remove();
  }

  hide() {
    this.run = null;
    this.playing = false;
    this.group.visible = false;
    this.dom.bottom.hidden = true; this.dom.right.hidden = true;
    this.legend.show(false);
    $("addlayers").style.display = "";
    $("stats").style.display = "";
    $("event").style.display = "";
    $("coords").hidden = false;
    $("danger-marker").hidden = true;
    $("danger-note").hidden = true;
  }

  update(dt: number) {
    if (!this.run) return;
    // keep the replay cursor readable at any zoom
    this.cursor.scale.setScalar(Math.max(0.6, this.frame.camera.position.distanceTo(this.cursor.position) / 80));
    // pulse ring, like the minimap marker
    const pulse = this.cursor.getObjectByName("pulse") as THREE.Mesh | undefined;
    if (pulse) {
      const ph = (performance.now() / 1000 * 0.7) % 1;
      pulse.scale.setScalar(1 + ph * 1.9);
      (pulse.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - ph);
    }
    if (!this.playing) return;
    const n = this.run.log.length - 1;
    const step = this.run.config.sim.step_s || 1;
    this.idx = Math.min(n, this.idx + (Math.min(0.25, dt) * this.speed) / step);
    this.seek(this.idx);
    if (this.idx >= n) this.setPlaying(false);
  }

  /** Move the replay to tick i: position and readouts come straight from the logged tick. */
  seek(i: number) {
    const run = this.run;
    if (!run) return null;
    this.idx = Math.max(0, Math.min(run.log.length - 1, i));
    const tk = run.log[Math.round(this.idx)];
    const y = this.frame.hf.sample(tk.x, tk.z);
    this.cursor.position.set(tk.x, y, tk.z);
    this.cursor.rotation.y = -tk.heading;
    $<HTMLInputElement>("db-slider").value = String(Math.round(this.idx));
    $("db-time").textContent = `T+${fmt(tk.t)} / ${fmt(run.log[run.log.length - 1].t)}`;
    this.readout(tk);
    const terr = this.terrainAt ? this.terrainAt(tk.x, tk.z) : { slope: 0, maxSlope: 0, nogo: false };
    const dg = dangerAt(terr, { spe: tk.incidents.includes("spe"), sheltered: tk.mode === "sheltering", leak: tk.incidents.includes("leak"), pnr: tk.margin_s < 0 }, this.slopeBins);
    $("danger-marker").style.left = `calc(${(dg.value * 100).toFixed(1)}% - 1px)`;
    $("danger-note").textContent = dg.label;
    $("danger-note").className = `danger-note num lv-${dg.level.toLowerCase()}`;
    $("danger-note").hidden = false;
    this.drawCharts();
    return { t: tk.t, x: tk.x, z: tk.z, o2_pct: tk.o2_pct, hr: tk.hr, dose_msv: tk.dose_msv };
  }

  // ------------------------------------------------------------------ scene
  private buildScene() {
    const run = this.run!;
    for (const l of this.lines) { this.group.remove(l); l.geometry.dispose(); (l.material as LineMaterial).dispose(); }
    this.lines = [];
    this.markerGroup.clear();
    const hf = this.frame.hf;
    // planned route: thin cream
    this.lines.push(this.addLine(run.plan.smooth.map(([x, z]) => [x, hf.sample(x, z) + 0.3, z]), null, 2, 0xdbccb5, 0.55));
    // walked trail coloured by state: mint ok, amber on a re-planned (shelter) route, red past the point of no return
    const pos: number[][] = [], col: THREE.Color[] = [];
    let px = Infinity, pz = Infinity;
    run.log.forEach((t, k) => {
      if (k && k < run.log.length - 1 && Math.hypot(t.x - px, t.z - pz) < 1.5) return;
      px = t.x; pz = t.z;
      pos.push([t.x, hf.sample(t.x, t.z) + 0.45, t.z]);
      col.push(new THREE.Color(t.margin_s < 0 ? C.risk : t.route_v > 1 ? C.amber : C.mint));
    });
    if (pos.length > 1) this.lines.push(this.addLine(pos, col, 4));

    // event markers from the tick log
    this.markers = [];
    let pnrSeen = false;
    run.log.forEach((t, i) => {
      for (const e of t.ev ?? []) {
        const k = e.slice(0, e.indexOf(":")), text = e.slice(e.indexOf(":") + 2);
        let label = "", sev = "info";
        if (k === "incident" && !/over/.test(text)) { label = "!"; sev = "critical"; }
        else if (k === "pnr" && /point of no return/i.test(text) && !pnrSeen) { label = "P"; sev = "critical"; pnrSeen = true; }
        else if (k === "stop") { label = "✓"; sev = "info"; }
        else if (k === "route" && /^Route v([2-9]|\d\d)/.test(text)) { label = "R"; sev = "warn"; }
        else if (k === "route" && /^Off route/.test(text)) { label = "O"; sev = "warn"; }
        else if (k === "end") { label = run.outcome?.result === "failure" ? "✕" : "★"; sev = run.outcome?.result === "failure" ? "critical" : "info"; }
        if (!label) continue;
        this.markers.push({ t: t.t, i, kind: k, text, sev });
        const sp = labelSprite(label, sev === "critical" ? C.risk : sev === "warn" ? C.amber : C.mint, C.bg, C.cream, 26);
        sp.position.set(t.x, hf.sample(t.x, t.z) + 0.6, t.z);
        (sp as any).tickIndex = i;
        this.markerGroup.add(sp);
      }
    });
    this.group.visible = true;
  }

  private addLine(pts: number[][], colors: THREE.Color[] | null, width: number, color = 0xffffff, opacity = 1) {
    const geo = new LineGeometry();
    geo.setPositions(pts.flat());
    if (colors) geo.setColors(colors.flatMap((c) => [c.r, c.g, c.b]));
    const mat = new LineMaterial({ color: colors ? 0xffffff : color, vertexColors: !!colors, linewidth: width, worldUnits: false, transparent: opacity < 1, opacity, depthTest: false });
    mat.resolution.set(innerWidth, innerHeight);
    const l = new Line2(geo, mat);
    l.renderOrder = colors ? 8 : 7;
    this.group.add(l);
    return l;
  }

  private fitCamera() {
    const run = this.run!;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const t of run.log) { x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x); z0 = Math.min(z0, t.z); z1 = Math.max(z1, t.z); }
    for (const [x, z] of run.plan.smooth) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, span = Math.max(120, x1 - x0, z1 - z0);
    const cy = this.frame.hf.sample(cx, cz);
    this.frame.controls.target.set(cx, cy, cz);
    this.frame.camera.position.set(cx, cy + span * 1.25, cz + span * 0.55);
    this.frame.controls.update();
  }

  // ------------------------------------------------------------------ charts (small multiples, one scale each)
  private series(): { key: keyof Tick; title: string; unit: string; min?: number; max?: number; digits: number }[] {
    return [
      { key: "o2_pct", title: "O₂", unit: "%", min: 0, max: 100, digits: 0 },
      { key: "met_w", title: "Work rate", unit: "W", digits: 0 },
      { key: "dose_msv", title: "Dose", unit: "mSv", min: 0, digits: 3 },
    ];
  }

  private drawCharts() {
    const run = this.run;
    if (!run) return;
    const cv = this.dom.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const log = run.log, n = log.length, T = log[n - 1].t || 1;
    const padL = 8, padR = 8, gap = 8;
    const ser = this.series();
    const rowH = (H - gap * (ser.length - 1)) / ser.length;
    const xOf = (t: number) => padL + (t / T) * (W - padL - padR);
    const cur = log[Math.round(this.idx)];
    const shown = this.hoverI !== null ? log[this.hoverI] : cur;

    ser.forEach((s, r) => {
      const top = r * (rowH + gap), bot = top + rowH;
      const vals = log.map((t) => t[s.key] as number);
      let lo = s.min ?? Math.min(...vals), hi = s.max ?? Math.max(...vals);
      if (s.key === "met_w") { lo = Math.floor(lo / 50) * 50; hi = Math.ceil(hi / 50) * 50; }
      if (hi - lo < 1e-9) hi = lo + 1;
      const yOf = (v: number) => bot - 4 - ((v - lo) / (hi - lo)) * (rowH - 22);
      // past the point of no return: faint red band
      g.fillStyle = "rgba(255, 79, 38, 0.12)";
      let start = -1;
      log.forEach((t, k) => {
        const neg = t.margin_s < 0;
        if (neg && start < 0) start = k;
        if ((!neg || k === n - 1) && start >= 0) { g.fillRect(xOf(log[start].t), top, xOf(t.t) - xOf(log[start].t), rowH); start = -1; }
      });
      // recessive frame: baseline only
      g.strokeStyle = C.line; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, bot + 0.5); g.lineTo(W - padR, bot + 0.5); g.stroke();
      // event ticks
      for (const m of this.markers) {
        g.strokeStyle = SEV[m.sev]; g.globalAlpha = 0.8;
        g.beginPath(); g.moveTo(xOf(m.t) + 0.5, top + 16); g.lineTo(xOf(m.t) + 0.5, bot); g.stroke();
      }
      g.globalAlpha = 1;
      // the series: 2px line, decimated to ~2 points per px
      g.strokeStyle = C.mint; g.lineWidth = 2; g.lineJoin = "round";
      g.beginPath();
      const stepK = Math.max(1, Math.floor(n / (W * 2)));
      for (let k = 0; k < n; k += stepK) { const x = xOf(log[k].t), y = yOf(vals[k]); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.lineTo(xOf(log[n - 1].t), yOf(vals[n - 1]));
      g.stroke();
      // labels (text tokens, not the series colour)
      g.font = `500 ${Math.round(11 * innerHeight / 720)}px "JetBrains Mono", monospace`;
      g.fillStyle = C.cream; g.textAlign = "left"; g.textBaseline = "top";
      const title = `${s.title} (${s.unit})`;
      g.fillText(title, padL + 2, top + 2);
      const tw = g.measureText(title).width;
      g.font = `${Math.round(10.5 * innerHeight / 720)}px "JetBrains Mono", monospace`;
      g.fillStyle = C.muted;
      g.fillText(`scale ${lo.toFixed(s.digits)}–${hi.toFixed(s.digits)}`, padL + tw + 14, top + 2);
      // value at the cursor / hover
      const v = shown[s.key] as number;
      g.fillStyle = C.cream; g.textAlign = "right";
      g.fillText(`${v.toFixed(s.digits)} ${s.unit}`, W - padR - 2, top + 2);
      // cursor dot
      g.fillStyle = C.cream; g.strokeStyle = C.bg; g.lineWidth = 2;
      g.beginPath(); g.arc(xOf(shown.t), yOf(v), 4, 0, Math.PI * 2); g.fill(); g.stroke();
    });
    // cursor line (and hover crosshair)
    g.strokeStyle = C.cream; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(xOf(cur.t), 0); g.lineTo(xOf(cur.t), H); g.stroke();
    if (this.hoverI !== null) {
      g.setLineDash([3, 3]); g.strokeStyle = C.muted;
      g.beginPath(); g.moveTo(xOf(shown.t), 0); g.lineTo(xOf(shown.t), H); g.stroke(); g.setLineDash([]);
    }
  }

  private readout(tk: Tick) {
    const ev = [...this.markers].reverse().find((m) => m.t <= tk.t);
    $("db-readout").innerHTML =
      `<span>O₂ <b>${tk.o2_pct.toFixed(0)}%</b></span><span>Work <b>${tk.met_w.toFixed(0)}</b> W</span><span>Dose <b>${tk.dose_msv.toFixed(3)}</b> mSv</span>` +
      `<span>Margin <b class="${tk.margin_s < 0 ? "bad" : ""}">${fmt(tk.margin_s)}</b></span><span>${tk.mode} · v${tk.route_v}</span>` +
      (ev ? `<span class="ev" style="color:${SEV[ev.sev]}">T+${fmt(ev.t)} ${esc(ev.text.slice(0, 80))}</span>` : "");
  }

  // ------------------------------------------------------------------ right rail
  private renderRight() {
    const run = this.run!, s = this.sum!;
    const fail = run.outcome?.result === "failure";
    $("db-outcome").className = `db-outcome ${fail ? "fail" : run.outcome ? "ok" : ""}`;
    $("db-outcome").textContent = fail ? "Mission failure" : run.outcome ? "Success" : "No outcome";
    $("db-cause").textContent = run.outcome?.cause ?? s.headline;
    $("db-first").innerHTML = s.first
      ? `<span class="k">First limit crossed</span><a href="#" data-t="${s.first.t}">${esc(s.first.text)}</a>`
      : `<span class="k">First limit crossed</span><span>None, every limit held</span>`;
    $("db-numbers").innerHTML = s.numbers.map(([k, v]) => `<div><span class="k">${k}</span><span class="num">${esc(v)}</span></div>`).join("");
    $("db-findings").innerHTML = s.findings.map((f) => `<li class="${f.severity}"><a href="#" data-t="${f.t}">${esc(f.text)}</a></li>`).join("") || "<li class=\"info\">Nothing notable.</li>";
    this.dom.right.querySelectorAll<HTMLAnchorElement>("a[data-t]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      this.seekTime(Number(a.dataset.t));
    }));
    $("db-meta").textContent = `${run.site} · ${new Date(run.created).toLocaleString()} · ${run.model}`;
  }

  private seekTime(t: number) {
    const log = this.run!.log;
    let i = log.findIndex((k) => k.t >= t);
    if (i < 0) i = log.length - 1;
    this.setPlaying(false);
    this.seek(i);
  }

  private async loadRunList() {
    const sel = $<HTMLSelectElement>("db-runs");
    try {
      const all: { file: string; created?: string; outcome?: { result: string }; site?: string }[] = await (await fetch("/api/runs")).json();
      const list = all.filter((r) => !r.site || r.site === this.run!.site); // a run replays only on its own site's terrain
      const cur = this.run!.id;
      sel.innerHTML = list.map((r) => {
        const id = r.file.replace(/\.json$/, "");
        return `<option value="${esc(r.file)}" ${id === cur ? "selected" : ""}>${r.created ? new Date(r.created).toLocaleString() : id} · ${r.outcome?.result ?? "?"}</option>`;
      }).join("");
      if (!list.some((r) => r.file.replace(/\.json$/, "") === cur)) sel.insertAdjacentHTML("afterbegin", `<option selected>current run (not saved)</option>`);
    } catch {
      sel.innerHTML = `<option>current run</option>`;
    }
  }

  // ------------------------------------------------------------------ DOM + controls
  private setPlaying(p: boolean) {
    this.playing = p;
    if (p && this.run && this.idx >= this.run.log.length - 1) this.idx = 0; // replay from the start
    $("db-play").textContent = p ? "Pause" : "Play";
  }

  private createDom() {
    const bottom = document.createElement("div");
    bottom.id = "db-bottom"; bottom.hidden = true;
    bottom.innerHTML = `
      <div class="db-row">
        <button id="db-play" class="fr-btn">Play</button>
        <span class="grp"><button class="fr-btn" data-dspeed="10">10×</button><button class="fr-btn on" data-dspeed="60">60×</button><button class="fr-btn" data-dspeed="300">300×</button></span>
        <input id="db-slider" type="range" min="0" max="1" step="1" value="0" aria-label="Replay time" />
        <span id="db-time" class="num">T+0:00</span>
      </div>
      <canvas id="db-charts" title="Drag to scrub. Ticks = events (red critical, amber warning, grey info); red band = past the point of no return."></canvas>
      <div id="db-readout" class="num"></div>`;
    $("centre").appendChild(bottom);

    const right = document.createElement("section");
    right.id = "db-right"; right.className = "dashed"; right.hidden = true;
    right.innerHTML = `
      <div class="label">Debrief</div>
      <div id="db-outcome" class="db-outcome"></div>
      <p id="db-cause"></p>
      <div id="db-first" class="db-first"></div>
      <div id="db-numbers" class="db-numbers"></div>
      <div class="label small">What happened</div>
      <ul id="db-findings"></ul>
      <label class="db-runs-l">Run <select id="db-runs"></select></label>
      <p id="db-meta"></p>
      <div class="db-btns">
        <button id="db-plan" class="fr-btn">Plan again</button>
        <button id="db-globe" class="fr-btn go">Back to globe</button>
      </div>`;
    $("right").insertBefore(right, $("danger"));
    this.dom = { bottom, right, canvas: $<HTMLCanvasElement>("db-charts") };
    this.legend = new LegendPanel($("centre"), "debrief-legend");
    this.legend.set(keyHtml("Walk", [
      { sym: SYM.arrow(), label: "Replay position" },
      { sym: SYM.line(C.mint, 4), label: "Walked trail" },
      { sym: SYM.line(C.amber, 4), label: "Trail on a re-planned route" },
      { sym: SYM.line(C.risk, 4), label: "Trail past the point of no return" },
      { sym: SYM.line(C.cream, 2), label: "Planned route" },
    ]) + keyHtml("Events (click to jump)", [
      { sym: SYM.badge(C.risk, "!"), label: "Incident" },
      { sym: SYM.badge(C.risk, "P"), label: "Point of no return" },
      { sym: SYM.badge(C.amber, "R"), label: "Re-planned" },
      { sym: SYM.badge(C.amber, "O"), label: "Off route" },
      { sym: SYM.badge(C.mint, "✓"), label: "Stop reached" },
      { sym: SYM.badge(C.mint, "★"), label: "End: success" },
      { sym: SYM.badge(C.risk, "✕"), label: "End: failure" },
    ]) + keyHtml("Charts", [
      { sym: SYM.band("rgba(255, 79, 38, 0.35)"), label: "Past the point of no return" },
      { sym: SYM.line(C.risk, 1.5), label: "Event tick (red critical, amber warning, grey info)" },
    ]));
    this.legend.show(false);
  }

  private bind() {
    $("db-play").addEventListener("click", () => this.setPlaying(!this.playing));
    this.dom.bottom.querySelectorAll<HTMLButtonElement>("[data-dspeed]").forEach((b) => b.addEventListener("click", () => {
      this.speed = Number(b.dataset.dspeed);
      this.dom.bottom.querySelectorAll("[data-dspeed]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    $<HTMLInputElement>("db-slider").addEventListener("input", (e) => { this.setPlaying(false); this.seek(Number((e.target as HTMLInputElement).value)); });
    $("db-globe").addEventListener("click", () => { location.hash = "#planet"; });
    $("db-plan").addEventListener("click", () => { location.hash = "#frame"; });
    $<HTMLSelectElement>("db-runs").addEventListener("change", async (e) => {
      const f = (e.target as HTMLSelectElement).value;
      if (!f.endsWith(".json")) return;
      const run = await (await fetch(`/api/runs/${encodeURIComponent(f)}`)).json();
      this.show(run);
    });

    // charts: hover = crosshair readout, press/drag = scrub
    const cv = this.dom.canvas;
    const iAt = (clientX: number) => {
      const r = cv.getBoundingClientRect(), log = this.run!.log, T = log[log.length - 1].t || 1;
      const t = Math.max(0, Math.min(1, (clientX - r.left - 8) / (r.width - 16))) * T;
      let i = log.findIndex((k) => k.t >= t);
      return i < 0 ? log.length - 1 : i;
    };
    let dragging = false;
    cv.addEventListener("pointerdown", (e) => { if (!this.run) return; dragging = true; cv.setPointerCapture(e.pointerId); this.setPlaying(false); this.seek(iAt(e.clientX)); });
    cv.addEventListener("pointermove", (e) => {
      if (!this.run) return;
      if (dragging) { this.hoverI = null; this.seek(iAt(e.clientX)); return; }
      this.hoverI = iAt(e.clientX);
      this.readout(this.run.log[this.hoverI]);
      this.drawCharts();
    });
    cv.addEventListener("pointerup", () => (dragging = false));
    cv.addEventListener("pointerleave", () => { if (!this.run) return; this.hoverI = null; this.seek(this.idx); });

    // click an event marker on the map to jump there
    this.frame.dom.addEventListener("click", (e) => {
      if (!this.run) return;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), this.frame.camera);
      const hit = rc.intersectObjects(this.markerGroup.children)[0];
      if (hit) { this.setPlaying(false); this.seek((hit.object as any).tickIndex); }
    });
  }
}

/** Replay cursor in the minimap style: brand-orange arrow with a white + black outline, dark halo and a
 *  view cone, drawn flat on the ground (always on top), plus a pulse ring animated in update(). */
function makeCursor() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.translate(128, 128);
  g.fillStyle = "rgba(15, 13, 27, 0.55)";
  g.beginPath(); g.arc(0, 0, 46, 0, Math.PI * 2); g.fill();
  const cone = g.createLinearGradient(0, 0, 0, -124);
  cone.addColorStop(0, "rgba(243, 233, 220, 0.6)"); cone.addColorStop(1, "rgba(243, 233, 220, 0)");
  g.fillStyle = cone;
  g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 124, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45); g.closePath(); g.fill();
  const arrow = () => { g.beginPath(); g.moveTo(0, -44); g.lineTo(32, 32); g.lineTo(0, 16); g.lineTo(-32, 32); g.closePath(); };
  g.lineJoin = "round";
  arrow(); g.strokeStyle = "#0e0f13"; g.lineWidth = 18; g.stroke();
  arrow(); g.strokeStyle = "#ffffff"; g.lineWidth = 8; g.stroke();
  arrow(); g.fillStyle = "#ea681d"; g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const flat = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.7; m.renderOrder = 12;
    return m;
  };
  const grp = new THREE.Group();
  const marker = flat(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const pulse = flat(new THREE.RingGeometry(1.45, 1.75, 48), new THREE.MeshBasicMaterial({ color: 0xea681d, transparent: true, depthTest: false, depthWrite: false }));
  pulse.renderOrder = 11;
  pulse.name = "pulse";
  grp.add(pulse, marker);
  return grp;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
