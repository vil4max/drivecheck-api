import type { Snapshot } from "./coordinator";
import { neighbours, type Region } from "./regions";

/** Twice the apps' 60 s base interval (REQ-REFRESH-006). */
export const STALE_AFTER_MS = 2 * 60_000;

export type Phase = "alarm" | "quiet" | "unavailable" | "regionUnavailable";

export interface StatusView {
  region: Region;
  phase: Phase;
  checkedAt: number | null;
  stale: boolean;
  nearby: Region[];
}

export function checkedAt(snapshot: Snapshot): number {
  return snapshot.serverCachedAt ?? snapshot.fetchedAt;
}

export function isStale(snapshot: Snapshot, now: number): boolean {
  return now - checkedAt(snapshot) > STALE_AFTER_MS;
}

export function statusView(snapshot: Snapshot | null, region: Region, now: number): StatusView {
  if (snapshot === null) {
    return { region, phase: "unavailable", checkedAt: null, stale: false, nearby: [] };
  }
  const states = snapshot.feed.states;
  const own = states[region.apiKey];
  return {
    region,
    phase: own === undefined ? "regionUnavailable" : own.alertnow ? "alarm" : "quiet",
    checkedAt: checkedAt(snapshot),
    stale: isStale(snapshot, now),
    nearby: neighbours(region).filter((n) => states[n.apiKey]?.alertnow === true),
  };
}
