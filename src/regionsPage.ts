import { glyph } from "./glyphs.ts";
import { STRINGS } from "./i18n.ts";
import { documentShell, escapeHtml, pageHref } from "./page.ts";
import type { RegionRow, RegionsModel } from "./view.ts";

function row(r: RegionRow, alertLabel: string): string {
  const current = r.current ? ' aria-current="true"' : "";
  const marker = r.current ? glyph("location") : "";
  const state = r.state === "on" ? `<span class="state">${escapeHtml(alertLabel)}</span>` : "";
  return `<li><button class="row" type="submit" name="region" value="${r.id}"${current}><span class="dot ${r.state}"></span><span class="name">${escapeHtml(r.name)}</span>${marker}${state}</button></li>`;
}

/**
 * The Regions page, as iOS `RegionListView` (REQ-WEB-013). Each row is a submit button of one
 * form, so picking a region works without JavaScript (REQ-WEB-004).
 */
export function renderRegions(model: RegionsModel): string {
  const s = STRINGS[model.lang];
  const pill =
    model.current.pill === null
      ? ""
      : `<span class="pill">${escapeHtml(model.current.pill)}</span>`;
  const alerting =
    model.alerting.length === 0
      ? ""
      : `<section class="section"><h2>${escapeHtml(s.alertSection(model.alerting.length))}</h2><ul class="card group alerting">${model.alerting.map((r) => row(r, s.alertShort)).join("")}</ul></section>`;
  const main = `<h1 class="page-title">${escapeHtml(s.regions)}</h1>
<div class="card current accent-${model.current.accent}"><span class="pin">${glyph("location")}</span><span class="grow"><span class="label">${escapeHtml(s.currentRegion)}</span><span class="name">${escapeHtml(model.current.name)}</span></span>${pill}</div>
<form method="post" action="/region" class="regions">
${alerting}
<section class="section"><h2>${escapeHtml(s.otherRegions)}</h2><ul class="card group">${model.others.map((r) => row(r, s.alertShort)).join("")}</ul></section>
</form>`;
  const toolbar = `<a class="icon-btn start" href="${pageHref("/", model.lang)}" aria-label="${escapeHtml(s.back)}">${glyph("back")}</a>`;
  return documentShell({
    lang: model.lang,
    title: `${s.regions} · Drive Check`,
    accent: model.current.accent,
    path: "/regions",
    toolbar,
    main,
  });
}
