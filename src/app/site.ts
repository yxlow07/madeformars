// Active explorable site (multi-site): ?site=<id> picks it; Jezero (Three Forks) is the default.
// Site data: Jezero at / (data/processed), others at /sites/<id>/ (data/sites/<id>, served by the dev server).
import { BUST } from "./bust";

export interface SiteInfo {
  id: string; name: string; mission: string; base: string; lat: number; lon: number; elev_m: number;
  splat: boolean; camera: string;
}

const params = new URLSearchParams(location.search);
// live bindings: switching site in-page (setSite) updates them for every importer
export let SITE_ID = params.get("site") || "jezero";
export let SITE_BASE = SITE_ID === "jezero" ? "/" : `/sites/${SITE_ID}/`;
/** Arrived here by choosing a site on the globe (go straight into the site view, no splash). */
export const SITE_ENTER = params.has("enter");

export const JEZERO: SiteInfo = { id: "jezero", name: "Jezero — Three Forks", mission: "m2020", base: "/", lat: 18.4534, lon: 77.4084,
  elev_m: -2545, splat: true, camera: "Mastcam-Z (colour)" };

/** Registry baked by pipeline/global/bake_sites.py (falls back to Jezero alone). */
export async function loadSites(): Promise<SiteInfo[]> {
  try {
    const r = await fetch("/global/sites.json" + BUST);
    if (!r.ok) throw new Error(String(r.status));
    const list = (await r.json()) as SiteInfo[];
    return list.length ? list : [JEZERO];
  } catch {
    return [JEZERO];
  }
}

/** Switch the active site in-page (no reload): data base path + the URL's ?site= (so a reload keeps it). */
export function setSite(id: string) {
  SITE_ID = id;
  SITE_BASE = id === "jezero" ? "/" : `/sites/${id}/`;
  history.replaceState(null, "", location.pathname + `?site=${encodeURIComponent(id)}` + location.hash);
}

// Window / canvas listeners of the per-site views (map, walk, debrief) hang off this signal, so
// switching site removes them all at once (endSiteScope) before the next site's views are built.
let scope = new AbortController();
export const siteSignal = () => scope.signal;
export function endSiteScope() {
  scope.abort();
  scope = new AbortController();
}
