import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Data } from "../data";
import type { HeightField } from "../terrain";
import type { PlanResult, PlannerParams } from "./astar";

const BIN_COLORS = ["#2ea043", "#e6c828", "#eb781e", "#d21e1e"];

/** Ray-march a camera ray against the height field. */
export function pickTerrain(hf: HeightField, ray: THREE.Ray): THREE.Vector3 | null {
  const p = ray.origin.clone();
  const step = 0.5;
  let prevAbove = p.y - (hf.inside(p.x, p.z) ? hf.sample(p.x, p.z) : -1e9);
  let t = 0;
  for (let k = 0; k < 20000; k++) {
    const dt = Math.max(step, Math.min(20, prevAbove * 0.5));
    t += dt;
    p.copy(ray.origin).addScaledVector(ray.direction, t);
    if (t > 6000) return null;
    if (!hf.inside(p.x, p.z)) { prevAbove = 1e9; continue; }
    const above = p.y - hf.sample(p.x, p.z);
    if (above <= 0) {
      // refine by bisection
      let lo = t - dt, hi = t;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const q = ray.origin.clone().addScaledVector(ray.direction, mid);
        if (q.y - hf.sample(q.x, q.z) > 0) lo = mid; else hi = mid;
      }
      const q = ray.origin.clone().addScaledVector(ray.direction, hi);
      q.y = hf.sample(q.x, q.z);
      return q;
    }
    prevAbove = above;
  }
  return null;
}

function labelSprite(text: string, color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.lineWidth = 5; g.strokeStyle = "#1b120d"; g.stroke();
  g.fillStyle = "#1b120d"; g.font = "bold 30px system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false }));
  s.scale.set(0.045, 0.045, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  return s;
}

export class PlannerUI {
  private markers: { pos: THREE.Vector3; sprite: THREE.Sprite }[] = [];
  private start: { pos: THREE.Vector3; sprite: THREE.Sprite };
  private group = new THREE.Group();
  private route: Line2 | null = null;
  private worker: Worker;
  private reqId = 0;
  private dragging = -1;
  private downAt: { x: number; y: number } | null = null;
  readonly params: PlannerParams;
  lastResult: PlanResult | null = null;
  onBusy: (busy: boolean) => void = () => {};

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private dom: HTMLElement,
              private hf: HeightField, data: Data, startPos: THREE.Vector3,
              private orbit: { enabled: boolean }, private isWalking: () => boolean) {
    scene.add(this.group);
    const pp = data.layers.planner, lp = data.layers.params;
    this.params = {
      climbWeight: pp.climb_weight, walkSpeed: pp.walk_speed_mps, slopeBins: lp.slope_bins_deg,
      smoothPasses: pp.smooth_passes, maxStops: pp.max_stops,
    };
    this.start = { pos: startPos.clone(), sprite: labelSprite("S", "#3fd0ff") };
    this.start.sprite.position.copy(startPos).add(new THREE.Vector3(0, 0.5, 0));
    this.group.add(this.start.sprite);

    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const m = data.meta;
    this.worker.postMessage({
      type: "init", params: this.params,
      grid: { w: m.width, h: m.height, dx: m.res_x_m, dz: m.res_z_m, cost: data.cost, height: data.height, slope: data.slope },
    });
    this.buildPanel();
    this.bindPointer();
  }

  private ndc(e: PointerEvent | MouseEvent) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  private rayFrom(e: PointerEvent | MouseEvent) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(this.ndc(e), this.camera);
    return rc.ray;
  }
  /** Index of the marker under the pointer (screen distance), -1 none. */
  private hitMarker(e: PointerEvent | MouseEvent) {
    const r = this.dom.getBoundingClientRect();
    let best = -1, bestD = 18;
    this.markers.forEach((m, i) => {
      const p = m.pos.clone().project(this.camera);
      if (p.z > 1) return;
      const sx = ((p.x + 1) / 2) * r.width + r.left, sy = ((1 - p.y) / 2) * r.height + r.top - 16;
      const d = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  private bindPointer() {
    this.dom.addEventListener("pointerdown", (e) => {
      if (this.isWalking() || e.button !== 0) return;
      const hit = this.hitMarker(e);
      if (hit >= 0) {
        this.dragging = hit;
        this.orbit.enabled = false;
        this.dom.setPointerCapture(e.pointerId);
      } else this.downAt = { x: e.clientX, y: e.clientY };
    });
    this.dom.addEventListener("pointermove", (e) => {
      if (this.dragging < 0) return;
      const p = pickTerrain(this.hf, this.rayFrom(e));
      if (p) this.moveMarker(this.dragging, p);
    });
    this.dom.addEventListener("pointerup", (e) => {
      if (this.dragging >= 0) {
        this.dragging = -1;
        this.orbit.enabled = !this.isWalking();
        this.dom.releasePointerCapture(e.pointerId);
        this.clearRoute();
        return;
      }
      if (this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 5) {
        const p = pickTerrain(this.hf, this.rayFrom(e));
        if (p) this.addMarker(p);
      }
      this.downAt = null;
    });
    this.dom.addEventListener("contextmenu", (e) => {
      const hit = this.hitMarker(e);
      if (hit >= 0) { e.preventDefault(); this.removeMarker(hit); }
    });
  }

  addMarker(p: THREE.Vector3) {
    if (this.markers.length >= this.params.maxStops) { this.status(`At most ${this.params.maxStops} markers.`, true); return; }
    const sprite = labelSprite(String(this.markers.length + 1), "#ffd27a");
    this.group.add(sprite);
    this.markers.push({ pos: p.clone(), sprite });
    this.moveMarker(this.markers.length - 1, p);
    this.clearRoute();
    this.refresh();
  }
  private moveMarker(i: number, p: THREE.Vector3) {
    const m = this.markers[i];
    m.pos.copy(p);
    m.sprite.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
  }
  removeMarker(i: number) {
    const [m] = this.markers.splice(i, 1);
    this.group.remove(m.sprite);
    m.sprite.material.map?.dispose();
    m.sprite.material.dispose();
    this.markers.forEach((mk, k) => {
      const s = labelSprite(String(k + 1), "#ffd27a");
      s.position.copy(mk.sprite.position);
      this.group.remove(mk.sprite);
      this.group.add(s);
      mk.sprite = s;
    });
    this.clearRoute();
    this.refresh();
  }
  clearAll() {
    while (this.markers.length) this.removeMarker(this.markers.length - 1);
  }

  private cellOf(p: THREE.Vector3) {
    const [i, j] = this.hf.cellOf(p.x, p.z);
    return i * this.hf.w + j;
  }

  /** Run the planner; resolves with the result (also drawn). */
  plan(): Promise<PlanResult> {
    const stops = [this.start.pos, ...this.markers.map((m) => m.pos)].map((p) => this.cellOf(p));
    const id = ++this.reqId;
    this.onBusy(true);
    this.status("Planning…");
    return new Promise((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "result" && e.data.id === id) {
          this.worker.removeEventListener("message", handler);
          this.onBusy(false);
          resolve(e.data.res);
        }
      };
      this.worker.addEventListener("message", handler);
      this.worker.postMessage({ type: "plan", id, stops });
    });
  }

  async planAndShow(): Promise<PlanResult> {
    const res = await this.plan();
    this.show(res);
    return res;
  }

  private clearRoute() {
    if (this.route) { this.group.remove(this.route); this.route.geometry.dispose(); this.route = null; }
    this.lastResult = null;
    (document.getElementById("summary") as HTMLElement).innerHTML = "";
    (document.getElementById("profile") as HTMLCanvasElement).hidden = true;
  }

  private show(res: PlanResult) {
    this.clearRoute();
    this.lastResult = res;
    if (!res.ok) { this.status(res.message ?? "No route.", true); return; }
    const bins = this.params.slopeBins;
    const binOf = (s: number) => { let b = 0; while (b < bins.length && s >= bins[b]) b++; return b; };
    // Draped, smoothed polyline coloured by slope bin of the nearest raw cell.
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    const sm = res.smooth;
    for (let k = 0; k < sm.length; k++) {
      const [x, z] = sm[k];
      pos.push(x, this.hf.sample(x, z) + 0.35, z);
      c.set(BIN_COLORS[binOf(res.profile[k].s)]);
      col.push(c.r, c.g, c.b);
    }
    const geo = new LineGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    const mat = new LineMaterial({ linewidth: 4, vertexColors: true, worldUnits: false, depthTest: true });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.route = new Line2(geo, mat);
    this.route.computeLineDistances();
    this.route.renderOrder = 6;
    // dark outline underneath so the slope-coloured line reads on every layer (e.g. green on green)
    const outlineMat = new LineMaterial({ linewidth: 8, color: 0x1b120d, worldUnits: false, depthTest: true, depthWrite: false });
    outlineMat.resolution.set(window.innerWidth, window.innerHeight);
    const outline = new Line2(geo, outlineMat);
    outline.renderOrder = 5;
    this.route.add(outline);
    this.group.add(this.route);
    this.renderSummary(res);
    this.renderProfile(res);
    this.status(`Route found in ${res.ms.toFixed(0)} ms · order S → ${res.order.join(" → ")} → S`);
  }

  private renderSummary(res: PlanResult) {
    const s = res.summary!;
    const edges = [0, ...this.params.slopeBins];
    const t = s.time_s;
    const time = t >= 3600 ? `${Math.floor(t / 3600)} h ${Math.round((t % 3600) / 60)} min` : `${Math.round(t / 60)} min`;
    const binsHtml = s.bin_share.map((f, k) =>
      `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${BIN_COLORS[k]}"></i> ${k < edges.length - 1 ? `${edges[k]}–${edges[k + 1]}°` : `> ${edges[k]}°`}</td><td>${(100 * f).toFixed(1)}%</td></tr>`).join("");
    (document.getElementById("summary") as HTMLElement).innerHTML = `
      <table class="kv">
        <tr><td>Distance</td><td>${(s.distance_m / 1000).toFixed(2)} km</td></tr>
        <tr><td>Climb / descent</td><td>${s.climb_m.toFixed(0)} / ${s.descent_m.toFixed(0)} m</td></tr>
        <tr><td>Max slope</td><td>${s.max_slope_deg.toFixed(1)}°</td></tr>
        <tr><td>Est. time (0.9 m/s, slope-adjusted)</td><td>${time}</td></tr>
        ${binsHtml}
      </table>`;
  }

  private renderProfile(res: PlanResult) {
    const cv = document.getElementById("profile") as HTMLCanvasElement;
    cv.hidden = false;
    const W = (cv.width = cv.clientWidth * devicePixelRatio), H = (cv.height = cv.clientHeight * devicePixelRatio);
    const g = cv.getContext("2d")!;
    const pr = res.profile, pad = 28 * devicePixelRatio;
    const dMax = pr[pr.length - 1].d || 1;
    let yMin = Infinity, yMax = -Infinity;
    for (const p of pr) { yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y); }
    if (yMax - yMin < 5) { yMax += 2.5; yMin -= 2.5; }
    const X = (d: number) => pad + (d / dMax) * (W - pad * 1.5);
    const Y = (y: number) => H - pad * 0.7 - ((y - yMin) / (yMax - yMin)) * (H - pad * 1.4);
    g.clearRect(0, 0, W, H);
    g.font = `${10 * devicePixelRatio}px system-ui`;
    g.fillStyle = "#b9a28e";
    g.fillText(`${yMax.toFixed(0)} m`, 4, Y(yMax) + 4);
    g.fillText(`${yMin.toFixed(0)} m`, 4, Y(yMin));
    g.fillText(`${(dMax / 1000).toFixed(2)} km`, W - pad * 1.6, H - 6);
    const bins = this.params.slopeBins;
    g.lineWidth = 2.5 * devicePixelRatio;
    for (let k = 1; k < pr.length; k++) {
      let b = 0; while (b < bins.length && pr[k].s >= bins[b]) b++;
      g.strokeStyle = BIN_COLORS[b];
      g.beginPath(); g.moveTo(X(pr[k - 1].d), Y(pr[k - 1].y)); g.lineTo(X(pr[k].d), Y(pr[k].y)); g.stroke();
    }
  }

  private status(text: string, warn = false) {
    const el = document.getElementById("plan-status") as HTMLElement;
    el.textContent = text;
    el.classList.toggle("warn", warn);
  }

  private refresh() {
    (document.getElementById("plan-btn") as HTMLButtonElement).disabled = this.markers.length === 0;
    if (!this.lastResult) this.status(this.markers.length ? `${this.markers.length} marker(s). Press Plan route.` : "Click the terrain to add markers.");
  }

  private buildPanel() {
    const sec = document.getElementById("planner-section")!;
    sec.innerHTML = `<h2>Route planner</h2>
      <div class="seg"><button id="plan-btn" disabled>Plan route</button><button id="clear-btn">Clear</button></div>
      <p class="hint">Click terrain to add · drag to move · right-click to remove. S = rover stop (start/end).</p>
      <p class="hint" id="plan-status">Click the terrain to add markers.</p>
      <div id="summary"></div>`;
    document.getElementById("plan-btn")!.addEventListener("click", () => { void this.planAndShow(); });
    document.getElementById("clear-btn")!.addEventListener("click", () => this.clearAll());
    window.addEventListener("resize", () => {
      this.route?.traverse((o) => { if (o instanceof Line2) (o.material as LineMaterial).resolution.set(window.innerWidth, window.innerHeight); });
      if (this.lastResult?.ok) this.renderProfile(this.lastResult);
    });
  }
}
