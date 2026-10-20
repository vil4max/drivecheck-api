import type { Snapshot } from "./feed.ts";
import { neighbours, REGIONS, type Region, regionById } from "./regions.ts";

/** Twice the apps' 60 s base interval (REQ-REFRESH-006). */
export const STALE_AFTER_MS = 2 * 60_000;

export type Phase = "alarm" | "quiet" | "unavailable" | "regionUnavailable";

export interface StatusView {
  region: Region;
  phase: Phase;
  checkedAt: number | null;
  stale: boolean;
  nearby: Region[];
  surrounded: boolean;
}

export function checkedAt(snapshot: Snapshot): number {
  return snapshot.serverCachedAt ?? snapshot.fetchedAt;
}

export function isStale(snapshot: Snapshot, now: number): boolean {
  return now - checkedAt(snapshot) > STALE_AFTER_MS;
}

/**
 * REQ-SURF-010, as iOS `NearbyRegionPolicy.isSurrounded`: at least one neighbour under alert and
 * either half or more of the neighbours or more than half of the country; Kyiv Oblast alone is
 * enough for Kyiv city, one way only. Reads the given snapshot only and forecasts nothing.
 */
export function isSurrounded(region: Region, states: Snapshot["feed"]["states"]): boolean {
  const inAlarm = (r: Region) => states[r.apiKey]?.alertnow === true;
  if (region.id === "kyiv-city" && inAlarm(regionById("kyiv-oblast")!)) return true;
  const ring = neighbours(region);
  const alerting = ring.filter(inAlarm).length;
  if (alerting === 0) return false;
  return alerting * 2 >= ring.length || REGIONS.filter(inAlarm).length * 2 > REGIONS.length;
}

export function statusView(snapshot: Snapshot | null, region: Region, now: number): StatusView {
  if (snapshot === null) {
    return {
      region,
      phase: "unavailable",
      checkedAt: null,
      stale: false,
      nearby: [],
      surrounded: false,
    };
  }
  const states = snapshot.feed.states;
  const own = states[region.apiKey];
  const phase: Phase = own === undefined ? "regionUnavailable" : own.alertnow ? "alarm" : "quiet";
  const stale = isStale(snapshot, now);
  return {
    region,
    phase,
    checkedAt: checkedAt(snapshot),
    stale,
    nearby: neighbours(region).filter((n) => states[n.apiKey]?.alertnow === true),
    // Stale data never turns yellow: the neighbours' alerts are as old as the region's.
    surrounded: phase === "quiet" && !stale && isSurrounded(region, states),
  };
}
