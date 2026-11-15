import { BUST } from "./bust";
import { marsSun } from "./sun";
// Global data layers: catalogue (layers.json), CPU arrays for STATS + scoring, overlay PNGs for the globe.
export interface LayerMeta {
  id: string;
  name: string;
  units: string;
  file: string;
  png?: string;
  width: number;
  height: number;
  dtype: "uint16" | "uint8" | "int16";
  offset?: number;
  scale?: number;
  nodata?: number;
  kind: "continuous" | "categorical" | "mineral";
  min?: number;
  max?: number;
  source: string;
  citation: string;
  mineral?: string;
  midrange?: number;
  table?: string;
  legend?: import("./legend").LegendSpec;
  /** Seasonal layer (Mars Climate Database): file / png carry {m} = Mars month 01..12, chosen for today's Ls at load. */
  seasonal?: boolean;
  group?: string;
}

export interface GeoUnit { index: number; code: string; age: string; name: string }

/** A sampled grid: row 0 = 90N, col 0 = 180W. Returns null where there is no data. */
export class Grid {
  constructor(readonly meta: LayerMeta, readonly data: Uint16Array | Uint8Array | Int16Array) {}
  private idx(lat: number, lon: number) {
    const { width: w, height: h } = this.meta;
    const x = Math.floor(((((lon + 180) % 360) + 360) % 360) / 360 * w);
    const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
    return y * w + Math.min(w - 1, x);
  }
  raw(lat: number, lon: number) { return this.data[this.idx(lat, lon)]; }
  value(lat: number, lon: number): number | null {
    const q = this.raw(lat, lon);
    const m = this.meta;
    if (m.dtype === "uint16") return q === 0 ? null : (m.offset ?? 0) + (q - 1) * (m.scale ?? 1);
    if (m.dtype === "uint8" && m.kind === "categorical") return q === 0 ? null : q;
    return q;
  }
}

export class LayerStore {
  metas: LayerMeta[] = [];
  units: GeoUnit[] = [];
  grids = new Map<string, Grid>();
  /** Today's season (NASA GISS Mars24): solar longitude and the Mars month (1..12, 30 deg of Ls each) the weather layers show. */
  readonly season = (() => { const ls = marsSun().ls; return { ls, month: Math.min(12, Math.floor(ls / 30) + 1) }; })();

  async load(base = "/global/") {
    const [cat, units] = await Promise.all([
      fetch(base + "layers.json" + BUST).then((r) => r.json()),
      fetch(base + "geology_units.json" + BUST).then((r) => r.json()),
    ]);
    const mm = String(this.season.month).padStart(2, "0");
    this.metas = (cat as LayerMeta[]).map((m) => m.seasonal ? { ...m, file: m.file.replace("{m}", mm), png: m.png?.replace("{m}", mm) } : m);
    this.units = units;
    await Promise.all(this.metas.map(async (m) => {
      const buf = await (await fetch(base + m.file + BUST)).arrayBuffer();
      const arr = m.dtype === "uint16" ? new Uint16Array(buf) : m.dtype === "int16" ? new Int16Array(buf) : new Uint8Array(buf);
      if (arr.length !== m.width * m.height) throw new Error(`${m.file}: ${arr.length} values, expected ${m.width * m.height}`);
      this.grids.set(m.id, new Grid(m, arr));
    }));
  }

  meta(id: string) { return this.metas.find((m) => m.id === id); }
  get(id: string) { return this.grids.get(id); }
  value(id: string, lat: number, lon: number) { return this.grids.get(id)?.value(lat, lon) ?? null; }
  minerals() { return this.metas.filter((m) => m.kind === "mineral"); }
  weather() { return this.metas.filter((m) => m.group === "weather"); }
  /** e.g. "Ls 22° (Mars month 1, northern spring)" */
  seasonLabel() {
    const { ls, month } = this.season;
    const north = ["spring", "summer", "autumn", "winter"][Math.floor(ls / 90) % 4];
    return `Ls ${ls.toFixed(0)}° (Mars month ${month}, northern ${north})`;
  }
  unit(idx: number | null) { return idx ? this.units.find((u) => u.index === idx) ?? null : null; }

  /** Plain arrays for the score worker (transferable copies). */
  bundle(ids: string[]) {
    return ids.map((id) => {
      const g = this.grids.get(id)!;
      return { meta: g.meta, data: g.data.slice() };
    });
  }
}

export interface RadiationCfg { gale_dose_msv_day: number; gale_elev_m: number; free_space_msv_day: number; scale_height_m: number }

/** Surface GCR dose model (labelled "model" in the UI): dose falls from the free-space value as the
 *  atmospheric column grows, calibrated to Curiosity RAD at Gale. Column ∝ exp(-h / H). */
export function doseModel(elev_m: number, c: RadiationCfg) {
  const col = Math.exp(-(elev_m - c.gale_elev_m) / c.scale_height_m); // column relative to Gale
  return c.free_space_msv_day - (c.free_space_msv_day - c.gale_dose_msv_day) * col;
}
