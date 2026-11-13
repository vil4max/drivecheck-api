import { kyivTimeToEpochMs, type Snapshot } from "../feed.ts";
import { LANGS } from "../i18n.ts";
import { type Lang, regionById } from "../regions.ts";
import { checkedAt } from "../status.ts";
import { ENVS, hasFields, isRecord, parseToken, regionFromAppCode } from "./registration.ts";
import type { ApnsEnv, LiveActivityRow, PushStore } from "./registry.ts";
import { ALERT_START_LEVEL, alertStartTitle, PUSH_SOUND, regionName, sourceLabel } from "./text.ts";

/** Seconds from 1970-01-01 to 2001-01-01, Foundation's reference date. */
const REFERENCE_DATE_S = 978_307_200;
/** The stale date: 15 minutes after the check, as the app's own horizon (app plan point 5). */
export const STALE_AFTER_S = 15 * 60;
/** The green all-clear stays 5 minutes after the end (owner, 2026-11-10). */
export const DISMISSAL_AFTER_S = 5 * 60;

type Phase = "alarm" | "quiet";

/**
 * The app's `DriveCheckActivityAttributes.ContentState`, field for field. ActivityKit decodes it
 * with default strategies, so `checkedAt` is a `Date` in seconds since the reference date.
 */
function contentState(regionId: string, lang: Lang, snapshot: Snapshot, phase: Phase) {
  const startedAt = phase === "alarm" ? alarmStartedAt(snapshot, regionId) : null;
  return {
    phase,
    regionTitle: regionName(regionId, lang),
    checkedAt: checkedAt(snapshot) / 1000 - REFERENCE_DATE_S,
    sourceLabel: sourceLabel(snapshot.feed.source, lang),
    isStale: false,
    // REQ-PUSHAPI-015: only when known; an app before 3.4 ignores the key.
    ...(startedAt === null ? {} : { alertStartedAt: startedAt / 1000 - REFERENCE_DATE_S }),
  };
}

/**
 * REQ-PUSHAPI-015: when the region's current alarm started, as the feed says it (owner,
 * 2026-11-13: the time from the response, not when this server saw it). The feed's `changed` is
 * the alarm's start for a region in alarm; for a clear region it is only the cache time, so it is
 * never read there.
 */
export function alarmStartedAt(snapshot: Snapshot, regionId: string): number | null {
  const apiKey = regionById(regionId)?.apiKey;
  const state = apiKey === undefined ? undefined : snapshot.feed.states[apiKey];
  if (state?.alertnow !== true || state.changed === undefined) return null;
  return kyivTimeToEpochMs(state.changed);
}

const unixSeconds = (ms: number) => Math.floor(ms / 1000);

/** `start` to a push-to-start token: red, with the alert-start title and a new update token. */
export function startPayload(regionId: string, lang: Lang, snapshot: Snapshot, now: number) {
  return JSON.stringify({
    aps: {
      event: "start",
      timestamp: unixSeconds(now),
      "attributes-type": "DriveCheckActivityAttributes",
      attributes: {},
      "input-push-token": 1,
      "stale-date": unixSeconds(checkedAt(snapshot)) + STALE_AFTER_S,
      "interruption-level": ALERT_START_LEVEL,
      alert: { title: alertStartTitle(regionId, lang), sound: PUSH_SOUND },
      "content-state": contentState(regionId, lang, snapshot, "alarm"),
    },
  });
}

/** `update` while the alarm lasts: the new check time and stale date. */
export function updatePayload(regionId: string, lang: Lang, snapshot: Snapshot, now: number) {
  return JSON.stringify({
    aps: {
      event: "update",
      timestamp: unixSeconds(now),
      "stale-date": unixSeconds(checkedAt(snapshot)) + STALE_AFTER_S,
      "content-state": contentState(regionId, lang, snapshot, "alarm"),
    },
  });
}

/** `end` in one step: the green final content, removed 5 minutes later. */
export function endPayload(regionId: string, lang: Lang, snapshot: Snapshot, now: number) {
  return JSON.stringify({
    aps: {
      event: "end",
      timestamp: unixSeconds(now),
      "dismissal-date": unixSeconds(now) + DISMISSAL_AFTER_S,
      "content-state": contentState(regionId, lang, snapshot, "quiet"),
    },
  });
}

/** A Live Activity record as the app sends it, with the region mapped to the catalog. */
export interface LiveActivityRegistration {
  startToken: string;
  region: string;
  env: ApnsEnv;
  lang: Lang;
  activityToken: string | null;
}

/** Above it a new start token is refused with 503 (owner, 2026-11-10; revisited after Group 0). */
export const MAX_LIVE_ACTIVITIES = 5_000;

/**
 * REQ-PUSHAPI-008: exactly `startToken`, `region`, `env` and `lang`, plus at most
 * `activityToken`, each valid; any other key, `urgent` included (REQ-PUSHAPI-013), is refused.
 * The app omits `activityToken` while it holds no activity; `null` is refused.
 */
export function parseLiveActivity(body: unknown): LiveActivityRegistration | null {
  if (
    !isRecord(body) ||
    !hasFields(body, ["startToken", "region", "env", "lang"], ["activityToken"])
  ) {
    return null;
  }
  const hasActivity = "activityToken" in body;
  const startToken = parseToken(body.startToken);
  const activityToken = hasActivity ? parseToken(body.activityToken) : null;
  const region = typeof body.region === "string" ? regionFromAppCode(body.region) : undefined;
  const env = ENVS.find((candidate) => candidate === body.env);
  const lang = LANGS.find((candidate) => candidate === body.lang);
  if (
    startToken === null ||
    (hasActivity && activityToken === null) ||
    region === undefined ||
    env === undefined ||
    lang === undefined
  ) {
    return null;
  }
  return { startToken, region: region.id, env, lang, activityToken };
}

export function parseLiveActivityDeletion(body: unknown): string | null {
  return isRecord(body) && Object.keys(body).length === 1 && "startToken" in body
    ? parseToken(body.startToken)
    : null;
}

/** Stores or refreshes a record; a new one is refused at the cap. */
export function registerLiveActivity(
  store: PushStore,
  registration: LiveActivityRegistration,
  now: number,
): 204 | 503 {
  const known = store.liveActivity(registration.startToken) !== null;
  if (!known && store.countLiveActivities() >= MAX_LIVE_ACTIVITIES) return 503;
  const row: LiveActivityRow = { ...registration, lastSeen: now };
  store.transaction(() => {
    const previous = store.upsertLiveActivity(row);
    // AC-10: the region follows the driver; a running activity must not keep the old region's
    // state, so it gets one push with the new region's state once the alarm sends.
    if (previous !== null && previous.region !== row.region && row.activityToken !== null) {
      store.enqueueMove(row.startToken, row.region, now);
    }
  });
  return 204;
}
