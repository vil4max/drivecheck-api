import { describe, expect, test } from "vitest";
import { memoryStore, pushClient } from "./pushSupport";

/**
 * Apple fixes no token size ("APNs device tokens are of variable length. Don't hard-code their
 * size."); a real ActivityKit push-to-start token measured 256 hex digits on 2026-11-12, and the
 * old 200-digit cap answered its record with 400 (regional-check BUG-LA-push-start).
 */
const hex = (digits: number) => "ab".repeat(Math.ceil(digits / 2)).slice(0, digits);

describe("token length", () => {
  test("REQ-PUSHAPI-008 a Live Activity record takes tokens of 1 to 1024 hex digits", async () => {
    const { db, store } = memoryStore();
    const send = pushClient("/v1/push/live-activity", store);
    const record = (startToken: string, activityToken?: string) => ({
      startToken,
      region: "kharkiv",
      env: "production",
      lang: "uk",
      ...(activityToken === undefined ? {} : { activityToken }),
    });

    expect((await send("PUT", record(hex(256), hex(256)))).status).toBe(204);
    expect((await send("PUT", record(hex(1024)))).status).toBe(204);
    expect((await send("PUT", record("a"))).status).toBe(204);
    expect((await send("PUT", record(hex(1025)))).status).toBe(400);
    expect((await send("PUT", record(hex(256), hex(1025)))).status).toBe(400);
    expect((await send("PUT", record(`${hex(255)}g`))).status).toBe(400);
    expect(
      db.prepare("SELECT length(start_token) AS n FROM push_live_activities ORDER BY n").all(),
    ).toEqual([{ n: 1 }, { n: 256 }, { n: 1024 }]);
  });

  test("REQ-PUSHAPI-001 a notice registration takes tokens of 1 to 1024 hex digits", async () => {
    const { db, store } = memoryStore();
    const send = pushClient("/v1/push/registration", store);
    const device = (token: string) => ({ token, region: "kharkiv", env: "production", lang: "uk" });

    expect((await send("PUT", device(hex(256)))).status).toBe(204);
    expect((await send("PUT", device(hex(1025)))).status).toBe(400);
    expect(db.prepare("SELECT length(token) AS n FROM push_devices").all()).toEqual([{ n: 256 }]);
  });
});
