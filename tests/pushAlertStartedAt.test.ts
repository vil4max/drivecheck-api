import { describe, expect, test } from "vitest";
import type { Snapshot } from "../src/feed";
import { apnsRequest } from "../src/push/apns";
import {
  alarmStartedAt,
  endPayload,
  registerLiveActivity,
  startPayload,
  updatePayload,
} from "../src/push/liveActivity";
import { sendBatch } from "../src/push/sender";
import { memoryStore, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";
/** Seconds from 1970-01-01 to 2001-01-01, as ActivityKit decodes dates. */
const REFERENCE_DATE_S = 978_307_200;
/** 2026-11-13 08:29:04 in Kyiv (UTC+2 in winter). */
const STARTED_KYIV = "2026-11-13 08:29:04";
const STARTED_MS = Date.UTC(2026, 10, 13, 6, 29, 4);

/** Kharkiv in alarm since `STARTED_KYIV`; every clear region's `changed` is the cache time. */
function snap(alarm: boolean, changed: string | null = STARTED_KYIV): Snapshot {
  const snapshot = snapshotWith(alarm ? [KHARKIV] : []);
  for (const [key, state] of Object.entries(snapshot.feed.states)) {
    const value = key === KHARKIV && alarm ? changed : snapshot.feed.cachedat;
    if (value === null) delete state.changed;
    else state.changed = value;
  }
  return snapshot;
}

const contentState = (body: string) =>
  (JSON.parse(body) as { aps: { "content-state": Record<string, unknown> } }).aps["content-state"];

describe("REQ-PUSHAPI-015 the alarm start comes from the feed's changed time", () => {
  test("REQ-PUSHAPI-015 a region in alarm starts at its changed time, read in Kyiv time", () => {
    expect(alarmStartedAt(snap(true), "kharkiv")).toBe(STARTED_MS);
  });

  test("REQ-PUSHAPI-015 a clear region and an alarm without changed have no start", () => {
    // For a clear region the feed's changed is only the cache time, never an all-clear time.
    expect(alarmStartedAt(snap(false), "kharkiv")).toBeNull();
    expect(alarmStartedAt(snap(true, null), "kharkiv")).toBeNull();
  });
});

describe("REQ-PUSHAPI-015 start and update carry the alert start", () => {
  const seconds = STARTED_MS / 1000 - REFERENCE_DATE_S;

  test("REQ-PUSHAPI-015 start and update hold alertStartedAt in reference-date seconds", () => {
    expect(contentState(startPayload("kharkiv", "en", snap(true), T0)).alertStartedAt).toBe(
      seconds,
    );
    expect(contentState(updatePayload("kharkiv", "en", snap(true), T0)).alertStartedAt).toBe(
      seconds,
    );
  });

  test("REQ-PUSHAPI-015 no known start and the end send no key", () => {
    expect(contentState(startPayload("kharkiv", "en", snap(true, null), T0))).not.toHaveProperty(
      "alertStartedAt",
    );
    expect(contentState(endPayload("kharkiv", "en", snap(false), T0))).not.toHaveProperty(
      "alertStartedAt",
    );
  });

  test("REQ-PUSHAPI-015 a move into a region in alarm carries that region's start", async () => {
    const { store } = memoryStore();
    const start = tokenNo(0x52);
    const record = (region: string) =>
      registerLiveActivity(
        store,
        { startToken: start, region, env: "production", lang: "en", activityToken: tokenNo(0xa2) },
        T0,
      );
    record("lviv");
    // AC-10: the driver moved to Kharkiv; the queued move resolves to Kharkiv's red update.
    record("kharkiv");
    const bodies: Record<string, unknown>[] = [];
    await sendBatch(
      store,
      async (item) => {
        bodies.push(contentState(apnsRequest(item, "topic", T0).body));
        return "sent";
      },
      () => {},
      { latest: snap(true), now: () => T0 },
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.phase).toBe("alarm");
    expect(bodies[0]?.alertStartedAt).toBe(seconds);
  });
});
