import { describe, expect, test } from "vitest";
import { type CoordinatorView, FeedCoordinator } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, alarmAfterRegistration, runAlarm } from "../src/push/alarm";
import { memoryStore, TOKEN_A, TOKEN_B, tokenNo } from "./pushSupport";
import { FakeWorld, feedJson, jsonResponse, snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
const LVIV = "Львівська область";

/** A snapshot fetched at `t`, cached upstream `ageMs` earlier (over 2 minutes is stale). */
function snap(alarmKeys: string[], t: number, ageMs = 0): Snapshot {
  return { ...snapshotWith(alarmKeys), fetchedAt: t, serverCachedAt: t - ageMs };
}

/** Three devices (two in Kharkiv, one in Lviv) and an alarm loop over a scripted feed. */
function harness() {
  const { db, store } = memoryStore();
  for (const [token, region] of [
    [TOKEN_A, "kharkiv"],
    [TOKEN_B, "kharkiv"],
    [tokenNo(3), "lviv"],
  ] as const) {
    store.upsertDevice({ token, region, env: "production", lang: "en", lastSeen: T0 });
  }
  const clock = { now: T0 };
  let view: CoordinatorView = { snapshot: null, rateLimitedUntil: null };
  const deps: AlarmDeps = {
    store,
    refresh: async () => view,
    deadline: () => new Promise<void>(() => {}),
    now: () => clock.now,
    log: () => {},
  };
  const state = { lastPollAt: null };
  return {
    db,
    store,
    /** One alarm at `t` that sees `snapshot`. */
    alarm: (t: number, snapshot: Snapshot | null, rateLimitedUntil: number | null = null) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil };
      return runAlarm(deps, state);
    },
    queued: () => db.prepare("SELECT token, region FROM push_outbox ORDER BY token").all(),
    statuses: () => db.prepare("SELECT value FROM push_state").all(),
  };
}

describe("all-clear change detection", () => {
  test("REQ-PUSH-002 a confirmed alarm-to-clear queues one push per device of that region", async () => {
    const h = harness();
    await h.alarm(T0, snap([KHARKIV], T0));
    expect(h.queued()).toEqual([]);
    await h.alarm(T0 + 30_000, snap([], T0 + 30_000));
    expect(h.queued()).toEqual([
      { token: TOKEN_A, region: "kharkiv" },
      { token: TOKEN_B, region: "kharkiv" },
    ]);
    // Lviv was clear in both snapshots: nothing for it, and a third clear changes nothing.
    await h.alarm(T0 + 60_000, snap([], T0 + 60_000));
    expect(h.queued()).toHaveLength(2);
  });

  test("REQ-PUSH-002 the 10-minute gap rule", async () => {
    // Clear exactly 600 000 ms after the last confirmed alarm, the feed failing in between: sent.
    const edge = harness();
    await edge.alarm(T0, snap([KHARKIV], T0));
    for (let t = T0 + 30_000; t < T0 + 600_000; t += 30_000) await edge.alarm(t, null);
    await edge.alarm(T0 + 600_000, snap([], T0 + 600_000));
    expect(edge.queued()).toHaveLength(2);

    // One millisecond later: the baseline is reset silently.
    const late = harness();
    await late.alarm(T0, snap([KHARKIV], T0));
    await late.alarm(T0 + 600_001, snap([], T0 + 600_001));
    expect(late.queued()).toEqual([]);

    // A stale snapshot is skipped, not taken as clear: the later fresh clear decides.
    const stale = harness();
    await stale.alarm(T0, snap([KHARKIV], T0));
    await stale.alarm(T0 + 60_000, snap([], T0 + 60_000, 180_000));
    expect(stale.queued()).toEqual([]);
    await stale.alarm(T0 + 300_000, snap([], T0 + 300_000));
    expect(stale.queued()).toHaveLength(2);

    // A stale clear, then a fresh clear 11 minutes after the last confirmed alarm: nothing.
    const staleLate = harness();
    await staleLate.alarm(T0, snap([KHARKIV], T0));
    await staleLate.alarm(T0 + 60_000, snap([], T0 + 60_000, 180_000));
    await staleLate.alarm(T0 + 660_000, snap([], T0 + 660_000));
    expect(staleLate.queued()).toEqual([]);
  });

  test("REQ-PUSH-002 a stale, missing or rate-limited feed sends nothing", async () => {
    const h = harness();
    await h.alarm(T0, snap([KHARKIV], T0));
    const baseline = h.statuses();
    await h.alarm(T0 + 30_000, null);
    await h.alarm(T0 + 60_000, snap([], T0 + 60_000, 120_001), T0 + 300_000);
    expect(h.queued()).toEqual([]);
    expect(h.statuses()).toEqual(baseline);

    // The same clear snapshot seen by two alarms queues once.
    const clear = snap([], T0 + 90_000);
    await h.alarm(T0 + 90_000, clear);
    await h.alarm(T0 + 120_000, clear);
    expect(h.queued()).toHaveLength(2);
  });

  test("REQ-PUSH-002 a cold start sets the baseline silently", async () => {
    const h = harness();
    await h.alarm(T0, snap([LVIV], T0));
    expect(h.queued()).toEqual([]);
    const [row] = h.statuses() as { value: string }[];
    const record = JSON.parse(row!.value);
    expect(record.processedFetchedAt).toBe(T0);
    expect(record.regions.kharkiv).toEqual({ alert: false, seenAt: T0 });
    expect(record.regions.lviv).toEqual({ alert: true, seenAt: T0 });
    expect(h.statuses()).toHaveLength(1);
  });
});

describe("the push alarm", () => {
  test("REQ-PUSHAPI-003 the alarm polls every 30 s only while devices exist", async () => {
    expect(alarmAfterRegistration(null, T0)).toBe(T0 + 30_000);
    expect(alarmAfterRegistration(T0 + 5_000, T0)).toBeNull();

    const world = new FakeWorld();
    const coordinator = new FeedCoordinator(world.deps());
    const { store } = memoryStore();
    const deps: AlarmDeps = {
      store,
      refresh: () => coordinator.refresh(),
      deadline: () => new Promise<void>(() => {}),
      now: () => world.now,
      log: () => {},
    };
    const state = { lastPollAt: null };

    // No device: no upstream request and no re-arm.
    expect(await runAlarm(deps, state)).toBeNull();
    expect(world.requests).toHaveLength(0);

    store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    world.queue(jsonResponse(feedJson()));
    expect(await runAlarm(deps, state)).toBe(T0 + 30_000);
    expect(world.requests).toHaveLength(1);

    // A client asked 5 s before the next alarm: the floor holds, the alarm makes no request.
    world.now = T0 + 25_000;
    world.queue(jsonResponse(feedJson()));
    await coordinator.current();
    await coordinator.idle();
    expect(world.requests).toHaveLength(2);
    world.now = T0 + 30_000;
    expect(await runAlarm(deps, state)).toBe(T0 + 60_000);
    expect(world.requests).toHaveLength(2);

    // The last device leaves: the loop stops.
    store.deleteDevice(TOKEN_A);
    world.now = T0 + 60_000;
    expect(await runAlarm(deps, state)).toBeNull();
    expect(world.requests).toHaveLength(2);
  });

  test("REQ-PUSHAPI-007 the alarm stops waiting for the feed after 20 s and re-arms", async () => {
    const h = harness();
    const deadlines: number[] = [];
    const { store } = h;
    const deps: AlarmDeps = {
      store,
      refresh: () => new Promise<CoordinatorView>(() => {}),
      deadline: async (ms) => {
        deadlines.push(ms);
      },
      now: () => T0,
      log: () => {},
    };
    expect(await runAlarm(deps, { lastPollAt: null })).toBe(T0 + 30_000);
    expect(deadlines).toEqual([20_000]);
    expect(h.statuses()).toEqual([]);

    // A failing refresh still re-arms, so the loop never ends on an error.
    const failing: AlarmDeps = {
      ...deps,
      refresh: async () => {
        throw new Error("storage unavailable");
      },
    };
    expect(await runAlarm(failing, { lastPollAt: null })).toBe(T0 + 30_000);
  });
});
