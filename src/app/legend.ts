// Map legends. Colour ramps / classes come from the bake outputs (layers.json "legend" blocks), never retyped here,
// so a legend always matches the overlay it explains.
export type Stop = [number, number[]];
export interface RampLegend { type: "ramp"; stops: Stop[]; min: number; max: number; units: string; note?: string; mark?: number | null }
export interface CatLegend { type: "categories"; items: { label: string; color: number[] }[]; note?: string }
export type LegendSpec = RampLegend | CatLegend;
/** A key row: a small symbol (HTML) + label, for markers and lines. */
export interface KeyItem { sym: string; label: string }

const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Value formatting by unit: metres as km, fractions as %, everything else with sensible digits. */
function fmtVal(v: number, units: string) {
  if (units === "m") return `${v > 0 ? "+" : ""}${(v / 1000).toFixed(Math.abs(v) < 1000 && v !== 0 ? 1 : 0)}`;
  if (/fraction/.test(units)) return `${(v * 100).toFixed(v * 100 < 2 ? 1 : 0)}`;
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toFixed(2);
}
function unitLabel(units: string) {
  if (units === "m") return "km";
  if (/fraction/.test(units)) return "%";
  return units;
}

export function legendHtml(title: string, spec: LegendSpec, opts: { lowLabel?: string; highLabel?: string } = {}) {
  if (spec.type === "categories") {
    return `<div class="lg"><div class="lg-title">${esc(title)}</div>
      <ul class="lg-cats">${spec.items.map((i) => `<li><i style="background:${rgb(i.color)}"></i>${esc(i.label)}</li>`).join("")}</ul>
      ${spec.note ? `<div class="lg-note">${esc(spec.note)}</div>` : ""}</div>`;
  }
  const grad = spec.stops.map(([t, c]) => `${rgb(c)} ${(t * 100).toFixed(1)}%`).join(", ");
  const mid = (spec.min + spec.max) / 2;
  const mark = spec.mark != null && spec.max > spec.min ? ((spec.mark - spec.min) / (spec.max - spec.min)) * 100 : null;
  return `<div class="lg"><div class="lg-title">${esc(title)} <span class="lg-units">${esc(unitLabel(spec.units))}</span></div>
    <div class="lg-bar" style="background:linear-gradient(90deg, ${grad})">${mark !== null ? `<b class="lg-mark" style="left:${mark.toFixed(1)}%"></b>` : ""}</div>
    <div class="lg-ticks num"><span>${opts.lowLabel ?? fmtVal(spec.min, spec.units)}</span><span>${opts.lowLabel ? "" : fmtVal(mid, spec.units)}</span><span>${opts.highLabel ?? fmtVal(spec.max, spec.units)}</span></div>
    ${spec.note ? `<div class="lg-note">${esc(spec.note)}</div>` : ""}</div>`;
}

export function keyHtml(title: string, items: KeyItem[]) {
  return `<div class="lg"><div class="lg-title">${esc(title)}</div>
    <ul class="lg-key">${items.map((i) => `<li><span class="lg-sym">${i.sym}</span>${esc(i.label)}</li>`).join("")}</ul></div>`;
}

/** Ready-made symbols (inline, so they match what is drawn on the map). */
export const SYM = {
  line: (color: string, w = 3, dash = false) => `<svg width="22" height="10" viewBox="0 0 22 10"><line x1="1" y1="5" x2="21" y2="5" stroke="${color}" stroke-width="${w}" ${dash ? 'stroke-dasharray="4 3"' : ""} stroke-linecap="round"/></svg>`,
  dot: (color: string, r = 4, ring = "") => `<svg width="22" height="12" viewBox="0 0 22 12"><circle cx="11" cy="6" r="${r}" fill="${color}" ${ring ? `stroke="${ring}" stroke-width="1.5"` : ""}/></svg>`,
  ring: (color: string) => `<svg width="22" height="12" viewBox="0 0 22 12"><circle cx="11" cy="6" r="4.5" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`,
  diamond: (color: string) => `<svg width="22" height="12" viewBox="0 0 22 12"><path d="M11 1 L16 6 L11 11 L6 6 Z" fill="${color}"/></svg>`,
  badge: (fill: string, text: string, fg = "#0e0f13", border = "#ece6dc") => `<svg width="22" height="16" viewBox="0 0 22 16"><circle cx="11" cy="8" r="7" fill="${fill}" stroke="${border}" stroke-width="1.4"/><text x="11" y="11.4" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="9" fill="${fg}">${esc(text)}</text></svg>`,
  square: (fill: string, text = "") => `<svg width="22" height="14" viewBox="0 0 22 14"><rect x="5" y="1" width="12" height="12" fill="${fill}"/><text x="11" y="10.5" text-anchor="middle" font-family="monospace" font-weight="700" font-size="9" fill="#0e0f13">${esc(text)}</text></svg>`,
  arrow: (fill = "#ea681d") => `<svg width="22" height="14" viewBox="0 0 22 14"><path d="M11 1 L16 12 L11 9 L6 12 Z" fill="${fill}" stroke="#fff" stroke-width="1" stroke-linejoin="round"/></svg>`,
  note: (fill = "#ece6dc", ink = "#0e0f13") => `<svg width="22" height="16" viewBox="0 0 22 16"><path d="M4 2 H18 Q20 2 20 4 V10 Q20 12 18 12 H10 L6 15 V12 H4 Q2 12 2 10 V4 Q2 2 4 2 Z" fill="${fill}" stroke="#3a3a40" stroke-width="1"/><circle cx="7.5" cy="7" r="1.2" fill="${ink}"/><circle cx="11" cy="7" r="1.2" fill="${ink}"/><circle cx="14.5" cy="7" r="1.2" fill="${ink}"/></svg>`,
  band: (color: string) => `<svg width="22" height="12" viewBox="0 0 22 12"><rect x="1" y="1" width="20" height="10" fill="${color}"/></svg>`,
};

/** A collapsible legend panel; `set(html)` replaces its contents (hidden when empty). */
export class LegendPanel {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  constructor(host: HTMLElement, id: string, title = "Legend") {
    this.el = document.createElement("div");
    this.el.id = id;
    this.el.className = "legend-panel";
    this.el.hidden = true;
    this.el.innerHTML = `<div class="lg-head"><span class="label mint small">${esc(title)}</span><button class="fl-btn-xs lg-min" title="Collapse / expand">–</button></div><div class="lg-body"></div>`;
    host.appendChild(this.el);
    this.body = this.el.querySelector(".lg-body") as HTMLDivElement;
    const btn = this.el.querySelector(".lg-min") as HTMLButtonElement;
    btn.addEventListener("click", () => {
      this.el.classList.toggle("collapsed");
      btn.textContent = this.el.classList.contains("collapsed") ? "+" : "–";
    });
    if (document.body.classList.contains("mobile")) { this.el.classList.add("collapsed"); btn.textContent = "+"; } // phones: start small
  }
  set(html: string) {
    if (this.body.innerHTML !== html) this.body.innerHTML = html;
    this.el.hidden = !html;
  }
  show(on: boolean) { this.el.hidden = !on || !this.body.innerHTML; }
}
