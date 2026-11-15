/// <reference lib="webworker" />
import { features, rank, type Candidate, type Features, type GridIn, type ScoreConfig } from "./score";

let grids = new Map<string, GridIn>();
let cfg: ScoreConfig;
let unitCodes: Record<number, string> = {};
let names: { lat: number; lon: number }[] = [];
const cache = new Map<string, Candidate & { features: Features }>();

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  const post = (msg: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(msg);
  if (m.type === "init") {
    grids = new Map((m.grids as GridIn[]).map((g) => [g.meta.id, g]));
    cfg = m.cfg; unitCodes = m.unitCodes; names = m.names;
    const t0 = performance.now();
    for (const c of m.candidates as Candidate[]) cache.set(c.id, { ...c, features: features(c, grids, (i) => unitCodes[i] ?? String(i), names, cfg) });
    post({ type: "ready", ms: performance.now() - t0, n: cache.size });
  } else if (m.type === "rank") {
    const t0 = performance.now();
    const ranked = rank([...cache.values()].filter((c) => c.kind === "base" || m.include?.includes(c.id)), cfg, m.weights);
    post({ type: "ranked", id: m.id, ranked, ms: performance.now() - t0 });
  } else if (m.type === "evaluate") {
    // a user-clicked site: compute its features once, then rank it against the candidates
    const c = m.candidate as Candidate;
    const t0 = performance.now();
    cache.set(c.id, { ...c, features: features(c, grids, (i) => unitCodes[i] ?? String(i), names, cfg) });
    const ranked = rank([...cache.values()].filter((x) => x.kind === "base" || x.id === c.id), cfg, m.weights);
    post({ type: "evaluated", id: m.id, site: ranked.find((x) => x.id === c.id), rankOf: ranked.findIndex((x) => x.id === c.id) + 1,
           of: ranked.length, ms: performance.now() - t0 });
  }
};
