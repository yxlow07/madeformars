// M2 wiring: data layers, point layers, STATS, score worker + breakdown card, EVENT ALERT, credits.
import { BUST } from "./bust";
import * as THREE from "three";
import type { Globe } from "./globe";
import { LayerStore, type RadiationCfg } from "./layers";
import { PointLayers, BASE_SCORE_STOPS, type Base, type Mission } from "./points";
import { LegendPanel, legendHtml, keyHtml, SYM } from "./legend";
import { buildDrawer, renderCredits, renderEvents, renderSiteCard, renderTop, setDanger, updateStats } from "./panels";
import type { Place, SearchIndex } from "./search";
import type { Candidate, ScoreConfig, Scored } from "./score/score";
import { gcDistance } from "./geo";

const $ = (id: string) => document.getElementById(id)!;

export interface M2Ctx {
  globe: Globe;
  landmarks: Place[];
  index: SearchIndex;
  select(p: Place & { elev?: number }): void;
  terrainSites: { name: string; lat: number; lon: number }[]; // sites with baked HiRISE terrain (M3)
}

export async function initM2(ctx: M2Ctx) {
  const { globe } = ctx;
  const L = new LayerStore();
  const [cfgAll, missionsRaw, basesRaw, events] = await Promise.all([
    fetch("/global/score_config.json" + BUST).then((r) => r.json()),
    fetch("/global/missions.json" + BUST).then((r) => r.json()),
    fetch("/global/bases.json" + BUST).then((r) => r.json()),
    fetch("/global/events.json" + BUST).then((r) => r.json()).catch(() => null),
    L.load(),
  ]);
  const cfg: ScoreConfig = cfgAll.score;
  const rad: RadiationCfg = cfgAll.radiation;
  const missions: Mission[] = missionsRaw.map((m: any) => ({ name: m.name, kind: "mission", type: `Landing site${m.agency ? " · " + m.agency : ""}${m.year ? " " + m.year : ""}`,
    lat: m.lat, lon: m.lon, source: m.source, agency: m.agency, year: m.year }));
  const bases: Base[] = basesRaw.map((b: any) => ({ id: `ez${b.id}`, name: b.name, kind: "base", type: "Exploration Zone (2015)", lat: b.lat, lon: b.lon,
    approximate: b.approximate, location_method: b.location_method, note: b.note, radius_km: b.radius_km, source: b.source }));
  ctx.index.add(missions);
  ctx.index.add(bases);
  $("loading-layers").remove();

  // ---- point layers
  const points = new PointLayers(globe, $("centre"));
  points.setData(ctx.landmarks, missions, bases);
  points.setExplorable(ctx.terrainSites.map((t) => ({ name: t.name, lat: t.lat, lon: t.lon, kind: "site", type: "Explorable site · detailed HiRISE terrain" }) as any));
  for (const [key, id] of [["landmarks", "lyr-landmarks"], ["missions", "lyr-missions"], ["bases", "lyr-bases"]] as const) {
    const cb = $(id) as HTMLInputElement;
    cb.addEventListener("change", () => { points.show[key] = cb.checked; refreshLegend(); });
  }

  // ---- legend: every overlay that is on (top-most first) + the marker key
  const legend = new LegendPanel($("centre"), "globe-legend");
  const activeLayers = new Set<string>();
  let legendOn = true;
  function refreshLegend() {
    const parts: string[] = [];
    for (const id of [...order].reverse()) {
      if (!activeLayers.has(id)) continue;
      const m = L.meta(id === "mineral" ? mineral : id);
      if (m?.legend) parts.push(legendHtml(m.name, m.legend));
    }
    const key = [{ sym: SYM.badge("#5ef2c2", "!", "#0e0f13", "#f3e9dc"), label: "Explorable site (walkable terrain)" }];
    if (points.show.missions) key.push({ sym: SYM.diamond("#ea681d"), label: "Mission landing site" });
    if (points.show.landmarks) key.push({ sym: SYM.dot("#ece6dc", 2.5), label: "Named feature (Gazetteer)" });
    parts.push(keyHtml("Markers", key));
    if (points.show.bases) parts.push(legendHtml("Candidate base (ring = zone)", { type: "ramp", stops: BASE_SCORE_STOPS, min: 0, max: 1, units: "best-spot score",
      note: "Pulsing = top sites. Score = weighted Science + Safety + Access." }, { lowLabel: "low", highLabel: "high" }));
    legend.set(parts.join(""));
    legend.show(legendOn);
  }

  // ---- score worker
  const worker = new Worker(new URL("./score/worker.ts", import.meta.url), { type: "module" });
  const gridIds = ["geology", "slope", "elevation", "albedo", "ti", ...L.minerals().map((m) => m.id)];
  const unitCodes = Object.fromEntries(L.units.map((u) => [u.index, u.code]));
  const cands: Candidate[] = bases.map((b) => ({ id: b.id, name: b.name, lat: b.lat, lon: b.lon, kind: "base" }));
  let weights = { ...cfg.weights };
  let ranked: Scored[] = [];
  let reqId = 0;
  const pending = new Map<number, (m: any) => void>();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") { (window as any).marswalk.scoreInitMs = m.ms; rerank(); }
    else pending.get(m.id)?.(m);
  };
  worker.postMessage({ type: "init", grids: L.bundle(gridIds), cfg, unitCodes, names: ctx.landmarks.map((l) => ({ lat: l.lat, lon: l.lon })), candidates: cands });
  const ask = <T,>(msg: any) => new Promise<T>((res) => { const id = ++reqId; pending.set(id, (m) => { pending.delete(id); res(m); }); worker.postMessage({ ...msg, id }); });

  let current: { site: Scored & any; rank: number; of: number } | null = null;
  async function rerank() {
    const t0 = performance.now();
    const m = await ask<{ ranked: Scored[]; ms: number }>({ type: "rank", weights });
    ranked = m.ranked;
    const wall = performance.now() - t0;
    (window as any).marswalk.lastRerankMs = wall;
    points.setScores(new Map(ranked.map((s, i) => [s.id, { score: s.score, rank: i + 1 }])), cfg.top_n);
    renderTop(ranked, cfg.top_n, wall);
    if (current) {
      if (current.site.kind === "base") {
        const i = ranked.findIndex((s) => s.id === current!.site.id);
        if (i >= 0) showCard({ ...bases.find((b) => b.id === ranked[i].id), ...ranked[i] }, i + 1, ranked.length);
      } else evaluate(current.site);
    }
  }

  function showCard(site: any, rank: number, of: number) {
    current = { site, rank, of };
    const hasTerrain = ctx.terrainSites.some((t) => gcDistance(site.lat, site.lon, t.lat, t.lon) < 100e3);
    renderSiteCard(site, rank, of, weights, hasTerrain);
    setDanger(site.hazard);
    (window as any).marswalk.card = { name: site.name, score: site.score, contrib: site.contrib, terms: site.terms, rank, of };
  }

  let evalSeq = 0;
  async function evaluate(p: { id?: string; name: string; lat: number; lon: number }) {
    const seq = ++evalSeq; // ignore results that arrive after a newer click
    const c: Candidate = { id: p.id ?? `pt:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, name: p.name, lat: p.lat, lon: p.lon, kind: "site" };
    const m = await ask<{ site: Scored; rankOf: number; of: number }>({ type: "evaluate", candidate: c, weights });
    if (seq !== evalSeq) return;
    showCard({ ...m.site, kind: "site" }, m.rankOf, m.of);
  }

  // ---- drawer (LAYERS MENU)
  const texCache = new Map<string, THREE.Texture>();
  const tex = (id: string) => {
    if (!texCache.has(id)) texCache.set(id, new THREE.TextureLoader().load(`/global/${L.meta(id)!.png}${BUST}`));
    return texCache.get(id)!;
  };
  let mineral = L.minerals()[0]?.id ?? "";
  const order = ["elevation", "geology", "ti", "mineral", "dust", "albedo", "science", ...L.weather().map((m) => m.id)];
  buildDrawer(L, weights, {
    onLayer(id, on, op) {
      globe.setOverlay(id, on ? tex(id === "mineral" ? mineral : id) : null, op, order.indexOf(id));
      if (on) activeLayers.add(id); else activeLayers.delete(id);
      refreshLegend();
    },
    onOpacity(id, op) { globe.setOverlayOpacity(id, op); },
    onMineral(id) { mineral = id; const cb = document.querySelector<HTMLInputElement>('input[data-layer="mineral"]'); if (cb?.checked) globe.setOverlay("mineral", tex(id)); refreshLegend(); },
    onWeights(w) { weights = w; rerank(); },
    onExag(v) { globe.setExag(v); },
    onTopPick(id) { const b = bases.find((x) => x.id === id); if (b) { ctx.select(b); globe.flyTo(b.lat, b.lon, 1.6); } },
    onCredits() { renderCredits(L); },
  });
  refreshLegend();
  $("layers-menu").addEventListener("click", () => {
    const d = $("drawer");
    d.hidden = !d.hidden;
    $("layers-menu").classList.toggle("on", !d.hidden);
  });

  renderEvents(events);

  return {
    layers: L, points, rad,
    hover(lat: number, lon: number) { updateStats(L, rad, lat, lon); },
    onSelect(p: Place & { id?: string }) {
      points.selectedName = p.name;
      updateStats(L, rad, p.lat, p.lon);
      const base = p.kind === "base" ? bases.find((b) => b.name === p.name && Math.abs(b.lat - p.lat) < 1e-6) : undefined;
      if (base) {
        evalSeq++; // a base selection supersedes any pending point evaluation
        const i = ranked.findIndex((s) => s.id === base.id);
        if (i >= 0) showCard({ ...base, ...ranked[i] }, i + 1, ranked.length);
      } else evaluate(p);
    },
    /** Legend only on the globe screen. */
    showLegend(on: boolean) { legendOn = on; legend.show(on); if (!on) points.hideLabels(); },
    onDeselect() {
      points.selectedName = null;
      evalSeq++; // drop any evaluation still in flight for the old selection
      current = null as any;
      $("sitecard").hidden = true;
      setDanger(null);
    },
    pickScreen(x: number, y: number) { return points.pickScreen(x, y); },
    update(dt: number) { points.update(dt); },
    setWeights(w: typeof weights) { weights = w; return rerank(); },
    get ranked() { return ranked; },
  };
}
