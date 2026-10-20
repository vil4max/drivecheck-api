import { type Glyph, glyph } from "./glyphs.ts";

// iOS `StatusHeroGraphic` at its design size: a 156 pt square, 60 ticks of 5 × 1.6 on radius 74,
// a 108 pt disc and a 54 pt symbol. The sweep and glow are CSS (theme.ts) so they can animate
// and stop under reduced motion.
const SIZE = 156;
const C = SIZE / 2;
const RING_RADIUS = 74;
const TICK_LENGTH = 5;
const TICKS = 60;
const DISC_RADIUS = 54;
const SYMBOL = 54;
const CORE_RADIUS = 27;

const ticks = Array.from({ length: TICKS }, (_, i) => {
  const angle = (i / TICKS) * 2 * Math.PI;
  const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
  const r1 = RING_RADIUS - TICK_LENGTH;
  const f = (n: number) => n.toFixed(2);
  return `<line class="tick" x1="${f(C + r1 * sin)}" y1="${f(C - r1 * cos)}" x2="${f(C + RING_RADIUS * sin)}" y2="${f(C - RING_RADIUS * cos)}"/>`;
}).join("");

/** The radar hero; purely decorative, since the status is the `h1` beside it. */
export function heroGraphic(symbol: Glyph): string {
  const offset = C - SYMBOL / 2;
  // The `.fill` symbols iOS uses draw a tinted core under the mark; the warning triangle does not.
  const core =
    symbol === "triangle"
      ? ""
      : `<circle class="core" cx="${C}" cy="${C}" r="${CORE_RADIUS}" fill="currentColor"/>`;
  return `<div class="radar" aria-hidden="true"><div class="glow"></div><div class="sweep"></div><svg viewBox="0 0 ${SIZE} ${SIZE}" focusable="false">${ticks}<circle class="disc" cx="${C}" cy="${C}" r="${DISC_RADIUS}"/><g class="glyph">${core}</g><g class="glyph" data-glyph="${symbol}" transform="translate(${offset} ${offset}) scale(${SYMBOL / 24})">${glyph(symbol).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g></svg></div>`;
}
