import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import { contrastRatio, escapeHtml, PALETTE } from "../src/page";
import { route, ukrainianRegionCode } from "../src/router";
import { snapshotWith, T0 } from "./support";

interface Call {
  path: string;
  view?: CoordinatorView;
  now?: number;
  regionCode?: string | null;
  headers?: Record<string, string>;
  method?: string;
  /** How long the coordinator takes to answer. */
  viewDelayMs?: number;
}

function call({
  path,
  view,
  now = T0,
  regionCode = null,
  headers = {},
  method = "GET",
  viewDelayMs = 0,
}: Call) {
  const fallback: CoordinatorView = { snapshot: snapshotWith([]), rateLimitedUntil: null };
  let clock = now;
  return route({
    request: new Request(`https://drivecheck.example${path}`, { method, headers }),
    regionCode,
    getMap: async () => null,
    getView: async () => {
      clock += viewDelayMs;
      return view ?? fallback;
    },
    clock: () => clock,
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

  test("REQ-API-001 counts age and Retry-After from when the coordinator answered", async () => {
    const view = { snapshot: snapshotWith([]), rateLimitedUntil: null };
    const body = (await (
      await call({ path: "/v1/alerts", view, now: T0 + 1_000, viewDelayMs: 4_000 })
    ).json()) as { freshness: { ageSeconds: number } };
    expect(body.freshness.ageSeconds).toBe(5);
    const limited = await call({
      path: "/v1/alerts",
      view: { snapshot: null, rateLimitedUntil: T0 + 45_000 },
      viewDelayMs: 5_000,
    });
    expect(limited.headers.get("retry-after")).toBe("40");
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
    // Spec 002 REQ-WEB-005: an external enhancing module is allowed, inline code is not.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  test("REQ-WEB-003 escapes every HTML-significant character in rendered text", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
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
    // Kyiv Oblast alone makes Kyiv city Stay Alert (REQ-SURF-010, spec 002).
    expect(quiet).toMatch(/<h1[^>]*>Stay Alert<\/h1>/);
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
    expect(html).toContain("Last known: Air Raid Alert · 12:00");
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

  test("REQ-WEB-002 uses the network region only for a Ukrainian address", () => {
    expect(ukrainianRegionCode({ country: "UA", regionCode: "46" })).toBe("46");
    expect(ukrainianRegionCode({ country: "PL", regionCode: "14" })).toBeNull();
    expect(ukrainianRegionCode({ country: "UA" })).toBeNull();
    expect(ukrainianRegionCode(undefined)).toBeNull();
  });

  test("REQ-WEB-002 an unknown network region falls back to Kyiv city", async () => {
    for (const regionCode of ["40", "43", "99"]) {
      const html = await (await call({ path: "/?lang=en", regionCode })).text();
      expect(html).toContain('<p class="region">Kyiv</p>');
    }
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

describe("region choice", () => {
  const regionName = async (res: Response) =>
    /<title>[^<]*— ([^<·]+) · Drive Check<\/title>/.exec(await res.text())?.[1]?.trim();

  test("REQ-WEB-004 the region shown: ?region=, then the cookie, then the network, then Kyiv", async () => {
    const lviv = { cookie: "theme=x; region=lviv" };
    expect(await regionName(await call({ path: "/", headers: lviv, regionCode: "30" }))).toBe(
      "Lviv Oblast",
    );
    expect(await regionName(await call({ path: "/?region=odesa", headers: lviv }))).toBe(
      "Odesa Oblast",
    );
    const bad = { cookie: "region=../x" };
    expect(await regionName(await call({ path: "/", headers: bad, regionCode: "46" }))).toBe(
      "Lviv Oblast",
    );
    expect(await regionName(await call({ path: "/", headers: bad }))).toBe("Kyiv");
  });

  test("REQ-WEB-004 a ?region= link shows its region without remembering it", async () => {
    const res = await call({ path: "/?region=odesa", headers: { cookie: "region=lviv" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("vary")).toContain("Cookie");
  });

  test("REQ-WEB-004 POST /region remembers a catalog region and returns to Status", async () => {
    const post = (body: string) =>
      route({
        request: new Request("https://drivecheck.example/region", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
        regionCode: null,
        getView: async () => ({ snapshot: snapshotWith([]), rateLimitedUntil: null }),
        getMap: async () => null,
        clock: () => T0,
      });
    const ok = await post("region=lviv");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    expect(ok.headers.get("set-cookie")).toBe(
      "region=lviv; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    // The page the visitor came from keeps its language.
    expect((await post("region=lviv&lang=uk")).headers.get("location")).toBe("/?lang=uk");
    expect((await post("region=lviv&lang=xx")).headers.get("location")).toBe("/");
    const unknown = await post("region=atlantis");
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("set-cookie")).toBeNull();
  });
});

describe("review repairs", () => {
  const post = (headers: Record<string, string>) =>
    route({
      request: new Request("https://drivecheck.example/region", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: "region=lviv",
      }),
      regionCode: null,
      getView: async () => ({ snapshot: snapshotWith([]), rateLimitedUntil: null }),
      getMap: async () => null,
      clock: () => T0,
    });

  test("REQ-WEB-004 another site cannot choose the visitor's region", async () => {
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site", origin: "null" },
      { origin: "https://evil.example" },
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // The site's own form, as browsers send it under referrer-policy: no-referrer.
    const own = await post({ "sec-fetch-site": "same-origin", origin: "null" });
    expect(own.status).toBe(303);
    const older = await post({ origin: "https://drivecheck.example" });
    expect(older.status).toBe(303);
  });

  test("REQ-WEB-006 the page allows its own origin only and cannot be framed", async () => {
    const res = await call({ path: "/?lang=en" });
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    const regions = await call({ path: "/regions?lang=en" });
    expect(regions.headers.get("content-security-policy")).toContain("connect-src 'self'");
  });

  test("REQ-WEB-004 a ?region= page keeps the region in its links", async () => {
    const html = await (await call({ path: "/?region=kharkiv&lang=en" })).text();
    expect(html).toContain('href="/?region=kharkiv&amp;lang=uk"');
    const plain = await (await call({ path: "/?region=nowhere&lang=en" })).text();
    expect(plain).not.toContain("region=nowhere");
  });
});
