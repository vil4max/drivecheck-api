import type { Snapshot } from "./feed.ts";
import { glyph } from "./glyphs.ts";
import { heroGraphic } from "./hero.ts";
import { LANGS, STRINGS } from "./i18n.ts";
import type { Lang } from "./regions.ts";
import { PALETTE, STYLESHEET } from "./theme.ts";
import type { Accent, StatusModel } from "./view.ts";

export { contrastRatio, PALETTE } from "./theme.ts";

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

/** A link to one of the pages, keeping a `?region=` the page was opened with (REQ-WEB-004). */
export const pageHref = (path: string, lang: Lang, region: string | null) =>
  region === null ? `${path}?lang=${lang}` : `${path}?region=${region}&amp;lang=${lang}`;

/** The document every page shares: head, toolbar slot, footer and the enhancing script. */
export function documentShell(opts: {
  lang: Lang;
  title: string;
  accent: Accent;
  path: string;
  linkRegion: string | null;
  toolbar: string;
  main: string;
  /** Data the enhancing script starts from, so opening the page adds no request. */
  data?: string;
}): string {
  const s = STRINGS[opts.lang];
  const languages = LANGS.filter((l) => l !== opts.lang)
    .map(
      (l) =>
        `<a href="${pageHref(opts.path, l, opts.linkRegion)}" hreflang="${l}" lang="${l}">${escapeHtml(STRINGS[l].languageName)}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="${PALETTE.background}">
<title>${escapeHtml(opts.title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
<style>${STYLESHEET}</style>
<script type="module" src="/app/client/app.js"></script>
</head>
<body class="accent-${opts.accent}">
<div class="shell">
<header class="toolbar">${opts.toolbar}<p class="title">Drive Check</p></header>
<main id="main"${opts.data === undefined ? "" : ` data-state="${escapeHtml(opts.data)}"`}>
${opts.main}
</main>
<footer class="footer">
<button type="button" class="install" id="install">${escapeHtml(s.install)}</button>
<p class="hint" id="install-hint" data-ios="${escapeHtml(s.hintIos)}" data-mac="${escapeHtml(s.hintMac)}"></p>
<p>${escapeHtml(s.informational)}</p>
<nav aria-label="${escapeHtml(s.languages)}">${languages}</nav>
<p><a href="/v1/alerts">API</a> · ${escapeHtml(s.source)}</p>
</footer>
</div>
</body>
</html>
`;
}

/** The Status page in the iOS layout (REQ-WEB-011); complete without its script (REQ-WEB-005). */
export function renderPage(
  model: StatusModel,
  state?: { snapshot: Snapshot | null; mapFetchedAt: number | null },
): string {
  const s = STRINGS[model.lang];
  const nearby =
    model.nearby === null
      ? ""
      : `<p class="card nearby" id="nearby">${glyph("triangle")}<span>${escapeHtml(model.nearby)}</span></p>`;
  const caption =
    model.mapCaption === null
      ? ""
      : `<span class="caption" id="map-caption">${escapeHtml(model.mapCaption)}</span>`;
  const toolbar = `<a class="icon-btn end" href="${pageHref("/", model.lang, model.linkRegion)}" id="refresh" aria-label="${escapeHtml(s.refresh)}">${glyph("refresh")}</a>`;
  const main = `<section class="hero" id="hero" data-region="${model.regionId}">
${heroGraphic(model.symbol)}
<h1 id="status" aria-live="polite">${escapeHtml(model.title)}</h1>
<p class="region">${escapeHtml(model.regionName)}</p>
<p class="meta" id="meta">${escapeHtml(model.meta)}</p>
</section>
${nearby}
<a href="${pageHref("/regions", model.lang, model.linkRegion)}" class="card map${model.mapMissing ? " no-image" : ""}" id="map" aria-label="${escapeHtml(model.mapLabel)}" aria-describedby="map-hint">
${caption}
<span class="failed">${glyph("offline")}<span>${escapeHtml(s.mapError)}</span></span>
<span class="image" style="background-image:url(/v1/map)"></span>
<span class="sr-only" id="map-hint">${escapeHtml(s.opensRegions)}</span>
</a>`;
  return documentShell({
    lang: model.lang,
    title: model.documentTitle,
    accent: model.accent,
    path: "/",
    linkRegion: model.linkRegion,
    toolbar,
    main,
    ...(state === undefined ? {} : { data: JSON.stringify(state) }),
  });
}
