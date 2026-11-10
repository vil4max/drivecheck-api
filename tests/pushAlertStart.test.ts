import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, type AlarmState, runAlarm } from "../src/push/alarm";
import { registerLiveActivity } from "../src/push/liveActivity";
import type { PushStore } from "../src/push/registry";
import { memoryStore, TOKEN_A, TOKEN_B, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
const LVIV = "Львівська область";
const S1 = tokenNo(0x51);
const S2 = tokenNo(0x52);
const S3 = tokenNo(0x53);
const ACT1 = tokenNo(0xa1);
const ACT3 = tokenNo(0xa3);

/** A snapshot fetched at `t`, cached upstream `ageMs` earlier (over 2 minutes is stale). */
function snap(alarmKeys: string[], t: number, ageMs = 0): Snapshot {
  return { ...snapshotWith(alarmKeys), fetchedAt: t, serverCachedAt: t - ageMs };
}

function addRecord(
  store: PushStore,
  startToken: string,
  region: string,
  activityToken: string | null = null,
  now = T0,
) {
  registerLiveActivity(
    store,
    { startToken, region, env: "production", lang: "en", activityToken },
    now,
  );
}

/** Notice devices A (Kharkiv) and B (Lviv), records S1, S2 (Kharkiv) and S3 (Lviv). */
function harness(withDevices = true) {
  const { db, store } = memoryStore();
  if (withDevices) {
    store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    store.upsertDevice({
      token: TOKEN_B,
      region: "lviv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
  }
  addRecord(store, S1, "kharkiv");
  addRecord(store, S2, "kharkiv");
  addRecord(store, S3, "lviv");
  const clock = { now: T0 };
  let view: CoordinatorView = { snapshot: null, rateLimitedUntil: null };
  const deps: AlarmDeps = {
    store,
    refresh: async () => view,
    deadline: () => new Promise<void>(() => {}),
    now: () => clock.now,
    log: () => {},
  };
  const state: AlarmState = { lastPollAt: null };
  return {
    db,
    store,
    clock,
    alarm: (t: number, snapshot: Snapshot | null) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil: null };
      return runAlarm(deps, state);
    },
    queued: () =>
      db.prepare("SELECT kind, token FROM push_outbox ORDER BY kind, token").all() as {
        kind: string;
        token: string;
      }[],
  };
}

describe("alert start", () => {
  test("REQ-PUSH-008 an alarm after a recent clear starts once", async () => {
    const h = harness();
    await h.alarm(T0, snap([], T0));
    expect(h.queued()).toEqual([]);
    await h.alarm(T0 + 600_000, snap([KHARKIV], T0 + 600_000));
    expect(h.queued()).toEqual([
      { kind: "alertstart", token: TOKEN_A },
      { kind: "la-start", token: S1 },
      { kind: "la-start", token: S2 },
    ]);
    // The same alarm on the next polls queues nothing more.
    await h.alarm(T0 + 630_000, snap([KHARKIV], T0 + 630_000));
    await h.alarm(T0 + 660_000, snap([KHARKIV], T0 + 660_000));
    expect(h.queued()).toHaveLength(3);

    // One millisecond past the gap: the baseline is reset silently.
    const late = harness();
    await late.alarm(T0, snap([], T0));
    await late.alarm(T0 + 600_001, snap([KHARKIV], T0 + 600_001));
    expect(late.queued()).toEqual([]);

    // A cold start in alarm, and a stale alarm after a clear: nothing.
    const cold = harness();
    await cold.alarm(T0, snap([KHARKIV], T0));
    expect(cold.queued()).toEqual([]);
    const stale = harness();
    await stale.alarm(T0, snap([], T0));
    await stale.alarm(T0 + 60_000, snap([KHARKIV], T0 + 60_000, 120_001));
    expect(stale.queued()).toEqual([]);
  });

  test("REQ-PUSH-008 notices and Live Activities are independent", async () => {
    // No notice device at all: the records alone keep the loop polling and get their start.
    const h = harness(false);
    expect(await h.alarm(T0, snap([], T0))).toBe(T0 + 30_000);
    await h.alarm(T0 + 30_000, snap([LVIV], T0 + 30_000));
    expect(h.queued()).toEqual([{ kind: "la-start", token: S3 }]);
  });
});

describe("ending and moving activities", () => {
  test("REQ-PUSH-008 a fresh clear queues one end for every held activity", async () => {
    // After a gap longer than 10 minutes: no notice, but the held activity still ends.
    const h = harness();
    addRecord(h.store, S1, "kharkiv", ACT1);
    await h.alarm(T0, snap([KHARKIV], T0));
    await h.alarm(T0 + 660_000, snap([], T0 + 660_000));
    expect(h.queued()).toEqual([{ kind: "la-end", token: S1 }]);
    // Pending: the next fresh clear does not queue it twice.
    await h.alarm(T0 + 690_000, snap([], T0 + 690_000));
    expect(h.queued()).toEqual([{ kind: "la-end", token: S1 }]);

    // A confirmed all-clear: the notice and the end; a record without a token gets nothing.
    const confirmed = harness();
    addRecord(confirmed.store, S1, "kharkiv", ACT1);
    await confirmed.alarm(T0, snap([KHARKIV], T0));
    await confirmed.alarm(T0 + 30_000, snap([], T0 + 30_000));
    expect(confirmed.queued()).toEqual([
      { kind: "allclear", token: TOKEN_A },
      { kind: "la-end", token: S1 },
    ]);

    // A cold start that sees the region clear ends a held activity too; a stale clear does not.
    const cold = harness();
    addRecord(cold.store, S3, "lviv", ACT3);
    await cold.alarm(T0, snap([KHARKIV], T0, 120_001));
    expect(cold.queued()).toEqual([]);
    await cold.alarm(T0 + 30_000, snap([KHARKIV], T0 + 30_000));
    expect(cold.queued()).toEqual([{ kind: "la-end", token: S3 }]);
  });

  test("REQ-PUSH-008 a region change moves the activity", () => {
    const { db, store } = memoryStore();
    const moves = () =>
      db.prepare("SELECT token, created_at FROM push_outbox WHERE kind = 'la-move'").all();
    addRecord(store, S1, "kharkiv", ACT1);
    addRecord(store, S2, "kharkiv");
    expect(moves()).toEqual([]);

    // Same region, a new activity token: no move.
    addRecord(store, S1, "kharkiv", tokenNo(0xa2), T0 + 1);
    expect(moves()).toEqual([]);
    // A record holding a token moves: one move. A second move before it is sent: still one.
    addRecord(store, S1, "lviv", tokenNo(0xa2), T0 + 2);
    addRecord(store, S1, "odesa", tokenNo(0xa2), T0 + 3);
    expect(moves()).toEqual([{ token: S1, created_at: T0 + 2 }]);
    // A record without a token moves: nothing to move.
    addRecord(store, S2, "lviv", null, T0 + 4);
    expect(moves()).toEqual([{ token: S1, created_at: T0 + 2 }]);
  });

  test("REQ-PUSH-008 each queued push waits no longer than its lifetime", async () => {
    const { db, store } = memoryStore();
    addRecord(store, S1, "kharkiv", ACT1);
    store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    store.enqueue("kharkiv", "kharkiv@1", T0);
    store.enqueue("kharkiv", "start:kharkiv@1", T0, "alertstart");
    store.enqueueLiveActivityStarts("kharkiv", "start:kharkiv@1", T0);
    store.enqueueEnds(["kharkiv"], T0);
    const kinds = () =>
      (db.prepare("SELECT kind FROM push_outbox ORDER BY kind").all() as { kind: string }[]).map(
        (row) => row.kind,
      );
    const run = (now: number) =>
      runAlarm(
        {
          store,
          refresh: async () => ({ snapshot: null, rateLimitedUntil: null }),
          deadline: () => new Promise<void>(() => {}),
          now: () => now,
          log: () => {},
        },
        { lastPollAt: now },
      );
    await run(T0 + 300_000);
    expect(kinds()).toEqual(["alertstart", "allclear", "la-end", "la-start"]);
    // Past 5 minutes the notices and the start go unsent; the end waits up to 4 hours.
    await run(T0 + 300_001);
    expect(kinds()).toEqual(["la-end"]);
    await run(T0 + 4 * 3_600_000);
    expect(kinds()).toEqual(["la-end"]);
    await run(T0 + 4 * 3_600_000 + 1);
    expect(kinds()).toEqual([]);
  });
});

describe("the push alarm with Live Activities", () => {
  test("REQ-PUSHAPI-003 the alarm runs while either store has an entry", async () => {
    const { store } = memoryStore();
    let polls = 0;
    const deps: AlarmDeps = {
      store,
      refresh: async () => {
        polls += 1;
        return { snapshot: snap([], T0), rateLimitedUntil: null };
      },
      deadline: () => new Promise<void>(() => {}),
      now: () => T0,
      log: () => {},
    };
    expect(await runAlarm(deps, { lastPollAt: null })).toBeNull();
    expect(polls).toBe(0);
    addRecord(store, S1, "kharkiv");
    expect(await runAlarm(deps, { lastPollAt: null })).toBe(T0 + 30_000);
    expect(polls).toBe(1);
    store.deleteLiveActivity(S1);
    expect(await runAlarm(deps, { lastPollAt: null })).toBeNull();
    expect(polls).toBe(1);
  });
});
