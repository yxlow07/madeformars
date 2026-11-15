// Type-ahead search over named features (Gazetteer); missions, bases and sites join the index in M2.
import { lon360 } from "./geo";

export interface Place {
  name: string;
  kind: string;          // "landmark" | "mission" | "base" | "site"
  type: string;          // e.g. Crater, Mons, Planitia
  lat: number;
  lon: number;           // -180..180
  diameter_km?: number;
  link?: string;
  source?: string;
  /** Informal name the query matched (shown next to the official name). */
  alias?: string;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Well-known informal / historical names -> the official IAU (Gazetteer) name, so e.g. "Mount Sharp" finds Aeolis Mons. */
export const ALIASES: Record<string, string[]> = {
  "Aeolis Mons": ["Mount Sharp"],
  "Olympus Mons": ["Nix Olympica"],
  "Valles Marineris": ["Grand Canyon of Mars"],
};

function score(key: string, n: string) {
  if (key === n) return 3;
  if (key.startsWith(n)) return 2;
  if (key.split(/[\s-]+/).some((w) => w.startsWith(n))) return 1.5;
  if (key.includes(n)) return 1;
  return -1;
}

export class SearchIndex {
  private items: { p: Place; key: string; aliases: string[] }[] = [];
  add(places: Place[]) { for (const p of places) this.items.push({ p, key: norm(p.name), aliases: p.kind === "landmark" ? ALIASES[p.name] ?? [] : [] }); }
  get all() { return this.items.map((i) => i.p); }
  query(q: string, limit = 8): Place[] {
    const n = norm(q.trim());
    if (!n) return [];
    const scored: [number, Place][] = [];
    for (const { p, key, aliases } of this.items) {
      let s = score(key, n), via: string | undefined;
      for (const a of aliases) { const sa = score(norm(a), n); if (sa > s) { s = sa; via = a; } }
      if (s < 0) continue;
      // prefer sites / missions, then bigger features
      s += (p.kind !== "landmark" ? 0.5 : 0) + Math.min(0.4, Math.log10(1 + (p.diameter_km ?? 0)) / 10);
      scored.push([s, via ? { ...p, alias: via } : p]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
  }
}

export function bindSearch(input: HTMLInputElement, list: HTMLUListElement, index: SearchIndex, onPick: (p: Place) => void) {
  let results: Place[] = [];
  let active = 0;
  const render = () => {
    list.innerHTML = results.map((p, i) =>
      `<li data-i="${i}" class="${i === active ? "active" : ""}"><span>${p.alias ? `${escapeHtml(p.alias)} <span class="t">(${escapeHtml(p.name)})</span>` : escapeHtml(p.name)}</span>` +
      `<span class="t">${escapeHtml(p.type || p.kind)} · ${p.lat.toFixed(2)}, ${lon360(p.lon).toFixed(2)}</span></li>`).join("");
    list.hidden = results.length === 0;
  };
  input.addEventListener("input", () => { results = index.query(input.value); active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(results.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && results[active]) { pick(results[active]); }
    else if (e.key === "Escape") { list.hidden = true; input.blur(); }
  });
  list.addEventListener("mousedown", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (li) { e.preventDefault(); pick(results[Number(li.dataset.i)]); }
  });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 120));
  input.addEventListener("focus", () => { if (results.length) list.hidden = false; });
  function pick(p: Place) {
    input.value = p.name;
    list.hidden = true;
    input.blur();
    onPick(p);
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
