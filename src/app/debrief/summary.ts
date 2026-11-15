// Debrief auto-summary from rules (PRD feature 8). Pure TS: runs in the browser and under Node.
import { distToPolyline, fmt, type Pt, type Tick, type SimEvent, type Outcome } from "../sim/engine.ts";

export interface RunLike {
  config: { sim: { dose_limit_msv: number; spe: { alert_min: number } }; limits: { suitHours: number; reserveMin: number; doseBudgetMsv: number } };
  plan: { smooth: Pt[]; stops: { name: string; x: number; z: number }[]; distance_m?: number; time_s?: number };
  outcome: Outcome; events: SimEvent[]; log: Tick[];
  routes?: { v: number; t: number; why: string }[];
}

export interface Finding { t: number; severity: "info" | "warn" | "critical"; text: string; limit?: boolean }
export interface Summary {
  headline: string;
  first: Finding | null;     // first limit crossed (null = none)
  findings: Finding[];       // time-ordered
  numbers: [string, string][];
}

export function summarise(run: RunLike): Summary {
  const log = run.log, L = run.config.limits;
  const findings: Finding[] = [];
  if (!log.length) return { headline: "Empty run.", first: null, findings, numbers: [] };

  // when each stop was reached (from the tick events)
  const reachedAt = new Map<string, number>();
  for (const tk of log) for (const e of tk.ev ?? []) {
    const m = /^stop: Reached (.*)\.$/.exec(e);
    if (m && !reachedAt.has(m[1])) reachedAt.set(m[1], tk.t);
  }
  const context = (tk: Tick) => {
    if (tk.mode === "explore") {
      const off = distToPolyline(tk.x, tk.z, run.plan.smooth);
      return off > 30 ? `while exploring ${off.toFixed(0)} m off the planned route` : "while walking freely near the route";
    }
    if (tk.route_v > 1 && tk.incidents.length) return `while walking to shelter during the ${incName(tk.incidents[0])}`;
    const next = run.plan.stops.find((s) => !(reachedAt.has(s.name) && reachedAt.get(s.name)! <= tk.t));
    return next ? `on the way to ${next.name}` : "on the way back to the habitat";
  };

  // limit rules: first tick each one is crossed
  const firstTick = (pred: (t: Tick) => boolean) => log.find(pred);
  const neg = firstTick((t) => t.margin_s < 0);
  if (neg) findings.push({ t: neg.t, severity: "critical", limit: true,
    text: `Return margin went negative at T+${fmt(neg.t)} ${context(neg)} (walk home ${fmt(neg.return_s)}).` });
  const reservePct = (100 * L.reserveMin * 60) / (L.suitHours * 3600);
  const res = firstTick((t) => t.o2_pct < reservePct);
  if (res) findings.push({ t: res.t, severity: "critical", limit: true,
    text: `O₂ fell into the ${L.reserveMin}-min reserve at T+${fmt(res.t)} ${context(res)}.` });
  const dose = firstTick((t) => t.dose_msv > L.doseBudgetMsv);
  if (dose) findings.push({ t: dose.t, severity: "warn", limit: true,
    text: `Dose passed the ${L.doseBudgetMsv} mSv walk budget at T+${fmt(dose.t)} ${context(dose)}.` });

  // incidents and what happened next
  for (const e of run.events) {
    if (e.kind === "incident" && e.severity === "critical") findings.push({ t: e.t, severity: "warn", text: `T+${fmt(e.t)}: ${e.text}` });
    if (e.kind === "route" && /^Route v[2-9]/.test(e.text)) findings.push({ t: e.t, severity: "info", text: `T+${fmt(e.t)}: re-planned — ${e.text.replace(/^Route v\d+: /, "")}.` });
  }
  // shelter reached in time?
  const spe = run.events.find((e) => e.kind === "incident" && /Solar particle event/.test(e.text));
  if (spe) {
    const inside = run.events.find((e) => e.t >= spe.t && e.kind === "end" && /Reached/.test(e.text));
    const alert = run.config.sim.spe.alert_min * 60;
    if (inside) findings.push({ t: inside.t, severity: inside.t - spe.t <= alert ? "info" : "warn",
      text: `Reached shelter ${fmt(inside.t - spe.t)} after the solar event alert (${run.config.sim.spe.alert_min} min allowed).` });
  }
  // off route
  let offMax = 0, offT = 0;
  for (const t of log) if (t.mode === "explore") { const d = distToPolyline(t.x, t.z, run.plan.smooth); if (d > offMax) { offMax = d; offT = t.t; } }
  if (offMax > 30) findings.push({ t: offT, severity: "warn", text: `Furthest from the planned route: ${offMax.toFixed(0)} m at T+${fmt(offT)}.` });
  // body
  const hard = log.filter((t) => t.met_w > 520).length;
  if (hard) findings.push({ t: log.find((t) => t.met_w > 520)!.t, severity: "warn", text: `Work rate above 520 W for ${fmt(hard)}.` });

  findings.sort((a, b) => a.t - b.t);
  const limits = findings.filter((f) => f.limit);
  let first: Finding | null = limits[0] ?? null;
  if (run.outcome?.result === "failure" && !first) first = { t: run.outcome.t, severity: "critical", limit: true, text: run.outcome.cause };

  // key numbers
  let dist = 0;
  for (let i = 1; i < log.length; i++) dist += Math.hypot(log[i].x - log[i - 1].x, log[i].z - log[i - 1].z);
  const last = log[log.length - 1];
  const reached = run.plan.stops.filter((s) => reachedAt.has(s.name)).length;
  const minMargin = Math.min(...log.map((t) => t.margin_s));
  const numbers: [string, string][] = [
    ["Duration", `T+${fmt(last.t)}${run.plan.time_s ? ` (plan ${fmt(run.plan.time_s)})` : ""}`],
    ["Walked", `${(dist / 1000).toFixed(2)} km${run.plan.distance_m ? ` (plan ${(run.plan.distance_m / 1000).toFixed(2)})` : ""}`],
    ["Stops", `${reached} / ${run.plan.stops.length}`],
    ["O₂ at end", `${last.o2_pct.toFixed(0)}% (${last.o2_l.toFixed(0)} L)`],
    ["Min margin", fmt(minMargin)],
    ["Peak work", `${Math.max(...log.map((t) => t.met_w)).toFixed(0)} W`],
    ["Dose", `${last.dose_msv.toFixed(3)} mSv`],
    ["Route versions", String(last.route_v)],
  ];
  const ok = run.outcome?.result === "success";
  const headline = run.outcome
    ? `${ok ? "Success" : "Mission failure — crew lost"}. ${run.outcome.cause}`
    : `Run stopped at T+${fmt(last.t)} without an outcome.`;
  return { headline, first, findings, numbers };
}

function incName(k: string) { return k === "spe" ? "solar event" : k === "leak" ? "suit leak" : k; }
