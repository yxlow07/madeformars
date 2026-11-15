// A* route planner over the cost grid. Pure TS (no DOM / three) so it runs in a Web Worker
// and under Node (scripts/crosscheck.ts) for the TS-vs-Python cross-check.
//
// Grid: row-major, row 0 = north. cost: +Infinity = no-go, else >= 1.
// Edge cost (8-connected) = horizontal step length * mean(cell cost) + climbWeight * max(0, dh).
// Heuristic = straight-line distance * minCost (admissible: every edge costs >= length * minCost).
// Diagonal moves may not cut the corner of a no-go cell.

export interface Grid {
  w: number;
  h: number;
  dx: number;          // metres between columns (east)
  dz: number;          // metres between rows (south)
  cost: Float32Array;
  height: Float32Array;
  slope: Float32Array; // degrees, for summaries
}

export interface PlannerParams {
  climbWeight: number;
  walkSpeed: number;     // m/s on flat ground
  slopeBins: number[];   // e.g. [8, 15, 25]
  smoothPasses: number;
  maxStops: number;
}

export interface Leg { cells: Int32Array; cost: number }

export interface RouteSummary {
  distance_m: number;
  climb_m: number;
  descent_m: number;
  max_slope_deg: number;
  time_s: number;
  bin_share: number[];  // fraction of route length per slope bin
}

export interface PlanResult {
  ok: boolean;
  message?: string;
  order: number[];            // visit order (indices into stops)
  cells: number[];            // raw cell path (closed loop start -> ... -> start)
  smooth: [number, number][]; // smoothed display polyline, local x/z
  profile: { d: number; y: number; s: number }[];
  summary?: RouteSummary;
  cost: number;
  ms: number;
}

class MinHeap {
  private idx: Int32Array;
  private key: Float64Array;
  size = 0;
  constructor(cap: number) {
    this.idx = new Int32Array(cap);
    this.key = new Float64Array(cap);
  }
  push(i: number, k: number) {
    if (this.size === this.idx.length) {
      const ni = new Int32Array(this.size * 2); ni.set(this.idx); this.idx = ni;
      const nk = new Float64Array(this.size * 2); nk.set(this.key); this.key = nk;
    }
    let n = this.size++;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.key[p] <= k) break;
      this.idx[n] = this.idx[p]; this.key[n] = this.key[p]; n = p;
    }
    this.idx[n] = i; this.key[n] = k;
  }
  pop(): number {
    const top = this.idx[0];
    const li = this.idx[--this.size], lk = this.key[this.size];
    let n = 0;
    for (;;) {
      let c = 2 * n + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[n] = this.idx[c]; this.key[n] = this.key[c]; n = c;
    }
    this.idx[n] = li; this.key[n] = lk;
    return top;
  }
}

export class Planner {
  private g: Float64Array;
  private from: Int32Array;
  private closed: Uint32Array; // generation stamps avoid clearing per search
  private open: Uint32Array;
  private gen = 0;
  readonly minCost: number;
  readonly grid: Grid;
  readonly params: PlannerParams;

  // (no parameter properties: keeps the file runnable under Node's strip-only TS mode)
  constructor(grid: Grid, params: PlannerParams) {
    this.grid = grid;
    this.params = params;
    const n = grid.w * grid.h;
    this.g = new Float64Array(n);
    this.from = new Int32Array(n);
    this.closed = new Uint32Array(n);
    this.open = new Uint32Array(n);
    let m = Infinity;
    for (let i = 0; i < n; i++) if (grid.cost[i] < m) m = grid.cost[i];
    this.minCost = Number.isFinite(m) ? Math.max(1, m) : 1;
  }

  passable(c: number) { return Number.isFinite(this.grid.cost[c]); }

  /** Optimal cell path a -> b, or null if unreachable. */
  astar(a: number, b: number): Leg | null {
    const { w, h, dx, dz, cost, height } = this.grid;
    if (!this.passable(a) || !this.passable(b)) return null;
    const gen = ++this.gen;
    const kw = this.params.climbWeight, mc = this.minCost;
    const bi = Math.floor(b / w), bj = b % w;
    const hz = (c: number) => {
      const di = (Math.floor(c / w) - bi) * dz, dj = ((c % w) - bj) * dx;
      return Math.sqrt(di * di + dj * dj) * mc;
    };
    const heap = new MinHeap(4096);
    this.g[a] = 0; this.from[a] = -1; this.open[a] = gen;
    heap.push(a, hz(a));
    const DI = [-1, -1, -1, 0, 0, 1, 1, 1], DJ = [-1, 0, 1, -1, 1, -1, 0, 1];
    const LEN = DI.map((di, k) => Math.hypot(di * dz, DJ[k] * dx));
    while (heap.size) {
      const c = heap.pop();
      if (this.closed[c] === gen) continue;
      this.closed[c] = gen;
      if (c === b) break;
      const ci = Math.floor(c / w), cj = c - ci * w;
      const gc = this.g[c], cc = cost[c], hc = height[c];
      for (let k = 0; k < 8; k++) {
        const ni = ci + DI[k], nj = cj + DJ[k];
        if (ni < 0 || nj < 0 || ni >= h || nj >= w) continue;
        const n = ni * w + nj;
        const cn = cost[n];
        if (cn === Infinity || this.closed[n] === gen) continue;
        if (DI[k] !== 0 && DJ[k] !== 0 &&
            (cost[ci * w + nj] === Infinity || cost[ni * w + cj] === Infinity)) continue;
        const dh = height[n] - hc;
        const ng = gc + LEN[k] * 0.5 * (cc + cn) + (dh > 0 ? kw * dh : 0);
        if (this.open[n] !== gen || ng < this.g[n]) {
          this.open[n] = gen; this.g[n] = ng; this.from[n] = c;
          heap.push(n, ng + hz(n));
        }
      }
    }
    if (this.closed[b] !== gen) return null;
    const path: number[] = [];
    for (let c = b; c !== -1; c = this.from[c]) path.push(c);
    path.reverse();
    return { cells: Int32Array.from(path), cost: this.g[b] };
  }

  /** Cost of travelling a cell path in its direction (same formula as the search). */
  pathCost(cells: ArrayLike<number>): number {
    const { w, dx, dz, cost, height } = this.grid;
    let s = 0;
    for (let k = 1; k < cells.length; k++) {
      const a = cells[k - 1], b = cells[k];
      const len = Math.hypot((Math.floor(b / w) - Math.floor(a / w)) * dz, ((b % w) - (a % w)) * dx);
      const dh = this.grid.height[b] - height[a];
      s += len * 0.5 * (cost[a] + cost[b]) + (dh > 0 ? this.params.climbWeight * dh : 0);
    }
    return s;
  }

  /**
   * Closed tour from stops[0] visiting all other stops, cheapest visit order (brute force).
   * Reverse of an optimal path is optimal for the reverse direction (climb term differs by
   * climbWeight * net height change, a constant), so one A* per unordered pair suffices.
   */
  plan(stops: number[]): PlanResult {
    const t0 = performanceNow();
    const fail = (message: string): PlanResult => ({ ok: false, message, order: [], cells: [], smooth: [], profile: [], cost: Infinity, ms: performanceNow() - t0 });
    if (stops.length < 2) return fail("Add at least one marker besides the start.");
    if (stops.length - 1 > this.params.maxStops) return fail(`At most ${this.params.maxStops} stops.`);
    for (let k = 0; k < stops.length; k++) if (!this.passable(stops[k]))
      return fail(k === 0 ? "Start point is in a no-go cell." : `Marker ${k} is in a no-go cell (too steep or rough).`);

    const n = stops.length;
    const legs: (Leg | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
    const fwd: number[][] = Array.from({ length: n }, () => Array(n).fill(Infinity));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const leg = this.astar(stops[i], stops[j]);
      if (!leg) continue;
      legs[i][j] = leg;
      legs[j][i] = { cells: leg.cells.slice().reverse(), cost: NaN };
      fwd[i][j] = leg.cost;
      fwd[j][i] = this.pathCost(legs[j][i]!.cells);
      legs[j][i]!.cost = fwd[j][i];
    }
    const others = Array.from({ length: n - 1 }, (_, k) => k + 1);
    let best: number[] | null = null, bestCost = Infinity;
    for (const perm of permutations(others)) {
      let c = 0, prev = 0;
      for (const p of perm) { c += fwd[prev][p]; prev = p; if (c >= bestCost) break; }
      c += fwd[prev][0];
      if (c < bestCost) { bestCost = c; best = perm; }
    }
    if (!best) {
      const unreachable = others.filter((k) => fwd[0][k] === Infinity);
      return fail(`No route: marker${unreachable.length > 1 ? "s" : ""} ${unreachable.join(", ")} cannot be reached without crossing no-go terrain.`);
    }
    const order = [0, ...best, 0];
    const cells: number[] = [];
    for (let k = 0; k < order.length - 1; k++) {
      const leg = legs[order[k]][order[k + 1]]!;
      for (let q = k === 0 ? 0 : 1; q < leg.cells.length; q++) cells.push(leg.cells[q]);
    }
    const res = this.describe(cells);
    return { ok: true, order: best, cells, ...res, cost: bestCost, ms: performanceNow() - t0 };
  }

  /** Smoothing, profile and summary for a raw cell path. */
  describe(cells: number[]) {
    const { w, dx, dz, height, slope } = this.grid;
    const x0 = -((w - 1) / 2) * dx, z0 = -((this.grid.h - 1) / 2) * dz;
    const pts: [number, number][] = cells.map((c) => [x0 + (c % w) * dx, z0 + Math.floor(c / w) * dz]);
    let smooth = pts.map((p) => [p[0], p[1]] as [number, number]);
    for (let pass = 0; pass < this.params.smoothPasses; pass++) {
      const nxt = smooth.map((p) => [p[0], p[1]] as [number, number]);
      for (let k = 1; k < smooth.length - 1; k++) for (const ax of [0, 1])
        nxt[k][ax] = 0.25 * smooth[k - 1][ax] + 0.5 * smooth[k][ax] + 0.25 * smooth[k + 1][ax];
      smooth = nxt;
    }
    const edges = [0, ...this.params.slopeBins, 90];
    const binLen = new Array(edges.length - 1).fill(0);
    let dist = 0, climb = 0, descent = 0, maxS = 0, time = 0;
    const profile = [{ d: 0, y: height[cells[0]], s: slope[cells[0]] }];
    for (let k = 1; k < cells.length; k++) {
      const a = cells[k - 1], b = cells[k];
      const hlen = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      const dh = height[b] - height[a];
      const len = Math.hypot(hlen, dh);
      dist += len;
      if (dh > 0) climb += dh; else descent -= dh;
      const s = 0.5 * (slope[a] + slope[b]);
      maxS = Math.max(maxS, slope[a], slope[b]);
      let bi = 0;
      while (bi < edges.length - 2 && s >= edges[bi + 1]) bi++;
      binLen[bi] += len;
      time += len / walkSpeed(this.params.walkSpeed, hlen > 0 ? dh / hlen : 0);
      profile.push({ d: dist, y: height[b], s: slope[b] });
    }
    const summary: RouteSummary = {
      distance_m: dist, climb_m: climb, descent_m: descent, max_slope_deg: maxS, time_s: time,
      bin_share: binLen.map((l) => (dist > 0 ? l / dist : 0)),
    };
    return { smooth, profile, summary };
  }
}

/** Tobler-style hiking function, normalised so flat ground = v0 (suited walking pace). */
export function walkSpeed(v0: number, grade: number): number {
  return v0 * Math.exp(-3.5 * (Math.abs(grade + 0.05) - 0.05));
}

function* permutations(a: number[]): Generator<number[]> {
  if (a.length <= 1) { yield a.slice(); return; }
  for (let i = 0; i < a.length; i++) {
    const rest = a.slice(0, i).concat(a.slice(i + 1));
    for (const p of permutations(rest)) yield [a[i], ...p];
  }
}

function performanceNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
