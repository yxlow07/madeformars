// Frame mode 3D scene (Phase 1 terrain inside the shell, POI markers, route, safe envelope).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { HeightField, buildTerrain } from "../../terrain";
import type { TerrainMeta, Traverse } from "../../data";
import type { RouteResult } from "./route";
import { StopSplat } from "../../splat";
import { siteSignal } from "../site";
import { evaStart, sunAt, sunDirLocal } from "../sun";
import { makeSun } from "../globe";

export interface Poi {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  x: number;
  z: number;
  description: string;
  tags?: string[];
  science_weight?: number;
  facts?: { text: string; source: string }[];
  image?: { file: string; credit?: string; source?: string };
}

export interface PoisData {
  site: string;
  habitat: Poi;
  pois: Poi[];
}

const SKY = new THREE.Color(0x0f0d1b);
export const BIN_COLORS = ["#2ea043", "#e6c828", "#eb781e", "#d21e1e"];

export function labelSprite(text: string, bg: string, fg = "#0e0f13", border = "#ece6dc", radius = 24) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.beginPath();
  g.arc(32, 32, radius, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = border;
  g.stroke();
  g.fillStyle = fg;
  g.font = "bold 26px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 32, 34);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false }));
  s.scale.set(0.042, 0.042, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  return s;
}

/** Planning note marker: a small message bubble (same size as the pins), light fill, dark dots. */
export function noteSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ece6dc"; g.strokeStyle = "#0e0f13"; g.lineWidth = 3;
  g.beginPath();
  g.moveTo(14, 12); g.lineTo(50, 12); g.quadraticCurveTo(56, 12, 56, 18); g.lineTo(56, 38); g.quadraticCurveTo(56, 44, 50, 44);
  g.lineTo(30, 44); g.lineTo(18, 56); g.lineTo(20, 44); g.lineTo(14, 44); g.quadraticCurveTo(8, 44, 8, 38); g.lineTo(8, 18); g.quadraticCurveTo(8, 12, 14, 12);
  g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#0e0f13";
  for (const x of [21, 32, 43]) { g.beginPath(); g.arc(x, 28, 3.6, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false }));
  s.scale.set(0.042, 0.042, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  return s;
}

// Standard viridis color ramp (matching the global science heatmap)
export const VIRIDIS_STOPS: [number, number[]][] = [
  [0.0, [20, 18, 40]],     // baseline
  [0.2, [68, 1, 84]],      // 1/5
  [0.4, [59, 82, 139]],    // 2/5
  [0.6, [33, 145, 140]],   // 3/5
  [0.8, [94, 201, 98]],    // 4/5
  [1.0, [253, 231, 37]],   // 5/5
];

function viridisColor(scoreNorm: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, scoreNorm));
  let k = 0;
  while (k < VIRIDIS_STOPS.length - 2 && v > VIRIDIS_STOPS[k + 1][0]) k++;
  const [a, ca] = VIRIDIS_STOPS[k], [b, cb] = VIRIDIS_STOPS[k + 1];
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return [
    Math.round(ca[0] + (cb[0] - ca[0]) * t),
    Math.round(ca[1] + (cb[1] - ca[1]) * t),
    Math.round(ca[2] + (cb[2] - ca[2]) * t),
  ];
}

/** Local science heatmap: kernel density of POI science ratings, sum_i rating_i * exp(-d²/2σ²), σ = 60 m,
 *  normalised to the strongest spot. Colour and opacity both follow the density (low = transparent).
 *  Canvas row 0 is the north edge (z min) — CanvasTexture's flipY puts it at uv.y = 1 like the other layers. */
export function buildScienceTexture(pois: Poi[], w = 512, h = 512, meta: TerrainMeta): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  const [x0, x1] = meta.extent_x_m, [z0, z1] = meta.extent_z_m;
  const sigma = 60, k = 1 / (2 * sigma * sigma);
  const dens = new Float32Array(w * h);
  let max = 1e-9;
  for (let py = 0; py < h; py++) {
    const z = z0 + ((py + 0.5) / h) * (z1 - z0); // row 0 = north (z min)
    for (let px = 0; px < w; px++) {
      const x = x0 + ((px + 0.5) / w) * (x1 - x0);
      let v = 0;
      for (const p of pois) v += (p.science_weight ?? 3) * Math.exp(-((x - p.x) ** 2 + (z - p.z) ** 2) * k);
      dens[py * w + px] = v;
      if (v > max) max = v;
    }
  }
  for (let i = 0; i < dens.length; i++) {
    const v = dens[i] / max;
    const [r, gg, b] = viridisColor(v);
    img.data.set([r, gg, b, Math.round(255 * Math.min(1, v / 0.6))], i * 4);
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Extract 3D line segments for safe-return contour where homeTime == thresholdSec. */
export function extractEnvelopeContour(
  homeTime: Float32Array,
  thresholdSec: number,
  hf: HeightField,
  meta: TerrainMeta,
  step = 2,
): number[] {
  const { width: w, height: h } = meta;
  const [x0] = meta.extent_x_m;
  const [z0] = meta.extent_z_m;
  const dx = meta.res_x_m;
  const dz = meta.res_z_m;
  const pts: number[] = [];

  const val = (i: number, j: number) => homeTime[i * w + j];

  for (let i = 0; i < h - step; i += step) {
    for (let j = 0; j < w - step; j += step) {
      const v0 = val(i, j);
      const v1 = val(i, j + step);
      const v2 = val(i + step, j + step);
      const v3 = val(i + step, j);
      // no-go cells have no walk-back time: they are obstacles, not "beyond the envelope" — skip them
      if (!Number.isFinite(v0) || !Number.isFinite(v1) || !Number.isFinite(v2) || !Number.isFinite(v3)) continue;

      let mask = 0;
      if (v0 <= thresholdSec) mask |= 1;
      if (v1 <= thresholdSec) mask |= 2;
      if (v2 <= thresholdSec) mask |= 4;
      if (v3 <= thresholdSec) mask |= 8;

      if (mask === 0 || mask === 15) continue;

      const px0 = x0 + j * dx, pz0 = z0 + i * dz;
      const px1 = x0 + (j + step) * dx, pz1 = z0 + (i + step) * dz;

      const interp = (va: number, vb: number) => {
        const d = vb - va;
        return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (thresholdSec - va) / d));
      };

      const top = [px0 + interp(v0, v1) * (px1 - px0), pz0];
      const right = [px1, pz0 + interp(v1, v2) * (pz1 - pz0)];
      const bot = [px0 + interp(v3, v2) * (px1 - px0), pz1];
      const left = [px0, pz0 + interp(v0, v3) * (pz1 - pz0)];

      const addSeg = (a: number[], b: number[]) => {
        pts.push(a[0], hf.sample(a[0], a[1]) + 0.45, a[1]);
        pts.push(b[0], hf.sample(b[0], b[1]) + 0.45, b[1]);
      };

      if (mask === 1 || mask === 14) addSeg(left, top);
      else if (mask === 2 || mask === 13) addSeg(top, right);
      else if (mask === 3 || mask === 12) addSeg(left, right);
      else if (mask === 4 || mask === 11) addSeg(right, bot);
      else if (mask === 5) { addSeg(left, top); addSeg(right, bot); }
      else if (mask === 6 || mask === 9) addSeg(top, bot);
      else if (mask === 7 || mask === 8) addSeg(left, bot);
      else if (mask === 10) { addSeg(top, right); addSeg(left, bot); }
    }
  }
  return pts;
}

export class FrameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly hf: HeightField;
  readonly terrain: ReturnType<typeof buildTerrain>;

  // ---- the local Sun (NASA GISS Mars24 for this site) ----
  /** When a walk planned now starts: now if the Sun is up, else the next 09:00 local solar time. */
  readonly sunStartMs: number;
  sunNow = { elev: 0, az: 0, ltst: 0 };
  private sunDirV = new THREE.Vector3(-0.5, 0.75, -0.4);
  private skyOn = false;
  private sunSprite: THREE.Object3D;
  private dayF = 1;

  private routeGroup = new THREE.Group();
  private markerGroup = new THREE.Group();
  private envelopeGroup = new THREE.Group();
  private routeLine: Line2 | null = null;
  private envelopeLine: LineSegments2 | null = null;
  private scrubberDot: THREE.Mesh;

  /** Perseverance's real drive track (Phase 1 data). Hidden by default: it is not part of the user's plan. */
  readonly traverseGroup = new THREE.Group();
  readonly poiSprites = new Map<string, THREE.Sprite>();
  readonly customSprites = new Map<string, THREE.Sprite>();
  /** Planning notes (message bubbles): never route stops, hidden during the walk / debrief. */
  readonly noteSprites = new Map<string, THREE.Sprite>();

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    readonly dom: HTMLElement,
    readonly meta: TerrainMeta,
    readonly heightBuf: Float32Array,
    readonly textures: { ortho: THREE.Texture; slope: THREE.Texture; hazard: THREE.Texture; science?: THREE.Texture },
    readonly traverse: Traverse,
    readonly poisData: PoisData,
  ) {
    this.hf = new HeightField(meta, heightBuf);

    this.scene.background = SKY.clone();
    this.scene.fog = new THREE.Fog(SKY.clone(), 800, 3200);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 7000);
    const stop = new THREE.Vector3(meta.stop.x, this.hf.sample(meta.stop.x, meta.stop.z), meta.stop.z);
    this.camera.position.set(stop.x - 380, stop.y + 430, stop.z + 560);

    // Directional light for terrain shading
    const sun = new THREE.DirectionalLight(0xfff1e0, 1.2);
    sun.position.set(-500, 750, -400);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x2a1b32, 0.8));

    // Terrain
    this.terrain = buildTerrain(this.hf, textures);
    this.scene.add(this.terrain.group);
    // the Sun in the walk sky, at its true apparent size; lighting follows the site's local solar time
    this.sunSprite = makeSun(0.35, 1500);
    this.sunSprite.visible = false;
    this.scene.add(this.sunSprite);
    const m = meta as any;
    this.sunStartMs = evaStart(m.origin_lat, m.origin_lon);
    this.setSunTime(this.sunStartMs);

    // Rover traverse
    const travGroup = this.traverseGroup;
    travGroup.visible = false;
    const travMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, fog: true });
    for (const line of traverse.lines) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < line.length - 1; k++) {
        const [x0, z0] = line[k], [x1, z1] = line[k + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
        for (let s = 0; s < n; s++) {
          const x = x0 + ((x1 - x0) * s) / n, z = z0 + ((z1 - z0) * s) / n;
          if (this.hf.inside(x, z)) pts.push(new THREE.Vector3(x, this.hf.sample(x, z) + 0.35, z));
        }
      }
      if (pts.length > 1) travGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), travMat));
    }
    const wpPts = traverse.waypoints.filter((w) => this.hf.inside(w.x, w.z))
      .map((w) => new THREE.Vector3(w.x, this.hf.sample(w.x, w.z) + 0.3, w.z));
    travGroup.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(wpPts),
      new THREE.PointsMaterial({ color: 0xdbccb5, size: 4, sizeAttenuation: false })));
    this.scene.add(travGroup);

    // Groups
    this.scene.add(this.routeGroup);
    this.scene.add(this.envelopeGroup);
    this.scene.add(this.markerGroup);

    // Scrubber dot
    this.scrubberDot = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x5ef2c2 }),
    );
    this.scrubberDot.visible = false;
    this.scene.add(this.scrubberDot);

    // Controls
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.target.copy(stop);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 3500;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = 1.8;
    this.controls.enabled = false; // enabled when entering FRAME mode

    // Habitat marker
    const hab = poisData.habitat;
    const habPos = new THREE.Vector3(hab.x, this.hf.sample(hab.x, hab.z) + 0.5, hab.z);
    const habSprite = labelSprite("H", "#5ef2c2", "#0e0f13", "#ece6dc", 26);
    habSprite.position.copy(habPos);
    (habSprite as any).poiId = "habitat";
    this.markerGroup.add(habSprite);
    this.poiSprites.set("habitat", habSprite);

    // POI markers
    poisData.pois.forEach((poi, idx) => {
      const pos = new THREE.Vector3(poi.x, this.hf.sample(poi.x, poi.z) + 0.5, poi.z);
      const sprite = labelSprite(String(idx + 1), "#f7b257", "#0e0f13", "#3a3a40");
      sprite.position.copy(pos);
      (sprite as any).poiId = poi.id;
      this.markerGroup.add(sprite);
      this.poiSprites.set(poi.id, sprite);
    });

    // Ensure orbit camera stays above ground
    this.controls.addEventListener("change", () => {
      const g = this.hf.inside(this.camera.position.x, this.camera.position.z)
        ? this.hf.sample(this.camera.position.x, this.camera.position.z)
        : -1e9;
      if (this.camera.position.y < g + 2.0) this.camera.position.y = g + 2.0;
    });

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      if (this.routeLine) {
        (this.routeLine.material as LineMaterial).resolution.set(window.innerWidth, window.innerHeight);
      }
      if (this.envelopeLine) {
        (this.envelopeLine.material as LineMaterial).resolution.set(window.innerWidth, window.innerHeight);
      }
    }, { signal: siteSignal() });
  }

  setTopDown() {
    const t = this.controls.target;
    this.camera.position.set(t.x, 1150, t.z + 0.1);
    this.controls.update();
  }

  setTilt3D() {
    const t = this.controls.target;
    this.camera.position.set(t.x - 380, t.y + 430, t.z + 560);
    this.controls.update();
  }

  resetView() {
    const stop = new THREE.Vector3(this.meta.stop.x, this.hf.sample(this.meta.stop.x, this.meta.stop.z), this.meta.stop.z);
    this.controls.target.copy(stop);
    this.setTilt3D();
  }

  /** Generated overlay (site elevation or a global layer sampled over the site) in shader slot 4. */
  setOverlayTexture(tex: THREE.Texture, opacity = 0.65) {
    this.terrain.material.uniforms.tGlobal.value = tex;
    this.setLayer(4, opacity);
  }

  setLayer(layer: number, opacity = 0.65) {
    this.terrain.material.uniforms.uLayer.value = layer;
    this.terrain.material.uniforms.uOpacity.value = opacity;
  }

  updateMarkerBadges(routeOrder: string[]) {
    // Habitat
    const habSprite = this.poiSprites.get("habitat");
    if (habSprite) {
      const s = labelSprite("H", "#5ef2c2", "#0e0f13", "#ece6dc", 26);
      habSprite.material.map?.dispose();
      habSprite.material.map = s.material.map;
    }
    // Update POIs
    this.poisData.pois.forEach((poi, idx) => {
      const sprite = this.poiSprites.get(poi.id);
      if (!sprite) return;
      const orderIdx = routeOrder.indexOf(poi.id);
      if (orderIdx >= 0) {
        const s = labelSprite(String(orderIdx + 1), "#f26d4a", "#fff", "#5ef2c2", 26);
        sprite.material.map?.dispose();
        sprite.material.map = s.material.map;
      } else {
        const s = labelSprite(String(idx + 1), "#f7b257", "#0e0f13", "#3a3a40", 24);
        sprite.material.map?.dispose();
        sprite.material.map = s.material.map;
      }
    });
    // Custom markers
    this.customSprites.forEach((sprite, id) => {
      const orderIdx = routeOrder.indexOf(id);
      if (orderIdx >= 0) {
        const s = labelSprite(String(orderIdx + 1), "#f26d4a", "#fff", "#5ef2c2", 26);
        sprite.material.map?.dispose();
        sprite.material.map = s.material.map;
      } else {
        const s = labelSprite("M", "#ff4f26", "#fff", "#3a3a40", 24);
        sprite.material.map?.dispose();
        sprite.material.map = s.material.map;
      }
    });
  }

  addCustomMarker(id: string, x: number, z: number, label = "M") {
    const pos = new THREE.Vector3(x, this.hf.sample(x, z) + 0.5, z);
    const sprite = labelSprite(label, "#ff4f26", "#ffffff", "#ece6dc", 24);
    sprite.position.copy(pos);
    (sprite as any).customId = id;
    this.markerGroup.add(sprite);
    this.customSprites.set(id, sprite);
    return sprite;
  }

  addNote(id: string, x: number, z: number) {
    const sprite = noteSprite();
    sprite.position.set(x, this.hf.sample(x, z) + 0.5, z);
    (sprite as any).noteId = id;
    this.markerGroup.add(sprite);
    this.noteSprites.set(id, sprite);
    return sprite;
  }

  removeNote(id: string) {
    const s = this.noteSprites.get(id);
    if (!s) return;
    this.markerGroup.remove(s);
    s.material.map?.dispose();
    s.material.dispose();
    this.noteSprites.delete(id);
  }

  removeCustomMarker(id: string) {
    const s = this.customSprites.get(id);
    if (s) {
      this.markerGroup.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
      this.customSprites.delete(id);
    }
  }

  updateRoute(res: RouteResult, slopeBins: number[]) {
    this.clearRoute();
    if (!res.ok || !res.smooth || !res.smooth.length) return;

    const binOf = (s: number) => {
      let b = 0;
      while (b < slopeBins.length && s >= slopeBins[b]) b++;
      return Math.min(b, BIN_COLORS.length - 1);
    };

    const pos: number[] = [], col: number[] = [];
    const color = new THREE.Color();
    const sm = res.smooth;

    for (let k = 0; k < sm.length; k++) {
      const [x, z] = sm[k];
      pos.push(x, this.hf.sample(x, z) + 0.38, z);
      const s = res.profile[k] ? res.profile[k].s : 0;
      color.set(BIN_COLORS[binOf(s)]);
      col.push(color.r, color.g, color.b);
    }

    const geo = new LineGeometry();
    geo.setPositions(pos);
    geo.setColors(col);

    // Dark outline underneath
    const outlineMat = new LineMaterial({
      linewidth: 8,
      color: 0x0f0d1b,
      worldUnits: false,
      depthTest: true,
      depthWrite: false,
    });
    outlineMat.resolution.set(window.innerWidth, window.innerHeight);
    const outline = new Line2(geo, outlineMat);
    outline.renderOrder = 5;

    // Foreground colored line
    const mat = new LineMaterial({
      linewidth: 4,
      vertexColors: true,
      worldUnits: false,
      depthTest: true,
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.routeLine = new Line2(geo, mat);
    this.routeLine.renderOrder = 6;
    this.routeLine.add(outline);

    this.routeGroup.add(this.routeLine);
  }

  clearRoute() {
    if (this.routeLine) {
      this.routeGroup.remove(this.routeLine);
      this.routeLine.geometry.dispose();
      this.routeLine = null;
    }
    this.setScrubber(null);
  }

  updateEnvelope(homeTime: Float32Array, thresholdSec: number) {
    if (this.envelopeLine) {
      this.envelopeGroup.remove(this.envelopeLine);
      this.envelopeLine.geometry.dispose();
      this.envelopeLine = null;
    }

    const segs = extractEnvelopeContour(homeTime, thresholdSec, this.hf, this.meta, 2);
    if (!segs.length) return;

    const geo = new LineSegmentsGeometry(); // disjoint segments (LineGeometry would join them into streaks)
    geo.setPositions(segs);

    const mat = new LineMaterial({
      linewidth: 2.5,
      color: 0x5ef2c2,
      worldUnits: false,
      depthTest: true,
      transparent: true,
      opacity: 0.85,
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.envelopeLine = new LineSegments2(geo, mat);
    this.envelopeLine.renderOrder = 4;
    this.envelopeGroup.add(this.envelopeLine);
  }

  setScrubber(p: { x: number; y: number; z: number } | null) {
    if (!p) {
      this.scrubberDot.visible = false;
      return;
    }
    this.scrubberDot.position.set(p.x, p.y + 0.6, p.z);
    this.scrubberDot.visible = true;
  }

  pickTerrain(clientX: number, clientY: number): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    rc.setFromCamera(ndc, this.camera);

    const ray = rc.ray;
    const p = ray.origin.clone();
    const step = 0.5;
    let prevAbove = p.y - (this.hf.inside(p.x, p.z) ? this.hf.sample(p.x, p.z) : -1e9);
    let t = 0;
    for (let k = 0; k < 15000; k++) {
      const dt = Math.max(step, Math.min(20, prevAbove * 0.5));
      t += dt;
      p.copy(ray.origin).addScaledVector(ray.direction, t);
      if (t > 5000) return null;
      if (!this.hf.inside(p.x, p.z)) {
        prevAbove = 1e9;
        continue;
      }
      const above = p.y - this.hf.sample(p.x, p.z);
      if (above <= 0) {
        let lo = t - dt, hi = t;
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) / 2;
          const q = ray.origin.clone().addScaledVector(ray.direction, mid);
          if (q.y - this.hf.sample(q.x, q.z) > 0) lo = mid; else hi = mid;
        }
        const q = ray.origin.clone().addScaledVector(ray.direction, hi);
        q.y = this.hf.sample(q.x, q.z);
        return q;
      }
      prevAbove = above;
    }
    return null;
  }

  pickMarker(clientX: number, clientY: number): { type: "poi" | "custom" | "note"; id: string } | null {
    const rc = new THREE.Raycaster();
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    rc.setFromCamera(ndc, this.camera);

    const hits = rc.intersectObjects(this.markerGroup.children.filter((o) => o.visible));
    if (!hits.length) return null;
    const hit = hits[0].object as any;
    if (hit.noteId) return { type: "note", id: hit.noteId };
    if (hit.poiId) return { type: "poi", id: hit.poiId };
    if (hit.customId) return { type: "custom", id: hit.customId };
    return null;
  }

  /** 3D scan (Gaussian splat) of the rover stop, if this site has one; fades in close to the stop at ground level. */
  splat: StopSplat | null = null;
  async loadSplat(base: string) {
    const st = this.meta.stop;
    const sp = new StopSplat(this.scene, this.renderer, this.camera, new THREE.Vector3(st.x, this.hf.sample(st.x, st.z), st.z), (x, z) => this.hf.sample(x, z));
    if (await sp.load(base)) this.splat = sp;
    return !!this.splat;
  }
  /** Free everything this site's scene holds (switching site in-page): controls, splat, GPU buffers, DOM. */
  dispose() {
    this.controls.enabled = false;
    this.controls.dispose();
    this.leaderSvg?.remove();
    this.leaderSvg = null;
    this.splat?.dispose();
    this.splat = null;
    const tex = new Set<THREE.Texture>(Object.values(this.textures).filter(Boolean) as THREE.Texture[]);
    this.scene.traverse((o: any) => {
      o.geometry?.dispose?.();
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        for (const v of Object.values(m)) if ((v as any)?.isTexture) tex.add(v as THREE.Texture);
        for (const u of Object.values<any>(m.uniforms ?? {})) if (u?.value?.isTexture) tex.add(u.value);
        m.dispose();
      }
    });
    for (const t of tex) t.dispose();
    this.scene.clear();
  }

  /** Fly the orbit camera low and close to the stop, where the splat looks right. */
  viewSplat() {
    // A one-stop scan is only right from where it was shot: stand at the rover's mast (~2 m) and look out,
    // away from the habitat model (which sits beside the stop and would block the view).
    const st = this.meta.stop, y = this.hf.sample(st.x, st.z);
    const home = this.scene.getObjectByName("home-hdu");
    let dx = 1, dz = 0;
    if (home) { dx = st.x - home.position.x; dz = st.z - home.position.z; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const tx = st.x + dx * 16, tz = st.z + dz * 16; // look out, not down: the near field (rover deck, mast shadow) is the weakest part
    this.camera.position.set(st.x - dx * 0.5, y + 2.2, st.z - dz * 0.5);
    this.controls.target.set(tx, this.hf.sample(tx, tz) + 0.3, tz);
    this.controls.update();
  }

  /** Light the site for a moment in time: Sun direction, scene brightness, model lights and (in the walk) the sky. */
  setSunTime(ms: number) {
    const m = this.meta as any;
    const s = sunAt(m.origin_lat, m.origin_lon, ms);
    this.sunNow = { elev: s.elev, az: s.az, ltst: s.ltst };
    this.sunDirV.set(...sunDirLocal(Math.max(s.elev, 2), s.az));
    const t = THREE.MathUtils.clamp((s.elev + 6) / 18, 0, 1);         // civil twilight (-6 deg) to 12 deg
    this.dayF = t * t * (3 - 2 * t);
    const u = this.terrain.material.uniforms;
    u.uSunDir.value.copy(this.sunDirV);
    u.uDay.value = this.dayF;
    const key = this.scene.getObjectByName("model-key") as THREE.DirectionalLight | undefined;
    if (key) { key.position.copy(this.sunDirV).multiplyScalar(1000); key.intensity = 1.6 * this.dayF; }
    const hemi = this.scene.getObjectByName("model-hemi") as THREE.HemisphereLight | undefined;
    if (hemi) hemi.intensity = 0.35 + 1.25 * this.dayF;
    this.applySky();
  }
  /** Walk view: a dusty daytime sky (butterscotch, darkening to night) and the Sun drawn in it. Planning keeps the dark backdrop. */
  setSky(on: boolean) { this.skyOn = on; this.applySky(); }
  private applySky() {
    const fog = this.scene.fog as THREE.Fog;
    if (!this.skyOn) {
      (this.scene.background as THREE.Color).copy(SKY); fog.color.copy(SKY); fog.near = 800; fog.far = 3200;
      this.sunSprite.visible = false;
      return;
    }
    const d = this.dayF, c = new THREE.Color(0x0e0f13).lerp(new THREE.Color(0x6e4a38), Math.min(1, d * 2)).lerp(new THREE.Color(0xc9a582), Math.max(0, d * 2 - 1));
    (this.scene.background as THREE.Color).copy(c); fog.color.copy(c); fog.near = 350; fog.far = 2400;
    this.sunSprite.visible = this.sunNow.elev > -1;
  }

  render(now: number) {
    if (this.controls.enabled) this.controls.update();
    if (this.sunSprite.visible) this.sunSprite.position.copy(this.camera.position).addScaledVector(this.sunDirV, 1500);
    this.splat?.update();
    this.declutter();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- pin declutter
  // Pins that overlap on screen are pushed apart (screen space, every frame) by shifting each sprite's
  // `center`, so the world position stays true and ray picking hits the drawn icon. A thin leader line
  // goes from a moved icon back to its real spot.
  private offsets = new Map<THREE.Sprite, { x: number; y: number }>();
  private leaderSvg: SVGSVGElement | null = null;

  private declutter() {
    const sprites = [...this.markerGroup.children].filter((o) => (o as THREE.Sprite).isSprite && o.visible) as THREE.Sprite[];
    const H = this.renderer.domElement.clientHeight || innerHeight, W = this.renderer.domElement.clientWidth || innerWidth;
    this.camera.updateMatrixWorld();
    const p5 = this.camera.projectionMatrix.elements[5];
    const pts: { s: THREE.Sprite; ax: number; ay: number; size: number; o: { x: number; y: number }; on: boolean }[] = [];
    const v = new THREE.Vector3();
    for (const s of sprites) {
      v.copy(s.position).project(this.camera);
      const size = s.scale.y * p5 * (H / 2);                  // on-screen icon size (sizeAttenuation off)
      const prev = this.offsets.get(s) ?? { x: 0, y: 0 };
      pts.push({ s, ax: ((v.x + 1) / 2) * W, ay: ((1 - v.y) / 2) * H - size / 2, size, o: { x: prev.x * 0.85, y: prev.y * 0.85 },
        on: v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 });
    }
    const live = pts.filter((p) => p.on);
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        const minD = (a.size + b.size) / 2 * 1.12; // a little breathing room between icons
        let dx = (b.ax + b.o.x) - (a.ax + a.o.x), dy = (b.ay + b.o.y) - (a.ay + a.o.y);
        let d = Math.hypot(dx, dy);
        if (d >= minD) continue;
        if (d < 0.01) { const ang = (i * 2.399 + j) % (Math.PI * 2); dx = Math.cos(ang); dy = Math.sin(ang); d = 1; } // identical spots: fixed fan-out
        const push = (minD - Math.min(d, minD)) / 2;
        const ux = dx / d, uy = dy / d;
        a.o.x -= ux * push; a.o.y -= uy * push;
        b.o.x += ux * push; b.o.y += uy * push;
      }
    }
    let svg = "";
    for (const p of pts) {
      if (!p.on) { p.o.x = 0; p.o.y = 0; }
      this.offsets.set(p.s, p.o);
      p.s.center.set(0.5 - p.o.x / p.size, p.o.y / p.size);
      if (p.on && Math.hypot(p.o.x, p.o.y) > 5) {
        const bx = p.ax, by = p.ay + p.size / 2;               // true anchor (bottom of the unmoved icon)
        const ix = p.ax + p.o.x, iy = p.ay + p.o.y;            // moved icon centre
        svg += `<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${ix.toFixed(1)}" y2="${iy.toFixed(1)}" />` +
          `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="2.5" />`;
      }
    }
    this.leaders(svg);
  }

  private leaders(inner: string) {
    if (!this.leaderSvg) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.id = "pin-leaders";
      el.setAttribute("aria-hidden", "true");
      this.renderer.domElement.after(el);
      this.leaderSvg = el;
    }
    if (this.leaderSvg.innerHTML !== inner) this.leaderSvg.innerHTML = inner;
    this.leaderSvg.style.display = inner ? "" : "none";
  }

  /** Walk / debrief: show only the habitat and these pins (the route's stops); null = show every pin again. */
  showOnlyPins(ids: string[] | null) {
    const keep = ids ? new Set(["habitat", ...ids]) : null;
    for (const [id, sp] of [...this.poiSprites, ...this.customSprites]) sp.visible = !keep || keep.has(id);
    for (const sp of this.noteSprites.values()) sp.visible = !keep; // notes are for planning only
  }

  /** Called when leaving the site view (globe on screen): drop the leader lines. */
  hideOverlays() { if (this.leaderSvg) this.leaderSvg.style.display = "none"; }
}
