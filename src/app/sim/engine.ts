// Sim engine (PRD features 5-7). Pure TS: fixed 1 s steps, no DOM / three (testable under Node).
import { walkSpeed } from "../../planner/astar.ts";
import type { HealthModel } from "./body.ts";

export interface SimConfig {
  step_s: number; substep_s?: number; gravity_ratio: number; load_kg: number; kj_per_l_o2: number; ref_metabolic_w: number; rq: number;
  suit_temp_base_c: number; suit_temp_per_w: number; suit_temp_lag_s: number; battery_hours: number;
  off_route_m: number; arrive_m: number; dose_limit_msv: number;
  spe: { multiplier: number; alert_min: number; duration_min: number };
  leak: { o2_multiplier: number };
}

export interface SimWorld {
  height(x: number, z: number): number;
  inside(x: number, z: number): boolean;
  homeTime(x: number, z: number): number;          // fastest walking time (s) back to the habitat
  walkSpeedMps: number;                             // suited pace on flat ground
  suitHours: number; reserveMin: number;
  doseRateMsvH: number;                             // GCR model at this site
  shelters: { id: string; name: string; x: number; z: number }[];
}

export type Pt = [number, number];
export interface SimEvent { t: number; kind: string; text: string; severity: "info" | "warn" | "critical" }
export interface Tick {
  t: number; x: number; z: number; heading: number; o2_l: number; o2_pct: number; co2_pct: number; hr: number; met_w: number;
  suit_c: number; core_c: number; batt_pct: number; dose_msv: number; dose_rate: number; speed: number; route_v: number;
  mode: string; margin_s: number; return_s: number; incidents: string[]; ev?: string[];
}
export type Outcome = { result: "success" | "failure"; cause: string; t: number } | null;

export class SimEngine {
  t = 0; x: number; z: number; heading = 0; speed = 0;
  mode: "auto" | "explore" = "auto";
  paused = false;
  hold = false;  // sheltering: time runs, the walker stays put until the solar event is over
  o2Cap: number; o2: number; co2Pct = 0; battPct = 100; dose = 0; suitC: number; hr = 0; met = 0; core = 37;
  routeVersion = 0;
  route: Pt[] = []; stops: { name: string; x: number; z: number; reached: boolean }[] = [];
  private seg = 0; private segPos = 0;
  routeGoal: "plan" | "shelter" = "plan";
  shelterTarget: string | null = null;
  incidents: { spe?: { until: number; deadline: number }; leak?: boolean } = {};
  events: SimEvent[] = [];
  log: Tick[] = [];
  outcome: Outcome = null;
  pnr = false; offRoute = false;
  leftShelter = false;
  /** the user's planned walk (route + stops with their reached flags), kept while a shelter route is active */
  private plan: { pts: Pt[]; stops: { name: string; x: number; z: number; reached: boolean }[] } | null = null;
  private planSeg = 0;            // where the planned walk was interrupted (route segment index)
  /** set when a solar event ends while sheltering: the caller plans a leg from here to `target` and calls resumeVia() */
  resumeRequest: { target: Pt } | null = null; // a walk can only finish after leaving shelter at least once
  input = { forward: 0, turn: 0 };  // self-explore controls
  marginS = Infinity; returnS = 0;
  private pendingEv: string[] = [];
  private walkO2Lps: number;

  readonly cfg: SimConfig;
  readonly world: SimWorld;
  readonly body: HealthModel;

  // (no parameter properties: keeps the file runnable under Node's strip-only TS mode)
  constructor(cfg: SimConfig, world: SimWorld, body: HealthModel, start: Pt) {
    this.cfg = cfg; this.world = world; this.body = body;
    [this.x, this.z] = start;
    this.o2Cap = (world.suitHours * 3600 * cfg.ref_metabolic_w) / (cfg.kj_per_l_o2 * 1000);
    this.o2 = this.o2Cap;
    this.suitC = cfg.suit_temp_base_c;
    // O2 rate used for "time left" and the walk-back margin: the suit's rated average workload (EMU design ~293 W), or the
    // flat-ground walking rate if that is higher -> an 8 h suit shows ~8 h left at the start, and the margin stays conservative
    const walkW = (body as any).metabolic ? (body as any).metabolic(world.walkSpeedMps, 0, cfg.load_kg, cfg.gravity_ratio) : 0;
    this.walkO2Lps = Math.max(walkW, cfg.ref_metabolic_w) / (cfg.kj_per_l_o2 * 1000);
  }

  /** Resume the planned walk after sheltering: `leg` = path from here to the bookmark (null = go straight there). */
  resumeVia(leg: Pt[] | null) {
    if (!this.plan) { this.resumeRequest = null; return; }
    const rest = this.plan.pts.slice(Math.min(this.planSeg + 1, this.plan.pts.length - 1));
    const pts: Pt[] = [...(leg && leg.length ? leg : [[this.x, this.z] as Pt]), ...rest];
    this.stops = this.plan.stops; // remaining stops keep their reached flags
    const planPts = this.plan.pts;
    this.setRoute(pts, null, "plan", "back to the planned walk after sheltering");
    this.plan = { pts: planPts, stops: this.stops };
    this.seg = 0; this.segPos = 0; // start at the leg's beginning (here), never at a later point of a looping route
    this.resumeRequest = null;
  }

  /** stops = null keeps the current stops and their reached flags (re-joining the same plan). */
  setRoute(pts: Pt[], stops: { name: string; x: number; z: number }[] | null, goal: "plan" | "shelter", why: string, shelterId: string | null = null) {
    if (goal === "shelter" && this.routeGoal === "plan" && this.plan) this.planSeg = this.seg; // bookmark the walk
    this.route = pts.slice();
    if (stops) this.stops = stops.map((s) => ({ ...s, reached: false }));
    this.seg = 0; this.segPos = 0;
    // start from the route point nearest to the current position
    let best = 0, bd = Infinity;
    pts.forEach(([px, pz], i) => { const d = Math.hypot(px - this.x, pz - this.z); if (d < bd) { bd = d; best = i; } });
    this.seg = Math.min(best, Math.max(0, pts.length - 2));
    this.routeGoal = goal;
    this.shelterTarget = shelterId;
    if (goal === "plan") this.plan = { pts: this.route, stops: this.stops };
    this.routeVersion++;
    this.emit("route", `Route v${this.routeVersion}: ${why}`, goal === "shelter" ? "warn" : "info");
  }

  emit(kind: string, text: string, severity: SimEvent["severity"] = "info") {
    this.events.push({ t: this.t, kind, text, severity });
    this.pendingEv.push(`${kind}: ${text}`);
  }

  // ---- incidents
  injectSPE(source = "injected") {
    if (this.incidents.spe) return;
    const c = this.cfg.spe;
    this.incidents.spe = { until: this.t + c.duration_min * 60, deadline: this.t + c.alert_min * 60 };
    this.emit("incident", `Solar particle event (${source}): dose rate ×${c.multiplier} for ${c.duration_min} min. Reach shelter within ${c.alert_min} min.`, "critical");
  }
  injectLeak() {
    if (this.incidents.leak) return;
    this.incidents.leak = true;
    this.emit("incident", `Suit leak: O₂ drain ×${this.cfg.leak.o2_multiplier}. Switch to backup supply and abort to the habitat.`, "critical");
  }

  doseRate() { return this.world.doseRateMsvH * (this.incidents.spe && this.t < this.incidents.spe.until && !this.inShelter() ? this.cfg.spe.multiplier : 1); }
  inShelter() { return this.world.shelters.some((s) => Math.hypot(s.x - this.x, s.z - this.z) < this.cfg.arrive_m); }
  o2TimeLeftS() { return this.o2 / (this.walkO2Lps * (this.incidents.leak ? this.cfg.leak.o2_multiplier : 1)); }

  /** Advance by dt (default: the fixed log step). The UI sub-steps (substep_s) for smooth motion and
   *  responsive controls; the tick log still gets exactly one entry per whole second of sim time. */
  step(dt = this.cfg.step_s) {
    if (this.outcome) return;
    const prevT = this.t;
    let moved = 0, grade = 0;
    if (!this.paused && !this.hold && !this.resumeRequest) {
      if (this.mode === "auto" && this.route.length > 1) { const r = this.walkRoute(dt); moved = r.d; grade = r.grade; }
      else if (this.mode === "explore") { const r = this.walkFree(dt); moved = r.d; grade = r.grade; }
    }
    this.speed = moved / dt;
    const out = this.body.step({ dt, speedMps: this.speed, grade, loadKg: this.cfg.load_kg, gravity: this.cfg.gravity_ratio,
      ambientC: -60, doseRateMsvH: this.doseRate() });
    this.hr = out.heartRate; this.met = out.metabolicW; this.core = out.coreTempC;
    const o2use = out.o2UseLps * dt * (this.incidents.leak ? this.cfg.leak.o2_multiplier : 1);
    this.o2 = Math.max(0, this.o2 - o2use);
    this.co2Pct = Math.min(100, this.co2Pct + (100 * out.o2UseLps * dt * this.cfg.rq) / (this.o2Cap * this.cfg.rq));
    const suitTarget = this.cfg.suit_temp_base_c + this.cfg.suit_temp_per_w * (this.met - 150);
    this.suitC += (suitTarget - this.suitC) * Math.min(1, dt / this.cfg.suit_temp_lag_s);
    this.battPct = Math.max(0, this.battPct - (100 * dt) / (this.cfg.battery_hours * 3600));
    this.dose += (this.doseRate() * dt) / 3600;
    this.t = Math.round((this.t + dt) * 1000) / 1000;
    if (!this.leftShelter && !this.world.shelters.some((s) => Math.hypot(s.x - this.x, s.z - this.z) < 2 * this.cfg.arrive_m)) this.leftShelter = true;
    for (const a of out.alerts) if (!this.events.some((e) => e.text === a && this.t - e.t < 300)) this.emit("body", a, "warn");

    // walk-back limit: getting home must fit in the O2 left minus the reserve
    // a free walker can stand on a cell the planner marks no-go (+inf); keep the last finite estimate there
    const ht = this.world.homeTime(this.x, this.z);
    this.returnS = Number.isFinite(ht) ? ht : this.returnS + (moved / Math.max(0.1, this.world.walkSpeedMps));
    this.marginS = this.o2TimeLeftS() - this.world.reserveMin * 60 - this.returnS;
    if (this.marginS < 0 && !this.pnr && !this.inShelter()) {
      this.pnr = true;
      this.emit("pnr", `Point of no return: getting home takes ${fmt(this.returnS)}, O₂ left minus reserve is ${fmt(this.o2TimeLeftS() - this.world.reserveMin * 60)}.`, "critical");
    } else if (this.marginS >= 0 && this.pnr) { this.pnr = false; this.emit("pnr", "Back inside the safe-return envelope.", "info"); }

    if (this.incidents.spe) {
      const s = this.incidents.spe;
      if (prevT < s.deadline && this.t >= s.deadline && !this.inShelter()) this.emit("incident", "SPE alert time passed outside shelter: dose accumulating.", "critical");
      if (this.t >= s.until) {
        delete this.incidents.spe;
        this.emit("incident", this.hold ? "Solar particle event over: leaving shelter, the walk resumes." : "Solar particle event over.", "info");
        this.hold = false;
        if (this.routeGoal === "shelter" && this.plan && !this.incidents.leak) {
          // nearest-point rejoin could skip unvisited stops (a shelter near the route's end): go back to the bookmark
          this.resumeRequest = { target: this.plan.pts[Math.min(this.planSeg, this.plan.pts.length - 1)] };
        }
      }
    }
    // failure / success
    if (this.o2 <= 0) this.end("failure", `O₂ ran out at T+${fmt(this.t)}${this.pnr ? " after passing the point of no return" : ""}.`);
    else if (this.dose >= this.cfg.dose_limit_msv) this.end("failure", `Dose limit ${this.cfg.dose_limit_msv} mSv passed at T+${fmt(this.t)}.`);

    if (Math.floor(this.t + 1e-6) === Math.floor(prevT + 1e-6) && !this.outcome) return;
    this.log.push({ t: this.t, x: this.x, z: this.z, heading: this.heading, o2_l: this.o2, o2_pct: (100 * this.o2) / this.o2Cap,
      co2_pct: this.co2Pct, hr: this.hr, met_w: this.met, suit_c: this.suitC, core_c: this.core, batt_pct: this.battPct, dose_msv: this.dose,
      dose_rate: this.doseRate(), speed: this.speed, route_v: this.routeVersion, mode: this.paused ? "paused" : this.hold ? "sheltering" : this.mode,
      margin_s: this.marginS, return_s: this.returnS, incidents: Object.keys(this.incidents),
      ...(this.pendingEv.length ? { ev: this.pendingEv.splice(0) } : {}) });
  }

  end(result: "success" | "failure", cause: string) {
    if (this.outcome) return;
    this.outcome = { result, cause, t: this.t };
    this.emit("end", result === "failure" ? `Mission failure — crew lost. ${cause}` : `Success. ${cause}`, result === "failure" ? "critical" : "info");
  }

  private walkRoute(dt: number) {
    let budget = 0, d = 0, grade = 0;
    const p0x = this.x, p0z = this.z, h0 = this.world.height(this.x, this.z);
    // speed from the slope of the segment ahead (Tobler, suited pace)
    const [ax, az] = this.route[this.seg], [bx, bz] = this.route[Math.min(this.seg + 1, this.route.length - 1)];
    const segLen = Math.hypot(bx - ax, bz - az) || 1e-6;
    const g = (this.world.height(bx, bz) - this.world.height(ax, az)) / segLen;
    budget = walkSpeed(this.world.walkSpeedMps, g) * dt;
    while (budget > 0 && this.seg < this.route.length - 1) {
      const [sx, sz] = this.route[this.seg], [ex, ez] = this.route[this.seg + 1];
      const L = Math.hypot(ex - sx, ez - sz);
      const left = L - this.segPos;
      if (budget < left) { this.segPos += budget; budget = 0; }
      else { budget -= left; this.seg++; this.segPos = 0; }
      const [cx, cz] = this.route[this.seg], [nx, nz] = this.route[Math.min(this.seg + 1, this.route.length - 1)];
      const l2 = Math.hypot(nx - cx, nz - cz) || 1;
      this.x = cx + ((nx - cx) / l2) * this.segPos;
      this.z = cz + ((nz - cz) / l2) * this.segPos;
      if (l2 > 1e-3) this.heading = Math.atan2(nx - cx, -(nz - cz));
    }
    // distance actually walked this step: never more than the walking speed allows. A route switch snaps the walker onto
    // the new route; counting that jump as walking produced 2000+ W spikes (and an O2 burst) in a single sub-step.
    const maxStep = walkSpeed(this.world.walkSpeedMps, g) * dt;
    d = Math.min(Math.hypot(this.x - p0x, this.z - p0z), maxStep);
    grade = d > 0 ? (this.world.height(this.x, this.z) - h0) / d : 0;
    this.checkArrivals();
    if (this.seg >= this.route.length - 1) this.routeDone();
    return { d, grade };
  }

  private walkFree(dt: number) {
    this.heading += this.input.turn * 1.2 * dt;
    if (!this.input.forward) { this.checkArrivals(); return { d: 0, grade: 0 }; }
    const h0 = this.world.height(this.x, this.z);
    const dirx = Math.sin(this.heading), dirz = -Math.cos(this.heading);
    const g = (this.world.height(this.x + dirx, this.z + dirz) - h0);
    const v = walkSpeed(this.world.walkSpeedMps, g) * this.input.forward;
    const nx = this.x + dirx * v * dt, nz = this.z + dirz * v * dt;
    const px = this.x, pz = this.z;
    if (this.world.inside(nx, nz)) { this.x = nx; this.z = nz; }
    // off-route flag
    const off = distToPolyline(this.x, this.z, this.route);
    if (off > this.cfg.off_route_m && !this.offRoute) { this.offRoute = true; this.emit("route", `Off route: ${off.toFixed(0)} m from the planned path.`, "warn"); }
    else if (off <= this.cfg.off_route_m && this.offRoute) { this.offRoute = false; this.emit("route", "Back on route.", "info"); }
    this.checkArrivals();
    if (this.route.length && this.inShelter()) this.routeDone();
    const d = Math.hypot(this.x - px, this.z - pz); // blocked at the AOI edge = standing still
    return { d, grade: d ? (this.world.height(this.x, this.z) - h0) / d : 0 };
  }

  /** Auto-walk reaches stops in the planned order only (a stop passed early, e.g. the depot beside the habitat at the
   *  start, counts when its turn comes); free walking counts any stop the walker reaches. */
  private checkArrivals() {
    const cand = this.mode === "auto" ? this.stops.filter((s) => !s.reached).slice(0, 1) : this.stops.filter((s) => !s.reached);
    for (const s of cand) if (Math.hypot(s.x - this.x, s.z - this.z) < this.cfg.arrive_m) {
      s.reached = true; this.emit("stop", `Reached ${s.name}.`, "info");
    }
  }

  private routeDone() {
    if (!this.inShelter() || !this.leftShelter) return;
    const sh = this.world.shelters.find((s) => Math.hypot(s.x - this.x, s.z - this.z) < this.cfg.arrive_m)!;
    if (this.routeGoal === "shelter" && this.incidents.spe && !this.incidents.leak) {
      // solar event only: wait it out inside, then the planned walk resumes (a suit leak ends the walk instead)
      if (!this.hold) { this.hold = true; this.emit("incident", `Sheltering in ${sh.name} until the solar event is over, then the walk resumes.`, "info"); }
      return;
    }
    if (this.routeGoal === "shelter") this.end("success", `Reached ${sh.name} at T+${fmt(this.t)} with ${Math.round((100 * this.o2) / this.o2Cap)}% O₂ (route v${this.routeVersion}).`);
    else if (this.stops.every((s) => s.reached)) this.end("success", `Walk complete: back at ${sh.name} at T+${fmt(this.t)} with ${Math.round((100 * this.o2) / this.o2Cap)}% O₂.`);
  }
}

export function distToPolyline(x: number, z: number, pts: Pt[]) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
    best = Math.min(best, Math.hypot(x - (ax + t * vx), z - (az + t * vz)));
  }
  return best;
}

export function fmt(s: number) {
  if (!Number.isFinite(s)) return "∞";
  const sign = s < 0 ? "−" : "";
  s = Math.abs(Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${h ? h + ":" : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(sec).padStart(2, "0")}`;
}
