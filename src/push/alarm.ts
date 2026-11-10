import type { CoordinatorView } from "../coordinator.ts";
import { detectChanges, parseStatusRecord } from "./changes.ts";
import type { PushStore } from "./registry.ts";

/** Feed poll interval while a device is registered (owner, 2026-11-09). */
export const POLL_MS = 30_000;
/** How long an alarm waits for the feed before it gives up for this round (plan gate, point 3). */
export const FEED_DEADLINE_MS = 20_000;
/** The next alarm while pushes are still queued. */
export const SEND_REARM_MS = 1_000;
/** A device not heard from for 60 days is deleted (owner, 2026-11-09). */
export const DEVICE_EXPIRY_MS = 60 * 86_400_000;
/** A queued push older than 5 minutes is deleted unsent (plan gate, point 2). */
export const OUTBOX_TTL_MS = 5 * 60_000;
export const STATUSES_KEY = "statuses";

export interface AlarmDeps {
  store: PushStore;
  refresh: () => Promise<CoordinatorView>;
  deadline: (ms: number) => Promise<void>;
  now: () => number;
  /** Sends one batch from the outbox; absent while the APNs credentials are missing. */
  sendBatch?: () => Promise<void>;
  log: (message: string) => void;
}

/** Kept in the object's memory; after a restart the first alarm polls at once. */
export interface AlarmState {
  lastPollAt: number | null;
}

/** The first registration starts the loop; a scheduled alarm is left as it is. */
export function alarmAfterRegistration(existing: number | null, now: number): number | null {
  return existing === null ? now + POLL_MS : null;
}

const TIMED_OUT = Symbol("timed out");

/** Reads the feed and queues the all-clear pushes of every confirmed change. */
async function poll(deps: AlarmDeps): Promise<void> {
  const view = await Promise.race([
    deps.refresh(),
    deps.deadline(FEED_DEADLINE_MS).then((): typeof TIMED_OUT => TIMED_OUT),
  ]);
  if (view === TIMED_OUT) {
    deps.log("push alarm: the feed did not answer within 20 s; nothing processed");
    return;
  }
  // AC-2: while a 429 window is open the feed counts as rate limited, even for a held snapshot
  // another caller fetched before the window opened; it is judged once the window has closed.
  if (view.rateLimitedUntil !== null) return;
  const { store } = deps;
  const now = deps.now();
  const { record, cleared } = detectChanges(
    parseStatusRecord(store.loadState(STATUSES_KEY)),
    view.snapshot,
    now,
  );
  if (record === null) return;
  // The baseline and the queued pushes are written together, so a retried alarm cannot queue a
  // change twice or lose one.
  store.transaction(() => {
    store.saveState(STATUSES_KEY, JSON.stringify(record));
    for (const region of cleared) {
      store.enqueue(region, `${region}@${record.processedFetchedAt}`, now);
    }
  });
  if (cleared.length > 0) deps.log(`push alarm: all clear in ${cleared.join(", ")}`);
}

/**
 * One alarm (REQ-PUSHAPI-003): expire old devices and pushes, poll the feed when 30 s have passed
 * and a device is registered, send a batch, and return when the next alarm is due, or null to
 * stop. It never throws, so the loop survives a failing feed or store.
 */
export async function runAlarm(deps: AlarmDeps, state: AlarmState): Promise<number | null> {
  const { store } = deps;
  const now = deps.now();
  try {
    store.pruneDevices(now - DEVICE_EXPIRY_MS);
    store.pruneLiveActivities(now - DEVICE_EXPIRY_MS);
    store.dropOutboxBefore(now - OUTBOX_TTL_MS);
    if (state.lastPollAt === null || now - state.lastPollAt >= POLL_MS) {
      if (store.countDevices() === 0) return null;
      state.lastPollAt = now;
      await poll(deps);
    }
    if (deps.sendBatch !== undefined && store.hasOutbox()) {
      await deps.sendBatch();
      if (store.hasOutbox()) return deps.now() + SEND_REARM_MS;
    }
    if (store.countDevices() === 0) return null;
  } catch (error) {
    deps.log(`push alarm failed: ${(error as Error).message}`);
  }
  return (state.lastPollAt ?? now) + POLL_MS;
}
