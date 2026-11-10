import { LANGS } from "../i18n.ts";
import { type Lang, REGIONS, type Region } from "../regions.ts";
import type { ApnsEnv, PushStore } from "./registry.ts";

/** A registration as the app sends it, with the region already mapped to the catalog. */
export interface Registration {
  token: string;
  region: string;
  env: ApnsEnv;
  lang: Lang;
  /** The app's urgent switch (spec 004 AC-12); absent in the body means false. */
  urgent: boolean;
}

/** Above it a new token is refused with 503 (owner decision at the plan gate, 2026-11-09). */
export const MAX_DEVICES = 10_000;

/** An APNs device token as the app sends it: hex digits only. */
const TOKEN = /^[0-9a-f]{1,200}$/i;
export const ENVS: readonly ApnsEnv[] = ["production", "sandbox"];

// The app sends its `AlertRegion` raw values (`kyivCity`); the catalog ids are their kebab form.
const appCode = (id: string) =>
  id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const byAppCode = new Map(REGIONS.map((region) => [appCode(region.id), region]));

export function regionFromAppCode(code: string): Region | undefined {
  return byAppCode.get(code);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasExactly = (body: Record<string, unknown>, keys: string[]) =>
  Object.keys(body).length === keys.length && keys.every((key) => key in body);

/** Every `required` key, any of `optional`, and nothing else. */
export function hasFields(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return (
    required.every((key) => key in body) &&
    Object.keys(body).every((key) => required.includes(key) || optional.includes(key))
  );
}

export function parseToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value.toLowerCase() : null;
}

/** The urgent switch: a boolean, or absent for false; anything else is invalid (null). */
export function parseUrgent(body: Record<string, unknown>): boolean | null {
  if (!("urgent" in body)) return false;
  return typeof body.urgent === "boolean" ? body.urgent : null;
}

/**
 * REQ-PUSHAPI-001: exactly `token`, `region`, `env` and `lang`, plus at most `urgent`
 * (REQ-PUSHAPI-013), each valid, or nothing.
 */
export function parseRegistration(body: unknown): Registration | null {
  if (!isRecord(body) || !hasFields(body, ["token", "region", "env", "lang"], ["urgent"])) {
    return null;
  }
  const token = parseToken(body.token);
  const region = typeof body.region === "string" ? regionFromAppCode(body.region) : undefined;
  const env = ENVS.find((candidate) => candidate === body.env);
  const lang = LANGS.find((candidate) => candidate === body.lang);
  const urgent = parseUrgent(body);
  if (
    token === null ||
    region === undefined ||
    env === undefined ||
    lang === undefined ||
    urgent === null
  ) {
    return null;
  }
  return { token, region: region.id, env, lang, urgent };
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
