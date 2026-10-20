export interface RegionState {
  alertnow: boolean;
  changed?: string;
}

export interface Feed {
  source: string;
  cachedat: string;
  states: Record<string, RegionState>;
}

/** One decoded answer with the times it was fetched and, when parseable, cached upstream. */
export interface Snapshot {
  feed: Feed;
  fetchedAt: number;
  serverCachedAt: number | null;
}

export class FeedError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the fields the apps decode; extra upstream fields are dropped, not mirrored blindly. */
export function parseFeed(value: unknown): Feed {
  if (!isRecord(value)) throw new FeedError("feed is not an object");
  const { source, cachedat, states } = value;
  if (typeof source !== "string" || typeof cachedat !== "string" || !isRecord(states)) {
    throw new FeedError("feed lacks source, cachedat or states");
  }
  const parsed: Record<string, RegionState> = {};
  for (const [key, state] of Object.entries(states)) {
    if (!isRecord(state) || typeof state.alertnow !== "boolean") {
      throw new FeedError(`state ${key} has no boolean alertnow`);
    }
    parsed[key] =
      typeof state.changed === "string"
        ? { alertnow: state.alertnow, changed: state.changed }
        : { alertnow: state.alertnow };
  }
  return { source, cachedat, states: parsed };
}

const KYIV_ZONE = "Europe/Kyiv";
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: KYIV_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function kyivOffsetMs(epochMs: number): number {
  const parts = Object.fromEntries(zoneParts.formatToParts(epochMs).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** `cachedat` is Kyiv wall-clock time without an offset. */
export function kyivTimeToEpochMs(raw: string): number | null {
  const match = LOCAL_TIME.exec(raw);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  const guess = wall - kyivOffsetMs(wall);
  // Re-check at the guessed instant so a time near a DST switch gets the offset in force then.
  return wall - kyivOffsetMs(guess);
}
