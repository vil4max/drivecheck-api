import { LANGS, STRINGS } from "./i18n.ts";
import type { Lang } from "./regions.ts";
import type { Phase, StatusView } from "./status.ts";

// regional-check DriveCheckColors.swift.
export const PALETTE = {
  background: "#0C0E11",
  clear: "#7CC39B",
  alert: "#F07C7C",
  checking: "#9AA0A8",
  noData: "#C6CAD0",
  text: "#F2F3F5",
  textSecondary: "#A3A7AE",
} as const;

const PHASE_COLOUR: Record<Phase, string> = {
  alarm: PALETTE.alert,
  quiet: PALETTE.clear,
  unavailable: PALETTE.noData,
  regionUnavailable: PALETTE.noData,
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

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function kyivClock(epochMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(epochMs);
}

function link(regionId: string, lang: Lang): string {
  return `/?region=${encodeURIComponent(regionId)}&amp;lang=${lang}`;
}

export function renderPage(view: StatusView, lang: Lang): string {
  const s = STRINGS[lang];
  const regionName = view.region.names[lang];
  const status = s.phase[view.phase];
  const lines: string[] = [];
  if (view.checkedAt !== null) {
    const time = kyivClock(view.checkedAt);
    lines.push(
      `<p class="meta">${escapeHtml(view.stale ? s.lastKnown(time) : s.updated(time))}</p>`,
    );
  }
  if (view.nearby.length > 0) {
    const names = view.nearby.map((r) => r.names[lang]).join(", ");
    lines.push(`<p class="nearby">${escapeHtml(s.nearby(names))}</p>`);
  }
  const languages = LANGS.filter((l) => l !== lang)
    .map(
      (l) =>
        `<a href="${link(view.region.id, l)}" hreflang="${l}" lang="${l}">${escapeHtml(STRINGS[l].languageName)}</a>`,
    )
    .join(" · ");

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(`${status} — ${regionName} · Drive Check`)}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${PALETTE.background};color:${PALETTE.text};font:17px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
main{padding:24px 16px;max-width:32rem;text-align:center}
.region{font-size:1.25rem;margin:0}
h1{font-size:2.5rem;line-height:1.15;margin:.25em 0;color:${PHASE_COLOUR[view.phase]}}
.meta,.nearby,.note,nav,footer{color:${PALETTE.textSecondary}}
.nearby{color:${PALETTE.alert}}
.refresh{display:inline-block;margin:1rem 0;padding:.6em 1.4em;border:1px solid ${PALETTE.textSecondary};border-radius:999px;color:${PALETTE.text};text-decoration:none}
a{color:${PALETTE.text}}
a:focus-visible{outline:2px solid ${PALETTE.text};outline-offset:3px}
.note,footer{font-size:.85rem}
</style>
</head>
<body>
<main>
<p class="region">${escapeHtml(regionName)}</p>
<h1>${escapeHtml(status)}</h1>
${lines.join("\n")}
<a class="refresh" href="${link(view.region.id, lang)}">${escapeHtml(s.refresh)}</a>
<p class="note">${escapeHtml(s.informational)}</p>
<nav aria-label="${escapeHtml(s.languages)}">${languages}</nav>
<footer><a href="/v1/alerts">API</a> · ${escapeHtml(s.source)}</footer>
</main>
</body>
</html>
`;
}
