import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadAll, type Data } from "./data";
import { HeightField, buildTerrain } from "./terrain";
import { WalkControls } from "./walk";
import { PlannerUI } from "./planner/ui";
import { StopSplat } from "./splat";

const MARS_R = 3396190;
const SKY = new THREE.Color(0xc9a27e);

async function start() {
  const loading = document.getElementById("loading")!;
  let data: Data;
  try {
    data = await loadAll();
  } catch (e) {
    loading.classList.add("err");
    loading.textContent = String(e);
    throw e;
  }
  const { meta } = data;
  const hf = new HeightField(meta, data.height);
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById("app")!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = SKY;
  scene.fog = new THREE.Fog(SKY, 700, 2600);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 6000);
  const stop = new THREE.Vector3(meta.stop.x, hf.sample(meta.stop.x, meta.stop.z), meta.stop.z);
  camera.position.set(stop.x - 380, stop.y + 420, stop.z + 560);

  // Textures: ortho in sRGB-ish greyscale; layer PNGs are data colours, sampled nearest so bins stay crisp.
  const loader = new THREE.TextureLoader();
  const [ortho, slope, hazard] = await Promise.all(["ortho.jpg", "slope.png", "hazard.png"].map((u) => loader.loadAsync(u)));
  ortho.colorSpace = THREE.SRGBColorSpace;
  ortho.anisotropy = renderer.capabilities.getMaxAnisotropy();
  ortho.generateMipmaps = true;
  for (const t of [slope, hazard]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  const terrain = buildTerrain(hf, { ortho, slope, hazard });
  scene.add(terrain.group);

  // Rover traverse + waypoints + stop marker (context only).
  const travGroup = new THREE.Group();
  const travMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: true });
  for (const line of data.traverse.lines) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < line.length - 1; k++) {
      const [x0, z0] = line[k], [x1, z1] = line[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
      for (let s = 0; s < n; s++) {
        const x = x0 + ((x1 - x0) * s) / n, z = z0 + ((z1 - z0) * s) / n;
        if (hf.inside(x, z)) pts.push(new THREE.Vector3(x, hf.sample(x, z) + 0.4, z));
      }
    }
    if (pts.length > 1) travGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), travMat));
  }
  // Waypoints as fixed-size screen dots so they never block the close-up view.
  const wpPts = data.traverse.waypoints.filter((w) => hf.inside(w.x, w.z))
    .map((w) => new THREE.Vector3(w.x, hf.sample(w.x, w.z) + 0.3, w.z));
  travGroup.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(wpPts),
    new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false })));
  scene.add(travGroup);
  const stopMarker = new THREE.Mesh(new THREE.ConeGeometry(2.2, 6, 16), new THREE.MeshBasicMaterial({ color: 0x3fd0ff }));
  stopMarker.rotation.x = Math.PI;
  stopMarker.position.copy(stop).add(new THREE.Vector3(0, 6, 0));
  scene.add(stopMarker);

  // Controls.
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.copy(stop);
  orbit.enableDamping = true;
  orbit.maxPolarAngle = Math.PI * 0.495;
  orbit.minDistance = 3;
  orbit.maxDistance = 2500;
  orbit.zoomToCursor = true; // wheel zooms towards what is under the cursor
  orbit.zoomSpeed = 2;
  orbit.update();
  const walk = new WalkControls(camera, renderer.domElement, hf);
  const planner = new PlannerUI(scene, camera, renderer.domElement, hf, data, stop, orbit, () => walk.enabled);

  // Rover-stop splat (optional: the viewer works without it).
  const splat = new StopSplat(scene, renderer, camera, stop, (x, z) => (hf.inside(x, z) ? hf.sample(x, z) : 0));
  document.querySelectorAll<HTMLInputElement>("input[name=splat-mode]").forEach((r) =>
    r.addEventListener("change", () => { splat.mode = r.value as typeof splat.mode; r.blur(); }));
  const SINK_M = 0.3;
  let sinkOn = true;
  splat.load().then((ok) => {
    const sec = $("splat-section");
    sec.hidden = false;
    $("splat-status").textContent = ok
      ? `${splat.numSplats.toLocaleString()} splats · ${splat.transform!.splat_file}`
      : "No splat_transform.json in data/processed — run python tasks.py splat.";
    if (!ok) { ($("splat-gizmo") as HTMLButtonElement).disabled = true; return; }
    let gizmoOn = false;
    $("splat-gizmo").addEventListener("click", () => {
      gizmoOn = !gizmoOn;
      $("splat-gizmo").classList.toggle("on", gizmoOn);
      ($("splat-save") as HTMLButtonElement).disabled = !gizmoOn;
      splat.setGizmo(gizmoOn, orbit);
    });
    $("splat-save").addEventListener("click", () => splat.saveTransform());
  }).catch((e) => {
    $("splat-section").hidden = false;
    $("splat-status").textContent = `Splat failed to load: ${e}`;
    console.error(e);
  });
  $<HTMLInputElement>("splat-sink").addEventListener("change", (e) => (sinkOn = (e.target as HTMLInputElement).checked));

  // Keep the orbit camera above ground.
  orbit.addEventListener("change", () => {
    const g = hf.inside(camera.position.x, camera.position.z) ? hf.sample(camera.position.x, camera.position.z) : -1e9;
    if (camera.position.y < g + 1.5) camera.position.y = g + 1.5;
  });

  // UI wiring.
  const legends: Record<string, [string, string][]> = {
    "0": [],
    "1": [["#142a5a", "0°"], ["#1e78c8", "9°"], ["#50c8a0", "18°"], ["#f0d23c", "26°"], ["#c81e1e", "≥ 35°"]],
    "2": [["#2ea043", "0–8° easy"], ["#e6c828", "8–15° moderate"], ["#eb781e", "15–25° hard"], ["#d21e1e", "> 25° or rough: no-go"]],
  };
  const setLegend = (v: string) => {
    $("legend").innerHTML = legends[v].map(([c, t]) => `<i style="background:${c}"></i><span>${t}</span>`).join("");
  };
  document.querySelectorAll<HTMLInputElement>("input[name=layer]").forEach((r) =>
    r.addEventListener("change", () => { terrain.material.uniforms.uLayer.value = Number(r.value); setLegend(r.value); }));
  $<HTMLInputElement>("opacity").addEventListener("input", (e) => {
    terrain.material.uniforms.uOpacity.value = Number((e.target as HTMLInputElement).value);
  });
  $<HTMLInputElement>("traverse").addEventListener("change", (e) => (travGroup.visible = (e.target as HTMLInputElement).checked));

  const setMode = (m: "orbit" | "walk") => {
    $("mode-orbit").classList.toggle("on", m === "orbit");
    $("mode-walk").classList.toggle("on", m === "walk");
    $("cam-hint").textContent = m === "orbit"
      ? "Drag to orbit · right-drag to pan · wheel to zoom"
      : "WASD / arrows move (2.5 m/s, Shift 8 m/s) · drag to look · Space jump (3.71 m/s²)";
    if (m === "walk") {
      orbit.enabled = false;
      // Start a few metres from the orbit target, on the camera's side, facing it.
      const t = orbit.target.clone();
      const away = new THREE.Vector3(camera.position.x - t.x, 0, camera.position.z - t.z);
      if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
      away.setLength(8);
      walk.enter(t.x + away.x, t.z + away.z, new THREE.Vector3(t.x, t.y + 1.0, t.z));
    } else {
      walk.enabled = false;
      orbit.enabled = true;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      orbit.target.copy(camera.position).addScaledVector(dir, 25);
      orbit.target.y = hf.sample(orbit.target.x, orbit.target.z);
      camera.position.y += 15;
      orbit.update();
    }
  };
  // Blur buttons after clicking so Space/keys go to walking, not to re-clicking the focused button.
  $("mode-orbit").addEventListener("click", (e) => { (e.currentTarget as HTMLElement).blur(); setMode("orbit"); });
  $("mode-walk").addEventListener("click", (e) => { (e.currentTarget as HTMLElement).blur(); flight = null; setMode("walk"); });

  let flight: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;
  $("fly-stop").addEventListener("click", (e) => {
    (e.currentTarget as HTMLElement).blur();
    if (walk.enabled) setMode("orbit");
    const to = new THREE.Vector3(stop.x + 5, 0, stop.z + 8);
    to.y = hf.sample(to.x, to.z) + 3; // low and close: where the splat looks right
    flight = { from: camera.position.clone(), to, tFrom: orbit.target.clone(), tTo: stop.clone(), t: 0 };
  });

  $("stop-info").innerHTML = `<h2>Rover stop</h2>
    <table class="kv">
      <tr><td>Site / drive</td><td>${meta.stop.site} / ${meta.stop.drive}</td></tr>
      <tr><td>Lon, lat</td><td>${meta.stop.lon.toFixed(5)}°E, ${meta.stop.lat.toFixed(5)}°N</td></tr>
      <tr><td>Elevation</td><td>${meta.origin_elev_m.toFixed(1)} m</td></tr>
      <tr><td>AOI</td><td>${((meta.width - 1) * meta.res_x_m).toFixed(0)} × ${((meta.height - 1) * meta.res_z_m).toFixed(0)} m</td></tr>
      <tr><td>Relief</td><td>${(meta.max_height_m - meta.min_height_m).toFixed(1)} m</td></tr>
    </table>`;

  // Debug overlay (` key).
  const dbg = $("debug");
  window.addEventListener("keydown", (e) => { if (e.key === "`") dbg.hidden = !dbg.hidden; });
  let frames = 0, fpsT = performance.now(), fps = 0;

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  (window as any).marswalk = { scene, camera, renderer, hf, data, terrain, orbit, walk, setMode, planner, splat, THREE,
    get fps() { return fps; } };

  const clock = new THREE.Clock();
  loading.remove();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / 2.2);
      const s = flight.t * flight.t * (3 - 2 * flight.t);
      camera.position.lerpVectors(flight.from, flight.to, s);
      orbit.target.lerpVectors(flight.tFrom, flight.tTo, s);
      if (flight.t >= 1) flight = null;
    }
    if (walk.enabled) walk.update(dt);
    else orbit.update();
    stopMarker.visible = camera.position.distanceTo(stop) > 40;
    const fade = splat.update();
    terrain.material.uniforms.uSink.value = sinkOn ? SINK_M * fade : 0;
    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - fpsT > 500) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
      if (!dbg.hidden) {
        const p = camera.position;
        const lat = meta.origin_lat - (p.z / MARS_R) * (180 / Math.PI);
        const lon = meta.origin_lon + (p.x / (MARS_R * meta.kx_cos_lat)) * (180 / Math.PI);
        const info = renderer.info.render;
        dbg.textContent =
          `fps        ${fps.toFixed(0)}\n` +
          `triangles  ${info.triangles.toLocaleString()}\n` +
          `draw calls ${info.calls}\n` +
          `splats     ${splat.mesh ? `${splat.numSplats.toLocaleString()} (fade ${splat.fade.toFixed(2)})` : "not loaded"}\n` +
          `cam local  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)} m\n` +
          `cam lonlat ${lon.toFixed(6)}°E ${lat.toFixed(6)}°N\n` +
          `ground     ${hf.inside(p.x, p.z) ? (p.y - hf.sample(p.x, p.z)).toFixed(1) + " m below cam" : "outside AOI"}`;
      }
    }
  });
}

start();
