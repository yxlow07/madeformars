import * as THREE from "three";
import type { HeightField } from "./terrain";

const MARS_G = 3.71;   // m/s^2
const EYE = 1.7;       // m
const WALK = 2.5;      // m/s (brisker than a suited pace so the 1 km site is explorable)
const RUN = 8.0;       // m/s with Shift
const JUMP_V = 2.2;    // m/s -> ~0.65 m hop in Mars gravity
const TAP_S = 0.12;    // a quick key tap still moves you for this long

const FWD = ["KeyW", "ArrowUp"], BACK = ["KeyS", "ArrowDown"], LEFT = ["KeyA", "ArrowLeft"], RIGHT = ["KeyD", "ArrowRight"];
const MOVE_KEYS = new Set([...FWD, ...BACK, ...LEFT, ...RIGHT, "Space"]);

/** First-person walk: WASD / arrows to move, drag to look, Space to jump, Shift to run. */
export class WalkControls {
  enabled = false;
  private yaw = 0;
  private pitch = 0;
  private vy = 0;
  private feet = 0;
  private keys = new Set<string>();
  /** Remaining move time per key, so taps shorter than a frame still register. */
  private taps = new Map<string, number>();
  private dragging = false;
  private camera: THREE.PerspectiveCamera;
  private hf: HeightField;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, hf: HeightField) {
    this.camera = camera;
    this.hf = hf;
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      if (MOVE_KEYS.has(e.code)) e.preventDefault(); // no page scroll / no re-clicking a focused button
      this.keys.add(e.code);
      if (!e.repeat) this.taps.set(e.code, TAP_S);
      if (e.code === "Space" && this.onGround()) this.vy = JUMP_V;
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    dom.addEventListener("pointerdown", (e) => { if (this.enabled && e.button === 0) this.dragging = true; });
    window.addEventListener("pointerup", () => (this.dragging = false));
    window.addEventListener("pointermove", (e) => {
      if (!this.enabled || !this.dragging) return;
      this.yaw -= e.movementX * 0.0035;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0035, -1.45, 1.45);
    });
  }

  /** Start walking at (x, z) (default: under the camera), looking at lookAt (default: same heading). */
  enter(x?: number, z?: number, lookAt?: THREE.Vector3) {
    const p = this.camera.position;
    const px = x ?? p.x, pz = z ?? p.z;
    this.feet = this.hf.sample(px, pz);
    this.camera.position.set(px, this.feet + EYE, pz);
    const dir = new THREE.Vector3();
    if (lookAt) dir.subVectors(lookAt, this.camera.position);
    else this.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = lookAt ? Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) : 0;
    this.vy = 0;
    this.keys.clear();
    this.taps.clear();
    this.enabled = true;
  }

  private onGround() {
    return this.feet <= this.hf.sample(this.camera.position.x, this.camera.position.z) + 0.02;
  }

  private active(codes: string[]) {
    return codes.some((c) => this.keys.has(c) || (this.taps.get(c) ?? 0) > 0);
  }

  update(dt: number) {
    if (!this.enabled) return;
    dt = Math.min(dt, 0.1);
    const speed = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? RUN : WALK;
    const f = (this.active(FWD) ? 1 : 0) - (this.active(BACK) ? 1 : 0);
    const s = (this.active(RIGHT) ? 1 : 0) - (this.active(LEFT) ? 1 : 0);
    for (const [k, v] of this.taps) this.taps.set(k, v - dt);
    const p = this.camera.position;
    if (f || s) {
      const l = Math.hypot(f, s);
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const nx = p.x + ((fx * f - fz * s) / l) * speed * dt;
      const nz = p.z + ((fz * f + fx * s) / l) * speed * dt;
      if (this.hf.inside(nx, nz)) { p.x = nx; p.z = nz; }
    }
    const ground = this.hf.sample(p.x, p.z);
    this.vy -= MARS_G * dt;
    this.feet += this.vy * dt;
    if (this.feet <= ground) { this.feet = ground; this.vy = 0; }
    p.y = this.feet + EYE;
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }
}
