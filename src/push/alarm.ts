import type { CoordinatorView } from "../coordinator.ts";
import type { Snapshot } from "../feed.ts";
import { isStale } from "../status.ts";
import { alertStartOf, type Changes, detectChanges, parseStatusRecord } from "./changes.ts";
import type { PushStore } from "./registry.ts";
import { BATCH_SIZE, type WalkEntry } from "./sender.ts";

/** Feed poll interval while a device is registered (owner, 2026-11-09). */
export const POLL_MS = 30_000;
/** How long an alarm waits for the feed before it gives up for this round (plan gate, point 3). */
export const FEED_DEADLINE_MS = 20_000;
/** The next alarm while pushes are still queued. */
export const SEND_REARM_MS = 1_000;
/** A device not heard from for 60 days is deleted (owner, 2026-11-09). */
export const DEVICE_EXPIRY_MS = 60 * 86_400_000;
export const STATUSES_KEY = "statuses";

/**
 * REQ-PUSHAPI-015: each region's alarm start from the status record as saved now, for the senders'
 * `alertStart` option. Read from storage, not memory, so a restarted object keeps every start.
 */
export function savedAlertStarts(store: PushStore): (region: string) => number | undefined {
  const record = parseStatusRecord(store.loadState(STATUSES_KEY));
  return (region) => alertStartOf(record, region);
}

export interface AlarmDeps {
  store: PushStore;
  refresh: () => Promise<CoordinatorView>;
  deadline: (ms: number) => Promise<void>;
  now: () => number;
  /**
   * Sends up to `limit` queued pushes and returns how many rows it took; absent while the APNs
   * credentials are missing.
   */
  sendBatch?: (limit: number) => Promise<number | undefined>;
  /** Sends up to `limit` 5-minute updates of `walk`; absent with `sendBatch`. */
  sendUpdates?: (walk: WalkEntry[], limit: number) => Promise<number>;
  log: (message: string) => void;
}

/**
 * Kept in the object's memory; after a restart the first alarm polls at once, and every region
 * in alarm is updated at once, since its last update time is gone (option B: a lost walk restarts).
 */
export interface AlarmState {
  lastPollAt: number | null;
  /** The last fresh snapshot processed: the state queued Live Activity pushes carry. */
  latest?: Snapshot | null;
  /** Per region in alarm, when its Live Activities were last started or updated. */
  updatedAt?: Record<string, number>;
  /** Regions whose 5-minute update is being sent. */
  walk?: WalkEntry[];
}

/** The Live Activity update interval while an alarm lasts (owner, 2026-11-10). */
export const UPDATE_MS = 5 * 60_000;

/** The first registration starts the loop; a scheduled alarm is left as it is. */
export function alarmAfterRegistration(existing: number | null, now: number): number | null {
  return existing === null ? now + POLL_MS : null;
}

const TIMED_OUT = Symbol("timed out");

/**
 * AC-3: a region in alarm is due `UPDATE_MS` after its last start or update; one just started is
 * not. A region now clear leaves the walk: its activities get the end instead.
 */
function planUpdates(state: AlarmState, changes: Changes, now: number): void {
  state.updatedAt ??= {};
  state.walk ??= [];
  const { updatedAt, walk } = state;
  for (const region of changes.quiet) {
    delete updatedAt[region];
    const index = walk.findIndex((entry) => entry.region === region);
    if (index >= 0) walk.splice(index, 1);
  }
  for (const region of changes.alarm) {
    const last = updatedAt[region];
    if (changes.started.includes(region)) {
      updatedAt[region] = now;
    } else if (last === undefined || now - last >= UPDATE_MS) {
      updatedAt[region] = now;
      if (!walk.some((entry) => entry.region === region)) walk.push({ region, after: "" });
    }
  }
}

/** Reads the feed and queues the pushes of every confirmed change and fresh state. */
async function poll(deps: AlarmDeps, state: AlarmState): Promise<void> {
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
  const changes = detectChanges(
    parseStatusRecord(store.loadState(STATUSES_KEY)),
    view.snapshot,
    now,
  );
  const { record, cleared, started } = changes;
  if (record === null || view.snapshot === null) return;
  const queuedStarts: string[] = [];
  // The baseline and the queued pushes are written together, so a retried alarm cannot queue a
  // change twice or lose one.
  store.transaction(() => {
    store.saveState(STATUSES_KEY, JSON.stringify(record));
    for (const region of cleared) {
      store.enqueue(region, `${region}@${record.processedFetchedAt}`, now);
    }
    for (const region of started) {
      const changeId = `start:${region}@${record.processedFetchedAt}`;
      store.enqueue(region, changeId, now, "alertstart");
      store.enqueueLiveActivityStarts(region, changeId, now);
      // REQ-PUSHAPI-014: a zero here means no device of the region can get the Live Activity.
      queuedStarts.push(
        `${region}, ${store.countLiveActivitiesIn(region)} live activity starts queued`,
      );
    }
    // AC-4: any fresh clear ends every activity still held there, after a gap or a cold start too.
    store.enqueueEnds(changes.quiet, now);
  });
  state.latest = view.snapshot;
  planUpdates(state, changes, now);
  if (cleared.length > 0) deps.log(`push alarm: all clear in ${cleared.join(", ")}`);
  for (const line of queuedStarts) deps.log(`push alarm: alert started in ${line}`);
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
    store.dropExpiredOutbox(now);
    // AC-9: notice devices and Live Activity records each keep the loop running.
    const nobody = () => store.countDevices() + store.countLiveActivities() === 0;
    if (state.lastPollAt === null || now - state.lastPollAt >= POLL_MS) {
      if (nobody()) return null;
      state.lastPollAt = now;
      await poll(deps, state);
    }
    // Without a sender nothing would drain the walk; it is planned again once one exists.
    if (deps.sendBatch === undefined || deps.sendUpdates === undefined) state.walk = [];
    // AC-3, AC-5: a walk the stale feed cuts short is due again at the next fresh poll, not 5
    // minutes after it was planned; sendUpdates sends nothing from a stale snapshot either way.
    if (state.walk?.length && (state.latest == null || isStale(state.latest, now))) {
      for (const entry of state.walk) delete state.updatedAt?.[entry.region];
      state.walk = [];
    }
    const walking = () => (state.walk?.length ?? 0) > 0;
    if (deps.sendBatch !== undefined && (store.hasOutbox() || walking())) {
      // Events first, then the updates with what is left of the invocation's 45 sends.
      const used = store.hasOutbox() ? ((await deps.sendBatch(BATCH_SIZE)) ?? BATCH_SIZE) : 0;
      if (deps.sendUpdates !== undefined && state.walk !== undefined && used < BATCH_SIZE) {
        await deps.sendUpdates(state.walk, BATCH_SIZE - used);
      }
      if (store.hasOutbox() || walking()) return deps.now() + SEND_REARM_MS;
    }
    if (nobody()) return null;
  } catch (error) {
    deps.log(`push alarm failed: ${(error as Error).message}`);
  }
  return (state.lastPollAt ?? now) + POLL_MS;
}
