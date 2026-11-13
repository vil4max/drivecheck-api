import { describe, expect, test } from "vitest";
import type { Snapshot } from "../src/feed";
import { apnsRequest } from "../src/push/apns";
import { alertStartOf, detectChanges, GAP_MS, parseStatusRecord } from "../src/push/changes";
import {
  endPayload,
  registerLiveActivity,
  startPayload,
  updatePayload,
} from "../src/push/liveActivity";
import type { OutboxItem } from "../src/push/registry";
import { alarmLoop, memoryStore, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
/** Seconds from 1970-01-01 to 2001-01-01, as ActivityKit decodes dates. */
const REFERENCE_DATE_S = 978_307_200;

function snap(alarmKeys: string[], t: number): Snapshot {
  return { ...snapshotWith(alarmKeys), fetchedAt: t, serverCachedAt: t };
}

/** Runs the snapshots through `detectChanges` in order, as the alarm does, and returns the record. */
function recordAfter(...snapshots: Snapshot[]) {
  let record = null;
  for (const snapshot of snapshots) {
    record = detectChanges(record, snapshot, snapshot.fetchedAt).record ?? record;
  }
  return record;
}

const contentState = (body: string) =>
  (JSON.parse(body) as { aps: { "content-state": Record<string, unknown> } }).aps["content-state"];

describe("REQ-PUSHAPI-015 the saved record keeps when an alarm started", () => {
  test("REQ-PUSHAPI-015 a confirmed start is kept through the alarm and dropped at the clear", () => {
    const t1 = T0 + 30_000;
    const started = recordAfter(snap([], T0), snap([KHARKIV], t1));
    expect(alertStartOf(started, "kharkiv")).toBe(t1);

    const later = recordAfter(snap([], T0), snap([KHARKIV], t1), snap([KHARKIV], t1 + 30_000));
    expect(alertStartOf(later, "kharkiv")).toBe(t1);

    const cleared = recordAfter(snap([], T0), snap([KHARKIV], t1), snap([], t1 + 30_000));
    expect(alertStartOf(cleared, "kharkiv")).toBeUndefined();
  });

  test("REQ-PUSHAPI-015 a cold start and an alarm seen after a gap have no start", () => {
    expect(alertStartOf(recordAfter(snap([KHARKIV], T0)), "kharkiv")).toBeUndefined();
    const afterGap = recordAfter(snap([], T0), snap([KHARKIV], T0 + GAP_MS + 1));
    expect(alertStartOf(afterGap, "kharkiv")).toBeUndefined();
  });

  test("REQ-PUSHAPI-015 the start survives a restart through the saved JSON", () => {
    const t1 = T0 + 30_000;
    const saved = JSON.stringify(recordAfter(snap([], T0), snap([KHARKIV], t1)));
    expect(alertStartOf(parseStatusRecord(saved), "kharkiv")).toBe(t1);
  });
});

describe("REQ-PUSHAPI-015 start and update carry the alert start", () => {
  const snapshot = snap([KHARKIV], T0);
  const startedAt = T0 - 600_000;
  const seconds = startedAt / 1000 - REFERENCE_DATE_S;

  test("REQ-PUSHAPI-015 start and update hold alertStartedAt in reference-date seconds", () => {
    expect(
      contentState(startPayload("kharkiv", "en", snapshot, T0, startedAt)).alertStartedAt,
    ).toBe(seconds);
    expect(
      contentState(updatePayload("kharkiv", "en", snapshot, T0, startedAt)).alertStartedAt,
    ).toBe(seconds);
  });

  test("REQ-PUSHAPI-015 no known start and the end send no key", () => {
    expect(contentState(startPayload("kharkiv", "en", snapshot, T0))).not.toHaveProperty(
      "alertStartedAt",
    );
    expect(contentState(endPayload("kharkiv", "en", snap([], T0), T0))).not.toHaveProperty(
      "alertStartedAt",
    );
  });

  test("REQ-PUSHAPI-015 the APNs request passes the item's start into the body", () => {
    const item: OutboxItem = {
      id: 1,
      kind: "la-update",
      key: "s",
      token: "a",
      region: "kharkiv",
      env: "production",
      lang: "en",
      createdAt: T0,
      snapshot,
      alertStartedAt: startedAt,
    };
    expect(contentState(apnsRequest(item, "topic", T0).body).alertStartedAt).toBe(seconds);
  });
});

describe("REQ-PUSHAPI-015 through the alarm loop", () => {
  test("REQ-PUSHAPI-015 the start push and the 5-minute update carry the confirmed start", async () => {
    const { store } = memoryStore();
    const clock = { now: T0 };
    const bodies: Record<string, unknown>[] = [];
    const loop = alarmLoop(
      store,
      async (item) => {
        bodies.push(contentState(apnsRequest(item, "topic", clock.now).body));
        return "sent";
      },
      clock,
    );
    const start = tokenNo(0x51);
    registerLiveActivity(
      store,
      { startToken: start, region: "kharkiv", env: "production", lang: "en", activityToken: null },
      T0,
    );
    const drain = async (t: number, snapshot: Snapshot) => {
      let next = await loop.alarm(t, snapshot);
      while (next !== null && next - clock.now <= 1_000) next = await loop.alarm(next, snapshot);
    };

    await loop.alarm(T0, snap([], T0));
    const startedAt = T0 + 30_000;
    await drain(startedAt, snap([KHARKIV], startedAt));
    // The app sends back the new activity's update token, so the walk can reach it.
    registerLiveActivity(
      store,
      {
        startToken: start,
        region: "kharkiv",
        env: "production",
        lang: "en",
        activityToken: tokenNo(0xa1),
      },
      startedAt + 5_000,
    );
    for (let t = startedAt + 30_000; t <= startedAt + 330_000; t += 30_000) {
      await drain(t, snap([KHARKIV], t));
    }

    const expected = startedAt / 1000 - REFERENCE_DATE_S;
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.map((body) => body.alertStartedAt)).toEqual(bodies.map(() => expected));
  });
});
