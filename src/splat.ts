import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

export interface SplatTransform {
  scale: number;
  rotation_matrix: number[][];
  quaternion_xyzw: number[];
  translation: number[];
  splat_file: string;
  stop_local: number[];
  description?: string;
}

// "always": PRD behaviour — fade in within ~60 m of the stop.
const FADE_FULL = 45;
const FADE_OUT = 60;
// "auto": the splat comes from one mast position, so it only looks right from near there at
// ground level. Full inside 12 m horizontally and below 5 m above ground; gone by 25 m / 12 m.
const AUTO_R = [12, 25];
const AUTO_H = [5, 12];

export type SplatMode = "auto" | "always" | "off";

/** Loads the stop splat (if the pipeline produced one) and manages fade + debug gizmo. */
export class StopSplat {
  mesh: SplatMesh | null = null;
  transform: SplatTransform | null = null;
  fade = 0;
  mode: SplatMode = "auto";
  private gizmo: TransformControls | null = null;
  private gizmoHelper: THREE.Object3D | null = null;
  private spark: THREE.Object3D | null = null;

  /** Free the splat (switching site). */
  dispose() {
    if (this.mesh) { this.scene.remove(this.mesh); (this.mesh as any).dispose?.(); this.mesh = null; }
    if (this.spark) { this.scene.remove(this.spark); (this.spark as any).dispose?.(); this.spark = null; }
    this.gizmo?.detach();
  }

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer,
              private camera: THREE.PerspectiveCamera, private stop: THREE.Vector3,
              private groundAt: (x: number, z: number) => number) {}

  async load(base = ""): Promise<boolean> {
    const r = await fetch(base + "splat_transform.json");
    if (!r.ok) return false;
    this.transform = (await r.json()) as SplatTransform;
    const spark = new SparkRenderer({ renderer: this.renderer });
    this.spark = spark;
    this.scene.add(spark);
    const mesh = new SplatMesh({ url: base + this.transform.splat_file });
    this.applyTransform(mesh, this.transform);
    this.scene.add(mesh);
    await mesh.initialized;
    this.mesh = mesh;
    return true;
  }

  private applyTransform(mesh: THREE.Object3D, t: SplatTransform) {
    const [qx, qy, qz, qw] = t.quaternion_xyzw;
    mesh.quaternion.set(qx, qy, qz, qw);
    mesh.position.fromArray(t.translation);
    mesh.scale.setScalar(t.scale);
  }

  get numSplats(): number {
    const m = this.mesh as any;
    return m?.packedSplats?.numSplats ?? m?.numSplats ?? 0;
  }

  /** Fade by camera position relative to the stop (see mode); returns the fade factor 0..1. */
  update(): number {
    if (!this.mesh) return 0;
    const c = this.camera.position;
    const ramp = (v: number, full: number, out: number) => THREE.MathUtils.clamp((out - v) / (out - full), 0, 1);
    let f = 0;
    if (this.mode === "always") {
      f = ramp(c.distanceTo(this.stop), FADE_FULL, FADE_OUT);
    } else if (this.mode === "auto") {
      const dh = Math.hypot(c.x - this.stop.x, c.z - this.stop.z);
      const h = c.y - this.groundAt(c.x, c.z);
      f = ramp(dh, AUTO_R[0], AUTO_R[1]) * ramp(h, AUTO_H[0], AUTO_H[1]);
    }
    this.fade = this.gizmo?.enabled ? 1 : f * f * (3 - 2 * f);
    this.mesh.opacity = this.fade;
    this.mesh.visible = this.fade > 0.01;
    return this.fade;
  }

  /** Debug gizmo to nudge the splat by hand (T = move, R = rotate). */
  setGizmo(on: boolean, orbit: { enabled: boolean }) {
    if (!this.mesh) return;
    if (on && !this.gizmo) {
      this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
      this.gizmo.attach(this.mesh);
      this.gizmo.setSize(0.8);
      this.gizmo.addEventListener("dragging-changed", (e: any) => { orbit.enabled = !e.value; });
      this.gizmoHelper = this.gizmo.getHelper();
      this.scene.add(this.gizmoHelper);
      window.addEventListener("keydown", this.onKey);
    }
    if (this.gizmo) {
      this.gizmo.enabled = on;
      if (this.gizmoHelper) this.gizmoHelper.visible = on;
    }
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.gizmo?.enabled) return;
    if (e.key === "t") this.gizmo.setMode("translate");
    if (e.key === "r") this.gizmo.setMode("rotate");
  };

  /** Download the (possibly hand-corrected) transform as splat_transform.json. */
  saveTransform() {
    if (!this.mesh || !this.transform) return;
    const m = new THREE.Matrix4().makeRotationFromQuaternion(this.mesh.quaternion);
    const e = m.elements; // column-major
    const out: SplatTransform = {
      ...this.transform,
      scale: this.mesh.scale.x,
      rotation_matrix: [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]],
      quaternion_xyzw: [this.mesh.quaternion.x, this.mesh.quaternion.y, this.mesh.quaternion.z, this.mesh.quaternion.w],
      translation: this.mesh.position.toArray(),
      description: (this.transform.description ?? "") + " | hand-adjusted in viewer",
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = "splat_transform.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
