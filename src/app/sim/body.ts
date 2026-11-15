// Suit and body model (PRD feature 4) behind the health-module interface (PRD feature 10).
// The partner project can replace DefaultBody with its own module (same JSON in and out).
// Labelled "simplified model" in the UI.

export interface BodyInput {
  dt: number;            // s
  speedMps: number;
  grade: number;         // rise / run (signed)
  loadKg: number;
  gravity: number;       // ratio to Earth (0.38 on Mars)
  ambientC: number;
  doseRateMsvH: number;
}

export interface BodyOutput {
  heartRate: number;     // bpm
  metabolicW: number;
  o2UseLps: number;      // litres of O2 per second
  coreTempC: number;
  alerts: string[];
}

export interface HealthModel {
  step(i: BodyInput): BodyOutput;
}

export interface BodyParams {
  body_kg: number; terrain_factor: number; kj_per_l_o2: number;
  hr_rest: number; hr_per_w: number; hr_lag_s: number;
}

/** Pandolf load-carriage equation with the gravity-dependent terms scaled to Mars:
 *  M = 1.5·W + g·[ 2(W+L)(L/W)² + η(W+L)(1.5·V² + 0.35·V·G) ]   (W, L in kg; V m/s; G grade in %, uphill only)
 *  O2 use = M / (kJ per litre).  Heart rate and core temperature follow M with first-order lags. */
export class DefaultBody implements HealthModel {
  private hr: number;
  private core = 37.0;
  private p: BodyParams;
  constructor(p: BodyParams) { this.p = p; this.hr = p.hr_rest; }

  metabolic(speed: number, grade: number, load: number, g: number) {
    const W = this.p.body_kg, L = load, V = Math.max(0, speed), G = Math.max(0, grade * 100);
    return 1.5 * W + g * (2 * (W + L) * (L / W) ** 2 + this.p.terrain_factor * (W + L) * (1.5 * V * V + 0.35 * V * G));
  }

  step(i: BodyInput): BodyOutput {
    const M = this.metabolic(i.speedMps, i.grade, i.loadKg, i.gravity);
    const rest = this.metabolic(0, 0, i.loadKg, i.gravity);
    const hrTarget = Math.min(190, this.p.hr_rest + this.p.hr_per_w * (M - rest));
    this.hr += (hrTarget - this.hr) * Math.min(1, i.dt / this.p.hr_lag_s);
    const coreTarget = 37 + Math.max(0, M - rest) * 0.0035;
    this.core += (coreTarget - this.core) * Math.min(1, i.dt / 600);
    const alerts: string[] = [];
    if (M > 520) alerts.push("High workload — slow down"); // (heart rate is not shown: the simple HR formula is not physiology)
    if (this.core > 38.5) alerts.push("Core temperature high");
    return { heartRate: this.hr, metabolicW: M, o2UseLps: M / (this.p.kj_per_l_o2 * 1000), coreTempC: this.core, alerts };
  }
}
