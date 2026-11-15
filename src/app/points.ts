// Point layers on the globe: Landmarks (Gazetteer), Missions (landing sites), Bases (Exploration Zones).
// Markers are three.js objects; labels are pooled HTML elements projected each frame.
import * as THREE from "three";
import type { Globe } from "./globe";
import { dirFromLatLon } from "./geo";
import type { Place } from "./search";

export interface Base extends Place { id: string; approximate: boolean; location_method: string; note: string; radius_km: number; score?: number; rank?: number }
export interface Mission extends Place { agency?: string; year?: number }

const R_KM = 3396.19;

/** Base (Exploration Zone) colour by best-spot score: red (low) -> amber -> mint (high). Also drives the legend. */
export const BASE_SCORE_STOPS: [number, number[]][] = [[0, [255, 79, 38]], [0.5, [247, 178, 87]], [1, [94, 242, 194]]];
function scoreColor(s: number) {
  const [a, b, c] = BASE_SCORE_STOPS.map(([, k]) => new THREE.Color(k[0] / 255, k[1] / 255, k[2] / 255));
  return s < 0.5 ? a.clone().lerp(b, s / 0.5) : b.clone().lerp(c, (s - 0.5) / 0.5);
}

function circlePoints(lat: number, lon: number, rKm: number, n = 72) {
  const c = dirFromLatLon(lat, lon);
  const east = new THREE.Vector3(0, 1, 0).cross(c).normalize();
  if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
  const north = c.clone().cross(east).normalize();
  const a = rKm / R_KM;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push(c.clone().multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a) * Math.cos(t)).addScaledVector(north, Math.sin(a) * Math.sin(t)));
  }
  return pts;
}

/** Mint badge with a dark "!" (explorable site). */
function exploreTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0e0f13";
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#5ef2c2";
  g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#f3e9dc"; g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#0e0f13";
  g.fillRect(55, 28, 18, 46);          // "!" drawn as pixel blocks to match the pixel UI
  g.fillRect(55, 84, 18, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ringTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#5ef2c2"; g.lineWidth = 7;
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PointLayers {
  readonly group = new THREE.Group();
  landmarks: Place[] = [];
  missions: Mission[] = [];
  bases: Base[] = [];
  show = { landmarks: false, missions: false, bases: false };
  private lmPoints: THREE.Points | null = null;
  private lmFilter = -1;
  private misGroup = new THREE.Group();
  private baseGroup = new THREE.Group();
  private labels: HTMLDivElement[] = [];
  private top = new Set<string>();
  private t = 0;
  /** Sites with baked HiRISE terrain you can walk (MAP / Frame mode): always shown, mint "!" badge. */
  explorable: Place[] = [];
  selectedName: string | null = null;
  private exploreGroup = new THREE.Group();

  constructor(private globe: Globe, private host: HTMLElement) {
    this.group.add(this.misGroup, this.baseGroup, this.exploreGroup);
    this.group.renderOrder = 20;
    globe.scene.add(this.group);
  }

  setData(landmarks: Place[], missions: Mission[], bases: Base[]) {
    this.landmarks = landmarks; this.missions = missions; this.bases = bases;
    const diamond = new THREE.OctahedronGeometry(0.006, 0);
    const mm = new THREE.MeshBasicMaterial({ color: 0xea681d, depthTest: true });
    for (const m of missions) {
      const mesh = new THREE.Mesh(diamond, mm);
      mesh.position.copy(this.globe.surfacePoint(m.lat, m.lon)).multiplyScalar(1.004);
      mesh.userData = m;
      this.misGroup.add(mesh);
    }
    this.rebuildBases();
  }

  setExplorable(sites: Place[]) {
    this.explorable = sites;
    this.exploreGroup.clear();
    const badge = exploreTexture(), ring = ringTexture();
    for (const s of sites) {
      const p = this.globe.surfacePoint(s.lat, s.lon).multiplyScalar(1.006);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: ring, sizeAttenuation: false, depthTest: false, transparent: true, depthWrite: false }));
      halo.position.copy(p); halo.scale.set(0.05, 0.05, 1); halo.userData.pulse = true; halo.renderOrder = 21;
      const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: badge, sizeAttenuation: false, depthTest: false, transparent: true, depthWrite: false }));
      icon.position.copy(p); icon.scale.set(0.034, 0.034, 1); icon.renderOrder = 22;
      icon.userData.site = s;
      this.exploreGroup.add(halo, icon);
    }
  }

  /** Re-colour bases by score; top-N glow. */
  setScores(scores: Map<string, { score: number; rank: number }>, topN: number) {
    for (const b of this.bases) { const s = scores.get(b.id); b.score = s?.score; b.rank = s?.rank; }
    this.top = new Set(this.bases.filter((b) => (b.rank ?? 99) <= topN).map((b) => b.id));
    this.rebuildBases();
  }

  private rebuildBases() {
    this.baseGroup.clear();
    for (const b of this.bases) {
      const col = b.score === undefined ? new THREE.Color(0xdbccb5) : scoreColor(b.score);
      const isTop = this.top.has(b.id);
      const pts = circlePoints(b.lat, b.lon, b.radius_km).map((p) => p.multiplyScalar(1.003 + (this.globe.elevation.at(b.lat, b.lon) * this.globe.exag) / 3396190));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: isTop ? 1 : 0.75, depthTest: true }));
      line.userData = { base: b, top: isTop };
      this.baseGroup.add(line);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(isTop ? 0.006 : 0.004, 16), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true }));
      const p = this.globe.surfacePoint(b.lat, b.lon).multiplyScalar(1.003);
      dot.position.copy(p); dot.lookAt(p.clone().multiplyScalar(2));
      dot.userData = { base: b, top: isTop, dot: true };
      this.baseGroup.add(dot);
    }
  }

  private landmarkFilter(dist: number) {
    return dist > 3.2 ? 400 : dist > 2.2 ? 150 : dist > 1.5 ? 50 : dist > 1.2 ? 15 : 0;
  }

  update(dt: number) {
    this.t += dt;
    const d = this.globe.camera.position.length();
    this.misGroup.visible = this.show.missions;
    this.baseGroup.visible = this.show.bases;
    // glow pulse for the top-N bases
    if (this.show.bases) for (const o of this.baseGroup.children) if (o.userData.top) {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
      m.opacity = 0.65 + 0.35 * Math.sin(this.t * 4);
      if (o.userData.dot) o.scale.setScalar(1 + 0.35 * (0.5 + 0.5 * Math.sin(this.t * 4)));
    }
    for (const o of this.misGroup.children) o.scale.setScalar(Math.max(0.6, (d - 1) * 1.1));
    // explorable sites: drawn on top while on the visible hemisphere (so the limb does not cut the badge), hidden behind the planet
    const cam = this.globe.camera.position;
    for (const o of this.exploreGroup.children) {
      const n = o.position.clone().normalize();
      o.visible = n.dot(cam.clone().sub(o.position).normalize()) > 0.02;
    }
    // slow pulse ring behind the "!" badge
    const ph = (this.t * 0.6) % 1;
    for (const o of this.exploreGroup.children) if (o.userData.pulse) {
      o.scale.set(0.034 + 0.05 * ph, 0.034 + 0.05 * ph, 1);
      ((o as THREE.Sprite).material as THREE.SpriteMaterial).opacity = 0.9 * (1 - ph);
    }
    // landmarks: point density follows zoom
    const f = this.show.landmarks ? this.landmarkFilter(d) : -1;
    if (f !== this.lmFilter) {
      if (this.lmPoints) { this.group.remove(this.lmPoints); this.lmPoints.geometry.dispose(); this.lmPoints = null; }
      if (f >= 0) {
        const sel = this.landmarks.filter((l) => (l.diameter_km ?? 0) >= f);
        const pos = new Float32Array(sel.length * 3);
        sel.forEach((l, i) => { const p = this.globe.surfacePoint(l.lat, l.lon).multiplyScalar(1.002); pos.set([p.x, p.y, p.z], i * 3); });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        this.lmPoints = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdbccb5, size: 4, sizeAttenuation: false, depthTest: true }));
        this.lmPoints.userData.items = sel;
        this.group.add(this.lmPoints);
      }
      this.lmFilter = f;
    }
    this.placeLabels(d);
  }

  /** Visible items in priority order for labels and picking. */
  private visibleItems(): { p: Place; kind: string; prio: number }[] {
    const out: { p: Place; kind: string; prio: number }[] = [];
    for (const s of this.explorable) out.push({ p: s, kind: "explore", prio: 5 });
    if (this.show.bases) for (const b of this.bases) out.push({ p: b, kind: "base", prio: this.top.has(b.id) ? 3 : 1.5 });
    if (this.show.missions) for (const m of this.missions) out.push({ p: m, kind: "mission", prio: 2.5 });
    if (this.show.landmarks && this.lmPoints) for (const l of this.lmPoints.userData.items as Place[]) out.push({ p: l, kind: "landmark", prio: 1 + Math.log10(1 + (l.diameter_km ?? 0)) / 4 });
    return out;
  }

  private placeLabels(dist: number) {
    const rect = this.host.getBoundingClientRect();
    const items = this.visibleItems().sort((a, b) => b.prio - a.prio);
    const placed: { x: number; y: number; w: number }[] = [];
    let n = 0;
    const maxLabels = dist > 3 ? 18 : 40;
    for (const it of items) {
      if (n >= maxLabels) break;
      const scr = this.globe.project(this.globe.surfacePoint(it.p.lat, it.p.lon));
      if (!scr || scr.x < rect.left || scr.x > rect.right || scr.y < rect.top || scr.y > rect.bottom) continue;
      const showAll = it.kind !== "landmark" ? it.prio >= 2.5 || dist < 2.4 : true;
      if (!showAll) continue;
      if (it.kind === "explore" && it.p.name === this.selectedName) continue; // the selection tag already names it
      const w = it.p.name.length * 6.5 + 12;
      if (placed.some((q) => Math.abs(q.x - scr.x) < (q.w + w) / 2 && Math.abs(q.y - scr.y) < 14)) continue;
      placed.push({ x: scr.x, y: scr.y, w });
      const el = this.labels[n] ?? this.makeLabel();
      el.textContent = it.kind === "explore" ? `${it.p.name} · explore` : it.kind === "base" && (it.p as Base).rank ? `#${(it.p as Base).rank} ${it.p.name}` : it.p.name;
      el.className = `plabel ${it.kind}${it.kind === "base" && this.top.has((it.p as Base).id) ? " top" : ""}`;
      el.style.transform = `translate(${scr.x - rect.left}px, ${scr.y - rect.top}px)`;
      el.style.marginLeft = "";
      el.hidden = false;
      // a label that would run past the right edge (over the side rail) goes on the left of its marker instead
      const gap = it.kind === "explore" ? 16 : 6;
      if (scr.x + gap + 2 * w > rect.right && scr.x + gap + el.offsetWidth > rect.right - 4) {
        el.style.transform += " translateX(-100%)";
        el.style.marginLeft = `${-gap}px`;
      }
      n++;
    }
    for (let i = n; i < this.labels.length; i++) this.labels[i].hidden = true;
  }

  /** Off the globe screen the labels must not linger over the other views (update() stops running there). */
  hideLabels() { for (const l of this.labels) l.hidden = true; }

  private makeLabel() {
    const el = document.createElement("div");
    el.className = "plabel";
    this.host.appendChild(el);
    this.labels.push(el);
    return el;
  }

  /** Nearest visible point item within `px` pixels of a screen position. */
  pickScreen(x: number, y: number, px = 12): { p: Place; kind: string } | null {
    let best: { p: Place; kind: string } | null = null, bd = px;
    for (const it of this.visibleItems()) {
      const scr = this.globe.project(this.globe.surfacePoint(it.p.lat, it.p.lon));
      if (!scr) continue;
      // markers need a near-direct hit (<=6 px landmarks, <=10 px bases/missions); the explore badge is larger (<=16 px) and wins ties
      const d = Math.hypot(scr.x - x, scr.y - y) + (it.kind === "landmark" ? 6 : it.kind === "explore" ? -4 : 2);
      if (d < bd) { bd = d; best = { p: it.p, kind: it.kind }; }
    }
    return best;
  }
}
