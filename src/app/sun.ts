// Where the Sun is, seen from Mars: NASA GISS Mars24 algorithm (Allison & McEwen 2000, Planet. Space Sci. 48, 215;
// https://www.giss.nasa.gov/tools/mars24/help/algorithm.html). Gives the solar longitude Ls, the subsolar point, the
// Sun's distance and local true solar time (LTST); from those, the Sun's elevation / azimuth at any site.

const D2R = Math.PI / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export interface MarsSun {
  ls: number;           // areocentric solar longitude (deg; 0 = northern spring equinox)
  subLat: number;       // subsolar latitude (deg, planetocentric)
  subLonE: number;      // subsolar longitude (deg east, -180..180)
  distAU: number;       // heliocentric distance of Mars (AU)
  eot: number;          // equation of time (deg)
  mst: number;          // mean solar time at the prime meridian (h)
  angDiamDeg: number;   // apparent diameter of the Sun from Mars (deg)
}

/** TT - UTC (s): 32.184 + leap seconds (37 since 2017). */
function ttMinusUtc(ms: number) { return ms < Date.UTC(2017, 0, 1) ? (ms < Date.UTC(2009, 0, 1) ? 64.184 : 67.184) : 69.184; }

export function marsSun(date: Date | number = Date.now()): MarsSun {
  const ms = typeof date === "number" ? date : date.getTime();
  const jdUT = 2440587.5 + ms / 86400000;
  const jdTT = jdUT + ttMinusUtc(ms) / 86400;
  const dt = jdTT - 2451545.0;
  const M = 19.3871 + 0.52402073 * dt;                       // mean anomaly
  const aFMS = 270.3871 + 0.524038496 * dt;                  // fictitious mean sun
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018];
  const tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const phi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];
  let pbs = 0;
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(((0.985626 * dt) / tau[i] + phi[i]) * D2R);
  const s = (k: number) => Math.sin(k * M * D2R);
  const nuM = (10.691 + 3.0e-7 * dt) * s(1) + 0.623 * s(2) + 0.05 * s(3) + 0.005 * s(4) + 0.0005 * s(5) + pbs; // equation of centre
  const ls = mod(aFMS + nuM, 360);
  const eot = 2.861 * Math.sin(2 * ls * D2R) - 0.071 * Math.sin(4 * ls * D2R) + 0.002 * Math.sin(6 * ls * D2R) - nuM;
  const mst = mod(24 * ((jdTT - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626), 24);
  const subLonW = mod(mst * 15 + eot + 180, 360);            // Mars24 uses west longitudes
  const subLat = Math.asin(0.42565 * Math.sin(ls * D2R)) / D2R + 0.25 * Math.sin(ls * D2R);
  const c = (k: number) => Math.cos(k * M * D2R);
  const distAU = 1.52367934 * (1.00436 - 0.09309 * c(1) - 0.004336 * c(2) - 0.00031 * c(3) - 0.00003 * c(4));
  const angDiamDeg = (2 * Math.atan(695700 / (distAU * 149597870.7))) / D2R;
  return { ls, subLat, subLonE: mod(-subLonW + 180, 360) - 180, distAU, eot, mst, angDiamDeg };
}

/** Sun seen from a site: elevation / azimuth (deg; azimuth from north, clockwise) and local true solar time (h). */
export function sunAt(lat: number, lonE: number, date: Date | number = Date.now()) {
  const m = marsSun(date);
  const v = (la: number, lo: number) => [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.cos(la * D2R) * Math.sin(lo * D2R), Math.sin(la * D2R)];
  const sv = v(m.subLat, m.subLonE);
  const up = v(lat, lonE);
  const east = [-Math.sin(lonE * D2R), Math.cos(lonE * D2R), 0];
  const north = [-Math.sin(lat * D2R) * Math.cos(lonE * D2R), -Math.sin(lat * D2R) * Math.sin(lonE * D2R), Math.cos(lat * D2R)];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const elev = Math.asin(Math.max(-1, Math.min(1, dot(sv, up)))) / D2R;
  const az = mod(Math.atan2(dot(sv, east), dot(sv, north)) / D2R, 360);
  const ltst = mod(m.mst + (lonE >= 0 ? lonE : lonE + 360) / 15 + m.eot / 15, 24);  // LMST at east longitude + EOT
  return { elev, az, ltst, sun: m };
}

/** Mars solar hour in seconds (one sol = 88775.244 s). */
export const MARS_HOUR_S = 88775.244 / 24;

/** When a walk planned now would start: now if the Sun is up (>= 5 deg), else the next 09:00 local solar time. */
export function evaStart(lat: number, lonE: number, now = Date.now()): number {
  const s = sunAt(lat, lonE, now);
  if (s.elev >= 5) return now;
  const wait = mod(9 - s.ltst, 24) * MARS_HOUR_S * 1000;
  return now + wait;
}

/** Local frame direction (x east, y up, z south) of a Sun at elevation / azimuth. */
export function sunDirLocal(elevDeg: number, azDeg: number): [number, number, number] {
  const e = elevDeg * D2R, a = azDeg * D2R;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export function fmtLtst(h: number) {
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
