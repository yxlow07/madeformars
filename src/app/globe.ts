import * as THREE from "three";
import { BUST } from "./bust";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { R_MARS, dirFromLatLon, latLonFromDir } from "./geo";
import { marsSun, type MarsSun } from "./sun";

export interface MolaMeta { width: number; height: number; min_m: number; max_m: number; file: string }

/** CPU copy of the baked MOLA grid for elevation look-ups (row 0 = 90N, col 0 = 180W). */
export class Elevation {
  constructor(readonly data: Int16Array, readonly w: number, readonly h: number) {}
  at(lat: number, lon: number): number {
    const x = ((lon + 180) / 360) * this.w - 0.5, y = ((90 - lat) / 180) * this.h - 0.5;
    const x0 = Math.floor(x), y0 = Math.max(0, Math.min(this.h - 2, Math.floor(y)));
    const tx = x - x0, ty = Math.min(1, Math.max(0, y - y0));
    const g = (xx: number, yy: number) => this.data[yy * this.w + (((xx % this.w) + this.w) % this.w)];
    return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
  }
}

const VERT = /* glsl */ `
  uniform sampler2D tHeight;
  uniform float uExag;      // vertical exaggeration
  varying vec2 vUv;
  varying vec3 vPos;
  void main() {
    vUv = uv;
    float h = texture2D(tHeight, uv).r;
    vec3 p = position * (1.0 + h * uExag / ${R_MARS.toFixed(1)});
    vPos = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tHeight;
  uniform vec2 uTexel;      // 1/width, 1/height of the height map
  uniform float uShade;     // relief exaggeration for shading
  uniform vec3 uLight;      // world-space light direction
  uniform float uSat;
  uniform vec3 uTint;
  uniform float uContrast;
  varying vec2 vUv;
  varying vec3 vPos;
  void main() {
    vec3 n = normalize(vPos);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lon = atan(-n.z, n.x);
    // height gradient -> perturbed normal (east / north tangents of our lat-lon frame)
    float hE = texture2D(tHeight, vUv + vec2(uTexel.x, 0.0)).r - texture2D(tHeight, vUv - vec2(uTexel.x, 0.0)).r;
    float hN = texture2D(tHeight, vUv + vec2(0.0, uTexel.y)).r - texture2D(tHeight, vUv - vec2(0.0, uTexel.y)).r;
    float dE = 2.0 * ${R_MARS.toFixed(1)} * max(cos(lat), 0.05) * 6.2831853 * uTexel.x;
    float dN = 2.0 * ${R_MARS.toFixed(1)} * 3.1415927 * uTexel.y;
    vec3 tE = vec3(-sin(lon), 0.0, -cos(lon));
    vec3 tN = vec3(-sin(lat) * cos(lon), cos(lat), sin(lat) * sin(lon));
    vec3 nn = normalize(n - uShade * (hE / dE) * tE - uShade * (hN / dN) * tN);
    vec3 L = normalize(uLight);
    float lam = max(dot(nn, L), 0.0);
    // the real Sun lights one hemisphere: soft terminator (twilight band ~ 8 deg), faint night side
    float day = smoothstep(-0.10, 0.18, dot(n, L));
    vec3 c = texture2D(tColor, vUv).rgb;
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(g), c, uSat) * uTint;
    c = max((c - 0.3) * uContrast + 0.3, 0.0);
    vec3 col = c * (0.07 + 1.3 * lam * day);
    col += c * vec3(0.10, 0.04, 0.0) * (1.0 - abs(day * 2.0 - 1.0)) * step(0.02, day); // warm twilight at the terminator
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const OVERLAY_VERT = /* glsl */ `
  uniform sampler2D tHeight;
  uniform float uExag;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float h = texture2D(tHeight, uv).r;
    vec3 p = position * (1.0 + h * uExag / ${R_MARS.toFixed(1)});
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const OVERLAY_FRAG = /* glsl */ `
  uniform sampler2D tLayer;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tLayer, vUv);
    gl_FragColor = vec4(c.rgb, c.a * uOpacity);
    #include <colorspace_fragment>
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() { vN = normalize(normalMatrix * normal); vW = normalize((modelMatrix * vec4(normal, 0.0)).xyz); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }
`;
const ATMO_FRAG = /* glsl */ `
  uniform vec3 uLight;
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    float f = pow(1.0 - abs(dot(vN, vV)), 6.0);
    float lit = 0.12 + 0.88 * smoothstep(-0.25, 0.35, dot(-vW, normalize(uLight)));   // dusty limb glows on the day side
    gl_FragColor = vec4(vec3(1.0, 0.6, 0.35) * f * lit, f * 0.35 * lit);
  }
`;

export interface Framing { dist: number; offX: number; offY: number } // offsets in px of a 720-px-high reference

export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.001, 200);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  readonly elevation: Elevation;
  private marker: THREE.Mesh;
  private framing: Framing = { dist: 5, offX: 0, offY: 0 };
  private anim: ((t: number) => boolean) | null = null;
  /** Idle spin: Mars turns slowly (west -> east) from the splash on, until the user takes over the view. */
  spinning = true;
  spinPeriodS = 120;                 // one turn every 2 minutes
  private stars!: THREE.Object3D;
  /** The Sun for today (NASA GISS Mars24), drawn in the sky group so it turns with the stars. */
  readonly sun: MarsSun = marsSun();
  private sunObj!: THREE.Object3D;
  private atmoMat!: THREE.ShaderMaterial;
  private starPoints: THREE.Points | null = null;
  private lastRender = 0;
  private geometry!: THREE.SphereGeometry;
  private hTex!: THREE.DataTexture;
  private overlays = new Map<string, THREE.Mesh>();
  exag = 4;

  /** Show a data layer draped on the globe (same relief displacement), or remove it with tex = null. */
  setOverlay(id: string, tex: THREE.Texture | null, opacity = 0.7, order = 0) {
    const old = this.overlays.get(id);
    if (!tex) { if (old) { this.scene.remove(old); this.overlays.delete(id); } return; }
    if (old) {
      const u = (old.material as THREE.ShaderMaterial).uniforms;
      u.tLayer.value = tex; u.uOpacity.value = opacity;
      return;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.ShaderMaterial({
      vertexShader: OVERLAY_VERT, fragmentShader: OVERLAY_FRAG, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1 - order, polygonOffsetUnits: -4 - 4 * order,
      uniforms: { tLayer: { value: tex }, tHeight: { value: this.hTex }, uExag: { value: this.exag }, uOpacity: { value: opacity } },
    });
    const m = new THREE.Mesh(this.geometry, mat);
    m.renderOrder = 1 + order;
    this.overlays.set(id, m);
    this.scene.add(m);
  }
  setOverlayOpacity(id: string, opacity: number) {
    const m = this.overlays.get(id);
    if (m) (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = opacity;
  }
  setExag(v: number) {
    this.exag = v;
    this.material.uniforms.uExag.value = v;
    for (const m of this.overlays.values()) (m.material as THREE.ShaderMaterial).uniforms.uExag.value = v;
  }

  constructor(canvas: HTMLCanvasElement, color: THREE.Texture, mola: Int16Array, meta: MolaMeta) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.elevation = new Elevation(mola, meta.width, meta.height);

    // Data textures are uploaded without flipY: texture row 0 sits at uv.y = 0 (south), so reverse
    // the north-first MOLA rows to match the sphere's uv (uv.y = 1 at the north pole).
    const W = meta.width, H = meta.height;
    const hf = new Float32Array(mola.length);
    for (let r = 0; r < H; r++) {
      const src = r * W, dst = (H - 1 - r) * W;
      for (let c = 0; c < W; c++) hf[dst + c] = mola[src + c];
    }
    const hTex = new THREE.DataTexture(hf, W, H, THREE.RedFormat, THREE.FloatType);
    hTex.wrapS = THREE.RepeatWrapping;
    hTex.magFilter = THREE.LinearFilter;
    hTex.minFilter = THREE.LinearFilter;
    hTex.needsUpdate = true;
    color.colorSpace = THREE.SRGBColorSpace;
    color.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        tColor: { value: color }, tHeight: { value: hTex }, uExag: { value: 4 },
        uTexel: { value: new THREE.Vector2(1 / meta.width, 1 / meta.height) }, uShade: { value: 4 },
        uLight: { value: new THREE.Vector3(1, 0.6, 1) }, uSat: { value: 1.2 }, uTint: { value: new THREE.Vector3(1.9, 1.6, 0.8) }, uContrast: { value: 1.15 }, // fitted to the mockup colour statistics
      },
    });
    this.geometry = new THREE.SphereGeometry(1, 720, 360);
    this.hTex = hTex;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
    this.atmoMat = new THREE.ShaderMaterial({ uniforms: { uLight: { value: new THREE.Vector3(1, 0, 0) } },
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.012, 128, 64), this.atmoMat);
    this.scene.add(atmo);
    // real stars (NASA HEASARC Bright Star Catalogue, baked into Mars's frame); procedural sky only as a fallback
    this.stars = new THREE.Group();
    this.scene.add(this.stars);
    // the Sun at the subsolar point's direction (sky group = Mars body-fixed for today, like the stars), at its true size
    this.sunObj = makeSun(this.sun.angDiamDeg);
    dirFromLatLon(this.sun.subLat, this.sun.subLonE, this.sunObj.position).multiplyScalar(55);
    this.stars.add(this.sunObj);
    loadStars().then((pts) => { this.starPoints = pts; this.stars.add(pts); })
      .catch((e) => { console.warn("star catalogue:", e); this.stars.add(makeStarfield()); });

    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.018, 32), new THREE.MeshBasicMaterial({ color: 0x5ef2c2, side: THREE.DoubleSide, depthTest: false }));
    this.marker.renderOrder = 50;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.08;
    this.controls.maxDistance = 9;
    this.controls.zoomSpeed = 1.2;
    this.controls.enabled = false;
    this.controls.addEventListener("change", () => {
      const d = this.camera.position.length();
      this.controls.rotateSpeed = THREE.MathUtils.clamp((d - 1) * 0.35, 0.02, 0.9); // slow near the surface
    });
    this.lookAt(15, -50, 5);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  /** Point the camera at (lat, lon) from distance d (globe radii from the centre). */
  lookAt(lat: number, lon: number, d: number) {
    this.camera.position.copy(dirFromLatLon(lat, lon)).multiplyScalar(d);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setFraming(f: Framing) { this.framing = { ...f }; this.applyFraming(); }
  /** true while an animation drives the camera / framing */
  get animating() { return !!this.anim; }

  private applyFraming() {
    const W = window.innerWidth, H = window.innerHeight, s = H / 720;
    this.camera.aspect = W / H;
    this.camera.setViewOffset(W, H, this.framing.offX * s, this.framing.offY * s, W, H);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.applyFraming();
  }

  /** Animate framing and camera distance (and optionally direction) over `ms`. */
  animateTo(target: Framing & { lat?: number; lon?: number }, ms: number): Promise<void> {
    const f0 = { ...this.framing };
    const p0 = this.camera.position.clone();
    const d0 = p0.length();
    const dir0 = p0.clone().normalize();
    const dir1 = target.lat !== undefined && target.lon !== undefined ? dirFromLatLon(target.lat, target.lon) : dir0.clone();
    const q = new THREE.Quaternion().setFromUnitVectors(dir0, dir1);
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.anim = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const d = d0 + (target.dist - d0) * e;
        const dir = dir0.clone().applyQuaternion(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), q, e));
        this.camera.position.copy(dir).multiplyScalar(d);
        this.camera.lookAt(0, 0, 0);
        this.framing = { dist: d, offX: f0.offX + (target.offX - f0.offX) * e, offY: f0.offY + (target.offY - f0.offY) * e };
        this.applyFraming();
        if (t >= 1) { this.controls.update(); resolve(); return false; }
        return true;
      };
    });
  }

  /** Stop the idle spin for good (the user grabbed the planet or asked to fly somewhere). */
  stopSpin() { this.spinning = false; }

  flyTo(lat: number, lon: number, dist?: number) {
    this.stopSpin(); // a flight is always user-initiated (search, top site, entering / leaving a site)
    const d = dist ?? Math.min(this.camera.position.length(), 2.2);
    return this.animateTo({ ...this.framing, dist: d, lat, lon }, 1200);
  }

  /** Ray-pick the globe at NDC (x, y), refined for MOLA relief. Returns lat/lon or null. */
  pick(ndc: THREE.Vector2): { lat: number; lon: number; elev: number } | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    let r = 1;
    let hit: THREE.Vector3 | null = null;
    for (let k = 0; k < 4; k++) {
      const p = rc.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), r), new THREE.Vector3());
      if (!p) break;
      hit = p;
      const { lat, lon } = latLonFromDir(p);
      r = 1 + (this.elevation.at(lat, lon) * this.exag) / R_MARS;
    }
    if (!hit) return null;
    const { lat, lon } = latLonFromDir(hit);
    return { lat, lon, elev: this.elevation.at(lat, lon) };
  }

  surfacePoint(lat: number, lon: number) {
    return dirFromLatLon(lat, lon).multiplyScalar(1 + (this.elevation.at(lat, lon) * this.exag) / R_MARS);
  }

  setMarker(lat: number | null, lon?: number) {
    if (lat === null || lon === undefined) { this.marker.visible = false; return; }
    const p = this.surfacePoint(lat, lon);
    this.marker.position.copy(p).multiplyScalar(1.0015);
    this.marker.lookAt(p.clone().multiplyScalar(2));
    this.marker.visible = true;
  }

  /** Screen position (CSS px) of a world point, or null if behind the globe. */
  project(p: THREE.Vector3): { x: number; y: number } | null {
    const toCam = this.camera.position.clone().sub(p);
    if (toCam.dot(p.clone().normalize()) < 0) return null;
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  setColor(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const old = this.material.uniforms.tColor.value as THREE.Texture;
    this.material.uniforms.tColor.value = tex;
    old.dispose();
  }

  render(now: number) {
    const dt = this.lastRender ? Math.min(0.1, (now - this.lastRender) / 1000) : 0;
    this.lastRender = now;
    if (this.anim && !this.anim(now)) this.anim = null;
    // idle spin: orbit the camera about Mars's spin axis (+Y) and turn the stars with it, so the planet appears
    // to rotate under a fixed sky. Paused while an animation drives the camera.
    if (this.spinning && !this.anim && dt > 0) {
      // slow down when zoomed in closer than the splash view, so the ground never races past (down to 5% near the surface)
      const alt = this.camera.position.length() - 1;
      const a = ((-2 * Math.PI * dt) / this.spinPeriodS) * THREE.MathUtils.clamp(alt / 0.85, 0.05, 1); // full speed from the splash view outwards; west = surface moves east
      this.camera.position.applyAxisAngle(Y_AXIS, a);
      this.camera.lookAt(0, 0, 0);
      this.stars.rotateY(a);
    }
    if (this.starPoints) (this.starPoints.material as THREE.ShaderMaterial).uniforms.uTime.value = now / 1000; // slow twinkle
    if (!this.anim && this.controls.enabled) this.controls.update();
    // keep the selection ring a constant size on screen
    if (this.marker.visible) this.marker.scale.setScalar(this.camera.position.distanceTo(this.marker.position) * 0.32);
    // lit by the real Sun (it turns with the sky during the idle spin, so the day side stays where the Sun is)
    this.stars.updateMatrixWorld();
    this.sunObj.getWorldPosition(this.material.uniforms.uLight.value).normalize();
    this.atmoMat.uniforms.uLight.value.copy(this.material.uniforms.uLight.value);
    this.renderer.render(this.scene, this.camera);
  }
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** The Sun as seen from Mars: a white-hot disc at its true apparent size (~0.35 deg) plus a soft additive glow. */
export function makeSun(angDiamDeg: number, dist = 55) {
  const tex = (stops: [number, string][]) => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d")!, gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const r = dist * Math.tan(THREE.MathUtils.degToRad(angDiamDeg / 2));       // disc radius at the sky distance
  const disc = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex([[0, "#ffffff"], [0.42, "#fffaf0"], [0.5, "rgba(255,244,224,0.9)"], [0.56, "rgba(255,230,200,0)"]]),
    depthWrite: false, transparent: true, fog: false }));
  disc.scale.setScalar(4 * r);                     // the disc fills the inner half of the sprite: diameter 2r
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex([[0, "rgba(255,236,205,0.55)"], [0.12, "rgba(255,214,170,0.22)"], [0.4, "rgba(255,190,140,0.06)"], [1, "rgba(255,180,120,0)"]]),
    depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, fog: false }));
  glow.scale.setScalar(r * 2 * 14);
  const g = new THREE.Group();
  g.name = "sun";
  g.add(glow, disc);
  return g;
}

/** Bright Star Catalogue (BSC5, NASA HEASARC) baked by pipeline/global/bake_stars.py into Mars's equatorial frame
 *  (z = Mars north pole). Here the sky is turned by the IAU prime-meridian angle W(t) for the current date, so the
 *  planet faces the right stars, then mapped to the globe frame (x = lon 0, y = north, -z = lon 90E).
 *  Each star: size / brightness from its V magnitude, colour from B-V, and its own slow shimmer (10-40 s). */
async function loadStars(): Promise<THREE.Points> {
  const [meta, buf] = await Promise.all([
    fetch("/global/stars.json" + BUST).then((r) => r.json()),
    fetch("/global/stars.f32" + BUST).then((r) => { if (!r.ok) throw new Error(`stars.f32 ${r.status}`); return r.arrayBuffer(); }),
  ]);
  const f = new Float32Array(buf), n = f.length / 5;
  const days = (Date.now() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000;           // since J2000 (UTC ~ TT here)
  const W = THREE.MathUtils.degToRad((meta.prime_meridian.W0_deg + meta.prime_meridian.Wdot_deg_per_day * days) % 360);
  const cw = Math.cos(W), sw = Math.sin(W), R = 60;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n);
  const phase = new Float32Array(n), freq = new Float32Array(n);
  const rng = mulberry32(11);
  for (let i = 0; i < n; i++) {
    const x = f[i * 5], y = f[i * 5 + 1], z = f[i * 5 + 2], m = f[i * 5 + 3], bv = f[i * 5 + 4];
    const xb = cw * x + sw * y, yb = -sw * x + cw * y;                               // inertial -> Mars body-fixed
    pos.set([xb * R, z * R, -yb * R], i * 3);                                       // body -> globe frame
    size[i] = THREE.MathUtils.clamp(7.6 - 0.75 * m, 2.6, 9.0);                       // px; Sirius ~9, V 6.5 ~2.7
    alpha[i] = THREE.MathUtils.clamp(0.55 + (6.5 - m) * 0.11, 0.5, 1.0);
    const [r, g, b] = bvToRgb(bv);
    col.set([r, g, b], i * 3);
    phase[i] = rng() * Math.PI * 2;
    freq[i] = (2 * Math.PI) / (10 + rng() * 30);                                     // one swell every 10-40 s
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  geo.setAttribute("aFreq", new THREE.BufferAttribute(freq, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPx: { value: Math.min(2, window.devicePixelRatio || 1) } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aAlpha; attribute float aPhase; attribute float aFreq; attribute vec3 color;
      uniform float uTime; uniform float uPx;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float tw = 0.5 + 0.5 * sin(uTime * aFreq + aPhase);      // 0..1, slow
        vAlpha = aAlpha * (0.5 + 0.5 * tw);                       // shine stronger and weaker
        vColor = color;
        gl_PointSize = aSize * uPx * (0.85 + 0.25 * tw);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float a = vAlpha * pow(clamp(1.12 - d, 0.0, 1.0), 1.4);    // bright core, soft edge (visible even at 2-3 px)
        gl_FragColor = vec4(vColor, a);   // AdditiveBlending already scales by alpha (pre-multiplying here made it alpha^2)
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.userData = { source: meta.catalogue, count: n, W_deg: THREE.MathUtils.radToDeg(W) };
  return pts;
}

/** Star colour from B-V: Ballesteros (2012) temperature, Planckian-locus RGB, kept gentle (mixed toward white). */
function bvToRgb(bv: number): [number, number, number] {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = t / 100;
  let r: number, g: number, b: number;
  if (k <= 66) { r = 255; g = 99.47 * Math.log(k) - 161.12; b = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04; }
  else { r = 329.7 * Math.pow(k - 60, -0.1332); g = 288.12 * Math.pow(k - 60, -0.0755); b = 255; }
  const c = (v: number) => THREE.MathUtils.clamp(v, 0, 255) / 255;
  const mix = 0.55;                                                                   // 0 = white, 1 = full colour
  return [1 - mix + mix * c(r), 1 - mix + mix * c(g), 1 - mix + mix * c(b)];
}

function makeStarfield() {
  const n = 22000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const rng = mulberry32(7);
  for (let i = 0; i < n; i++) {
    const u = rng() * 2 - 1, th = rng() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([60 * s * Math.cos(th), 60 * u, 60 * s * Math.sin(th)], i * 3);
    const b = 0.35 + 0.65 * Math.pow(rng(), 3), tint = rng();
    col.set([b * (0.85 + 0.15 * tint), b * 0.9, b * (1.05 - 0.2 * tint)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
}

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
