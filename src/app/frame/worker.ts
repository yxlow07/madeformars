/// <reference lib="webworker" />
import { RoutePlanner, type Limits } from "./route";

let rp: RoutePlanner | null = null;
const post = (m: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "init") {
    rp = new RoutePlanner(m.grid, m.params);
    const t0 = performance.now();
    const T = rp.computeHomeTime(m.home);
    post({ type: "ready", homeMs: performance.now() - t0, homeTime: T });
  } else if (m.type === "shelter" && rp) {
    const r = rp.routesTo(m.from, m.targets);
    post({ type: "shelter", id: m.id, ...r });
  } else if (m.type === "plan" && rp) {
    const res = rp.plan(m.home, m.stops, m.lambda, m.limits as Limits, m.optimise, m.maxBrute);
    post({ type: "result", id: m.id, res });
  }
};
