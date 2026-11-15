// Global data layers on the site (Frame) view, plus a high-resolution elevation layer from the site's own DTM.
// Global maps are km-scale (TES 7-16 km, SIM 3292 ~5 km pixels): over a 1 km site they are one value, which the
// overlay shows honestly (sampled at every texel from the same coloured PNG the globe uses) and the legend states.
import * as THREE from "three";
import { BUST } from "../bust";
import type { LayerMeta } from "../layers";
import type { LegendSpec } from "../legend";

export interface SiteMeta {
  origin_lat: number; origin_lon: number; origin_elev_m: number;
  extent_x_m: [number, number]; extent_z_m: [number, number]; width: number; height: number;
}

const R = 3396190, DEG = 180 / Math.PI;
/** Site x/z (m) -> planetocentric lat / east lon (deg). z grows southward (calibrated against pois.json). */
export function siteLatLon(m: SiteMeta, x: number, z: number) {
  return { lat: m.origin_lat - (z / R) * DEG, lon: m.origin_lon + (x / (R * Math.cos(m.origin_lat / DEG))) * DEG };
}

const N = 256; // texture size: plenty for km-scale data on a 1 km site
function canvasTexture(fill: (px: number, py: number, x: number, z: number) => [number, number, number, number], m: SiteMeta) {
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  const img = g.createImageData(N, N);
  const [x0, x1] = m.extent_x_m, [z0, z1] = m.extent_z_m;
  for (let py = 0; py < N; py++) {
    const z = z0 + ((py + 0.5) / N) * (z1 - z0); // row 0 = north (z min), as the science texture
    for (let px = 0; px < N; px++) img.data.set(fill(px, py, x0 + ((px + 0.5) / N) * (x1 - x0), z), (py * N + px) * 4);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter; // show the real (coarse) pixel edges of global data, do not blur them
  return t;
}

const imgCache = new Map<string, Promise<ImageData>>();
/** Pixels of a global layer PNG (equirectangular, row 0 = 90N, col 0 = 180W). */
function layerPixels(png: string): Promise<ImageData> {
  if (!imgCache.has(png)) imgCache.set(png, new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d")!; g.drawImage(i, 0, 0); res(g.getImageData(0, 0, i.width, i.height)); };
    i.onerror = () => rej(new Error("layer image " + png));
    i.src = `/global/${png}${BUST}`;
  }));
  return imgCache.get(png)!;
}

/** Site overlay for a global layer: every texel takes the colour of the global pixel it falls in. */
export async function globalSiteTexture(m: SiteMeta, meta: LayerMeta) {
  const d = await layerPixels(meta.png!);
  const cells = new Set<number>();
  const tex = canvasTexture((_px, _py, x, z) => {
    const { lat, lon } = siteLatLon(m, x, z);
    const col = Math.min(d.width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * d.width)));
    const row = Math.min(d.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * d.height)));
    const k = (row * d.width + col) * 4;
    cells.add(row * d.width + col);
    return [d.data[k], d.data[k + 1], d.data[k + 2], d.data[k + 3]];
  }, m);
  const pixelKm = (360 / d.width) * (Math.PI / 180) * (R / 1000); // east-west at the equator; N-S is the same
  return { tex, cells: cells.size, pixelKm };
}

/** High-resolution elevation from the site DTM (1 m), coloured over the site's own height range. */
export function siteElevation(m: SiteMeta, height: Float32Array, stops: [number, number[]][]) {
  let lo = Infinity, hi = -Infinity;
  for (const h of height) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const colour = (t: number): [number, number, number, number] => {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [a, ca] = stops[k], [b, cb] = stops[k + 1], u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u, 255];
  };
  const [x0, x1] = m.extent_x_m, [z0, z1] = m.extent_z_m;
  const tex = canvasTexture((_px, _py, x, z) => {
    const j = Math.min(m.width - 1, Math.max(0, Math.round(((x - x0) / (x1 - x0)) * (m.width - 1))));
    const i = Math.min(m.height - 1, Math.max(0, Math.round(((z - z0) / (z1 - z0)) * (m.height - 1))));
    return colour((height[i * m.width + j] - lo) / (hi - lo || 1));
  }, m);
  tex.magFilter = THREE.LinearFilter;
  const legend: LegendSpec = { type: "ramp", stops, min: m.origin_elev_m + lo, max: m.origin_elev_m + hi, units: "m (MOLA datum)",
    note: `HiRISE DTM, 1 m. Colours span this site only (${(hi - lo).toFixed(0)} m of relief), not the globe's −8…+12 km scale.` };
  return { tex, legend };
}
