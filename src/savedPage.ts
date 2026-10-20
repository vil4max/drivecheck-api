import type { Snapshot } from "./feed.ts";
import { LANGS } from "./i18n.ts";
import { renderPage } from "./page.ts";
import { type Lang, regionById } from "./regions.ts";
import { renderRegions } from "./regionsPage.ts";
import { regionsModel, statusModel } from "./view.ts";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** An attribute's value from the first `<tag …>` in the page, in any attribute order. */
function attribute(html: string, tag: string, name: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0];
  if (open === undefined) return undefined;
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
  return value?.replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]!);
}

/**
 * A saved Status or Regions page drawn again for `now` from the answer it carries, so a page
 * served offline shows its age and "Last known" (REQ-REFRESH-006) even when its script cannot run.
 * A page that carries no answer (the offline page) is returned as it was saved.
 */
export function redrawSaved(html: string, now: number): string {
  const page = attribute(html, "main", "data-page");
  const state = attribute(html, "main", "data-state");
  const region = regionById(attribute(html, "main", "data-region") ?? "");
  const lang = attribute(html, "html", "lang") as Lang | undefined;
  if (state === undefined || region === undefined || lang === undefined || !LANGS.includes(lang)) {
    return html;
  }
  const data = JSON.parse(state) as { snapshot: Snapshot | null; mapFetchedAt: number | null };
  if (page === "regions") {
    return renderRegions(regionsModel(data.snapshot, region, lang, null, now), data);
  }
  if (page === "status") {
    return renderPage(statusModel(data.snapshot, region, lang, now, data.mapFetchedAt), data);
  }
  return html;
}
