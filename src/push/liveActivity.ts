import { LANGS } from "../i18n.ts";
import type { Lang } from "../regions.ts";
import { regionFromAppCode } from "./registration.ts";
import type { ApnsEnv, LiveActivityRow, PushStore } from "./registry.ts";

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

const TOKEN = /^[0-9a-f]{1,200}$/i;
const ENVS: readonly ApnsEnv[] = ["production", "sandbox"];
const REQUIRED = ["startToken", "region", "env", "lang"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value.toLowerCase() : null;
}

/**
 * REQ-PUSHAPI-008: exactly `startToken`, `region`, `env` and `lang`, plus at most `activityToken`,
 * each valid. The app omits `activityToken` while it holds no activity; `null` is refused.
 */
export function parseLiveActivity(body: unknown): LiveActivityRegistration | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  const hasActivity = "activityToken" in body;
  if (keys.length !== REQUIRED.length + (hasActivity ? 1 : 0)) return null;
  if (!REQUIRED.every((key) => key in body)) return null;
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
  store.upsertLiveActivity(row);
  return 204;
}
