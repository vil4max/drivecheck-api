import type { Snapshot } from "../feed.ts";
import { REGIONS } from "../regions.ts";
import { isStale } from "../status.ts";

/** The previous confirmed alarm must be at most this old for a clear to count (owner, 2026-11-09). */
export const GAP_MS = 10 * 60_000;

export interface RegionStatus {
  alert: boolean;
  /** `fetchedAt` of the snapshot that last confirmed this status. */
  seenAt: number;
  /**
   * REQ-PUSHAPI-015: `fetchedAt` of the snapshot that confirmed the alarm's start after a
   * confirmed clear; absent while clear, after a cold start, or for an alarm seen after a gap.
   */
  alertSince?: number;
}

/** The one overwritten record of region statuses (plan gate, point 4): no history. */
export interface StatusRecord {
  processedFetchedAt: number;
  regions: Record<string, RegionStatus>;
}

/** An unreadable record counts as none: the next snapshot is then a silent cold start. */
export function parseStatusRecord(raw: string | null): StatusRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as StatusRecord;
    return typeof value.processedFetchedAt === "number" && typeof value.regions === "object"
      ? value
      : null;
  } catch {
    return null;
  }
}

export interface Changes {
  /** Null when the snapshot is not to be processed (stale, missing, or not newer). */
  record: StatusRecord | null;
  /** Confirmed alarm → clear (REQ-PUSH-002): the all-clear notice. */
  cleared: string[];
  /** Confirmed clear → alarm (REQ-PUSH-008): the alert-start notice and the Live Activity start. */
  started: string[];
  /** Every region this fresh snapshot shows clear or in alarm, whatever came before (AC-3, AC-4). */
  quiet: string[];
  alarm: string[];
}

const NOTHING: Changes = { record: null, cleared: [], started: [], quiet: [], alarm: [] };

/**
 * REQ-PUSH-002, REQ-PUSH-008: only a fresh snapshot newer than the last one processed counts. A
 * region whose previous confirmed status was the opposite one, seen at most `GAP_MS` earlier, is
 * cleared or started; a region seen for the first time, or after a longer gap, only sets the
 * baseline. `quiet` and `alarm` list the fresh state for the Live Activity updates and ends,
 * which follow any fresh state (owner, 2026-11-10).
 */
export function detectChanges(
  previous: StatusRecord | null,
  snapshot: Snapshot | null,
  now: number,
): Changes {
  if (snapshot === null || isStale(snapshot, now)) return NOTHING;
  if (previous !== null && snapshot.fetchedAt <= previous.processedFetchedAt) return NOTHING;
  const regions: Record<string, RegionStatus> = { ...previous?.regions };
  const changes: Changes = { ...NOTHING, cleared: [], started: [], quiet: [], alarm: [] };
  for (const region of REGIONS) {
    const state = snapshot.feed.states[region.apiKey];
    // A region missing from the feed is unknown: its last confirmed status stays as it was.
    if (state === undefined) continue;
    const before = previous?.regions[region.id];
    const confirmed = before !== undefined && snapshot.fetchedAt - before.seenAt <= GAP_MS;
    if (confirmed && before.alert && !state.alertnow) changes.cleared.push(region.id);
    if (confirmed && !before.alert && state.alertnow) changes.started.push(region.id);
    (state.alertnow ? changes.alarm : changes.quiet).push(region.id);
    const status: RegionStatus = { alert: state.alertnow, seenAt: snapshot.fetchedAt };
    const since = alarmSince(state.alertnow, confirmed ? before : undefined, snapshot.fetchedAt);
    if (since !== undefined) status.alertSince = since;
    regions[region.id] = status;
  }
  return { ...changes, record: { processedFetchedAt: snapshot.fetchedAt, regions } };
}

/**
 * REQ-PUSHAPI-015: a confirmed clear → alarm starts it at this snapshot, a confirmed alarm keeps
 * its start, and anything else (clear, cold start, a gap) has none.
 */
function alarmSince(
  alertNow: boolean,
  confirmedBefore: RegionStatus | undefined,
  fetchedAt: number,
): number | undefined {
  if (!alertNow || confirmedBefore === undefined) return undefined;
  return confirmedBefore.alert ? confirmedBefore.alertSince : fetchedAt;
}

/** REQ-PUSHAPI-015: when the region's current alarm started, if this server saw it start. */
export function alertStartOf(record: StatusRecord | null, regionId: string): number | undefined {
  const status = record?.regions[regionId];
  return status?.alert ? status.alertSince : undefined;
}
