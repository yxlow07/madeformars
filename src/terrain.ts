import * as THREE from "three";
import type { TerrainMeta } from "./data";

/** Height-field sampling in the local frame (x east, z south, metres). */
export class HeightField {
  readonly x0: number;
  readonly z0: number;
  constructor(readonly meta: TerrainMeta, readonly h: Float32Array) {
    this.x0 = meta.extent_x_m[0];
    this.z0 = meta.extent_z_m[0];
  }
  get w() { return this.meta.width; }
  get hgt() { return this.meta.height; }
  get dx() { return this.meta.res_x_m; }
  get dz() { return this.meta.res_z_m; }
  at(i: number, j: number) {
    i = Math.min(this.hgt - 1, Math.max(0, i));
    j = Math.min(this.w - 1, Math.max(0, j));
    return this.h[i * this.w + j];
  }
  /** Bilinear height at local (x, z). */
  sample(x: number, z: number): number {
    const fj = (x - this.x0) / this.dx;
    const fi = (z - this.z0) / this.dz;
    const j = Math.floor(fj), i = Math.floor(fi);
    const tx = fj - j, tz = fi - i;
    const a = this.at(i, j), b = this.at(i, j + 1), c = this.at(i + 1, j), d = this.at(i + 1, j + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  inside(x: number, z: number) {
    return x >= this.x0 && z >= this.z0 && x <= -this.x0 && z <= -this.z0;
  }
  cellOf(x: number, z: number): [number, number] {
    return [Math.round((z - this.z0) / this.dz), Math.round((x - this.x0) / this.dx)];
  }
  posOf(i: number, j: number): [number, number] {
    return [this.x0 + j * this.dx, this.z0 + i * this.dz];
  }
}

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  uniform vec4 uExtent; // x0, z0, x1, z1
  uniform vec2 uGrid;   // samples in x, z
  uniform vec2 uStop;   // stop x, z
  uniform float uSink;  // metres the terrain is lowered under the splat (0 = off)
  uniform vec2 uSinkR;  // full sink inside .x metres, none beyond .y
  varying vec2 vUvOrtho;
  varying vec2 vUvGrid;
  varying vec3 vNormal;
  void main() {
    vec2 t = (position.xz - uExtent.xy) / (uExtent.zw - uExtent.xy);
    vec3 pos = position;
    pos.y -= uSink * (1.0 - smoothstep(uSinkR.x, uSinkR.y, distance(position.xz, uStop)));
    // Ortho covers the vertex extent exactly; layer PNGs have one pixel per sample.
    vUvOrtho = vec2(t.x, 1.0 - t.y);
    vUvGrid = vec2((t.x * (uGrid.x - 1.0) + 0.5) / uGrid.x, 1.0 - (t.y * (uGrid.y - 1.0) + 0.5) / uGrid.y);
    vNormal = normal;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D tOrtho;
  uniform sampler2D tSlope;
  uniform sampler2D tHazard;
  uniform sampler2D tScience;
  uniform sampler2D tGlobal;
  uniform int uLayer;
  uniform float uOpacity;
  uniform vec3 uSunDir;
  uniform float uDay;       // 0 night .. 1 full day, from the local Sun's elevation (Mars24)
  varying vec2 vUvOrtho;
  varying vec2 vUvGrid;
  varying vec3 vNormal;
  void main() {
    #include <logdepthbuf_fragment>
    float g = texture2D(tOrtho, vUvOrtho).r;
    // HiRISE ortho already contains real shading; tint it Mars-butterscotch and add soft relief light.
    vec3 base = vec3(g) * vec3(1.08, 0.80, 0.60);
    vec3 n = normalize(vNormal);
    float lam = clamp(dot(n, normalize(uSunDir)), 0.0, 1.0);
    // relief lit by the local Sun (low sun = long shading), scene brightness from its elevation
    vec3 col = base * mix(0.10, 1.0, uDay) * (0.5 + 0.72 * lam);
    if (uLayer == 1) col = mix(col, texture2D(tSlope, vUvGrid).rgb, uOpacity);
    else if (uLayer == 2) col = mix(col, texture2D(tHazard, vUvGrid).rgb, uOpacity);
    else if (uLayer == 3) {
      vec4 sci = texture2D(tScience, vUvGrid);
      col = mix(col, sci.rgb, sci.a * uOpacity);
    }
    else if (uLayer == 4) {
      vec4 g = texture2D(tGlobal, vUvGrid);
      col = mix(col, g.rgb, g.a * uOpacity);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export interface TerrainOpts {
  tiles: number;        // tiles per side (4)
  lodSteps: number[];   // sample strides per LOD level, e.g. [1, 2, 4]
  lodDist: number[];    // switch distances, metres
}

/** Builds a tiled, LOD'd terrain mesh with skirts (to hide LOD cracks). */
export function buildTerrain(hf: HeightField, textures: { ortho: THREE.Texture; slope: THREE.Texture; hazard: THREE.Texture; science?: THREE.Texture },
                             opts: TerrainOpts = { tiles: 4, lodSteps: [1, 2, 4], lodDist: [0, 260, 520] }) {
  const { w, hgt } = hf;
  // Per-sample normals from central differences over the whole grid (seamless across tiles).
  const normals = new Float32Array(w * hgt * 3);
  for (let i = 0; i < hgt; i++) for (let j = 0; j < w; j++) {
    const gx = (hf.at(i, j + 1) - hf.at(i, j - 1)) / (2 * hf.dx);
    const gz = (hf.at(i + 1, j) - hf.at(i - 1, j)) / (2 * hf.dz);
    const l = Math.hypot(gx, 1, gz), k = (i * w + j) * 3;
    normals[k] = -gx / l; normals[k + 1] = 1 / l; normals[k + 2] = -gz / l;
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      tOrtho: { value: null }, tSlope: { value: null }, tHazard: { value: null }, tScience: { value: null }, tGlobal: { value: null },
      uLayer: { value: 0 }, uOpacity: { value: 0.6 },
      uSunDir: { value: new THREE.Vector3(-0.5, 0.75, -0.4) }, uDay: { value: 1 },
      uExtent: { value: new THREE.Vector4(hf.x0, hf.z0, hf.x0 + (w - 1) * hf.dx, hf.z0 + (hgt - 1) * hf.dz) },
      uGrid: { value: new THREE.Vector2(w, hgt) },
      uStop: { value: new THREE.Vector2(hf.meta.stop.x, hf.meta.stop.z) },
      uSink: { value: 0 },
      uSinkR: { value: new THREE.Vector2(25, 40) },
    }]),
  });
  material.uniforms.tOrtho.value = textures.ortho;
  material.uniforms.tSlope.value = textures.slope;
  material.uniforms.tHazard.value = textures.hazard;
  if (textures.science) material.uniforms.tScience.value = textures.science;

  const group = new THREE.Group();
  group.name = "terrain";
  const pickables: THREE.Mesh[] = [];
  const cellsX = w - 1, cellsZ = hgt - 1;
  const T = opts.tiles;
  for (let ti = 0; ti < T; ti++) for (let tj = 0; tj < T; tj++) {
    const i0 = Math.round((ti * cellsZ) / T), i1 = Math.round(((ti + 1) * cellsZ) / T);
    const j0 = Math.round((tj * cellsX) / T), j1 = Math.round(((tj + 1) * cellsX) / T);
    const lod = new THREE.LOD();
    opts.lodSteps.forEach((step, li) => {
      const mesh = new THREE.Mesh(tileGeometry(hf, normals, i0, i1, j0, j1, step), material);
      mesh.matrixAutoUpdate = false;
      lod.addLevel(mesh, opts.lodDist[li]);
      if (li === 0) pickables.push(mesh);
    });
    const [cx, cz] = hf.posOf((i0 + i1) / 2, (j0 + j1) / 2);
    lod.position.set(0, 0, 0);
    // LOD distance is measured to the object's position; offset children so the LOD sits at the tile centre.
    lod.position.set(cx, hf.sample(cx, cz), cz);
    lod.children.forEach((m) => { m.position.set(-cx, -hf.sample(cx, cz), -cz); m.updateMatrix(); });
    group.add(lod);
  }
  return { group, material, pickables };
}

function tileGeometry(hf: HeightField, normals: Float32Array, i0: number, i1: number, j0: number, j1: number, step: number) {
  const rows: number[] = [], cols: number[] = [];
  for (let i = i0; i < i1; i += step) rows.push(i);
  rows.push(i1);
  for (let j = j0; j < j1; j += step) cols.push(j);
  cols.push(j1);
  const nr = rows.length, nc = cols.length;
  const skirt = 2 * (nr + nc);
  const pos = new Float32Array((nr * nc + skirt) * 3);
  const nor = new Float32Array((nr * nc + skirt) * 3);
  const put = (k: number, i: number, j: number, drop: number) => {
    const [x, z] = hf.posOf(i, j);
    pos[k * 3] = x; pos[k * 3 + 1] = hf.at(i, j) - drop; pos[k * 3 + 2] = z;
    const s = (i * hf.w + j) * 3;
    nor[k * 3] = normals[s]; nor[k * 3 + 1] = normals[s + 1]; nor[k * 3 + 2] = normals[s + 2];
  };
  for (let a = 0; a < nr; a++) for (let b = 0; b < nc; b++) put(a * nc + b, rows[a], cols[b], 0);
  const idx: number[] = [];
  for (let a = 0; a < nr - 1; a++) for (let b = 0; b < nc - 1; b++) {
    const p = a * nc + b, q = p + 1, r = p + nc, s = r + 1;
    idx.push(p, r, q, q, r, s);
  }
  // Skirts: duplicate each border vertex 3 m lower and stitch.
  const drop = 3 * step;
  let k = nr * nc;
  const edge = (verts: number[]) => {
    const start = k;
    verts.forEach((v) => { const a = Math.floor(v / nc), b = v % nc; put(k++, rows[a], cols[b], drop); });
    for (let e = 0; e < verts.length - 1; e++) {
      const t0 = verts[e], t1 = verts[e + 1], b0 = start + e, b1 = start + e + 1;
      idx.push(t0, b0, t1, t1, b0, b1, t0, t1, b0, t1, b1, b0); // both windings: always visible
    }
  };
  edge(Array.from({ length: nc }, (_, b) => b));
  edge(Array.from({ length: nc }, (_, b) => (nr - 1) * nc + b));
  edge(Array.from({ length: nr }, (_, a) => a * nc));
  edge(Array.from({ length: nr }, (_, a) => a * nc + nc - 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor.subarray(0, k * 3), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
