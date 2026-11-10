import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import { type AlarmDeps, runAlarm } from "../src/push/alarm";
import { MAX_LIVE_ACTIVITIES, registerLiveActivity } from "../src/push/liveActivity";
import type { PushStore } from "../src/push/registry";
import { route } from "../src/router";
import { memoryStore, TOKEN_A, TOKEN_B, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const PATH = "/v1/push/live-activity";
const DAY = 86_400_000;

/** The router with its Live Activity endpoint wired to `store`, as the Worker wires the object. */
function client(store: PushStore, clock = { now: T0 }) {
  const view: CoordinatorView = { snapshot: snapshotWith([]), rateLimitedUntil: null };
  return (method: string, body?: unknown, raw?: string) =>
    route({
      request: new Request(`https://drivecheck.example${PATH}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(raw !== undefined || body !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
      }),
      regionCode: null,
      getView: async () => view,
      getMap: async () => null,
      clock: () => clock.now,
      push: {
        register: async () => 204,
        forget: async () => {},
      },
      liveActivity: {
        register: async (registration) => registerLiveActivity(store, registration, clock.now),
        forget: async (startToken) => store.deleteLiveActivity(startToken),
      },
    });
}

const valid = { startToken: TOKEN_A, region: "kharkiv", env: "production", lang: "uk" };

const rows = (db: ReturnType<typeof memoryStore>["db"]) =>
  db.prepare("SELECT * FROM push_live_activities ORDER BY start_token").all();

describe("PUT and DELETE /v1/push/live-activity", () => {
  test("REQ-PUSHAPI-008 PUT and DELETE of a Live Activity record", async () => {
    const { db, store } = memoryStore();
    const clock = { now: T0 };
    const send = client(store, clock);

    const ok = await send("PUT", valid);
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(rows(db)).toEqual([
      {
        start_token: TOKEN_A,
        region: "kharkiv",
        env: "production",
        lang: "uk",
        activity_token: null,
        last_seen: T0,
      },
    ]);
    // A Live Activity record is not a notice registration.
    expect(db.prepare("SELECT * FROM push_devices").all()).toEqual([]);

    // The same start token with an activity token: one row, token set; uppercase hex is stored
    // lowercase. Then without it: the token is cleared.
    clock.now = T0 + 1_000;
    expect((await send("PUT", { ...valid, activityToken: TOKEN_B.toUpperCase() })).status).toBe(
      204,
    );
    expect(db.prepare("SELECT activity_token, last_seen FROM push_live_activities").all()).toEqual([
      { activity_token: TOKEN_B, last_seen: T0 + 1_000 },
    ]);
    expect((await send("PUT", valid)).status).toBe(204);
    expect(db.prepare("SELECT activity_token FROM push_live_activities").all()).toEqual([
      { activity_token: null },
    ]);

    const refused = [
      { ...valid, token: TOKEN_B },
      { ...valid, activityToken: null },
      { ...valid, activityToken: "zz" },
      { ...valid, region: "kyiv-city" },
      { ...valid, env: "dev" },
      { ...valid, lang: "de" },
      { ...valid, startToken: "" },
      { startToken: TOKEN_B, region: "kharkiv", env: "production" },
      [valid],
      null,
    ];
    for (const body of refused) {
      expect((await send("PUT", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send("PUT", undefined, "{not json")).status).toBe(400);
    expect(rows(db)).toHaveLength(1);

    for (const method of ["GET", "POST"]) {
      const response = await send(method, method === "GET" ? undefined : valid);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("PUT, DELETE");
    }

    const gone = await send("DELETE", { startToken: TOKEN_A });
    expect(gone.status).toBe(204);
    expect(rows(db)).toEqual([]);
    expect((await send("DELETE", { startToken: TOKEN_A })).status).toBe(204);
    expect((await send("DELETE", { startToken: TOKEN_A, region: "kharkiv" })).status).toBe(400);
    expect((await send("DELETE", { token: TOKEN_A })).status).toBe(400);
  });

  test("REQ-PUSHAPI-008 at most 5,000 records", async () => {
    const { db, store } = memoryStore();
    const send = client(store);
    for (let n = 0; n < MAX_LIVE_ACTIVITIES; n += 1) {
      store.upsertLiveActivity({
        startToken: tokenNo(n),
        region: "lviv",
        env: "production",
        lang: "en",
        activityToken: null,
        lastSeen: T0,
      });
    }
    expect(MAX_LIVE_ACTIVITIES).toBe(5_000);
    expect((await send("PUT", { ...valid, startToken: tokenNo(MAX_LIVE_ACTIVITIES) })).status).toBe(
      503,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_live_activities").all()).toEqual([
      { n: MAX_LIVE_ACTIVITIES },
    ]);
    expect((await send("PUT", { ...valid, startToken: tokenNo(7) })).status).toBe(204);
    expect(store.countLiveActivities()).toBe(MAX_LIVE_ACTIVITIES);
  });
});

describe("the Live Activity record", () => {
  test("REQ-PUSHAPI-009 a record keeps six fields for 60 days", async () => {
    const { db, store } = memoryStore();
    const now = T0 + 60 * DAY;
    const record = (startToken: string, lastSeen: number) => ({
      startToken,
      region: "kharkiv",
      env: "production" as const,
      lang: "en" as const,
      activityToken: null,
      lastSeen,
    });
    store.upsertLiveActivity(record(TOKEN_A, now - 60 * DAY + 1));
    store.upsertLiveActivity(record(TOKEN_B, now - 60 * DAY - 1));
    expect(Object.keys(rows(db)[0]!).sort()).toEqual([
      "activity_token",
      "env",
      "lang",
      "last_seen",
      "region",
      "start_token",
    ]);
    expect(store.countLiveActivities()).toBe(2);

    const logs: string[] = [];
    const deps: AlarmDeps = {
      store,
      refresh: async () => ({ snapshot: null, rateLimitedUntil: null }),
      deadline: () => new Promise<void>(() => {}),
      now: () => now,
      log: (m) => logs.push(m),
    };
    await runAlarm(deps, { lastPollAt: null });
    expect(db.prepare("SELECT start_token FROM push_live_activities").all()).toEqual([
      { start_token: TOKEN_A },
    ]);
    expect(store.countLiveActivities()).toBe(1);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN_A);
      expect(line).not.toContain(TOKEN_B);
    }
  });
});
