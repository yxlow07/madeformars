// Best-spot score (PRD feature 1). Pure TS (no DOM / three): runs in a Web Worker and under Node
// (scripts/bake_scores.ts writes data/global/scores.json with this same code).

export interface ScoreConfig {
  radius_km: number;
  sample_km: number;
  weights: { science: number; safety: number; access: number };
  science_norm: { units: number; minerals: number; names: number };
  steep_deg: number;
  dust_albedo_min: number;
  dust_ti_max: number;
  dust_weight: number;
  access: { elev_best_m: number; elev_worst_m: number; lat_full_deg: number; lat_zero_deg: number };
  top_n: number;
}

export interface GridIn {
  meta: { id: string; width: number; height: number; dtype: string; offset?: number; scale?: number; kind: string; midrange?: number; mineral?: string };
  data: ArrayLike<number>;
}

export interface Candidate { id: string; name: string; lat: number; lon: number; kind: string }

export interface Features {
  units: number;              // distinct SIM 3292 units in the disk
  unitCodes: string[];
  minerals: string[];         // TES minerals whose disk mean exceeds their mid-range
  names: number;              // named features (Gazetteer) inside the disk
  steepShare: number;         // share of MOLA cells steeper than steep_deg
  dustShare: number;          // share of cells that are bright AND low thermal inertia
  elev_m: number;             // median elevation
  absLat: number;
  samples: number;
}

export interface Terms { science: number; safety: number; access: number }
export interface Scored extends Candidate { features: Features; terms: Terms; score: number; contrib: Terms; hazard: number }

const R = 3396.19; // km

function cellValue(g: GridIn, lat: number, lon: number): number | null {
  const { width: w, height: h, dtype, offset = 0, scale = 1, kind } = g.meta;
  const x = Math.min(w - 1, Math.floor((((((lon + 180) % 360) + 360) % 360) / 360) * w));
  const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
  const q = g.data[y * w + x];
  if (dtype === "uint16") return q === 0 ? null : offset + (q - 1) * scale;
  if (kind === "categorical") return q === 0 ? null : q;
  return q;
}

/** Sample points on a regular km grid inside a spherical-cap disk. */
export function diskSamples(lat: number, lon: number, radiusKm: number, stepKm: number): [number, number][] {
  const out: [number, number][] = [];
  const dLat = (stepKm / R) * (180 / Math.PI);
  const n = Math.ceil(radiusKm / stepKm);
  for (let i = -n; i <= n; i++) {
    const la = lat + i * dLat;
    if (la > 89.9 || la < -89.9) continue;
    const dLon = dLat / Math.max(0.05, Math.cos((la * Math.PI) / 180));
    for (let j = -n * 4; j <= n * 4; j++) {
      const lo = lon + j * dLon;
      if (gcKm(lat, lon, la, lo) <= radiusKm) out.push([la, ((((lo + 180) % 360) + 360) % 360) - 180]);
    }
  }
  return out;
}

export function gcKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function features(c: Candidate, grids: Map<string, GridIn>, unitCode: (i: number) => string,
                         names: { lat: number; lon: number }[], cfg: ScoreConfig): Features {
  const pts = diskSamples(c.lat, c.lon, cfg.radius_km, cfg.sample_km);
  const geo = grids.get("geology"), slope = grids.get("slope"), elev = grids.get("elevation");
  const alb = grids.get("albedo"), ti = grids.get("ti");
  const mins = [...grids.values()].filter((g) => g.meta.kind === "mineral");
  const units = new Set<number>();
  let steep = 0, dust = 0, dustN = 0;
  const elevs: number[] = [];
  const minSum = new Map<string, [number, number]>();
  for (const [la, lo] of pts) {
    const u = geo ? cellValue(geo, la, lo) : null;
    if (u) units.add(u);
    const s = slope ? cellValue(slope, la, lo) : null;
    if (s !== null && s > cfg.steep_deg) steep++;
    const e = elev ? cellValue(elev, la, lo) : null;
    if (e !== null) elevs.push(e);
    const a = alb ? cellValue(alb, la, lo) : null, t = ti ? cellValue(ti, la, lo) : null;
    if (a !== null && t !== null) { dustN++; if (a >= cfg.dust_albedo_min && t <= cfg.dust_ti_max) dust++; }
    for (const g of mins) {
      const v = cellValue(g, la, lo);
      if (v === null) continue;
      const acc = minSum.get(g.meta.id) ?? [0, 0];
      acc[0] += v; acc[1]++;
      minSum.set(g.meta.id, acc);
    }
  }
  const minerals: string[] = [];
  for (const g of mins) {
    const acc = minSum.get(g.meta.id);
    if (acc && acc[1] > 0 && acc[0] / acc[1] > (g.meta.midrange ?? Infinity)) minerals.push(g.meta.mineral ?? g.meta.id);
  }
  elevs.sort((a, b) => a - b);
  const nNames = names.filter((p) => gcKm(c.lat, c.lon, p.lat, p.lon) <= cfg.radius_km).length;
  return {
    units: units.size, unitCodes: [...units].map(unitCode), minerals, names: nNames,
    steepShare: pts.length ? steep / pts.length : 0, dustShare: dustN ? dust / dustN : 0,
    elev_m: elevs.length ? elevs[Math.floor(elevs.length / 2)] : 0, absLat: Math.abs(c.lat), samples: pts.length,
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function terms(f: Features, cfg: ScoreConfig): Terms {
  const n = cfg.science_norm;
  const science = (clamp01(f.units / n.units) + clamp01(f.minerals.length / n.minerals) + clamp01(f.names / n.names)) / 3;
  const safety = clamp01(1 - f.steepShare - cfg.dust_weight * f.dustShare);
  const a = cfg.access;
  const elevTerm = clamp01((a.elev_worst_m - f.elev_m) / (a.elev_worst_m - a.elev_best_m));
  const latTerm = f.absLat <= a.lat_full_deg ? 1 : clamp01((a.lat_zero_deg - f.absLat) / (a.lat_zero_deg - a.lat_full_deg));
  return { science, safety, access: (elevTerm + latTerm) / 2 };
}

/** Weighted score; contributions add up exactly to the score. */
export function scoreOf(t: Terms, w: ScoreConfig["weights"]) {
  const sum = w.science + w.safety + w.access || 1;
  const contrib = { science: (w.science * t.science) / sum, safety: (w.safety * t.safety) / sum, access: (w.access * t.access) / sum };
  return { score: contrib.science + contrib.safety + contrib.access, contrib };
}

export function rank(cands: (Candidate & { features: Features })[], cfg: ScoreConfig, w = cfg.weights): Scored[] {
  return cands.map((c) => {
    const t = terms(c.features, cfg);
    const { score, contrib } = scoreOf(t, w);
    return { ...c, terms: t, score, contrib, hazard: 1 - t.safety };
  }).sort((a, b) => b.score - a.score);
}
