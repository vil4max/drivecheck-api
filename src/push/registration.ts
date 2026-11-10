import { LANGS } from "../i18n.ts";
import { type Lang, REGIONS, type Region } from "../regions.ts";
import type { ApnsEnv, PushStore } from "./registry.ts";

/** A registration as the app sends it, with the region already mapped to the catalog. */
export interface Registration {
  token: string;
  region: string;
  env: ApnsEnv;
  lang: Lang;
}

/** Above it a new token is refused with 503 (owner decision at the plan gate, 2026-11-09). */
export const MAX_DEVICES = 10_000;

/** An APNs device token as the app sends it: hex digits only. */
const TOKEN = /^[0-9a-f]{1,200}$/i;
const ENVS: readonly ApnsEnv[] = ["production", "sandbox"];

// The app sends its `AlertRegion` raw values (`kyivCity`); the catalog ids are their kebab form.
const appCode = (id: string) =>
  id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const byAppCode = new Map(REGIONS.map((region) => [appCode(region.id), region]));

export function regionFromAppCode(code: string): Region | undefined {
  return byAppCode.get(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasExactly = (body: Record<string, unknown>, keys: string[]) =>
  Object.keys(body).length === keys.length && keys.every((key) => key in body);

function parseToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value.toLowerCase() : null;
}

/** REQ-PUSHAPI-001: exactly `token`, `region`, `env` and `lang`, each valid, or nothing. */
export function parseRegistration(body: unknown): Registration | null {
  if (!isRecord(body) || !hasExactly(body, ["token", "region", "env", "lang"])) return null;
  const token = parseToken(body.token);
  const region = typeof body.region === "string" ? regionFromAppCode(body.region) : undefined;
  const env = ENVS.find((candidate) => candidate === body.env);
  const lang = LANGS.find((candidate) => candidate === body.lang);
  if (token === null || region === undefined || env === undefined || lang === undefined) {
    return null;
  }
  return { token, region: region.id, env, lang };
}

export function parseDeletion(body: unknown): string | null {
  return isRecord(body) && hasExactly(body, ["token"]) ? parseToken(body.token) : null;
}

/** Stores or refreshes a device; a new one is refused at the cap (REQ-PUSHAPI-007). */
export function register(store: PushStore, registration: Registration, now: number): 204 | 503 {
  if (!store.hasDevice(registration.token) && store.countDevices() >= MAX_DEVICES) return 503;
  store.upsertDevice({ ...registration, lastSeen: now });
  return 204;
}
