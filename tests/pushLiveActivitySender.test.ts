import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, type AlarmState, runAlarm } from "../src/push/alarm";
import { type ApnsCredentials, apnsSender, ProviderToken } from "../src/push/apns";
import { registerLiveActivity } from "../src/push/liveActivity";
import type { PushStore } from "../src/push/registry";
import { sendBatch, sendUpdates } from "../src/push/sender";
import { memoryStore, TOKEN_A, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
const LVIV = "Львівська область";
const S1 = tokenNo(0x51);
const S2 = tokenNo(0x52);
const ACT1 = tokenNo(0xa1);
const TOPIC = "vil4max.RegionalCheck";

async function credentials(): Promise<ApnsCredentials> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const key = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { key, keyId: "KEYID12345", teamId: "TEAMID1234", topic: TOPIC };
}

interface Sent {
  token: string;
  headers: Record<string, string>;
  aps: Record<string, unknown>;
}

function snap(alarmKeys: string[], t: number, ageMs = 0): Snapshot {
  return { ...snapshotWith(alarmKeys), fetchedAt: t, serverCachedAt: t - ageMs };
}

function addRecord(
  store: PushStore,
  startToken: string,
  region: string,
  activityToken: string | null,
  now = T0,
) {
  registerLiveActivity(
    store,
    { startToken, region, env: "production", lang: "en", activityToken },
    now,
  );
}

/** The whole loop with a fake APNs that answers by token and records every request. */
async function harness(answer: (token: string) => [number, string | null] = () => [200, null]) {
  const { db, store } = memoryStore();
  const clock = { now: T0 };
  const sent: Sent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url: string, init: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    const token = url.split("/").pop()!;
    sent.push({
      token,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      aps: JSON.parse(String(init.body)).aps,
    });
    const [status, reason] = answer(token);
    return new Response(reason === null ? null : JSON.stringify({ reason }), { status });
  };
  const send = apnsSender(new ProviderToken(await credentials(), () => clock.now), fetch, () => {});
  let view: CoordinatorView = { snapshot: null, rateLimitedUntil: null };
  const state: AlarmState = { lastPollAt: null };
  const deps: AlarmDeps = {
    store,
    refresh: async () => view,
    deadline: () => new Promise<void>(() => {}),
    now: () => clock.now,
    sendBatch: (limit) =>
      sendBatch(store, send, () => {}, {
        limit,
        latest: state.latest ?? null,
        now: () => clock.now,
      }),
    sendUpdates: (walk, limit) =>
      sendUpdates(store, walk, send, () => {}, {
        limit,
        latest: state.latest ?? null,
        now: () => clock.now,
      }),
    log: () => {},
  };
  return {
    db,
    store,
    sent,
    state,
    maxInFlight: () => maxInFlight,
    /** One alarm at `t` that sees `snapshot` (null: the feed failed). */
    alarm: (t: number, snapshot: Snapshot | null) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil: null };
      return runAlarm(deps, state);
    },
    /** Alarms at `t` until nothing is left to send this round. */
    drain: async (t: number, snapshot: Snapshot | null) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil: null };
      let next = await runAlarm(deps, state);
      while (next !== null && next - clock.now <= 1_000) {
        clock.now = next;
        next = await runAlarm(deps, state);
      }
    },
    activityToken: (startToken: string) =>
      (
        db
          .prepare("SELECT activity_token FROM push_live_activities WHERE start_token = ?")
          .all(startToken)[0] as { activity_token: string | null } | undefined
      )?.activity_token,
  };
}

const unix = (ms: number) => Math.floor(ms / 1000);

describe("sending Live Activity pushes", () => {
  test("REQ-PUSH-008 the alert start reaches the notice device and every record", async () => {
    const h = await harness();
    h.store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    addRecord(h.store, S1, "kharkiv", null);
    await h.alarm(T0, snap([], T0));
    await h.drain(T0 + 30_000, snap([KHARKIV], T0 + 30_000));
    const notice = h.sent.find((s) => s.token === TOKEN_A)!;
    expect(notice.headers["apns-push-type"]).toBe("alert");
    expect(notice.headers["apns-topic"]).toBe(TOPIC);
    expect(notice.headers["apns-expiration"]).toBe(String(unix(T0 + 30_000) + 300));
    expect(notice.aps["interruption-level"]).toBe("time-sensitive");
    expect(notice.aps.sound).toBe("drivecheck.caf");
    const start = h.sent.find((s) => s.token === S1)!;
    expect(start.headers["apns-push-type"]).toBe("liveactivity");
    expect(start.headers["apns-topic"]).toBe(`${TOPIC}.push-type.liveactivity`);
    expect(start.headers["apns-priority"]).toBe("10");
    expect(start.headers["apns-expiration"]).toBe(String(unix(T0 + 30_000) + 300));
    expect(start.aps.event).toBe("start");
    expect(h.sent).toHaveLength(2);
  });

  test("REQ-PUSH-008 updates every 5 minutes while the alarm lasts", async () => {
    const h = await harness();
    addRecord(h.store, S1, "kharkiv", null);
    addRecord(h.store, S2, "kharkiv", null);
    await h.alarm(T0, snap([], T0));
    const startAt = T0 + 30_000;
    await h.drain(startAt, snap([KHARKIV], startAt));
    expect(h.sent.map((s) => s.aps.event)).toEqual(["start", "start"]);
    // The app sends back the update token of S1's new activity; S2 never does.
    addRecord(h.store, S1, "kharkiv", ACT1, startAt + 5_000);

    for (let t = startAt + 30_000; t <= startAt + 270_000; t += 30_000) {
      await h.drain(t, snap([KHARKIV], t));
    }
    expect(h.sent).toHaveLength(2);
    // Due at 5 minutes, but the feed is stale then: nothing until the next fresh snapshot.
    await h.drain(startAt + 300_000, snap([KHARKIV], startAt + 300_000, 120_001));
    expect(h.sent).toHaveLength(2);
    const fresh = startAt + 330_000;
    await h.drain(fresh, snap([KHARKIV], fresh));
    expect(h.sent).toHaveLength(3);
    const update = h.sent[2]!;
    expect(update.token).toBe(ACT1);
    expect(update.headers["apns-priority"]).toBe("5");
    expect(update.headers["apns-push-type"]).toBe("liveactivity");
    expect(update.aps.event).toBe("update");
    expect(update.aps["stale-date"]).toBe(unix(fresh) + 900);
    // The next one is 5 minutes later, not at the next poll.
    await h.drain(fresh + 30_000, snap([KHARKIV], fresh + 30_000));
    expect(h.sent).toHaveLength(3);
    await h.drain(fresh + 300_000, snap([KHARKIV], fresh + 300_000));
    expect(h.sent).toHaveLength(4);
  });

  test("REQ-PUSH-008 a fresh clear ends the activity in green", async () => {
    const h = await harness((token) =>
      token === tokenNo(0xb2) ? [500, "InternalServerError"] : [200, null],
    );
    h.store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    addRecord(h.store, S1, "kharkiv", ACT1);
    await h.alarm(T0, snap([KHARKIV], T0));
    h.sent.length = 0;
    const clearAt = T0 + 30_000;
    await h.drain(clearAt, snap([], clearAt));
    expect(h.sent.map((s) => [s.token, s.aps.event ?? "notice"]).sort()).toEqual([
      [ACT1, "end"],
      [TOKEN_A, "notice"],
    ]);
    const end = h.sent.find((s) => s.token === ACT1)!;
    expect(end.headers["apns-priority"]).toBe("10");
    expect(end.headers["apns-expiration"]).toBe(String(unix(clearAt) + 4 * 3600));
    expect(end.aps["dismissal-date"]).toBe(unix(clearAt) + 300);
    expect((end.aps["content-state"] as { phase: string }).phase).toBe("quiet");
    expect(h.activityToken(S1)).toBeNull();
    // Nothing more on later clears.
    await h.drain(clearAt + 30_000, snap([], clearAt + 30_000));
    expect(h.sent).toHaveLength(2);

    // After an 11-minute gap: no notice, but the end still goes out.
    const gap = await harness();
    gap.store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    addRecord(gap.store, S1, "kharkiv", ACT1);
    // A cold start in alarm updates the held activity at once (updates follow any fresh state).
    await gap.alarm(T0, snap([KHARKIV], T0));
    expect(gap.sent.map((s) => [s.token, s.aps.event])).toEqual([[ACT1, "update"]]);
    gap.sent.length = 0;
    await gap.drain(T0 + 660_000, snap([], T0 + 660_000));
    expect(gap.sent.map((s) => [s.token, s.aps.event])).toEqual([[ACT1, "end"]]);

    // An end APNs answers with 500 is tried once: the token is cleared, nothing is repeated.
    addRecord(h.store, S2, "lviv", tokenNo(0xb2));
    await h.drain(clearAt + 60_000, snap([], clearAt + 60_000));
    await h.drain(clearAt + 90_000, snap([], clearAt + 90_000));
    expect(h.sent.filter((s) => s.token === tokenNo(0xb2))).toHaveLength(1);
    expect(h.activityToken(S2)).toBeNull();
  });

  test("REQ-PUSH-008 a moved activity shows the new region's fresh state", async () => {
    const h = await harness();
    addRecord(h.store, S1, "kharkiv", ACT1);
    addRecord(h.store, S2, "kharkiv", tokenNo(0xa2));
    await h.drain(T0, snap([KHARKIV, LVIV], T0));
    h.sent.length = 0;
    // S1 moves into Lviv, in alarm: one red update named for Lviv, no end.
    addRecord(h.store, S1, "lviv", ACT1, T0 + 10_000);
    await h.drain(T0 + 15_000, null);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.aps.event).toBe("update");
    expect(h.sent[0]!.aps["content-state"]).toMatchObject({
      phase: "alarm",
      regionTitle: "Lviv Oblast",
    });
    // S2 moves into Odesa, clear: one green end named for Odesa, and its token is forgotten.
    addRecord(h.store, S2, "odesa", tokenNo(0xa2), T0 + 20_000);
    await h.drain(T0 + 25_000, null);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.aps.event).toBe("end");
    expect(h.sent[1]!.aps["content-state"]).toMatchObject({
      phase: "quiet",
      regionTitle: "Odesa Oblast",
    });
    expect(h.activityToken(S2)).toBeNull();

    // With no fresh state when it is sent, a move sends nothing.
    const stale = await harness();
    addRecord(stale.store, S1, "kharkiv", ACT1);
    await stale.drain(T0, snap([KHARKIV], T0));
    stale.sent.length = 0;
    addRecord(stale.store, S1, "lviv", ACT1, T0 + 200_000);
    await stale.drain(T0 + 200_000, null);
    expect(stale.sent).toEqual([]);
  });

  test("REQ-PUSHAPI-011 APNs answers by token kind", async () => {
    const answers: Record<string, [number, string | null]> = {
      [S1]: [410, "Unregistered"],
      [ACT1]: [410, "Unregistered"],
      [TOKEN_A]: [410, "Unregistered"],
      [tokenNo(0xa2)]: [429, "TooManyRequests"],
    };
    const h = await harness((token) => answers[token] ?? [200, null]);
    h.store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    addRecord(h.store, S1, "kharkiv", null);
    addRecord(h.store, S2, "lviv", ACT1);
    addRecord(h.store, tokenNo(0x54), "lviv", tokenNo(0xa2));
    await h.alarm(T0, snap([LVIV], T0));
    await h.drain(T0 + 30_000, snap([KHARKIV, LVIV], T0 + 30_000));
    // The start token APNs calls gone deletes its record; the notice token its device.
    expect(h.store.liveActivity(S1)).toBeNull();
    expect(h.db.prepare("SELECT token FROM push_devices").all()).toEqual([]);
    // The update token APNs calls gone is cleared, the record stays; 429 changes nothing.
    expect(h.store.liveActivity(S2)?.activityToken).toBeNull();
    expect(h.store.liveActivity(tokenNo(0x54))?.activityToken).toBe(tokenNo(0xa2));
    // One request each, nothing retried.
    expect(h.sent.filter((s) => s.token === tokenNo(0xa2))).toHaveLength(1);
  });

  test("REQ-PUSHAPI-004 the update walk sends at most 45 per invocation", async () => {
    const h = await harness();
    for (let n = 0; n < 100; n += 1)
      addRecord(h.store, tokenNo(0x1000 + n), "kharkiv", tokenNo(0x2000 + n));
    // A cold start in alarm: the held activities are updated at once, in rounds of 45.
    const counts: number[] = [];
    let before = 0;
    let next = await h.alarm(T0, snap([KHARKIV], T0));
    counts.push(h.sent.length - before);
    before = h.sent.length;
    while (next !== null && next - T0 <= 5_000) {
      next = await h.alarm(next, snap([KHARKIV], T0));
      counts.push(h.sent.length - before);
      before = h.sent.length;
    }
    expect(counts.filter((n) => n > 0)).toEqual([45, 45, 10]);
    expect(new Set(h.sent.map((s) => s.token)).size).toBe(100);
    expect(h.maxInFlight()).toBeLessThanOrEqual(6);

    // An eviction mid-walk loses the memory: the next poll walks the region again from the start,
    // so no record is skipped.
    const e = await harness();
    for (let n = 0; n < 50; n += 1)
      addRecord(e.store, tokenNo(0x1000 + n), "kharkiv", tokenNo(0x2000 + n));
    await e.alarm(T0, snap([KHARKIV], T0));
    expect(e.sent).toHaveLength(45);
    delete e.state.walk;
    delete e.state.updatedAt;
    e.state.lastPollAt = null;
    await e.drain(T0 + 30_000, snap([KHARKIV], T0 + 30_000));
    expect(new Set(e.sent.map((s) => s.token)).size).toBe(50);
  });
});
