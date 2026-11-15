// Loads pipeline outputs from data/processed (served at the site root). No other network use.

export interface TerrainMeta {
  width: number;
  height: number;
  res_x_m: number;
  res_z_m: number;
  extent_x_m: [number, number];
  extent_z_m: [number, number];
  origin_lon: number;
  origin_lat: number;
  origin_elev_m: number;
  min_height_m: number;
  max_height_m: number;
  kx_cos_lat: number;
  stop: { site: number; drive: number; lon: number; lat: number; x: number; z: number; y: number };
}

export interface Traverse {
  lines: [number, number][][];
  waypoints: { site: number; drive: number; sol: number; x: number; z: number }[];
}

async function get(path: string): Promise<Response> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`missing ${path} (HTTP ${r.status}) — run "python tasks.py terrain" first`);
  return r;
}

export async function loadAll() {
  const [meta, hbuf, sbuf, cbuf, trav, layers] = await Promise.all([
    get("terrain.json").then((r) => r.json() as Promise<TerrainMeta>),
    get("height.f32").then((r) => r.arrayBuffer()),
    get("slope.f32").then((r) => r.arrayBuffer()),
    get("cost.f32").then((r) => r.arrayBuffer()),
    get("traverse.json").then((r) => r.json() as Promise<Traverse>),
    get("layers.json").then((r) => r.json()),
  ]);
  const n = meta.width * meta.height;
  for (const [name, b] of [["height", hbuf], ["slope", sbuf], ["cost", cbuf]] as const) {
    if (b.byteLength !== n * 4) throw new Error(`${name}.f32 has ${b.byteLength} bytes, expected ${n * 4}`);
  }
  return {
    meta,
    height: new Float32Array(hbuf),
    slope: new Float32Array(sbuf),
    cost: new Float32Array(cbuf),
    traverse: trav,
    layers,
  };
}

export type Data = Awaited<ReturnType<typeof loadAll>>;
