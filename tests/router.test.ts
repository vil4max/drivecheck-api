import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import { contrastRatio, PALETTE } from "../src/page";
import { route } from "../src/router";
import { snapshotWith, T0 } from "./support";

interface Call {
  path: string;
  view?: CoordinatorView;
  now?: number;
  regionCode?: string | null;
  headers?: Record<string, string>;
  method?: string;
}

function call({ path, view, now = T0, regionCode = null, headers = {}, method = "GET" }: Call) {
  const fallback: CoordinatorView = { snapshot: snapshotWith([]), rateLimitedUntil: null };
  return route({
    request: new Request(`https://drivecheck.example${path}`, { method, headers }),
    regionCode,
    getView: async () => view ?? fallback,
    now,
  });
}

describe("GET /v1/alerts", () => {
  test("REQ-API-001 mirrors the feed and adds freshness, cache and CORS headers", async () => {
    const snapshot = snapshotWith(["м. Київ"]);
    const response = await call({
      path: "/v1/alerts",
      view: { snapshot, rateLimitedUntil: null },
      now: T0 + 30_000,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=10");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.apiVersion).toBe(1);
    expect(body.source).toBe(snapshot.feed.source);
    expect(body.cachedat).toBe("2026-10-18 12:00:00");
    expect(body.states).toEqual(snapshot.feed.states);
    expect(body.freshness).toEqual({
      fetchedAt: "2026-10-18T09:00:00.000Z",
      checkedAt: "2026-10-18T09:00:00.000Z",
      ageSeconds: 30,
      stale: false,
      rateLimitedUntil: null,
    });
  });

  test("REQ-REFRESH-006 reports stale and the open rate-limit window", async () => {
    const view = { snapshot: snapshotWith([]), rateLimitedUntil: T0 + 200_000 };
    const body = (await (await call({ path: "/v1/alerts", view, now: T0 + 150_000 })).json()) as {
      freshness: { stale: boolean; rateLimitedUntil: string };
    };
    expect(body.freshness.stale).toBe(true);
    expect(body.freshness.rateLimitedUntil).toBe("2026-10-18T09:03:20.000Z");
  });

  test("REQ-API-002 answers 503 with Retry-After when no snapshot is held", async () => {
    const response = await call({
      path: "/v1/alerts",
      view: { snapshot: null, rateLimitedUntil: T0 + 45_000 },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("45");
    expect(await response.json()).toEqual({ apiVersion: 1, error: "unavailable" });
  });

  test("REQ-API-001 rejects other methods and unknown paths", async () => {
    expect((await call({ path: "/v1/alerts", method: "POST" })).status).toBe(405);
    expect((await call({ path: "/v2/alerts" })).status).toBe(404);
  });
});

describe("GET /", () => {
  test("REQ-WEB-003 renders the status as the only h1 with its region and Kyiv update time", async () => {
    const view = { snapshot: snapshotWith(["м. Київ"]), rateLimitedUntil: null };
    const html = await (await call({ path: "/?lang=en", view })).text();
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Air Raid Alert<\/h1>/);
    expect(html).toContain("Kyiv");
    expect(html).toContain("Updated 12:00");
    expect(html).not.toContain("<script");
  });

  test("REQ-WEB-003 every text colour has at least 4.5:1 contrast on the background", () => {
    for (const colour of [
      PALETTE.clear,
      PALETTE.alert,
      PALETTE.noData,
      PALETTE.text,
      PALETTE.textSecondary,
    ]) {
      expect(contrastRatio(colour, PALETTE.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("REQ-SURF-005 shows the nearby line only when a neighbour is under alert", async () => {
    const quiet = await (
      await call({
        path: "/?lang=en",
        view: { snapshot: snapshotWith(["Київська область"]), rateLimitedUntil: null },
      })
    ).text();
    expect(quiet).toMatch(/<h1[^>]*>No Alert<\/h1>/);
    expect(quiet).toContain("Nearby: Kyiv Oblast");
    const none = await (await call({ path: "/?lang=en" })).text();
    expect(none).not.toContain("Nearby");
  });

  test("REQ-PROVIDER-003 states that the data is informational", async () => {
    const html = await (await call({ path: "/?lang=en" })).text();
    expect(html).toContain("Alert data is informational only.");
  });

  test("REQ-REFRESH-006 a stale page keeps the status and says it is not current", async () => {
    const view = { snapshot: snapshotWith(["м. Київ"]), rateLimitedUntil: null };
    const html = await (await call({ path: "/?lang=en", view, now: T0 + 600_000 })).text();
    expect(html).toMatch(/<h1[^>]*>Air Raid Alert<\/h1>/);
    expect(html).toContain("Last known · Updated 12:00");
  });

  test("REQ-API-002 the page shows Unavailable with 503 when there is no snapshot", async () => {
    const response = await call({
      path: "/?lang=en",
      view: { snapshot: null, rateLimitedUntil: null },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/<h1[^>]*>Unavailable<\/h1>/);
  });

  test("REQ-WEB-001 picks the language from ?lang, then Accept-Language, else English", async () => {
    const uk = await (await call({ path: "/?lang=uk" })).text();
    expect(uk).toContain('<html lang="uk"');
    expect(uk).toMatch(/<h1[^>]*>Тривоги немає<\/h1>/);
    expect(uk).toContain("Київ");
    const ru = await (
      await call({ path: "/", headers: { "accept-language": "de-DE, ru;q=0.8, en;q=0.5" } })
    ).text();
    expect(ru).toContain('<html lang="ru"');
    expect(ru).toContain("Тревоги нет");
    const en = await (await call({ path: "/", headers: { "accept-language": "de" } })).text();
    expect(en).toContain('<html lang="en"');
    expect(en).toContain('hreflang="uk"');
    expect(en).toContain('hreflang="ru"');
  });

  test("REQ-WEB-002 picks the region from ?region, then the network region, else Kyiv city", async () => {
    const lviv = await (await call({ path: "/?lang=en", regionCode: "46" })).text();
    expect(lviv).toContain("Lviv Oblast");
    const odesa = await (await call({ path: "/?lang=en&region=odesa", regionCode: "46" })).text();
    expect(odesa).toContain("Odesa Oblast");
    const fallback = await (
      await call({ path: "/?lang=en&region=nowhere", regionCode: null })
    ).text();
    expect(fallback).toContain("Kyiv");
  });
});
