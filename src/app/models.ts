// NASA 3D Resources models (github.com/nasa/NASA-3D-Resources; free to use, no copyright, NASA media guidelines):
//   Habitat Demonstration Unit (home base), Space Exploration Vehicle (pressurised-rover shelter).
// The walker is the project's rigged Astronaut_MarsWalk.glb (skeleton + MarsWalk walk cycles), loaded with loadAnimated().
// Files live in data/processed/models/ (Draco-compressed glb; decoder copied from three's examples into /draco/).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

let loader: GLTFLoader | null = null;
function getLoader() {
  if (!loader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath("/draco/");
    loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
  }
  return loader;
}

const cache = new Map<string, Promise<THREE.Object3D>>();

/** Load a glb and fit it to a real-world size: centred on x/z, standing on y = 0, facing −z (yaw offset in radians). */
export async function loadFitted(url: string, fit: { height?: number; length?: number }, yaw = 0): Promise<THREE.Group> {
  if (!cache.has(url)) cache.set(url, getLoader().loadAsync(url).then((g) => g.scene));
  const src = (await cache.get(url)!).clone(true);
  const inner = new THREE.Group();
  inner.add(src);
  inner.rotation.y = yaw;
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = fit.height ? fit.height / size.y : (fit.length ?? 1) / Math.max(size.x, size.z);
  const wrap = new THREE.Group();
  inner.position.set(-c.x, -box.min.y, -c.z);
  const scaled = new THREE.Group();
  scaled.scale.setScalar(s);
  scaled.add(inner);
  wrap.add(scaled);
  wrap.userData.size = size.clone().multiplyScalar(s);
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.frustumCulled = true;
    // KHR_materials_transmission (habitat windows) costs an extra full render pass: use plain transparency instead
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshPhysicalMaterial[]) {
      if (mat.transmission > 0) { mat.transmission = 0; mat.transparent = true; mat.opacity = Math.min(mat.opacity, 0.45); mat.needsUpdate = true; }
    }
  });
  return wrap;
}

/** A rigged, animated glb (the walking astronaut): skeleton-safe clone, fitted to `height` metres standing on y = 0,
 *  facing -z after `yaw`. Returns the model, an AnimationMixer on it and its clips by name. The size is measured on
 *  the skinned pose of the first clip's first frame (the bind pose can be a T / A pose). */
export async function loadAnimated(url: string, height: number, yaw = 0) {
  const gltf = await getLoader().loadAsync(url);
  const src = cloneSkinned(gltf.scene);
  const inner = new THREE.Group();
  inner.add(src);
  inner.rotation.y = yaw;
  const mixer = new THREE.AnimationMixer(src);
  const clips = new Map(gltf.animations.map((c) => [c.name, c] as const));
  if (gltf.animations[0]) { mixer.clipAction(gltf.animations[0]).play(); mixer.update(0); }
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner, true);
  mixer.stopAllAction();
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = height / size.y;
  inner.position.set(-c.x, -box.min.y, -c.z);
  const scaled = new THREE.Group();
  scaled.scale.setScalar(s);
  scaled.add(inner);
  const wrap = new THREE.Group();
  wrap.add(scaled);
  wrap.userData.size = size.clone().multiplyScalar(s);
  wrap.userData.scale = s;
  src.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; }); // skinned bounds lag the pose
  return { model: wrap, mixer, clips, root: src };
}

/** Light for the PBR models (the terrain shader ignores scene lights). */
export function modelLights() {
  const g = new THREE.Group();
  const hemi = new THREE.HemisphereLight(0xfff1e0, 0x6b4a36, 1.6);
  hemi.name = "model-hemi";                     // FrameScene.setSunTime dims these with the local Sun
  g.add(hemi);
  const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
  key.name = "model-key";
  key.position.set(-500, 750, -400);
  g.add(key);
  return g;
}

/** Environment lighting for the metallic PBR parts (without it they render black). The terrain shader is unaffected. */
export function setModelEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  if (scene.environment) return;
  scene.add(modelLights());
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

/** The NASA astronaut ships in a T-pose with no skeleton: bend both arms down at the shoulder (CPU, once),
 *  blending over 10 cm so the suit does not tear. Works in the fitted model's metre space (y up, x = across). */
export function armsDown(model: THREE.Group, angleDeg = 68, shoulder = { x: 0.27, y: 1.38 }) {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const a = (angleDeg * Math.PI) / 180;
  for (const m of meshes) {
    const g = m.geometry.clone();
    const toModel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    g.applyMatrix4(toModel);
    const pos = g.attributes.position as THREE.BufferAttribute, nor = g.attributes.normal as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), ax = Math.abs(x), side = Math.sign(x) || 1;
      if (y < shoulder.y - 0.26) continue;
      const d = ax - shoulder.x;
      if (d <= 0) continue;
      const w = Math.min(1, d / 0.1), t = w * w * (3 - 2 * w), ang = a * t;
      const c = Math.cos(ang), s = Math.sin(ang);
      const dx = ax - shoulder.x, dy = y - shoulder.y;
      pos.setXY(i, side * (shoulder.x + dx * c + dy * s), shoulder.y - dx * s + dy * c);
      if (nor) { const nx = nor.getX(i) * side, ny = nor.getY(i); nor.setXY(i, side * (nx * c + ny * s), -nx * s + ny * c); }
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    g.computeBoundingBox(); g.computeBoundingSphere();
    m.geometry = g;
    // geometry is now in model space: re-parent the mesh directly under the model with an identity transform
    model.add(m);
    m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1);
  }
  // drop the now-empty original hierarchy
  for (const c of [...model.children]) if (!(c as THREE.Mesh).isMesh) model.remove(c);
  return model;
}

/** Home base (Habitat Demonstration Unit) at the habitat POI. Its footprint rests on the lowest ground under it. */
export async function placeHome(frame: { scene: THREE.Scene; renderer: THREE.WebGLRenderer; hf: { sample(x: number, z: number): number } },
  at: { x: number; z: number }, yaw = 0.6) {
  setModelEnvironment(frame.renderer, frame.scene);
  const m = await loadFitted("/models/hdu1.glb", { height: 5.2 }, yaw);
  restOnGround(m, at, frame.hf);
  m.name = "home-hdu";
  frame.scene.add(m);
  return m;
}

/** Pressurised-rover shelter (Space Exploration Vehicle). */
export async function placeRover(frame: { scene: THREE.Scene; renderer: THREE.WebGLRenderer; hf: { sample(x: number, z: number): number } },
  at: { x: number; z: number }, yaw = -0.9) {
  setModelEnvironment(frame.renderer, frame.scene);
  const m = await loadFitted("/models/sev.glb", { length: 4.5 }, yaw);
  restOnGround(m, at, frame.hf);
  m.name = "shelter-sev";
  frame.scene.add(m);
  return m;
}

function restOnGround(m: THREE.Group, at: { x: number; z: number }, hf: { sample(x: number, z: number): number }) {
  // seat on the mean ground under the footprint, sunk 15 cm so no edge floats on gentle slopes
  const s = m.userData.size as THREE.Vector3, r = Math.max(s.x, s.z) / 2;
  const pts = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]];
  const y = pts.reduce((a, [dx, dz]) => a + hf.sample(at.x + dx, at.z + dz), 0) / pts.length - 0.15;
  m.position.set(at.x, y, at.z);
  m.add(drapedShadow(at, y, r * 1.3, hf));
}

/** Contact shadow draped over the terrain (a small grid whose vertices follow the height field). */
export function drapedShadow(at: { x: number; z: number }, baseY: number, radius: number, hf: { sample(x: number, z: number): number }, opacity = 0.6) {
  const sh = contactShadow(radius, opacity);
  sh.geometry.dispose();
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2, 16, 16);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, hf.sample(at.x + p.getX(i), at.z + p.getZ(i)) - baseY + 0.08);
  geo.computeBoundingSphere();
  sh.geometry = geo;
  sh.rotation.set(0, 0, 0);
  sh.position.set(0, 0, 0);
  return sh;
}

/** A point `dist` metres from `at` in the direction (of 24 tried) that stays clearest of `others`
 *  (pins, stops): keeps a model off the walking line and out from under other markers. */
export function besideAway(at: { x: number; z: number }, others: { x: number; z: number }[], dist: number) {
  let best = { x: at.x + dist, z: at.z }, bestD = -1;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2, x = at.x + Math.cos(a) * dist, z = at.z + Math.sin(a) * dist;
    // distance to the pins and to the straight lines home -> pin (walks leave home roughly along those)
    const d = Math.min(...others.map((o) => segDist(x, z, at.x, at.z, o.x, o.z)));
    if (d > bestD) { bestD = d; best = { x, z }; }
  }
  return best;
}

let blobTex: THREE.Texture | null = null;
/** Soft contact shadow under a model (the scene has no shadow maps): grounds it visually. */
export function contactShadow(radius: number, opacity = 0.55) {
  if (!blobTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, "rgba(0,0,0,1)"); grad.addColorStop(0.55, "rgba(0,0,0,0.55)"); grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    blobTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.06;
  m.renderOrder = 1;
  return m;
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2));
  return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
}
