/// <reference lib="webworker" />
import { Planner, type Grid, type PlannerParams } from "./astar";

let planner: Planner | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    planner = new Planner(msg.grid as Grid, msg.params as PlannerParams);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "ready", minCost: planner.minCost });
  } else if (msg.type === "plan" && planner) {
    const res = planner.plan(msg.stops as number[]);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "result", id: msg.id, res });
  }
};
