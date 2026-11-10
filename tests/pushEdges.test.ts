import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, type AlarmState, runAlarm } from "../src/push/alarm";
import { apnsSender, type Outcome, ProviderToken } from "../src/push/apns";
import { registerLiveActivity } from "../src/push/liveActivity";
import type { OutboxItem, PushStore } from "../src/push/registry";
import { sendBatch, sendUpdates, type WalkEntry } from "../src/push/sender";
import { generatedCredentials, memoryStore, storeOn, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
const LVIV = "Львівська область";
const S1 = tokenNo(0x51);
const ACT1 = tokenNo(0xa1);

const snap = (alarmKeys: string[], t: number, ageMs = 0, drop: string[] = []): Snapshot => ({
  ...snapshotWith(alarmKeys, drop),
  fetchedAt: t,
  serverCachedAt: t - ageMs,
});

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

/** A send that records what it was given and answers 200. */
function recorder() {
  const sent: OutboxItem[] = [];
  const send = async (item: OutboxItem): Promise<Outcome> => {
    sent.push(item);
    return "sent";
  };
  return { sent, send };
}

/** The alarm with a recording sender; `alarm` takes the view's 429 window too. */
function harness(store: PushStore) {
  const { sent, send } = recorder();
  const clock = { now: T0 };
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
    sent,
    state,
    alarm: (t: number, snapshot: Snapshot | null, rateLimitedUntil: number | null = null) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil };
      return runAlarm(deps, state);
    },
  };
}

describe("edges of the Live Activity loop", () => {
  test("REQ-PUSHAPI-004 events and updates share 45 sends per invocation", async () => {
    const { store } = memoryStore();
    for (let n = 0; n < 30; n += 1) {
      store.upsertDevice({
        token: tokenNo(0x100 + n),
        region: "lviv",
        env: "production",
        lang: "en",
        lastSeen: T0,
      });
    }
    for (let n = 0; n < 40; n += 1)
      addRecord(store, tokenNo(0x1000 + n), "kharkiv", tokenNo(0x2000 + n));
    store.enqueue("lviv", "lviv@1", T0);
    const h = harness(store);
    // A cold start in alarm plans the walk; the 30 queued notices go first, the walk takes the rest.
    const next = await h.alarm(T0, snap([KHARKIV], T0));
    expect(h.sent.filter((item) => item.kind === "allclear")).toHaveLength(30);
    expect(h.sent.filter((item) => item.kind === "la-update")).toHaveLength(15);
    expect(next).toBe(T0 + 1_000);
    await h.alarm(T0 + 1_000, snap([KHARKIV], T0));
    expect(h.sent).toHaveLength(70);
  });

  test("REQ-PUSH-008 nothing is sent on a stale, rate-limited or unknown feed", async () => {
    const { store } = memoryStore();
    addRecord(store, S1, "kharkiv", ACT1);
    const h = harness(store);
    await h.alarm(T0, snap([KHARKIV], T0));
    h.sent.length = 0;
    // A clear the 429 window holds back, a clear that is stale, a feed without the region.
    await h.alarm(T0 + 30_000, snap([], T0 + 30_000), T0 + 60_000);
    await h.alarm(T0 + 60_000, snap([], T0 + 60_000, 120_001));
    await h.alarm(T0 + 90_000, snap([], T0 + 90_000, 0, [KHARKIV]));
    expect(h.sent).toEqual([]);
    expect(store.liveActivity(S1)?.activityToken).toBe(ACT1);
    // The next fresh clear that names the region ends it.
    await h.alarm(T0 + 120_000, snap([], T0 + 120_000));
    expect(h.sent.map((item) => [item.kind, item.token])).toEqual([["la-end", ACT1]]);
  });

  test("REQ-PUSH-008 a queued start or end is checked against the latest state", async () => {
    const { store } = memoryStore();
    const { sent, send } = recorder();
    // A start queued for an alarm that the latest fresh snapshot shows already clear: dropped.
    addRecord(store, tokenNo(0x52), "kharkiv", null);
    store.enqueueLiveActivityStarts("kharkiv", "start:kharkiv@1", T0);
    await sendBatch(store, send, () => {}, {
      latest: snap([], T0 + 30_000),
      now: () => T0 + 30_000,
    });
    expect(sent).toEqual([]);
    expect(store.hasOutbox()).toBe(false);

    // An end queued for Kharkiv, then the driver moves into Lviv, in alarm, before it is sent:
    // one red update named for Lviv, no green end for Kharkiv, and the token stays.
    addRecord(store, S1, "kharkiv", ACT1);
    store.enqueueEnds(["kharkiv"], T0);
    addRecord(store, S1, "lviv", ACT1, T0 + 5_000);
    await sendBatch(store, send, () => {}, {
      latest: snap([LVIV], T0 + 10_000),
      now: () => T0 + 10_000,
    });
    expect(sent.map((item) => [item.kind, item.region, item.token])).toEqual([
      ["la-update", "lviv", ACT1],
    ]);
    expect(store.liveActivity(S1)?.activityToken).toBe(ACT1);
  });

  test("REQ-PUSH-008 a queued end that would turn red needs a fresh snapshot", async () => {
    const { store } = memoryStore();
    const { sent, send } = recorder();
    // Kharkiv cleared and an end was queued; the last fresh snapshot shows it in alarm again, but
    // it is stale by now, so no red update dated from it goes out and the token stays.
    addRecord(store, S1, "kharkiv", ACT1);
    store.enqueueEnds(["kharkiv"], T0);
    await sendBatch(store, send, () => {}, {
      latest: snap([KHARKIV], T0),
      now: () => T0 + 120_001,
    });
    expect(sent).toEqual([]);
    expect(store.hasOutbox()).toBe(false);
    expect(store.liveActivity(S1)?.activityToken).toBe(ACT1);
  });

  test("REQ-PUSH-008 a queued start follows the record to its region at send time", async () => {
    const { store } = memoryStore();
    const { sent, send } = recorder();
    const latest = snap([KHARKIV, LVIV], T0 + 10_000);
    // Queued for Kharkiv; the driver moved to clear Odesa before it was sent: no red activity.
    addRecord(store, S1, "kharkiv", null);
    store.enqueueLiveActivityStarts("kharkiv", "start:kharkiv@1", T0);
    addRecord(store, S1, "odesa", null, T0 + 5_000);
    // Queued for Kharkiv; the driver moved to Lviv, in alarm: the start names Lviv.
    const S2 = tokenNo(0x52);
    addRecord(store, S2, "kharkiv", null);
    store.enqueueLiveActivityStarts("kharkiv", "start:kharkiv@1", T0);
    addRecord(store, S2, "lviv", null, T0 + 5_000);
    await sendBatch(store, send, () => {}, { latest, now: () => T0 + 10_000 });
    expect(sent.map((item) => [item.kind, item.key, item.region])).toEqual([
      ["la-start", S2, "lviv"],
    ]);
    expect(store.hasOutbox()).toBe(false);
  });

  test("REQ-PUSH-008 a walk abandoned on a stale feed is due again at the next fresh poll", async () => {
    const { store } = memoryStore();
    for (let n = 0; n < 60; n += 1)
      addRecord(store, tokenNo(0x1000 + n), "kharkiv", tokenNo(0x2000 + n));
    const h = harness(store);
    const updates = () => h.sent.filter((item) => item.kind === "la-update").length;
    // A cold start in alarm plans the walk and sends 45 of the 60 updates.
    await h.alarm(T0, snap([KHARKIV], T0));
    expect(updates()).toBe(45);
    // The feed goes stale before the walk finishes: the rest is abandoned.
    await h.alarm(T0 + 120_001, snap([KHARKIV], T0 + 120_001, 120_001));
    expect(updates()).toBe(45);
    // The first fresh poll walks the region again rather than waiting out the 5 minutes.
    await h.alarm(T0 + 150_001, snap([KHARKIV], T0 + 150_001));
    expect(updates()).toBe(90);
  });

  test("REQ-PUSH-008 the update walk stops when the feed turns stale", async () => {
    const { store } = memoryStore();
    for (let n = 0; n < 60; n += 1)
      addRecord(store, tokenNo(0x1000 + n), "kharkiv", tokenNo(0x2000 + n));
    const { sent, send } = recorder();
    const walk: WalkEntry[] = [{ region: "kharkiv", after: "" }];
    const latest = snap([KHARKIV], T0);
    expect(await sendUpdates(store, walk, send, () => {}, { latest, now: () => T0 + 1_000 })).toBe(
      45,
    );
    // Two minutes and a moment later the last fresh snapshot is stale: no more updates from it.
    expect(
      await sendUpdates(store, walk, send, () => {}, { latest, now: () => T0 + 120_001 }),
    ).toBe(0);
    expect(walk).toEqual([]);
    expect(sent).toHaveLength(45);
  });

  test("REQ-PUSHAPI-001 a spec 003 outbox is migrated once and still sends", async () => {
    // The tables exactly as spec 003 deployed them, with one queued all-clear.
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE push_devices (token TEXT PRIMARY KEY, region TEXT NOT NULL,
      env TEXT NOT NULL, lang TEXT NOT NULL, last_seen INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE push_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL,
      region TEXT NOT NULL, change_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (token, change_id))`);
    db.exec("CREATE TABLE push_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO push_state VALUES ('deviceCount', '1')");
    db.exec(
      `INSERT INTO push_devices VALUES ('${tokenNo(1)}', 'kharkiv', 'production', 'uk', ${T0})`,
    );
    db.exec(`INSERT INTO push_outbox (token, region, change_id, created_at)
      VALUES ('${tokenNo(1)}', 'kharkiv', 'kharkiv@1', ${T0})`);

    storeOn(db);
    // A second start finds the migrations done and changes nothing.
    const { store } = storeOn(db);
    expect(db.prepare("SELECT value FROM push_state WHERE key = 'schemaVersion'").all()).toEqual([
      { value: "1" },
    ]);
    expect(db.prepare("SELECT kind FROM push_outbox").all()).toEqual([{ kind: "allclear" }]);
    // The migrated device table keeps exactly the five REQ-PUSHAPI-002 columns.
    expect(Object.keys(db.prepare("SELECT * FROM push_devices").all()[0]!).sort()).toEqual([
      "env",
      "lang",
      "last_seen",
      "region",
      "token",
    ]);

    const bodies: string[] = [];
    const send = apnsSender(
      new ProviderToken(await generatedCredentials(), () => T0),
      async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(null, { status: 200 });
      },
      () => {},
    );
    await sendBatch(store, send, () => {}, { now: () => T0 });
    expect(JSON.parse(bodies[0]!).aps.alert.title).toBe("Відбій тривоги: Харківська область");
    expect(store.hasOutbox()).toBe(false);
  });
});
