import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, runAlarm } from "../src/push/alarm";
import { apnsSender, ProviderToken } from "../src/push/apns";
import { registerLiveActivity } from "../src/push/liveActivity";
import type { OutboxItem, PushStore } from "../src/push/registry";
import { sendBatch } from "../src/push/sender";
import { generatedCredentials, memoryStore, TOKEN_A, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
const LVIV = "Львівська область";
const S1 = tokenNo(0x51);
const S2 = tokenNo(0x52);
const S3 = tokenNo(0x53);
const S4 = tokenNo(0x54);
const ACT4 = tokenNo(0xa4);

function snap(alarmKeys: string[], t: number): Snapshot {
  return { ...snapshotWith(alarmKeys), fetchedAt: t, serverCachedAt: t };
}

function addRecord(
  store: PushStore,
  startToken: string,
  region: string,
  activityToken: string | null = null,
) {
  registerLiveActivity(
    store,
    { startToken, region, env: "production", lang: "en", activityToken },
    T0,
  );
}

function expectNoToken(lines: string[]) {
  for (const line of lines) {
    for (const token of [TOKEN_A, S1, S2, S3, S4, ACT4]) expect(line).not.toContain(token);
  }
}

describe("push diagnostics", () => {
  test("REQ-PUSHAPI-014 an alarm start logs how many Live Activity starts it queued", async () => {
    const { store } = memoryStore();
    addRecord(store, S1, "kharkiv");
    addRecord(store, S2, "kharkiv");
    store.upsertDevice({
      token: TOKEN_A,
      region: "lviv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    const logs: string[] = [];
    let view: CoordinatorView = { snapshot: null, rateLimitedUntil: null };
    const clock = { now: T0 };
    const deps: AlarmDeps = {
      store,
      refresh: async () => view,
      deadline: () => new Promise<void>(() => {}),
      now: () => clock.now,
      log: (m) => logs.push(m),
    };
    const state = { lastPollAt: null };
    view = { snapshot: snap([], T0), rateLimitedUntil: null };
    await runAlarm(deps, state);
    clock.now = T0 + 60_000;
    view = { snapshot: snap([KHARKIV, LVIV], clock.now), rateLimitedUntil: null };
    await runAlarm(deps, state);

    // Two records in Kharkiv; Lviv has only a notice device, so its count is a visible zero.
    expect(logs).toContain("push alarm: alert started in kharkiv, 2 live activity starts queued");
    expect(logs).toContain("push alarm: alert started in lviv, 0 live activity starts queued");
    expectNoToken(logs);
  });

  test("REQ-PUSHAPI-014 a batch logs sent, deleted, failed and dropped pushes per kind", async () => {
    const { store } = memoryStore();
    addRecord(store, S1, "kharkiv");
    addRecord(store, S2, "kharkiv");
    addRecord(store, S3, "lviv");
    store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: T0,
    });
    store.enqueue("kharkiv", "start:kharkiv@1", T0, "alertstart");
    store.enqueueLiveActivityStarts("kharkiv", "start:kharkiv@1", T0);
    // Lviv is clear in the snapshot sent with the batch, so its start is dropped unsent.
    store.enqueueLiveActivityStarts("lviv", "start:lviv@1", T0);
    // A move resolves to an update in alarm and fails; it still counts as the queued `la-move`.
    addRecord(store, S4, "kharkiv", ACT4);
    store.enqueueMove(S4, "kharkiv", T0);
    const outcomes = new Map([
      [TOKEN_A, "sent"],
      [S1, "sent"],
      [S2, "drop-token"],
    ] as const);
    const send = async (item: OutboxItem) => outcomes.get(item.token as never) ?? "keep";
    const logs: string[] = [];

    await sendBatch(store, send, (m) => logs.push(m), {
      latest: snap([KHARKIV], T0),
      now: () => T0,
    });

    expect(logs).toEqual([
      "push batch: 2 sent, 1 tokens deleted, 1 failed, 1 dropped; " +
        "alertstart: 1 sent; la-move: 1 failed; la-start: 1 sent, 1 tokens deleted, 1 dropped",
    ]);
    expectNoToken(logs);
  });

  test("REQ-PUSHAPI-014 a refused push names its kind with the APNs status", async () => {
    const logs: string[] = [];
    const send = apnsSender(
      new ProviderToken(await generatedCredentials(), () => T0),
      async () => new Response(JSON.stringify({ reason: "InvalidPushType" }), { status: 400 }),
      (m) => logs.push(m),
    );
    const item: OutboxItem = {
      id: 1,
      kind: "la-start",
      key: S1,
      token: S1,
      region: "kharkiv",
      env: "production",
      lang: "en",
      createdAt: T0,
      snapshot: snap([KHARKIV], T0),
    };

    expect(await send(item)).toBe("keep");
    expect(logs).toEqual(["push refused: la-start 400 InvalidPushType"]);
    expectNoToken(logs);
  });
});
