import { describe, expect, test } from "vitest";
import { FeedError, kyivTimeToEpochMs, parseFeed } from "../src/feed";
import { rateLimitDeadline } from "../src/retryAfter";
import { feedJson } from "./support";

describe("feed", () => {
  test("REQ-PROVIDER-001 reads alertnow, changed, source and cachedat from the feed", () => {
    const feed = parseFeed(feedJson());
    expect(feed.source).toBe("fixture");
    expect(feed.cachedat).toBe("2026-08-02 00:00:00");
    expect(feed.states["м. Київ"]?.alertnow).toBeTypeOf("boolean");
    expect(Object.keys(feed.states)).toHaveLength(26);
  });

  test("REQ-PROVIDER-001 rejects a body without states or with a non-boolean alertnow", () => {
    expect(() => parseFeed({ source: "x", cachedat: "y" })).toThrow(FeedError);
    expect(() =>
      parseFeed({ source: "x", cachedat: "y", states: { a: { alertnow: "yes" } } }),
    ).toThrow(FeedError);
  });

  test("REQ-PROVIDER-001 converts cachedat from Europe/Kyiv local time in summer and winter", () => {
    expect(kyivTimeToEpochMs("2026-08-02 00:00:00")).toBe(Date.UTC(2026, 7, 1, 21, 0, 0));
    expect(kyivTimeToEpochMs("2026-12-01 12:30:15")).toBe(Date.UTC(2026, 11, 1, 10, 30, 15));
    expect(kyivTimeToEpochMs("not a time")).toBeNull();
  });
});

describe("Retry-After", () => {
  const now = Date.UTC(2026, 9, 18, 9, 0, 0);

  test("REQ-REFRESH-005 honours delta-seconds and an HTTP date", () => {
    expect(rateLimitDeadline("45", now, 1)).toBe(now + 45_000);
    expect(rateLimitDeadline("Sun, 18 Oct 2026 09:01:30 GMT", now, 1)).toBe(now + 90_000);
  });

  test("REQ-REFRESH-005 caps the window at 5 minutes and treats a past date as now", () => {
    expect(rateLimitDeadline("3600", now, 1)).toBe(now + 300_000);
    expect(rateLimitDeadline("Sun, 18 Oct 2026 08:00:00 GMT", now, 1)).toBe(now);
    expect(rateLimitDeadline("-5", now, 1)).toBe(now);
  });

  test("REQ-REFRESH-005 backs off 30 s, 60 s, 120 s up to 5 minutes without a usable header", () => {
    expect(rateLimitDeadline(null, now, 1)).toBe(now + 30_000);
    expect(rateLimitDeadline("soon", now, 2)).toBe(now + 60_000);
    expect(rateLimitDeadline(null, now, 3)).toBe(now + 120_000);
    expect(rateLimitDeadline(null, now, 9)).toBe(now + 300_000);
  });
});
