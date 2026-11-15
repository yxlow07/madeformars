// Sim mode (PRD Screen 4): walk view with a helmet HUD and minimap, vitals in the right rail,
// incidents with live re-planning (worker), point-of-no-return warning, failure -> debrief.
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { FrameScene, PoisData } from "../frame/frame";
import { labelSprite } from "../frame/frame";
import type { RouteResult, Limits } from "../frame/route";
import { SimEngine, fmt, distToPolyline, type Pt, type SimConfig, type SimWorld, type Tick, type SimEvent, type Outcome } from "./engine";
import { DefaultBody } from "./body";
import { keyHtml, SYM } from "../legend";
import { dangerAt, type LocalTerrain } from "./danger";
import { SITE_BASE } from "../site";
import { siteSignal } from "../site";
import { fmtLtst } from "../sun";
import { loadAnimated, placeRover, besideAway, setModelEnvironment, contactShadow } from "../models";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface SimContext {
  res: RouteResult;
  stops: { name: string; x: number; z: number; type?: string; description?: string; image?: { file: string; credit?: string }; fact?: { text: string; source: string } }[];
  homeTime: Float32Array;
  terrainAt?(x: number, z: number): LocalTerrain;
  stopIds?: string[];
  layers?: { options(): string; current(): string; select(key: string): Promise<void>; legend(): string };
  slopeBins?: number[];
  limits: Limits;
  worker: Worker;
  cellOf(x: number, z: number): number;
}

export interface RunLog {
  id: string; site: string; created: string; model: string;
  config: { sim: SimConfig; limits: Limits };
  plan: { smooth: Pt[]; stops: { name: string; x: number; z: number }[]; lambda: number; distance_m?: number; time_s?: number };
  shelters: SimWorld["shelters"];
  outcome: Outcome; events: SimEvent[]; routes: { v: number; t: number; why: string; pts: Pt[] }[]; log: Tick[];
}

type Shelter = SimWorld["shelters"][number];

const PROCEDURES: Record<string, string[]> = {
  spe: ["Stop the traverse and note the time.", "Walk the highlighted route to the nearest shelter.", "Stay inside until the event is over.", "Report dose to the habitat."],
  leak: ["Switch to the backup O₂ supply.", "Abort the traverse: walk the highlighted route home.", "Keep the pace steady to save O₂.", "Do not stop at science targets."],
};

export class SimUI {
  private frame: FrameScene;
  private cfg: SimConfig;
  private shelters: Shelter[];
  private pois: PoisData;
  private eng: SimEngine | null = null;
  private ctx: SimContext | null = null;
  private speed = 10;
  private view: "third" | "first" = "third";
  private acc = 0;
  private prevX = NaN; private prevZ = NaN;
  private smY = NaN; private smHead = 0; private camClear = NaN;
  private stride = 0; private lastX = 0; private lastZ = 0;
  private uiT = 0;
  private yawOff = 0; private pitch = 0.32; private camDist = 14;
  private keys = new Set<string>();
  private reqId = 0;
  private pending = new Map<number, (m: any) => void>();
  private routes: RunLog["routes"] = [];
  private evShown = 0;
  private reachedSeen = 0;
  private arrivedNames = new Set<string>();
  private resuming = false;      // stops reached so far (arrival pause triggers on a new one)
  private avHead = 0;           // avatar facing: turns quicker than the camera's smoothed heading
  private incident: { kind: "spe" | "leak"; text: string; steps: string[]; replan?: string; bad?: boolean; waiting: boolean } | null = null;
  private saved = false;
  lastRun: RunLog | null = null;

  // scene objects
  private group = new THREE.Group();
  private avatar: THREE.Group;
  private shelterLine: Line2 | null = null;
  private trail: THREE.Line;
  private trailPos = new Float32Array(3 * 20000);
  private trailN = 0;

  // minimap
  private mm!: HTMLCanvasElement;
  private mmBase = document.createElement("canvas");
  private ortho = new Image();

  private dom!: { hud: HTMLDivElement; bar: HTMLDivElement; right: HTMLElement; event: HTMLDivElement; end: HTMLDivElement };

  private walkSpeed: number;

  constructor(frame: FrameScene, cfg: SimConfig, shelterCfg: { id: string; name: string; poi: string }[], pois: PoisData, walkSpeed: number) {
    this.frame = frame; this.cfg = cfg; this.pois = pois; this.walkSpeed = walkSpeed;
    const hab = pois.habitat;
    this.shelters = [{ id: "habitat", name: "Habitat", x: hab.x, z: hab.z }];
    for (const s of shelterCfg) {
      const p = pois.pois.find((q) => q.id === s.poi);
      if (p) this.shelters.push({ id: s.id, name: s.name, x: p.x, z: p.z });
    }
    this.avatar = makeAvatar();
    this.group.add(this.avatar);
    this.loadAstronaut();
    for (const s of this.shelters.slice(1)) {
      const sp = labelSprite("R", "#5ef2c2", "#0e0f13", "#ece6dc", 26);
      sp.position.set(s.x, frame.hf.sample(s.x, s.z) + 0.5, s.z);
      this.group.add(sp);
      this.roverSprites.push(sp);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
    tg.setDrawRange(0, 0);
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0x5ef2c2, transparent: true, opacity: 0.9 }));
    this.trail.frustumCulled = false;
    this.group.add(this.trail);
    this.group.visible = false;
    frame.scene.add(this.group);
    this.ortho.src = SITE_BASE + "ortho.jpg";
    this.createDom();
    this.bind();
    window.addEventListener("resize", () => this.shelterLine && (this.shelterLine.material as LineMaterial).resolution.set(innerWidth, innerHeight), { signal: siteSignal() });
  }

  private roverSprites: THREE.Sprite[] = [];
  private roverModel: Promise<unknown> | null = null;

  // walking astronaut (rigged model with a walk cycle): legs keep pace with the on-screen speed, then settle to a stand
  private walk: { mixer: THREE.AnimationMixer; action: THREE.AnimationAction; mps: number; idleT: number } | null = null;
  private visSpeed = 0;

  /** Swap the placeholder walker for the rigged astronaut (Astronaut_MarsWalk.glb: skeleton + MarsWalk clips). */
  private async loadAstronaut() {
    try {
      setModelEnvironment(this.frame.renderer, this.frame.scene);
      const { model, mixer, clips, root } = await loadAnimated("/models/astronaut_marswalk.glb", 1.85, Math.PI);
      const inPlace = clips.get("MarsWalk_InPlace") ?? [...clips.values()][0];
      const fwd = clips.get("MarsWalk_Forward");
      // stride speed of the cycle (m/s at timeScale 1): how far the Forward clip carries the root bone per loop
      let mps = 1.0;
      const rootBone = (() => { let b: THREE.Object3D | null = null; root.traverse((o) => { if (!b && (o as THREE.Bone).isBone) b = o; }); return b as THREE.Object3D | null; })();
      if (fwd && rootBone) {
        const a = mixer.clipAction(fwd).play();
        const at = (t: number) => { mixer.setTime(t); model.updateMatrixWorld(true); return rootBone.getWorldPosition(new THREE.Vector3()); };
        const p0 = at(0), p1 = at(fwd.duration - 1e-3);
        const d = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        if (d > 0.2) mps = d / fwd.duration;
        a.stop();
      }
      // standing pose = the frame of the in-place cycle where the feet are closest together
      const action = mixer.clipAction(inPlace).play();
      // (three.js strips dots from glTF node names: "foot.L" -> "footL")
      const bone = (n: string) => root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
      const footL = bone("foot.L"), footR = bone("foot.R");
      let idleT = 0;
      if (footL && footR) {
        let best = Infinity;
        for (let i = 0; i < 48; i++) {
          const t = (i / 48) * inPlace.duration;
          mixer.setTime(t); model.updateMatrixWorld(true);
          const d = footL.getWorldPosition(new THREE.Vector3()).distanceTo(footR.getWorldPosition(new THREE.Vector3()));
          if (d < best) { best = d; idleT = t; }
        }
      }
      action.time = idleT; action.paused = true; mixer.update(0);
      this.walk = { mixer, action, mps, idleT };
      const body = this.avatar.children[0] as THREE.Group;
      body.clear();
      body.position.y = 0;
      model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.renderOrder = 2; }); // drawn over the ground ring / pointer
      body.add(model);
      this.avatar.children[1].visible = false; // placeholder legs
      this.avatar.add(contactShadow(0.7, 0.6));
    } catch (e) { console.warn("astronaut model:", e); }
  }

  /** Walk cycle: leg speed follows the walker's on-screen speed (any sim speed, capped so 60x is not a blur);
   *  when it stops, the cycle runs on to the standing frame and holds there. */
  private animateWalk(dt: number, moved: number) {
    const w = this.walk;
    if (!w || dt <= 0) return;
    this.visSpeed += (moved / dt - this.visSpeed) * (1 - Math.exp(-dt / 0.15));
    const a = w.action;
    if (this.visSpeed > 0.08) {
      a.paused = false;
      a.timeScale = Math.min(3.5, Math.max(0.35, this.visSpeed / w.mps));
    } else if (!a.paused) {
      // run on at normal pace and stop exactly on the standing frame (detect this frame's step crossing it, wrap included)
      a.timeScale = 1;
      const t0 = a.time;
      w.mixer.update(dt);
      const t1 = a.time, idle = w.idleT;
      const crossed = t1 >= t0 ? t0 <= idle && idle <= t1 : idle >= t0 || idle <= t1;
      if (crossed) { a.time = idle; a.paused = true; w.mixer.update(0); }
      return;
    }
    w.mixer.update(dt);
  }

  /** NASA Space Exploration Vehicle at the pressurised-rover shelter (22 MB: loaded the first time Sim opens). */
  private loadRover() {
    if (this.roverModel) return;
    const s = this.shelters.find((q) => q.id !== "habitat");
    if (!s) return;
    this.roverModel = placeRover(this.frame, besideAway(s, [this.pois.habitat], 4.5)).then((m: any) => {
      for (const sp of this.roverSprites) sp.position.y += m.userData.size.y + 0.6;
    }).catch((e) => console.warn("rover model:", e));
  }

  get running() { return !!this.eng; }
  get engine() { return this.eng; }

  // ------------------------------------------------------------------ lifecycle
  private listening = false;
  start(ctx: SimContext) {
    this.ctx = ctx;
    this.loadRover();
    if (!this.listening) { ctx.worker.addEventListener("message", (ev) => this.onWorkerMessage(ev.data)); this.listening = true; }
    const hab = this.pois.habitat;
    const meta = this.frame.meta;
    const x0 = meta.extent_x_m[0], z0 = meta.extent_z_m[0];
    const world: SimWorld = {
      height: (x, z) => this.frame.hf.sample(x, z),
      inside: (x, z) => this.frame.hf.inside(x, z),
      homeTime: (x, z) => {
        const j = Math.round((x - x0) / meta.res_x_m), i = Math.round((z - z0) / meta.res_z_m);
        return i < 0 || j < 0 || i >= meta.height || j >= meta.width ? Infinity : ctx.homeTime[i * meta.width + j];
      },
      walkSpeedMps: this.walkSpeed,
      suitHours: ctx.limits.suitHours, reserveMin: ctx.limits.reserveMin,
      doseRateMsvH: ctx.limits.doseRateMsvH, shelters: this.shelters,
    };
    const e = new SimEngine(this.cfg, world, new DefaultBody(this.cfg as any), [hab.x, hab.z]);
    e.setRoute(ctx.res.smooth as Pt[], ctx.stops, "plan", `planned walk, ${ctx.stops.length} stop${ctx.stops.length === 1 ? "" : "s"} (λ ${ctx.res.lambda})`);
    this.eng = e;
    this.routes = [{ v: 1, t: 0, why: "planned walk", pts: ctx.res.smooth as Pt[] }];
    this.acc = 0; this.evShown = 0; this.reachedSeen = 0; this.arrivedNames = new Set(); this.incident = null; this.saved = false; this.lastRun = null; this.trailN = 0;
    this.yawOff = 0; this.pitch = 0.32; this.camDist = 14;
    this.frame.setSky(true); this.frame.setSunTime(this.frame.sunStartMs);
    this.prevX = this.prevZ = this.smY = this.camClear = NaN; this.lastX = hab.x; this.lastZ = hab.z;
    (document.activeElement as HTMLElement | null)?.blur?.(); // focus left on a Frame input would swallow WASD
    this.clearShelterLine();
    this.drawMinimapBase();
    this.group.visible = true;
    this.dom.hud.hidden = false; this.dom.bar.hidden = false; this.dom.right.hidden = false; this.dom.event.hidden = false;
    this.dom.end.hidden = true;
    $("addlayers").style.display = "none";
    $("stats").style.display = "none";
    $("event-text").hidden = true;
    $("coords").hidden = true;
    $("danger-marker").hidden = false;
    $("danger-note").hidden = false;
    this.frame.controls.enabled = false;
    this.frame.traverseGroup.visible = false; // only the user's own plan on screen
    this.frame.showOnlyPins(ctx.stopIds ?? []); // hide the suggested locations that are not part of this walk
    if (ctx.layers) {
      const sel = $<HTMLSelectElement>("sim-layer");
      sel.innerHTML = ctx.layers.options();
      sel.value = ctx.layers.current();
      this.showLayerLegend();
    }
    this.setMode("auto");
    this.setSpeed(this.speed);
    this.setPaused(false);
    this.renderEvent();
    this.updateUi();
  }

  /** Remove this site's walk UI (switching site in-page). */
  dispose() {
    this.stop();
    for (const el of [this.dom.hud, this.dom.bar, this.dom.right, this.dom.event, this.dom.end]) el.remove();
  }

  stop() {
    this.eng = null;
    this.frame.setSky(false); this.frame.setSunTime(this.frame.sunStartMs);
    this.group.visible = false;
    this.clearShelterLine();
    for (const k of ["hud", "bar", "right", "event", "end"] as const) this.dom[k].hidden = true;
    $("addlayers").style.display = "";
    $("stats").style.display = "";
    $("event-text").hidden = false;
    $("coords").hidden = false;
    $("danger-marker").hidden = true;
    $("danger-note").hidden = true;
    $("sim-arrive").hidden = true;
    this.keys.clear();
  }

  /** Called every animation frame while in SIM mode. */
  update(realDt: number) {
    const e = this.eng;
    if (!e) return;
    const dtR = Math.min(0.25, realDt);
    const sub = this.cfg.substep_s ?? 0.1;
    if (e.mode === "explore" && !e.outcome) {
      e.input.forward = (this.keys.has("w") || this.keys.has("arrowup") ? 1 : 0) - (this.keys.has("s") || this.keys.has("arrowdown") ? 0.6 : 0);
      // turning follows real time, not sim time: A/D steer the same at 1x and at 60x
      const turn = (this.keys.has("d") || this.keys.has("arrowright") ? 1 : 0) - (this.keys.has("a") || this.keys.has("arrowleft") ? 1 : 0);
      e.input.turn = 0;
      e.heading += turn * 1.8 * dtR;
    }
    if (!e.outcome && !e.paused) {
      this.acc += dtR * this.speed;
      let n = 0;
      while (this.acc >= sub && n < 4000 && !e.outcome && !e.paused) {
        this.prevX = e.x; this.prevZ = e.z;
        e.step(sub); this.acc -= sub; n++;
        this.pushTrail(e.x, e.z);
        if (e.resumeRequest && !this.resuming) this.resumeWalk();
        const reached = e.stops.filter((s) => s.reached).length;
        if (reached > this.reachedSeen) {
          this.reachedSeen = reached;
          const fresh = e.stops.findIndex((s) => s.reached && !this.arrivedNames.has(s.name));
          for (const s of e.stops) if (s.reached) this.arrivedNames.add(s.name);
          // auto-walk pauses at every stop until the user continues (explore mode: the user is steering, no pause)
          if (fresh >= 0 && e.mode === "auto" && e.routeGoal === "plan" && !e.outcome) {
            const info = this.ctx?.stops.find((s) => s.name === e.stops[fresh].name) ?? e.stops[fresh];
            this.arrive(info, fresh + 1, e.stops.length);
            break;
          }
        }
      }
      if (e.outcome) this.finish();
    } else {
      this.prevX = e.x; this.prevZ = e.z; this.acc = 0;
    }
    this.placeAvatar(dtR);
    this.uiT += realDt;
    if (this.uiT > 0.1) { this.uiT = 0; this.updateUi(); }
  }

  // ------------------------------------------------------------------ incidents and re-planning
  /** Inject an incident. The sim clock keeps running (the alert countdown, O2 and dose all advance): the walker
   *  is re-planned to the best shelter at once (PRD: plan from the current position to every shelter, draw the best
   *  one with its margin). Auto-walk follows it immediately; in explore mode the user keeps control and can hand over.
   *  Both incidents can be active together. */
  private inject(kind: "spe" | "leak") {
    const e = this.eng;
    if (!e || e.outcome) return;
    if (kind === "spe") { if (e.incidents.spe) return; e.injectSPE("injected"); }
    else { if (e.incidents.leak) return; e.injectLeak(); }
    const text = kind === "spe"
      ? `Solar particle event — dose rate ×${this.cfg.spe.multiplier} for ${this.cfg.spe.duration_min} min. Reach shelter within ${this.cfg.spe.alert_min} min.`
      : `Suit leak — O₂ drain ×${this.cfg.leak.o2_multiplier}. Abort to the habitat.`;
    if (this.incident) {        // second incident on top of the first: list both, merge the procedures
      this.incident.text += "\n" + text;
      for (const st of PROCEDURES[kind]) if (!this.incident.steps.includes(st)) this.incident.steps.push(st);
      this.incident.kind += "+" + kind;
      this.incident.waiting = true;
    } else {
      this.incident = { kind, text, steps: [...PROCEDURES[kind]], waiting: true };
    }
    // an emergency overrides a stop's arrival pause; the clock must never be frozen by an incident
    $("sim-arrive").hidden = true;
    if (e.paused) this.setPaused(false);
    if (e.inShelter() && e.incidents.spe && !e.incidents.leak) {
      e.hold = true;
      this.incident.replan = `Already at a shelter: holding here for ${this.cfg.spe.duration_min} min until the event is over, then the walk resumes. Use 60× to skip ahead.`;
      this.incident.waiting = false;
      this.renderEvent();
      return;
    }
    e.hold = false; // e.g. holding at the rover for a solar event, then a leak: the walker must move again
    this.replanToShelter();
  }

  /** Fastest route from here to a shelter: any shelter while a solar event is on (the rover counts), else home. */
  private replanToShelter() {
    const e = this.eng!;
    const inc = this.incident!;
    const spe = !!e.incidents.spe, leak = !!e.incidents.leak;
    const targets = spe ? this.shelters : this.shelters.filter((s) => s.id === "habitat");
    this.renderEvent();
    const t0 = performance.now();
    this.request({ type: "shelter", from: this.ctx!.cellOf(e.x, e.z), targets: targets.map((s) => this.ctx!.cellOf(s.x, s.z)) }, (m) => {
      if (this.eng !== e || this.incident !== inc || e.outcome) return;
      const ms = performance.now() - t0;
      const ok = (m.routes as any[]).map((r, i) => ({ ...r, s: targets[i] })).filter((r) => r.ok).sort((a, b) => a.time_s - b.time_s);
      if (!ok.length) {
        inc.replan = `No walkable route to any shelter (re-planned in ${ms.toFixed(0)} ms). Cannot reach shelter`;
        inc.bad = true; inc.waiting = false;
        this.renderEvent();
        return;
      }
      const best = ok[0];
      const speLeft = spe ? e.incidents.spe!.deadline - e.t : Infinity;
      const marginSpe = speLeft - best.time_s;
      const marginO2 = e.o2TimeLeftS() - best.time_s;                     // O2 at the current (leak) drain vs the walk
      const margin = Math.min(marginSpe, leak ? marginO2 : Infinity);
      const why = `${spe && leak ? "solar event + suit leak" : spe ? "SPE" : "suit leak"}: fastest route to ${best.s.name} (${fmt(best.time_s)})`;
      e.setRoute(best.smooth as Pt[], [], "shelter", why, best.s.id);
      this.routes.push({ v: e.routeVersion, t: e.t, why, pts: best.smooth });
      const others = ok.slice(1).map((r) => `${r.s.name} ${fmt(r.time_s)}`).join(", ");
      inc.bad = margin < 0;
      inc.replan = `${best.s.name}: ${fmt(best.time_s)} walk, ${(best.distance_m).toFixed(0)} m. ` +
        (spe ? `Alert time left ${fmt(speLeft)}, margin ${fmt(marginSpe)}. ` : "") +
        (leak ? `O₂ left at ×${this.cfg.leak.o2_multiplier} drain: ${fmt(e.o2TimeLeftS())}, margin ${fmt(marginO2)}. ` : "") +
        (margin < 0 ? "Cannot reach shelter in time. " : "") +
        (others ? `Others: ${others}. ` : "") + `Re-planned in ${ms.toFixed(0)} ms.`;
      inc.waiting = false;
      this.drawShelterLine(best.smooth, margin < 0);
      this.renderEvent();
      this.drawMinimapBase();
    });
  }

  /** The solar event is over: plan the way from the shelter back to where the walk was interrupted, then carry on. */
  private resumeWalk() {
    const e = this.eng!;
    const target = e.resumeRequest!.target;
    this.resuming = true;
    this.request({ type: "shelter", from: this.ctx!.cellOf(e.x, e.z), targets: [this.ctx!.cellOf(target[0], target[1])] }, (m) => {
      this.resuming = false;
      if (this.eng !== e || e.outcome) return;
      const leg = m.routes[0];
      e.resumeVia(leg.ok ? (leg.smooth as Pt[]) : null);
      this.routes.push({ v: e.routeVersion, t: e.t, why: "back to the planned walk", pts: e.route });
      this.clearShelterLine();
      this.drawMinimapBase();
    });
  }

  /** Back to auto-walk after free walking: plan a leg from here to the nearest point of the active route. */
  private rejoin() {
    const e = this.eng!;
    const r = e.route;
    if (!r.length) return;
    let bi = 0, bd = Infinity;
    r.forEach(([x, z], i) => { const d = Math.hypot(x - e.x, z - e.z); if (d < bd) { bd = d; bi = i; } });
    if (bd < this.cfg.arrive_m) { e.setRoute(r.slice(bi), null, e.routeGoal, "rejoined the route", e.shelterTarget); e.mode = "auto"; return; }
    e.paused = true;
    this.request({ type: "shelter", from: this.ctx!.cellOf(e.x, e.z), targets: [this.ctx!.cellOf(r[bi][0], r[bi][1])] }, (m) => {
      if (this.eng !== e) return;
      const leg = m.routes[0];
      const pts: Pt[] = leg.ok ? [...(leg.smooth as Pt[]), ...r.slice(bi + 1)] : r.slice(bi);
      e.setRoute(pts, null, e.routeGoal, `rejoin the route (${fmt(leg.time_s ?? 0)} leg)`, e.shelterTarget);
      this.routes.push({ v: e.routeVersion, t: e.t, why: "rejoin", pts });
      e.mode = "auto";
      this.setPaused(false);
      this.drawMinimapBase();
    });
  }

  private request(msg: any, cb: (m: any) => void) {
    const id = 1e6 + ++this.reqId;
    this.pending.set(id, cb);
    this.ctx!.worker.postMessage({ ...msg, id });
  }

  /** The Frame worker answers "shelter" messages; FrameUI ignores them, we pick ours by id. */
  onWorkerMessage(m: any) {
    if (m?.type !== "shelter") return;
    const cb = this.pending.get(m.id);
    if (cb) { this.pending.delete(m.id); cb(m); }
  }

  // ------------------------------------------------------------------ end of run
  private finish() {
    const e = this.eng!;
    if (this.saved) return;
    this.saved = true;
    const ctx = this.ctx!;
    const created = new Date().toISOString();
    this.lastRun = {
      id: created.replace(/[:.]/g, "-"), site: this.pois.site, created,
      model: "simplified suit/body model (Pandolf at 0.38 g); radiation = model",
      config: { sim: this.cfg, limits: ctx.limits },
      plan: { smooth: ctx.res.smooth as Pt[], stops: ctx.stops, lambda: ctx.res.lambda, distance_m: ctx.res.stats?.distance_m, time_s: ctx.res.stats?.time_s },
      shelters: this.shelters, outcome: e.outcome, events: e.events, routes: this.routes, log: e.log,
    };
    (window as any).marswalk.lastRun = this.lastRun;
    const fail = e.outcome!.result === "failure";
    const end = this.dom.end;
    end.className = fail ? "fail" : "ok";
    end.innerHTML = `<div class="sim-end-title">${fail ? "Mission failure — crew lost" : "Walk complete"}</div>
      <p>${esc(e.outcome!.cause)}</p>
      <p class="sim-end-save" id="sim-save">Saving run log…</p>
      <button id="sim-debrief" class="fr-btn go">Debrief</button>`;
    end.hidden = false;
    $("sim-debrief").addEventListener("click", () => { location.hash = "#debrief"; });
    fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.lastRun) })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => { $("sim-save").textContent = `Run saved: runs/${j.file}`; })
      .catch(() => { $("sim-save").textContent = "Run kept in memory (no /api/runs on this server)."; });
    this.updateUi();
  }

  // ------------------------------------------------------------------ controls
  private setSpeed(s: number) {
    this.speed = s;
    this.dom.bar.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === s));
  }
  private setPaused(p: boolean) {
    if (this.eng) this.eng.paused = p;
    $("sim-play").textContent = p ? "Play" : "Pause";
    if (!p) $("sim-arrive").hidden = true;
  }

  /** Arrival at a stop: pause the walk and show the stop with a CONTINUE button. */
  private arrive(s: SimContext["stops"][number], k: number, n: number) {
    this.setPaused(true);
    this.acc = 0;
    const el = $("sim-arrive");
    el.innerHTML = `${s.image ? `<div class="sa-img"><img src="${SITE_BASE}${esc(s.image.file)}" alt="" onerror="this.parentElement.remove()" />${s.image.credit ? `<span class="sa-credit">${esc(s.image.credit)}</span>` : ""}</div>` : ""}
      <div class="sa-top"><span class="badge">Stop ${k} of ${n}</span><span class="sa-t num">T+${fmt(this.eng!.t)}</span></div>
      <div class="sa-name">Arrived · ${esc(s.name)}</div>
      ${s.type ? `<div class="sa-type">${esc(s.type)}</div>` : ""}
      ${s.description ? `<p class="sa-desc">${esc(s.description)}</p>` : ""}
      ${s.fact ? `<a class="sa-fact" href="${esc(s.fact.source)}" target="_blank" rel="noopener">${esc(s.fact.text)}</a>` : ""}
      <button id="sim-continue" class="fr-btn go">${k < n ? "Continue walk" : "Head home"}</button>`;
    el.hidden = false;
    $("sim-continue").addEventListener("click", () => this.setPaused(false));
  }
  private setMode(m: "auto" | "explore") {
    const e = this.eng;
    if (!e) return;
    if (m === "auto" && e.mode === "explore") this.rejoin();
    else e.mode = m;
    if (m === "explore") { e.input.forward = 0; e.input.turn = 0; if (e.paused && !e.outcome) this.setPaused(false); }
    this.dom.bar.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
    $("sim-keys").hidden = m !== "explore";
    $("sim-play").hidden = m === "explore"; // explore has no play / pause; it returns with auto-walk
    if (this.incident) this.renderEvent();
  }

  /** Legend of the chosen overlay, under the minimap. */
  private showLayerLegend() {
    const el = $("sim-layer-legend"), html = this.ctx?.layers?.legend() ?? "";
    el.innerHTML = html;
    el.hidden = !html;
  }

  private bind() {
    const bar = this.dom.bar;
    $<HTMLSelectElement>("sim-layer").addEventListener("change", async (ev) => {
      const sel = ev.target as HTMLSelectElement;
      sel.blur(); // keep WASD / Space for the walk
      await this.ctx?.layers?.select(sel.value);
      this.showLayerLegend();
    });
    // drop focus after a BUTTON click (so Space cannot re-press it); never for the LAYER dropdown, which closes on blur
    bar.addEventListener("click", (ev) => { if ((ev.target as HTMLElement).closest("button")) (document.activeElement as HTMLElement | null)?.blur?.(); });
    bar.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => b.addEventListener("click", () => this.setSpeed(Number(b.dataset.speed))));
    bar.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => this.setMode(b.dataset.mode as any)));
    $("sim-play").addEventListener("click", () => { const e = this.eng; if (e && !e.outcome) this.setPaused(!e.paused); });
    $("sim-view").addEventListener("click", () => { this.view = this.view === "third" ? "first" : "third"; $("sim-view").textContent = this.view === "third" ? "View: 3rd" : "View: 1st"; });
    $("sim-spe").addEventListener("click", () => this.inject("spe"));
    $("sim-leak").addEventListener("click", () => this.inject("leak"));
    $("sim-abort").addEventListener("click", () => { location.hash = "#frame"; });

    window.addEventListener("keydown", (ev) => {
      if (!this.eng) return;
      const tg = ev.target as HTMLInputElement;
      // only a visible text box keeps the keys (the search field); sliders, buttons, hidden inputs do not
      if ((tg?.tagName === "INPUT" && /^(text|search|number)$/.test(tg.type) && tg.offsetParent) || tg?.tagName === "TEXTAREA" || tg?.tagName === "SELECT") return;
      const k = ev.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        this.keys.add(k);
        if (this.eng.mode === "auto" && !this.eng.outcome && ["w", "a", "s", "d"].includes(k)) this.setMode("explore"); // WASD takes over
        ev.preventDefault();
      } else if ((k === " " || k === "enter") && !$("sim-arrive").hidden) { ev.preventDefault(); $("sim-continue").click(); }
      else if (k === " ") { ev.preventDefault(); if (this.eng.mode === "auto") $("sim-play").click(); }
      else if (k === "v") $("sim-view").click();
    }, { signal: siteSignal() });
    window.addEventListener("keyup", (ev) => this.keys.delete(ev.key.toLowerCase()), { signal: siteSignal() });
    window.addEventListener("blur", () => this.keys.clear(), { signal: siteSignal() });

    // drag to orbit the camera around the walker, wheel to zoom (3rd person)
    const cv = this.frame.dom;
    let drag: { x: number; y: number } | null = null;
    cv.addEventListener("pointerdown", (ev) => { if (this.eng) drag = { x: ev.clientX, y: ev.clientY }; }, { signal: siteSignal() });
    window.addEventListener("pointerup", () => (drag = null), { signal: siteSignal() });
    window.addEventListener("pointermove", (ev) => {
      if (!drag || !this.eng) return;
      this.yawOff -= (ev.clientX - drag.x) * 0.006;
      this.pitch = Math.max(-0.3, Math.min(1.35, this.pitch + (ev.clientY - drag.y) * 0.005));
      drag = { x: ev.clientX, y: ev.clientY };
    }, { signal: siteSignal() });
    cv.addEventListener("wheel", (ev) => { if (this.eng) this.camDist = Math.max(4, Math.min(220, this.camDist * Math.exp(ev.deltaY * 0.001))); }, { passive: true, signal: siteSignal() });
  }

  // ------------------------------------------------------------------ scene
  private placeAvatar(dt: number) {
    const e = this.eng!;
    // draw between the last two sim sub-steps so motion is continuous at any speed
    const a = Math.max(0, Math.min(1, this.acc / (this.cfg.substep_s ?? 0.1)));
    const x = Number.isFinite(this.prevX) ? this.prevX + (e.x - this.prevX) * a : e.x;
    const z = Number.isFinite(this.prevZ) ? this.prevZ + (e.z - this.prevZ) * a : e.z;
    const y = this.frame.hf.sample(x, z);
    // the route is a chain of ~1 m segments and the DTM has 1 m texture: low-pass the heading and the
    // camera height so the view does not twitch with every vertex and bump
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    if (!Number.isFinite(this.smY)) { this.smY = y; this.smHead = e.heading; this.avHead = e.heading; }
    this.smY += (y - this.smY) * k(0.35);
    let dh = e.heading - this.smHead;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.smHead += dh * k(e.mode === "explore" ? 0.08 : 0.6);
    let da = e.heading - this.avHead;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.avHead += da * k(e.mode === "explore" ? 0.04 : 0.12); // the body turns ~5x quicker than the camera follows
    this.avatar.position.set(x, y, z);
    this.avatar.rotation.y = -this.avHead;
    const moved = Number.isFinite(this.lastX) ? Math.hypot(x - this.lastX, z - this.lastZ) : 0;
    this.lastX = x; this.lastZ = z;
    if (this.walk) this.animateWalk(dt, moved > 5 ? 0 : moved); // (a jump, e.g. a new walk, is not a stride)
    else { // placeholder: gentle stride bob tied to the distance walked, none when standing
      this.stride += moved;
      this.avatar.children[0].position.y = 0.9 + (e.speed > 0.05 ? Math.sin(this.stride * Math.PI / 0.75) ** 2 * 0.025 : 0);
    }
    const cam = this.frame.camera;
    const h = this.smHead + this.yawOff;
    const dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    if (this.view === "first") {
      this.avatar.visible = false;
      const eye = new THREE.Vector3(x, this.smY + 1.7, z);
      cam.position.copy(eye);
      // first person: dragging down looks up (grab-the-view, like the orbit camera); same drag value, opposite sign
      cam.lookAt(eye.clone().add(dir.clone().multiplyScalar(10)).add(new THREE.Vector3(0, -10 * Math.tan(0.32 - this.pitch + 0.05), 0)));
    } else {
      this.avatar.visible = true;
      const target = new THREE.Vector3(x, this.smY + 1.4, z);
      const want = target.clone().addScaledVector(dir, -this.camDist * Math.cos(this.pitch)).add(new THREE.Vector3(0, this.camDist * Math.sin(this.pitch) + 1, 0));
      const g = this.frame.hf.inside(want.x, want.z) ? this.frame.hf.sample(want.x, want.z) + 1.5 : -1e9;
      if (want.y < g) want.y = g;
      // follow rigidly in the horizontal (no rubber-band lag), smooth only the ground clearance
      this.camClear = Number.isFinite(this.camClear) ? this.camClear + (want.y - this.camClear) * k(0.3) : want.y;
      cam.position.set(want.x, Math.max(this.camClear, g), want.z);
      cam.lookAt(target);
    }
  }

  private pushTrail(x: number, z: number) {
    const n = this.trailN;
    if (n > 0) {
      const px = this.trailPos[3 * (n - 1)], pz = this.trailPos[3 * (n - 1) + 2];
      if (Math.hypot(px - x, pz - z) < 1.5) return;
    }
    if (n >= this.trailPos.length / 3) return;
    this.trailPos.set([x, this.frame.hf.sample(x, z) + 0.25, z], 3 * n);
    this.trailN++;
    const g = this.trail.geometry;
    g.setDrawRange(0, this.trailN);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private drawShelterLine(pts: Pt[], bad: boolean) {
    this.clearShelterLine();
    const pos: number[] = [];
    for (const [x, z] of pts) pos.push(x, this.frame.hf.sample(x, z) + 0.6, z);
    if (pos.length < 6) return;
    const geo = new LineGeometry();
    geo.setPositions(pos);
    const mat = new LineMaterial({ color: bad ? 0xff4f26 : 0xf7b257, linewidth: 6, worldUnits: false, dashed: false, depthTest: false, transparent: true });
    mat.resolution.set(innerWidth, innerHeight);
    this.shelterLine = new Line2(geo, mat);
    this.shelterLine.renderOrder = 9;
    this.group.add(this.shelterLine);
  }
  private clearShelterLine() {
    if (!this.shelterLine) return;
    this.group.remove(this.shelterLine);
    this.shelterLine.geometry.dispose();
    (this.shelterLine.material as LineMaterial).dispose();
    this.shelterLine = null;
  }

  // ------------------------------------------------------------------ minimap
  private toMM(x: number, z: number, W: number) {
    const m = this.frame.meta;
    return [((x - m.extent_x_m[0]) / (m.extent_x_m[1] - m.extent_x_m[0])) * W, ((z - m.extent_z_m[0]) / (m.extent_z_m[1] - m.extent_z_m[0])) * W];
  }
  private drawMinimapBase() {
    const W = 360, c = this.mmBase;
    c.width = c.height = W;
    const g = c.getContext("2d")!;
    g.fillStyle = "#15161b"; g.fillRect(0, 0, W, W);
    const paint = () => {
      if (this.ortho.complete && this.ortho.naturalWidth) g.drawImage(this.ortho, 0, 0, W, W);
      const e = this.eng;
      if (!e || !this.ctx) return;
      const line = (pts: Pt[], col: string, w: number) => {
        g.strokeStyle = col; g.lineWidth = w; g.beginPath();
        pts.forEach(([x, z], i) => { const [u, v] = this.toMM(x, z, W); i ? g.lineTo(u, v) : g.moveTo(u, v); });
        g.stroke();
      };
      line(this.ctx.res.smooth as Pt[], "#0e0f13", 5);
      line(this.ctx.res.smooth as Pt[], "#ece6dc", 2.5);
      if (e.routeGoal === "shelter") line(e.route, this.incident?.bad ? "#ff4f26" : "#f7b257", 3.5);
      for (const s of this.ctx.stops) { const [u, v] = this.toMM(s.x, s.z, W); g.fillStyle = "#f7b257"; g.fillRect(u - 4, v - 4, 8, 8); }
      for (const s of this.shelters) {
        const [u, v] = this.toMM(s.x, s.z, W);
        g.fillStyle = "#5ef2c2"; g.fillRect(u - 6, v - 6, 12, 12);
        g.fillStyle = "#0e0f13"; g.font = "bold 10px monospace"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(s.id === "habitat" ? "H" : "R", u, v + 1);
      }
    };
    if (this.ortho.complete) paint(); else this.ortho.onload = () => { paint(); };
  }
  private drawMinimap() {
    const e = this.eng!;
    const c = this.mm, W = c.width;
    const g = c.getContext("2d")!;
    g.drawImage(this.mmBase, 0, 0, W, W);
    const s = W / 360;
    g.strokeStyle = "#5ef2c2"; g.lineWidth = 2 * s; g.beginPath();
    for (let i = 0; i < this.trailN; i++) {
      const [u, v] = this.toMM(this.trailPos[3 * i], this.trailPos[3 * i + 2], W);
      i ? g.lineTo(u, v) : g.moveTo(u, v);
    }
    g.stroke();
    // walker marker: sized in display pixels (canvas is 2x), brand orange on the greyscale ortho,
    // white + black double outline, dark halo, view cone and a slow pulse; red and faster past the point of no return
    const [u, v] = this.toMM(e.x, e.z, W);
    const px = W / 200;
    const col = e.pnr ? "#ff4f26" : "#ea681d";
    const now = performance.now() / 1000;
    const pulse = (now * (e.pnr ? 1.6 : 0.7)) % 1;
    g.save(); g.translate(u, v);
    g.strokeStyle = col; g.globalAlpha = 0.9 * (1 - pulse); g.lineWidth = 2.5 * px;
    g.beginPath(); g.arc(0, 0, (9 + 16 * pulse) * px, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.55; g.fillStyle = "#0e0f13";
    g.beginPath(); g.arc(0, 0, 11 * px, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.rotate(e.heading);
    const cone = g.createLinearGradient(0, 0, 0, -34 * px);
    cone.addColorStop(0, "rgba(243, 233, 220, 0.55)"); cone.addColorStop(1, "rgba(243, 233, 220, 0)");
    g.fillStyle = cone;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 34 * px, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45); g.closePath(); g.fill();
    const arrow = () => { g.beginPath(); g.moveTo(0, -11 * px); g.lineTo(8 * px, 8 * px); g.lineTo(0, 4 * px); g.lineTo(-8 * px, 8 * px); g.closePath(); };
    g.lineJoin = "round";
    arrow(); g.strokeStyle = "#0e0f13"; g.lineWidth = 5 * px; g.stroke();
    arrow(); g.strokeStyle = "#ffffff"; g.lineWidth = 2.2 * px; g.stroke();
    arrow(); g.fillStyle = col; g.fill();
    g.restore();
  }

  // ------------------------------------------------------------------ DOM
  private createDom() {
    const hud = document.createElement("div");
    hud.id = "sim-hud"; hud.hidden = true;
    hud.innerHTML = `
      <i class="hb tl"></i><i class="hb tr"></i><i class="hb bl"></i><i class="hb br"></i>
      <div id="sim-top"><span id="sim-clock" class="num">T+0:00</span><span id="sim-state"></span></div>
      <div id="sim-compass"><div id="sim-compass-strip"></div><i></i></div>
      <div id="sim-mm-wrap"><canvas id="sim-mm" width="400" height="400"></canvas>
        <div id="sim-layer-legend" hidden></div>
        <div id="sim-mm-key">${keyHtml("Minimap", [
          { sym: SYM.arrow(), label: "You (red past the point of no return)" },
          { sym: SYM.line("#ece6dc", 2.5), label: "Planned route" },
          { sym: SYM.line("#5ef2c2", 2), label: "Walked trail" },
          { sym: SYM.line("#f7b257", 3), label: "Route to shelter (red: cannot reach)" },
          { sym: SYM.square("#5ef2c2", "H"), label: "Shelter: habitat (H), rover (R)" },
          { sym: SYM.square("#f7b257"), label: "Stop" },
        ])}</div></div>
      <div id="sim-banner" hidden></div>
      <div id="sim-next"></div>
      <ul id="sim-log"></ul>
      <div id="sim-keys" hidden>W/S walk · A/D turn · drag to look · V view</div>
      <div id="sim-arrive" hidden></div>
      <div id="sim-end" hidden></div>`;
    $("centre").appendChild(hud);
    this.mm = $("sim-mm") as HTMLCanvasElement;

    const bar = document.createElement("div");
    bar.id = "sim-bar"; bar.hidden = true;
    bar.innerHTML = `
      <button id="sim-play" class="fr-btn">Pause</button>
      <span class="grp"><button class="fr-btn" data-speed="1">1×</button><button class="fr-btn" data-speed="10">10×</button><button class="fr-btn" data-speed="60">60×</button></span>
      <span class="grp"><button class="fr-btn" data-mode="auto">Auto-walk</button><button class="fr-btn" data-mode="explore">Explore</button></span>
      <button id="sim-view" class="fr-btn">View: 3rd</button>
      <span class="grp sim-lyr"><span class="lbl">Layer</span><select id="sim-layer" class="ft-select" title="Terrain overlay (same layers as the map)"></select></span>
      <span class="grp inj"><span class="lbl">Inject</span><button id="sim-spe" class="fr-btn">Solar event</button><button id="sim-leak" class="fr-btn">Suit leak</button></span>
      <button id="sim-abort" class="fr-btn">Plan</button>`;
    $("centre").appendChild(bar);

    const right = document.createElement("section");
    right.id = "sim-vitals"; right.className = "dashed"; right.hidden = true;
    const row = (id: string, k: string, src: string) => `<div class="stat"><span class="k">${k}</span><span class="v num model" id="${id}" data-src="${src}">[--]</span></div>`;
    right.innerHTML = `<div class="label">Vitals</div>
      ${row("sv-o2", "O₂", "Suit O₂ sized for the planned suit hours at the reference metabolic rate; drawn down by the body model")}
      <div class="sv-bar"><i id="sv-o2-bar"></i></div>
      ${row("sv-co2", "CO₂ scrubber", "Scrubber loading from metabolic CO₂ (RQ 0.85)")}
      ${row("sv-hr", "Work rate", "Metabolic work rate from the Pandolf load-carriage equation scaled to Mars gravity (0.38 g): body + suit load, walking speed and grade. It sets the O2 use.")}
      ${row("sv-temp", "Suit temp", "Simplified suit thermal model, 3 min lag")}
      ${row("sv-batt", "Battery", "Linear drain over the configured battery hours")}
      ${row("sv-dose", "Dose", "Curiosity RAD-calibrated GCR model scaled by elevation; solar events multiply it")}
      ${row("sv-ret", "Return / margin", "Fastest walk home from here (Dijkstra field) vs O₂ time left minus reserve")}`;
    $("right").insertBefore(right, $("danger"));

    const ev = document.createElement("div");
    ev.id = "sim-event"; ev.hidden = true;
    $("event").appendChild(ev);

    this.dom = { hud, bar, right, event: ev, end: $<HTMLDivElement>("sim-end") };
  }

  private renderEvent() {
    const el = this.dom.event, inc = this.incident;
    if (!inc) {
      el.innerHTML = `<p class="se-quiet">No incidents. Inject a solar event or a suit leak to test the plan.</p>`;
      return;
    }
    el.innerHTML = `${inc.text.split("\n").map((t) => `<p class="se-title">${esc(t)}</p>`).join("")}
      <ol class="se-steps">${inc.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <p class="se-replan ${inc.bad ? "bad" : ""}">${inc.waiting ? "Re-planning from the current position…" : esc(inc.replan ?? "")}</p>
      ${this.eng?.hold && !this.eng.outcome ? `<p class="se-status">Sheltering until the event is over; the walk then resumes. Use 60× to skip ahead.</p>` : ""}
      ${inc.waiting || !this.eng || this.eng.outcome || this.eng.hold ? "" : this.eng.mode === "auto"
        ? `<p class="se-status">Auto-walk is following the shelter route. The alert clock is running.</p>`
        : `<p class="se-status">Explore mode: walk the highlighted route yourself, or hand over.</p><button id="se-go" class="fr-btn go">Auto-walk to shelter</button>`}`;
    el.querySelector("#se-go")?.addEventListener("click", () => { if (this.eng) { this.setMode("auto"); this.renderEvent(); } });
  }

  private updateUi() {
    const e = this.eng;
    if (!e) return;
    const pct = (100 * e.o2) / e.o2Cap;
    const o2Left = e.o2TimeLeftS();
    $("sv-o2").textContent = `${e.o2.toFixed(0)} L · ${pct.toFixed(0)}% · ${fmt(o2Left)} left`;
    const bar = $("sv-o2-bar");
    bar.style.width = `${pct}%`;
    bar.style.background = pct < 25 ? "var(--risk)" : pct < 50 ? "var(--amber)" : "var(--mint)";
    $("sv-co2").textContent = `${e.co2Pct.toFixed(1)}%`;
    $("sv-hr").textContent = `${e.met.toFixed(0)} W`; // heart rate removed: the simple HR formula was not physiology
    $("sv-temp").textContent = `${e.suitC.toFixed(1)} °C · core ${e.core.toFixed(1)} °C`;
    $("sv-batt").textContent = `${e.battPct.toFixed(0)}%`;
    $("sv-dose").textContent = `${e.dose.toFixed(3)} mSv · ${(e.doseRate() * 1000).toFixed(e.doseRate() > 1 ? 0 : 1)} µSv/h`;
    const ret = $("sv-ret");
    ret.textContent = `${fmt(e.returnS)} / ${fmt(e.marginS)}`;
    ret.classList.toggle("bad", e.marginS < 0);

    // danger bar: the ground under the astronaut (slope / no-go), raised by incidents and the point of no return
    const terr = this.ctx?.terrainAt ? this.ctx.terrainAt(e.x, e.z) : { slope: 0, maxSlope: 0, nogo: false };
    const dg = dangerAt(terr, { spe: !!e.incidents.spe, sheltered: e.inShelter(), leak: !!e.incidents.leak, pnr: e.pnr }, this.ctx?.slopeBins);
    $("danger-marker").style.left = `calc(${(dg.value * 100).toFixed(1)}% - 1px)`;
    $("danger-note").textContent = dg.label;
    $("danger-note").className = `danger-note num lv-${dg.level.toLowerCase()}`;

    $("sim-clock").textContent = `T+${fmt(e.t)}`;
    const state = e.outcome ? (e.outcome.result === "failure" ? "failed" : "complete") : e.paused ? "paused" : e.hold ? "sheltering" : e.mode === "auto" ? "auto-walk" : "explore";
    this.frame.setSunTime(this.frame.sunStartMs + e.t * 1000); // the Sun moves with the walk clock
    const sn = this.frame.sunNow;
    $("sim-state").textContent = `×${this.speed} · ${state} · route v${e.routeVersion} · ${e.speed.toFixed(2)} m/s · LTST ${fmtLtst(sn.ltst)} · sun ${sn.elev.toFixed(0)}°`;
    this.drawCompass(e.heading);

    // next target
    let next = "";
    const nxt = e.stops.find((s) => !s.reached);
    if (e.routeGoal === "shelter") {
      const sh = this.shelters.find((s) => s.id === e.shelterTarget);
      if (sh) next = `To shelter: ${sh.name} · ${Math.hypot(sh.x - e.x, sh.z - e.z).toFixed(0)} m`;
    } else if (nxt) next = `Next: ${nxt.name} · ${Math.hypot(nxt.x - e.x, nxt.z - e.z).toFixed(0)} m`;
    else next = `Return: habitat · ${Math.hypot(this.shelters[0].x - e.x, this.shelters[0].z - e.z).toFixed(0)} m`;
    if (e.mode === "explore" && e.route.length) next += ` · ${distToPolyline(e.x, e.z, e.route).toFixed(0)} m off route`;
    $("sim-next").textContent = next;

    // banner: point of no return is red and shows the time left
    const ban = $("sim-banner");
    if (e.outcome) ban.hidden = true;
    else if (e.pnr) {
      ban.className = "pnr"; ban.hidden = false;
      ban.textContent = `Point of no return — walk home ${fmt(e.returnS)} > O₂ above reserve ${fmt(o2Left - e.world.reserveMin * 60)} · O₂ left ${fmt(o2Left)}`;
    } else if (e.incidents.spe) {
      const s = e.incidents.spe, left = s.deadline - e.t;
      ban.className = "inc"; ban.hidden = false;
      ban.textContent = e.inShelter() ? `Solar event — sheltered, ${fmt(s.until - e.t)} until it is over` : left > 0 ? `Solar event — reach shelter in ${fmt(left)}` : `SOLAR EVENT — alert time passed, dose ×${this.cfg.spe.multiplier} outside shelter`;
    } else if (e.incidents.leak) {
      ban.className = "inc"; ban.hidden = false;
      ban.textContent = `Suit leak — O₂ ${fmt(o2Left)} left at ×${this.cfg.leak.o2_multiplier} drain`;
    } else ban.hidden = true;

    // event log (latest 4)
    if (e.events.length !== this.evShown) {
      this.evShown = e.events.length;
      // incident over (and the walk resumed after sheltering): clear the panel and the shelter route
      if (this.incident && !e.incidents.spe && !e.incidents.leak) { this.incident = null; this.clearShelterLine(); this.drawMinimapBase(); }
      this.renderEvent();
      $("sim-log").innerHTML = e.events.slice(-4).map((v) => `<li class="${v.severity}"><span class="num">T+${fmt(v.t)}</span> ${esc(v.text)}</li>`).join("");
    }
    this.drawMinimap();
  }

  private drawCompass(heading: number) {
    // heading 0 = north (−z), clockwise
    const deg = ((heading * 180) / Math.PI + 360) % 360;
    const names: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    let html = "";
    for (let d = -90; d <= 90; d += 15) {
      const a = (Math.round((deg + d) / 15) * 15 + 360) % 360;
      const off = ((a - deg + 540) % 360) - 180;
      html += `<span style="left:${50 + (off / 180) * 100}%">${names[a] ?? "·"}</span>`;
    }
    $("sim-compass-strip").innerHTML = html + `<b class="num">${deg.toFixed(0).padStart(3, "0")}°</b>`;
  }
}

function makeAvatar() {
  const g = new THREE.Group();
  const body = new THREE.Group();
  // emissive so the suit reads as white under the dim Mars-dusk lighting of the Frame scene
  const suit = new THREE.MeshLambertMaterial({ color: 0xe9e3d6, emissive: 0x8a8378 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x56475c, emissive: 0x2a2230 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.55, 4, 10), suit);
  torso.position.y = 0.25;
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.28), dark);
  pack.position.set(0, 0.35, 0.3);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), suit);
  helmet.position.y = 0.86;
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12, -Math.PI / 2 - 0.9, 1.8, 0.9, 1.0), new THREE.MeshBasicMaterial({ color: 0xf7b257 }));
  visor.position.set(0, 0.86, -0.06);
  body.add(torso, pack, helmet, visor);
  body.position.y = 0.9;
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.7, 10), suit);
  legs.position.y = 0.38;
  // ring + facing pointer: opaque ground decals drawn after the terrain without depth test (slopes never clip them),
  // and BEFORE the astronaut (renderOrder 2), whose body then covers them only where it really overlaps
  const groundMat = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 32), groundMat(0x4fd9ad));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; ring.renderOrder = 1;
  // facing pointer: a triangle on the ring, pointing where the astronaut walks (local -z = forward)
  const tri = new THREE.Shape();
  tri.moveTo(0, 1.9); tri.lineTo(0.45, 1.0); tri.lineTo(-0.45, 1.0); tri.closePath(); // just outside the ring, ahead of the feet
  // the follow camera sits behind the astronaut, where its body would hide the ground ahead: the pointer is drawn on
  // top (transparent pass, after the body) and slightly see-through, so the facing is always visible
  const pointer = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshBasicMaterial({ color: 0x5ef2c2, transparent: true, opacity: 0.75,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  pointer.rotation.x = -Math.PI / 2; pointer.position.y = 0.09; pointer.renderOrder = 9; pointer.name = "facing";
  g.add(body, legs, ring, pointer);
  return g;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
