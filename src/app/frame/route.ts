// Frame-mode route planning (PRD feature 3). Pure TS (worker + Node): reuses the Phase 1 A* engine.
//  - fastest <-> safest:  cell cost = (1 - λ)·time + λ·risk     (both >= 1, so A* stays admissible)
//      time = exp(3.5·tan(slope))  (Tobler-style slowdown)   risk = 1 + 6(slope/25)² + 8·roughness
//  - order: brute force up to N stops, else nearest-neighbour + 2-opt on the pairwise leg costs
//  - limits along the whole route: O2 budget (suit - reserve), walk-back (time home <= O2 left - reserve), dose
import { Planner, walkSpeed, type Grid, type PlannerParams } from "../../planner/astar.ts";

export interface Limits { suitHours: number; reserveMin: number; doseBudgetMsv: number; doseRateMsvH: number; hazardSlopeDeg: number }

export interface RouteResult {
  ok: boolean;
  message?: string;
  lambda: number;
  order: number[];                 // indices into the requested stops (excluding the home start)
  cells: number[];                 // closed loop home -> stops -> home
  smooth: [number, number][];
  profile: { d: number; y: number; s: number; t: number; margin: number }[];
  stats?: {
    distance_m: number; time_s: number; climb_m: number; descent_m: number; max_slope_deg: number;
    o2_return_min: number; o2_return_pct: number; dose_msv: number; hazards: number; hazard_m: number;
    safety: number;               // 0..100 (higher = safer)
    min_margin_s: number;         // smallest walk-back margin along the route (s)
    pnr_index: number;            // first profile index where the margin goes negative (-1 = never)
    bin_share: number[];
  };
  flags: string[];                // limit violations, plain language
  ms: number;
}

export class RoutePlanner {
  readonly base: Grid;
  readonly params: PlannerParams;
  readonly time: Float32Array;   // time cost per cell (>= 1): slope slowdown only
  readonly risk: Float32Array;   // risk cost per cell (>= 1): slope + roughness (boulders), weighted towards roughness
  private planners = new Map<number, Planner>();
  homeTime: Float32Array | null = null; // fastest walking time (s) from every cell back to home
  home = -1;

  constructor(base: Grid, params: PlannerParams) {
    this.base = base;
    this.params = params;
    this.time = new Float32Array(base.cost.length);
    this.risk = new Float32Array(base.cost.length);
    for (let i = 0; i < base.cost.length; i++) {
      const c = base.cost[i], s = base.slope[i];
      if (!Number.isFinite(c)) { this.time[i] = this.risk[i] = Infinity; continue; }
      this.time[i] = Math.exp(3.5 * Math.tan((s * Math.PI) / 180));
      // Phase 1 cost = 1 + (s/9)^2 + 2·rough_norm  ->  recover rough_norm (0..1)
      const rough = Math.max(0, Math.min(1, (c - 1 - (s / 9) ** 2) / 2));
      // Rough (bouldery) ground barely slows walking but is the main trip / injury risk.
      this.risk[i] = 1 + 6 * (s / 25) ** 2 + 8 * rough;
    }
  }

  planner(lambda: number): Planner {
    const key = Math.round(lambda * 100) / 100;
    let p = this.planners.get(key);
    if (!p) {
      const c = new Float32Array(this.base.cost.length);
      for (let i = 0; i < c.length; i++) {
        c[i] = Number.isFinite(this.risk[i]) ? (1 - key) * this.time[i] + key * this.risk[i] : Infinity;
      }
      p = new Planner({ ...this.base, cost: c }, this.params);
      if (this.planners.size > 4) this.planners.delete(this.planners.keys().next().value!);
      this.planners.set(key, p);
    }
    return p;
  }

  /** Dijkstra over walking time (same Tobler pace as the summaries) from `home` to every cell.
   *  Walking is symmetric in time except for grade; we use the return direction (cell -> home). */
  computeHomeTime(home: number) {
    const { w, h, dx, dz, height } = this.base;
    const n = w * h, T = new Float32Array(n).fill(Infinity), done = new Uint8Array(n);
    const v0 = this.params.walkSpeed;
    const heapI: number[] = [], heapK: number[] = [];
    const push = (i: number, k: number) => {
      let j = heapI.length; heapI.push(i); heapK.push(k);
      while (j > 0) { const p = (j - 1) >> 1; if (heapK[p] <= k) break; heapI[j] = heapI[p]; heapK[j] = heapK[p]; j = p; }
      heapI[j] = i; heapK[j] = k;
    };
    const pop = () => {
      const top = heapI[0], li = heapI.pop()!, lk = heapK.pop()!;
      if (heapI.length) {
        let j = 0;
        for (;;) { let c = 2 * j + 1; if (c >= heapI.length) break; if (c + 1 < heapI.length && heapK[c + 1] < heapK[c]) c++; if (heapK[c] >= lk) break; heapI[j] = heapI[c]; heapK[j] = heapK[c]; j = c; }
        heapI[j] = li; heapK[j] = lk;
      }
      return top;
    };
    T[home] = 0; push(home, 0);
    const DI = [-1, -1, -1, 0, 0, 1, 1, 1], DJ = [-1, 0, 1, -1, 1, -1, 0, 1];
    while (heapI.length) {
      const c = pop();
      if (done[c]) continue;
      done[c] = 1;
      const ci = Math.floor(c / w), cj = c - ci * w;
      for (let k = 0; k < 8; k++) {
        const ni = ci + DI[k], nj = cj + DJ[k];
        if (ni < 0 || nj < 0 || ni >= h || nj >= w) continue;
        const nb = ni * w + nj;
        if (done[nb] || !Number.isFinite(this.base.cost[nb])) continue;
        const hl = Math.hypot(DI[k] * dz, DJ[k] * dx);
        // travel nb -> c (towards home): grade = (h_c - h_nb) / hl
        const grade = (height[c] - height[nb]) / hl;
        const t = T[c] + Math.hypot(hl, height[c] - height[nb]) / walkSpeed(v0, grade);
        if (t < T[nb]) { T[nb] = t; push(nb, t); }
      }
    }
    this.homeTime = T;
    this.home = home;
    return T;
  }

  /** Fastest route (λ = 0) from one cell to each target cell — used to re-plan to shelter after an incident. */
  routesTo(from: number, targets: number[]) {
    const t0 = now();
    const P = this.planner(0);
    const { w, dx, dz, height } = this.base;
    const v0 = this.params.walkSpeed;
    const out = targets.map((to) => {
      if (!P.passable(from) || !P.passable(to)) return { ok: false, cells: [] as number[], smooth: [] as [number, number][], time_s: Infinity, distance_m: Infinity };
      const leg = P.astar(from, to);
      if (!leg) return { ok: false, cells: [] as number[], smooth: [] as [number, number][], time_s: Infinity, distance_m: Infinity };
      const cells = Array.from(leg.cells);
      let t = 0, dist = 0;
      for (let k = 1; k < cells.length; k++) {
        const a = cells[k - 1], b = cells[k];
        const hl = Math.hypot((Math.floor(b / w) - Math.floor(a / w)) * dz, ((b % w) - (a % w)) * dx);
        const dh = height[b] - height[a], len = Math.hypot(hl, dh);
        dist += len; t += len / walkSpeed(v0, hl > 0 ? dh / hl : 0);
      }
      return { ok: true, cells, smooth: P.describe(cells).smooth, time_s: t, distance_m: dist };
    });
    return { routes: out, ms: now() - t0 };
  }

  /** Plan a closed walk home -> stops -> home. */
  plan(home: number, stops: number[], lambda: number, limits: Limits, optimise = true, maxBrute = 6): RouteResult {
    const t0 = now();
    const P = this.planner(lambda);
    const fail = (message: string): RouteResult => ({ ok: false, message, lambda, order: [], cells: [], smooth: [], profile: [], flags: [message], ms: now() - t0 });
    if (!stops.length) return fail("Add at least one stop.");
    if (!P.passable(home)) return fail("The habitat is on a no-go cell.");
    const bad = stops.findIndex((s) => !P.passable(s));
    if (bad >= 0) return fail(`Stop ${bad + 1} is on no-go terrain (too steep or rough).`);
    if (this.home !== home || !this.homeTime) this.computeHomeTime(home);

    const pts = [home, ...stops], n = pts.length;
    const legs: (Int32Array | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
    const C: number[][] = Array.from({ length: n }, () => Array(n).fill(Infinity));
    const need = optimise ? allPairs(n) : seqPairs(n);
    for (const [i, j] of need) {
      const leg = P.astar(pts[i], pts[j]);
      if (!leg) continue;
      legs[i][j] = leg.cells; C[i][j] = leg.cost;
      legs[j][i] = leg.cells.slice().reverse(); C[j][i] = P.pathCost(legs[j][i]!);
    }
    let order = stops.map((_, k) => k + 1);
    if (optimise) order = n - 1 <= maxBrute ? bruteOrder(C, n) : twoOpt(C, nnOrder(C, n));
    const seq = [0, ...order, 0];
    for (let k = 0; k < seq.length - 1; k++) {
      if (!legs[seq[k]][seq[k + 1]]) {
        const who = seq[k + 1] === 0 ? "the habitat" : `stop ${seq[k + 1]}`;
        return fail(`No route: ${who} cannot be reached without crossing no-go terrain.`);
      }
    }
    const cells: number[] = [];
    for (let k = 0; k < seq.length - 1; k++) {
      const leg = legs[seq[k]][seq[k + 1]]!;
      for (let q = k === 0 ? 0 : 1; q < leg.length; q++) cells.push(leg[q]);
    }
    const desc = P.describe(cells);
    const res = this.evaluate(cells, desc.smooth, limits);
    return { ok: true, lambda, order: order.map((o) => o - 1), cells, smooth: desc.smooth, ...res, ms: now() - t0 };
  }

  /** Time line, walk-back margin, O2, dose, hazards and safety for a cell path. */
  evaluate(cells: number[], smooth: [number, number][], L: Limits) {
    const { w, dx, dz, height, slope } = this.base;
    const v0 = this.params.walkSpeed, T = this.homeTime!;
    const usable = L.suitHours * 3600 - L.reserveMin * 60;
    const bins = [0, ...this.params.slopeBins, 90], binLen = new Array(bins.length - 1).fill(0);
    let t = 0, dist = 0, climb = 0, descent = 0, maxS = 0, hazards = 0, hazM = 0, inHaz = false, riskSum = 0;
    const risks: number[] = [];
    let minMargin = Infinity, pnr = -1;
    const profile: RouteResult["profile"] = [];
    const flags: string[] = [];
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (k > 0) {
        const a = cells[k - 1];
        const hl = Math.hypot((Math.floor(c / w) - Math.floor(a / w)) * dz, ((c % w) - (a % w)) * dx);
        const dh = height[c] - height[a], len = Math.hypot(hl, dh);
        dist += len; if (dh > 0) climb += dh; else descent -= dh;
        t += len / walkSpeed(v0, hl > 0 ? dh / hl : 0);
        const s = 0.5 * (slope[a] + slope[c]);
        let b = 0; while (b < bins.length - 2 && s >= bins[b + 1]) b++;
        binLen[b] += len;
        if (s >= L.hazardSlopeDeg) { hazM += len; if (!inHaz) { hazards++; inHaz = true; } } else inHaz = false;
      }
      maxS = Math.max(maxS, slope[c]);
      const r = Math.min(1, (this.risk[c] - 1) / 14); // 0 (benign) .. 1 (max slope + boulders)
      risks.push(r); riskSum += r;
      const margin = usable - t - (Number.isFinite(T[c]) ? T[c] : Infinity);
      if (margin < minMargin) minMargin = margin;
      if (margin < 0 && pnr < 0) pnr = k;
      profile.push({ d: dist, y: height[c], s: slope[c], t, margin });
    }
    risks.sort((a, b) => a - b);
    const p90 = risks[Math.floor(0.9 * (risks.length - 1))] ?? 0;
    const safety = Math.round(100 * (1 - Math.min(1, 0.5 * (riskSum / Math.max(1, risks.length)) + 0.5 * p90)));
    const o2Left = L.suitHours * 3600 - t;
    const dose = (t / 3600) * L.doseRateMsvH;
    if (usable <= 0) flags.push(`The ${L.reserveMin}-min O₂ reserve is larger than the ${L.suitHours} h suit supply: no walk is possible.`);
    else if (t > usable) flags.push(`Walk takes ${fmtDur(t)}, more than the O₂ budget of ${fmtDur(usable)} (suit ${L.suitHours} h − ${L.reserveMin} min reserve).`);
    if (pnr >= 0) flags.push(`Point of no return at T+${fmtDur(profile[pnr].t)}: from there, getting home takes longer than the O₂ left minus reserve.`);
    if (dose > L.doseBudgetMsv) flags.push(`Dose ${dose.toFixed(3)} mSv exceeds the per-walk budget ${L.doseBudgetMsv} mSv.`);
    void smooth;
    return {
      profile, flags,
      stats: {
        distance_m: dist, time_s: t, climb_m: climb, descent_m: descent, max_slope_deg: maxS,
        o2_return_min: o2Left / 60, o2_return_pct: (100 * o2Left) / (L.suitHours * 3600), dose_msv: dose,
        hazards, hazard_m: hazM, safety, min_margin_s: minMargin, pnr_index: pnr,
        bin_share: binLen.map((l) => (dist > 0 ? l / dist : 0)),
      },
    };
  }
}

export function diffText(prev: RouteResult["stats"], next: RouteResult["stats"]) {
  if (!prev || !next) return "";
  const dd = next.distance_m - prev.distance_m, dt = next.time_s - prev.time_s;
  const sign = (x: number) => (x >= 0 ? "+" : "−");
  return `${sign(dd)}${Math.abs(dd).toFixed(0)} m, ${sign(dt)}${Math.round(Math.abs(dt) / 60)} min, safety ${prev.safety} → ${next.safety}`;
}

export function fmtDur(s: number) {
  if (!Number.isFinite(s)) return "∞";
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

function allPairs(n: number) { const o: [number, number][] = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) o.push([i, j]); return o; }
function seqPairs(n: number) { const o: [number, number][] = []; for (let i = 0; i < n - 1; i++) o.push([i, i + 1]); o.push([0, n - 1]); return o; }
function tourCost(C: number[][], order: number[]) { let c = 0, p = 0; for (const k of order) { c += C[p][k]; p = k; } return c + C[p][0]; }
function bruteOrder(C: number[][], n: number) {
  const items = Array.from({ length: n - 1 }, (_, k) => k + 1);
  let best = items, bc = Infinity;
  const rec = (cur: number[], rest: number[]) => {
    if (!rest.length) { const c = tourCost(C, cur); if (c < bc) { bc = c; best = cur.slice(); } return; }
    for (let i = 0; i < rest.length; i++) rec([...cur, rest[i]], rest.filter((_, j) => j !== i));
  };
  rec([], items);
  return best;
}
function nnOrder(C: number[][], n: number) {
  const left = new Set(Array.from({ length: n - 1 }, (_, k) => k + 1)), out: number[] = [];
  let p = 0;
  while (left.size) { let b = -1, bc = Infinity; for (const k of left) if (C[p][k] < bc) { bc = C[p][k]; b = k; } if (b < 0) b = left.values().next().value!; out.push(b); left.delete(b); p = b; }
  return out;
}
function twoOpt(C: number[][], order: number[]) {
  let best = order.slice(), bc = tourCost(C, best), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let j = i + 1; j < best.length; j++) {
      const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
      const c = tourCost(C, cand);
      if (c < bc - 1e-9) { best = cand; bc = c; improved = true; }
    }
  }
  return best;
}
function now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }
