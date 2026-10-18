import type { CoordinatorView } from "./coordinator";
import { checkedAt, isStale } from "./status";

export const API_VERSION = 1;

const COMMON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
};

const iso = (epochMs: number) => new Date(epochMs).toISOString();

/** `GET /v1/alerts`: the feed's own fields unchanged plus freshness (REQ-API-001, REQ-API-002). */
export function alertsResponse(view: CoordinatorView, now: number): Response {
  const { snapshot, rateLimitedUntil } = view;
  if (snapshot === null) {
    const headers: Record<string, string> = { ...COMMON_HEADERS, "cache-control": "no-store" };
    if (rateLimitedUntil !== null) {
      headers["retry-after"] = String(Math.ceil((rateLimitedUntil - now) / 1000));
    }
    return new Response(JSON.stringify({ apiVersion: API_VERSION, error: "unavailable" }), {
      status: 503,
      headers,
    });
  }
  const checked = checkedAt(snapshot);
  const body = {
    apiVersion: API_VERSION,
    source: snapshot.feed.source,
    cachedat: snapshot.feed.cachedat,
    states: snapshot.feed.states,
    freshness: {
      fetchedAt: iso(snapshot.fetchedAt),
      checkedAt: iso(checked),
      ageSeconds: Math.max(0, Math.floor((now - checked) / 1000)),
      stale: isStale(snapshot, now),
      rateLimitedUntil: rateLimitedUntil === null ? null : iso(rateLimitedUntil),
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...COMMON_HEADERS, "cache-control": "public, max-age=10" },
  });
}
