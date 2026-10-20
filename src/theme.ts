import type { Accent } from "./view.ts";

// The iOS design tokens (regional-check `DriveCheckColors.swift`, `Theme+Redesign.swift`), so the
// web shows the same Status screen (REQ-WEB-011). Sizes are iOS points at the default Dynamic
// Type size, written in rem so the browser's text size scales them (REQ-WEB-010).

export const PALETTE = {
  background: "#0C0E11",
  clear: "#7CC39B",
  alert: "#F07C7C",
  caution: "#E8BA62",
  stale: "#C6CAD0",
  checking: "#9AA0A8",
  noData: "#C6CAD0",
  text: "#F2F3F5",
  textSecondary: "#A3A7AE",
} as const;

export const ACCENT: Record<Accent, string> = {
  clear: PALETTE.clear,
  alert: PALETTE.alert,
  caution: PALETTE.caution,
  stale: PALETTE.stale,
  unavailable: PALETTE.checking,
};

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2 contrast ratio. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** An opaque colour over the background, for checking translucent surfaces. */
export function over(hex: string, alpha: number, base: string = PALETTE.background): string {
  const mix = [1, 3, 5].map((i) => {
    const top = Number.parseInt(hex.slice(i, i + 2), 16);
    const bottom = Number.parseInt(base.slice(i, i + 2), 16);
    return Math.round(top * alpha + bottom * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  });
  return `#${mix.join("")}`.toUpperCase();
}

/** Card surfaces: white at 6 % with a 10 % stroke, as `Theme.surface` / `surfaceStroke`. */
export const SURFACE = over("#FFFFFF", 0.06);

const alpha = (hex: string, a: number) =>
  `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** Per-accent custom properties: the soft fill, edge, glow and sweep tints iOS derives. */
function accentVars(hex: string): string {
  return [
    `--accent:${hex}`,
    `--accent-soft:${alpha(hex, 0.14)}`,
    `--accent-edge:${alpha(hex, 0.4)}`,
    `--accent-glow:${alpha(hex, 0.2)}`,
    `--accent-sweep:${alpha(hex, 0.3)}`,
    `--accent-tick:${alpha(hex, 0.38)}`,
  ].join(";");
}

// iOS text styles in points: largeTitle 34, title3 20, headline/body 17, subheadline 15,
// footnote 13, caption 12 (1 rem = 16 px at the browser's default text size).
const FONT_FAMILY = `ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

// The location arrow before the region name, drawn by CSS so the region stays plain text.
const LOCATION_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M21 3 3 10.5l7.6 2.9L13.5 21z'/%3E%3C/svg%3E\")";

export const STYLESHEET = `
:root{color-scheme:dark;--bg:${PALETTE.background};--text:${PALETTE.text};--text2:${PALETTE.textSecondary};--surface:rgba(255,255,255,.06);--stroke:rgba(255,255,255,.10);--sep:rgba(255,255,255,.08);--caution:${PALETTE.caution};--alert:${PALETTE.alert};--clear:${PALETTE.clear};--grey:${PALETTE.checking};${accentVars(PALETTE.clear)}}
.accent-clear{${accentVars(ACCENT.clear)}}.accent-alert{${accentVars(ACCENT.alert)}}.accent-caution{${accentVars(ACCENT.caution)}}.accent-stale{${accentVars(ACCENT.stale)}}.accent-unavailable{${accentVars(ACCENT.unavailable)}}
*{box-sizing:border-box}
html{font-family:${FONT_FAMILY};-webkit-text-size-adjust:100%;text-size-adjust:100%}
@supports (font:-apple-system-body){html{font:-apple-system-body;font-family:${FONT_FAMILY}}}
body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);font-size:1.0625rem;line-height:1.35}
a{color:inherit}
:focus-visible{outline:2px solid var(--text);outline-offset:3px;border-radius:.5rem}
.shell{max-width:34rem;margin:0 auto;padding:0 1.25rem 2rem;display:flex;flex-direction:column;gap:1.25rem}
main{display:flex;flex-direction:column;gap:1.25rem}
.toolbar{display:grid;grid-template-columns:2.75rem 1fr 2.75rem;align-items:center;padding-top:.5rem;min-height:3.25rem}
.toolbar .title{grid-row:1;grid-column:2;text-align:center;font-size:1.0625rem;font-weight:600;margin:0}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:2.75rem;height:2.75rem;border-radius:50%;color:var(--text2);background:none;border:0;font:inherit;cursor:pointer;text-decoration:none}
.icon-btn:hover{color:var(--text);background:var(--surface)}
.icon-btn svg{width:1.25rem;height:1.25rem}
.toolbar .end{grid-row:1;grid-column:3;justify-self:end}
.toolbar .start{grid-row:1;grid-column:1;justify-self:start}
.hero{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;padding-top:.75rem;overflow-x:clip}
.radar{position:relative;width:min(9.75rem,100%);aspect-ratio:1;margin-bottom:.875rem}
.radar .glow{position:absolute;inset:-3.875rem;border-radius:50%;background:radial-gradient(circle,var(--accent-glow) 0,transparent 70%);pointer-events:none}
.radar .sweep{position:absolute;inset:.8rem;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 310deg,var(--accent-sweep) 360deg);animation:sweep 4s linear infinite}
.radar .sweep::after{content:"";position:absolute;left:50%;top:0;width:1.5px;height:50%;margin-left:-.75px;background:color-mix(in srgb,var(--accent) 55%,white);opacity:.9}
.radar svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.radar .tick{stroke:var(--accent-tick);stroke-width:1.6;stroke-linecap:round}
.radar .disc{fill:var(--accent-soft);stroke:var(--accent-edge);stroke-width:1}
.radar .glyph{color:var(--accent)}
.radar .core{opacity:.28}
@keyframes sweep{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.radar .sweep{animation:none;transform:rotate(45deg)}}
h1{margin:0;font-size:2.125rem;line-height:1.15;font-weight:700;letter-spacing:-.0375rem;color:var(--accent)}
.region{margin:.875rem 0 0;font-size:1.25rem;font-weight:600;display:inline-flex;align-items:center;gap:.375rem;justify-content:center}
.region::before{content:"";width:.8125rem;height:.8125rem;flex:none;background:currentColor;-webkit-mask:${LOCATION_MASK} center/contain no-repeat;mask:${LOCATION_MASK} center/contain no-repeat}
.meta{margin:.25rem 0 0;font-size:.9375rem;color:var(--text2);font-variant-numeric:tabular-nums}
.card{background:var(--surface);border:1px solid var(--stroke);border-radius:1.375rem}
.nearby{display:flex;gap:.75rem;align-items:center;padding:.75rem 1.125rem;font-weight:600;margin:0}
.nearby svg{flex:none;width:1.375rem;height:1.375rem;color:var(--caution)}
.map{position:relative;display:block;overflow:hidden;aspect-ratio:1000/670;text-decoration:none}
.map .image{position:absolute;inset:0;background:center/contain no-repeat}
.map .caption{position:absolute;z-index:2;left:0;right:0;bottom:0;padding:1.5rem 1.125rem .5rem;font-size:.75rem;text-align:center;background:linear-gradient(to bottom,rgba(12,14,17,0),rgba(12,14,17,.85))}
.map .failed{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;color:var(--text2)}
.map.no-image .failed,.map.is-failed .failed{display:flex}
.footer{text-align:center;color:var(--text2);font-size:.8125rem;display:flex;flex-direction:column;gap:.5rem;padding-top:.5rem}
.footer p{margin:0}
.footer nav{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap}
.footer a{color:var(--text);text-underline-offset:.2em}
.install{display:none;align-self:center;padding:.5rem 1rem;border-radius:999px;border:1px solid var(--stroke);background:var(--surface);color:var(--text);font:inherit;font-size:.9375rem;cursor:pointer}
.install.is-shown{display:inline-block}
.hint{display:none;text-align:center;color:var(--text2);font-size:.8125rem;margin:0}
.hint.is-shown{display:block}
.page-title{margin:.25rem 0 0;font-size:2.125rem;font-weight:700;letter-spacing:-.0375rem;color:var(--text)}
.current{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;padding:1rem 1.125rem}
.current .pin{display:inline-flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;border-radius:50%;background:var(--accent-soft);color:var(--accent);flex:none}
.current .pin svg{width:1rem;height:1rem}
.current .label{display:block;font-size:.75rem;color:var(--text2)}
.current .name{display:block;font-size:1.25rem;font-weight:600}
.current .grow{flex:1;min-width:0}
.pill{font-size:.75rem;font-weight:600;color:var(--accent);background:var(--accent-soft);padding:.375rem .75rem;border-radius:999px;white-space:nowrap}
.section{display:flex;flex-direction:column;gap:.375rem}
.section h2{margin:0;padding:0 .25rem;font-size:.8125rem;font-weight:600;letter-spacing:.02rem;text-transform:uppercase;color:var(--text2)}
.group{margin:0;padding:0;list-style:none;overflow:hidden}
.group.alerting{background:${alpha(PALETTE.alert, 0.08)};border-color:${alpha(PALETTE.alert, 0.22)}}
.group li+li{border-top:1px solid var(--sep)}
.row{display:flex;align-items:center;gap:.75rem;width:100%;min-height:2.75rem;padding:.5rem 1.125rem;background:none;border:0;color:var(--text);font:inherit;text-align:left;cursor:pointer}
.alerting .row{min-height:3rem}
.row:hover{background:var(--surface)}
.row:focus-visible{outline-offset:-3px;border-radius:1.25rem}
.row .dot{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--grey)}
.row .dot.on{background:var(--alert)}.row .dot.off{background:var(--clear)}
.row .name{flex:1;min-width:0}
.row .state{font-size:.75rem;color:var(--alert)}
.row svg{width:.875rem;height:.875rem;color:var(--text2)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (min-width:48rem){.shell{gap:1.5rem}.radar{width:min(11.25rem,100%)}h1{font-size:2.75rem}}
`;
