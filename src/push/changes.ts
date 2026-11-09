import type { Snapshot } from "../feed.ts";
import { REGIONS } from "../regions.ts";
import { isStale } from "../status.ts";

/** The previous confirmed alarm must be at most this old for a clear to count (owner, 2026-11-09). */
export const GAP_MS = 10 * 60_000;

export interface RegionStatus {
  alert: boolean;
  /** `fetchedAt` of the snapshot that last confirmed this status. */
  seenAt: number;
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

/**
 * REQ-PUSH-002: only a fresh snapshot newer than the last one processed counts. A region whose
 * previous confirmed status was an alarm seen at most `GAP_MS` earlier and is now clear is
 * cleared; a region seen for the first time, or after a longer gap, only sets the baseline.
 * `record` is null when nothing is to be written.
 */
export function detectChanges(
  previous: StatusRecord | null,
  snapshot: Snapshot | null,
  now: number,
): { record: StatusRecord | null; cleared: string[] } {
  if (snapshot === null || isStale(snapshot, now)) return { record: null, cleared: [] };
  if (previous !== null && snapshot.fetchedAt <= previous.processedFetchedAt) {
    return { record: null, cleared: [] };
  }
  const regions: Record<string, RegionStatus> = { ...previous?.regions };
  const cleared: string[] = [];
  for (const region of REGIONS) {
    const state = snapshot.feed.states[region.apiKey];
    // A region missing from the feed is unknown: its last confirmed status stays as it was.
    if (state === undefined) continue;
    const before = previous?.regions[region.id];
    if (!state.alertnow && before?.alert === true && snapshot.fetchedAt - before.seenAt <= GAP_MS) {
      cleared.push(region.id);
    }
    regions[region.id] = { alert: state.alertnow, seenAt: snapshot.fetchedAt };
  }
  return { record: { processedFetchedAt: snapshot.fetchedAt, regions }, cleared };
}
