import { alertsResponse } from "./api.ts";
import type { CoordinatorView, MapImage } from "./coordinator.ts";
import { LANGS, negotiateLanguage } from "./i18n.ts";
import { renderPage } from "./page.ts";
import { parseRegionCookie, regionCookie } from "./regionCookie.ts";
import { DEFAULT_REGION, type Region, regionById, regionByIsoCode } from "./regions.ts";
import { renderRegions } from "./regionsPage.ts";
import { regionsModel, statusModel } from "./view.ts";

export interface RouteInput {
  request: Request;
  /** `request.cf.regionCode`, only when Cloudflare places the address in Ukraine. */
  regionCode: string | null;
  getView: () => Promise<CoordinatorView>;
  getMap: () => Promise<MapImage | null>;
  /** Read after the view arrives, so ages and Retry-After count from the answer, not the request. */
  clock: () => number;
}

/** The ISO 3166-2:UA code of the visitor's network region, used for this response only. */
export function ukrainianRegionCode(
  cf: { country?: unknown; regionCode?: unknown } | undefined,
): string | null {
  return cf?.country === "UA" && typeof cf.regionCode === "string" ? cf.regionCode : null;
}

/** REQ-WEB-004: `?region=`, the visitor's cookie, the network region, Kyiv city. */
function pickRegion(
  query: string | null,
  cookie: string | null,
  regionCode: string | null,
): Region {
  return (
    (query === null ? undefined : regionById(query)) ??
    parseRegionCookie(cookie) ??
    (regionCode === null ? undefined : regionByIsoCode(regionCode)) ??
    DEFAULT_REGION
  );
}

/** `POST /region` from the Regions page without JavaScript: remember, then show Status. */
async function chooseRegion(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const region = regionById(form.get("region") ?? "");
  if (region === undefined) return new Response("Unknown region", { status: 400 });
  const lang = form.get("lang") ?? "";
  return new Response(null, {
    status: 303,
    headers: {
      // Back in the language the visitor chose; anything else falls to negotiation.
      location: (LANGS as readonly string[]).includes(lang) ? `/?lang=${lang}` : "/",
      "set-cookie": regionCookie(region.id),
      "cache-control": "no-store",
    },
  });
}

/** `GET /v1/map`: the held raster, or 503 and nothing older (REQ-WEB-012). */
function mapResponse(image: MapImage | null): Response {
  if (image === null) {
    return new Response("Map unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(image.bytes, {
    headers: {
      "content-type": image.contentType,
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function route({
  request,
  regionCode,
  getView,
  getMap,
  clock,
}: RouteInput): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/region" && request.method === "POST") return chooseRegion(request);
  if (!["/", "/regions", "/v1/alerts", "/v1/map"].includes(url.pathname)) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (url.pathname === "/v1/map") return mapResponse(await getMap());
  const view = await getView();
  const now = clock();
  if (url.pathname === "/v1/alerts") return alertsResponse(view, now);

  const lang = negotiateLanguage(
    url.searchParams.get("lang"),
    request.headers.get("accept-language"),
  );
  const region = pickRegion(
    url.searchParams.get("region"),
    request.headers.get("cookie"),
    regionCode,
  );
  const mapFetchedAt = view.mapFetchedAt ?? null;
  const html =
    url.pathname === "/regions"
      ? renderRegions(regionsModel(view.snapshot, region, lang))
      : renderPage(statusModel(view.snapshot, region, lang, now, mapFetchedAt), {
          snapshot: view.snapshot,
          mapFetchedAt,
        });
  return new Response(html, {
    status: view.snapshot === null ? 503 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=10",
      vary: "Accept-Language, Cookie",
      "content-security-policy": PAGE_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Everything from this origin only (REQ-WEB-006); `data:` for the CSS-drawn location glyph. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");
