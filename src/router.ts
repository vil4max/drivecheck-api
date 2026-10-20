import { alertsResponse } from "./api.ts";
import type { CoordinatorView, MapImage } from "./coordinator.ts";
import { negotiateLanguage } from "./i18n.ts";
import { renderPage } from "./page.ts";
import { DEFAULT_REGION, type Region, regionById, regionByIsoCode } from "./regions.ts";
import { statusView } from "./status.ts";

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

function pickRegion(query: string | null, regionCode: string | null): Region {
  return (
    (query === null ? undefined : regionById(query)) ??
    (regionCode === null ? undefined : regionByIsoCode(regionCode)) ??
    DEFAULT_REGION
  );
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
  if (!["/", "/v1/alerts", "/v1/map"].includes(url.pathname)) {
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
  const region = pickRegion(url.searchParams.get("region"), regionCode);
  const status = statusView(view.snapshot, region, now);
  return new Response(renderPage(status, lang), {
    status: view.snapshot === null ? 503 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=10",
      vary: "Accept-Language",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
