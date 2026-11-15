// MadeForMars wordmark (one word; M, F, M capitals): SVG strokes on a 14-unit-high grid in the mockups' stroke style.
// Capitals are 10 wide; lowercase 8 wide with a 9-unit x-height (y 5..14), the d's ascender reaching cap height.
const LETTERS: Record<string, string[]> = {
  M: ["M0 14 V0 H10 V14", "M5 0 V14"],
  A: ["M0 14 V3 L3 0 H10 V14", "M0 8 H10"],
  R: ["M0 14 V0 H10 V7 H0", "M5 7 L10 11 V14"],
  S: ["M10 0 H3 L0 3 V7 H10 V11 L7 14 H0"],
  W: ["M0 0 V14 H10 V0", "M5 14 V5"],
  L: ["M0 0 V14 H10"],
  K: ["M0 0 V14", "M0 7 H4 L10 1 V0", "M4 7 L10 12 V14"],
  D: ["M0 0 V14 H7 L10 11 V3 L7 0 Z"],
  E: ["M10 0 H0 V14 H10", "M0 7 H7"],
  F: ["M10 0 H0 V14", "M0 7 H7"],
  O: ["M3 0 H10 V11 L7 14 H0 V3 Z"],
  P: ["M0 14 V0 H10 V7 H0"],
  I: ["M3 0 V14", "M0 0 H6", "M0 14 H6"],
  a: ["M0 5 H8 V14 H0 V9 H8"],
  d: ["M8 0 V14 H0 V5 H8"],
  e: ["M8 14 H0 V5 H8 V9 H0"],
  o: ["M2 5 H8 V12 L6 14 H0 V7 Z"],
  r: ["M0 14 V5 H8"],
  s: ["M8 5 H2 L0 7 V9 H8 V12 L6 14 H0"],
};
const SPACE = 7; // extra width of a word space (grid units)
const widthOf = (ch: string) => (ch === "I" ? 6 : ch >= "a" && ch <= "z" ? 8 : 10);
/** Kerning (grid units): a lowercase letter tucks under F's open right side (its middle bar stops 3 short of the arm). */
const KERN: Record<string, number> = { Fo: -3, Fa: -3, Fe: -3, Fr: -3, Fs: -3 };

/** color "currentColor" lets CSS drive it (MAP / SIM card states). */
export function wordmarkSVG(color = "#ea681d", text = "MadeForMars"): string {
  const GAP = 3.4, SW = 1.55;
  const paths: string[] = [];
  let x = SW / 2;
  let prev = "";
  for (const ch of text) {
    if (ch === " ") { x += SPACE; prev = ""; continue; }
    x += KERN[prev + ch] ?? 0;
    prev = ch;
    for (const d of LETTERS[ch] ?? []) paths.push(`<path transform="translate(${x} ${SW / 2})" d="${d}"/>`);
    x += widthOf(ch) + GAP;
  }
  const width = x - GAP + SW / 2;
  const height = 14 + SW;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
    <g fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="square" stroke-linejoin="miter">${paths.join("")}</g></svg>`;
}
