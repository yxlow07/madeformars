// Mars conventions: planetocentric latitude, east longitude; stored -180..180, shown 0..360.
// Mars 2000 sphere R = 3,396,190 m (matches the USGS products).
import * as THREE from "three";

export const R_MARS = 3396190;

/** Unit direction for (lat, lon) in the globe frame used by THREE.SphereGeometry + an equirect
 *  texture whose column 0 is 180°W: lon 0 -> +X, lon 90E -> -Z, north -> +Y. */
export function dirFromLatLon(latDeg: number, lonDeg: number, out = new THREE.Vector3()) {
  const φ = THREE.MathUtils.degToRad(latDeg), λ = THREE.MathUtils.degToRad(lonDeg);
  return out.set(Math.cos(φ) * Math.cos(λ), Math.sin(φ), -Math.cos(φ) * Math.sin(λ));
}

export function latLonFromDir(v: THREE.Vector3): { lat: number; lon: number } {
  const n = v.clone().normalize();
  return { lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(n.y, -1, 1))), lon: THREE.MathUtils.radToDeg(Math.atan2(-n.z, n.x)) };
}

export const lon360 = (lon: number) => ((lon % 360) + 360) % 360;
export const lon180 = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export function fmtCoords(lat: number, lon: number, dp = 5) {
  return `${lat.toFixed(dp)}, ${lon360(lon).toFixed(dp)}`;
}

/** Great-circle distance in metres on the Mars sphere. */
export function gcDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R_MARS * Math.asin(Math.min(1, Math.sqrt(a)));
}
