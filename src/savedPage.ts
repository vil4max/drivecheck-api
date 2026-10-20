import type { Snapshot } from "./feed.ts";
import { LANGS } from "./i18n.ts";
import { renderPage } from "./page.ts";
import { type Lang, regionById } from "./regions.ts";
import { statusModel } from "./view.ts";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * A saved Status page drawn again for `now` from the answer it carries, so a page served offline
 * shows its age (REQ-REFRESH-006) even when its script cannot run. Any other page is returned as
 * it was saved.
 */
export function redrawSaved(html: string, now: number): string {
  const state = /<main id="main" data-state="([^"]*)">/.exec(html)?.[1];
  const regionId = /<section class="hero" id="hero" data-region="([^"]+)">/.exec(html)?.[1];
  const lang = /<html lang="([a-z]+)">/.exec(html)?.[1];
  const region = regionById(regionId ?? "");
  if (state === undefined || region === undefined || !LANGS.includes(lang as Lang)) return html;
  const data = JSON.parse(state.replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]!)) as {
    snapshot: Snapshot | null;
    mapFetchedAt: number | null;
  };
  return renderPage(statusModel(data.snapshot, region, lang as Lang, now, data.mapFetchedAt), data);
}
