// Danger of the astronaut's current spot (Sim and Debrief DANGER LEVEL bar).
// Terrain: local slope (mean over ~5 m of the 1 m DTM) mapped through the planner's slope bins, no-go cells near the top.
// Situation: a solar event outside shelter, a suit leak or being past the point of no return raise it.
export interface LocalTerrain { slope: number; maxSlope: number; nogo: boolean }
export interface Situation { spe?: boolean; sheltered?: boolean; leak?: boolean; pnr?: boolean }

export function dangerAt(t: LocalTerrain, s: Situation, bins = [8, 15, 25]) {
  const v = t.slope;
  let d: number;
  if (v < bins[0]) d = 0.25 * (v / bins[0]);
  else if (v < bins[1]) d = 0.25 + 0.25 * ((v - bins[0]) / (bins[1] - bins[0]));
  else if (v < bins[2]) d = 0.5 + 0.35 * ((v - bins[1]) / (bins[2] - bins[1]));
  else d = 0.85 + 0.15 * Math.min(1, (v - bins[2]) / 10);
  if (t.nogo) d = Math.max(d, 0.95);
  const terrain = d;
  let why = "";
  if (s.spe && !s.sheltered && d < 0.8) { d = 0.8; why = "solar event, unsheltered"; }
  if (s.leak && d < 0.7) { d = 0.7; why = why || "suit leak"; }
  if (s.pnr) { d = 1; why = "past the point of no return"; }
  const level = d < 0.25 ? "Low" : d < 0.5 ? "Moderate" : d < 0.85 ? "High" : "Extreme";
  const ground = t.nogo ? "no-go ground" : `${t.slope.toFixed(0)}° slope`;
  return { value: Math.max(0, Math.min(1, d)), terrain, level, label: `${level} · ${ground}${why ? ` · ${why}` : ""}` };
}
