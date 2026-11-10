import { endPayload, startPayload, updatePayload } from "./liveActivity.ts";
import type { ApnsEnv, OutboxItem } from "./registry.ts";
import { alertStartPayload, allClearPayload } from "./text.ts";

export type Outcome = "sent" | "drop-token" | "keep";

export interface ApnsCredentials {
  /** The `.p8` key (PKCS#8 PEM), entered by the owner with `wrangler secret put APNS_KEY`. */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

export interface ApnsEnvVars {
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

export const APNS_HOSTS: Record<ApnsEnv, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple: re-sign no more often than every 20 minutes and at least every 60. */
export const TOKEN_RESIGN_MS = 40 * 60_000;
/** A push not delivered within 5 minutes is dropped by APNs (plan gate, point 1). */
export const PUSH_LIFETIME_S = 300;

/** The credentials, or the names (never the values) of those missing. */
export function credentialsFrom(
  env: ApnsEnvVars,
): { credentials: ApnsCredentials } | { missing: string[] } {
  const names = ["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC"] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) return { missing };
  return {
    credentials: {
      key: env.APNS_KEY!,
      keyId: env.APNS_KEY_ID!,
      teamId: env.APNS_TEAM_ID!,
      topic: env.APNS_TOPIC!,
    },
  };
}

/**
 * REQ-PUSHAPI-005, after Apple's "Handling notification responses from APNs": a token that is
 * gone or bad for this app is deleted; every other answer keeps the device, and nothing is retried.
 */
export function classify(status: number, reason: string | null): Outcome {
  if (status === 200) return "sent";
  if (status === 410) return "drop-token";
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) {
    return "drop-token";
  }
  return "keep";
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jsonPart = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** The provider token: an ES256 JWT, cached and re-signed every 40 minutes. */
export class ProviderToken {
  private key: Promise<CryptoKey> | null = null;
  private cached: { jwt: Promise<string>; signedAt: number } | null = null;

  constructor(
    readonly credentials: ApnsCredentials,
    readonly now: () => number,
  ) {}

  get(): Promise<string> {
    const now = this.now();
    if (this.cached === null || now - this.cached.signedAt >= TOKEN_RESIGN_MS) {
      // Kept as a promise, so the parallel sends of one batch share one signature.
      const jwt = this.sign(Math.floor(now / 1000));
      this.cached = { jwt, signedAt: now };
      jwt.catch(() => {
        if (this.cached?.jwt === jwt) this.cached = null;
      });
    }
    return this.cached.jwt;
  }

  /** After `ExpiredProviderToken` the next push signs a new token. */
  expire(): void {
    this.cached = null;
  }

  private async sign(iat: number): Promise<string> {
    this.key ??= crypto.subtle.importKey(
      "pkcs8",
      pemToDer(this.credentials.key),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const input = `${jsonPart({ alg: "ES256", kid: this.credentials.keyId })}.${jsonPart({
      iss: this.credentials.teamId,
      iat,
    })}`;
    // WebCrypto's ECDSA signature is the raw r||s pair that JWS ES256 uses.
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await this.key,
      new TextEncoder().encode(input),
    );
    return `${input}.${base64Url(new Uint8Array(signature))}`;
  }
}

/** An `end` may still arrive within 4 hours, so a red activity never stays (owner, 2026-11-10). */
export const END_LIFETIME_S = 4 * 3600;

/**
 * The headers and body of one push by kind (spec 004, "APNs payloads"): notices go to the bundle
 * id topic, Live Activity pushes to its `.push-type.liveactivity` topic; `start` and `end` at
 * priority 10, `update` at 5, which Apple keeps outside the hourly budget.
 */
export function apnsRequest(
  item: OutboxItem,
  topic: string,
  now: number,
): { headers: Record<string, string>; body: string } {
  const expiration = (lifetime: number) => String(Math.floor(now / 1000) + lifetime);
  if (item.kind === "allclear" || item.kind === "alertstart") {
    return {
      headers: {
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-expiration": expiration(PUSH_LIFETIME_S),
      },
      body:
        item.kind === "allclear"
          ? allClearPayload(item.region, item.lang)
          : alertStartPayload(item.region, item.lang),
    };
  }
  const snapshot = item.snapshot;
  if (snapshot === undefined) throw new Error("a Live Activity push needs the feed state");
  const live = (priority: string, lifetime: number, body: string) => ({
    headers: {
      "apns-topic": `${topic}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": priority,
      "apns-expiration": expiration(lifetime),
    },
    body,
  });
  switch (item.kind) {
    case "la-start":
      return live("10", PUSH_LIFETIME_S, startPayload(item.region, item.lang, snapshot, now));
    case "la-update":
      return live("5", PUSH_LIFETIME_S, updatePayload(item.region, item.lang, snapshot, now));
    case "la-end":
      return live("10", END_LIFETIME_S, endPayload(item.region, item.lang, snapshot, now));
    case "la-move":
      throw new Error("a move is resolved before it is sent");
  }
}

/** Sends one queued push to APNs and classifies the answer; logs never name a token. */
export function apnsSender(
  token: ProviderToken,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  log: (message: string) => void,
): (item: OutboxItem) => Promise<Outcome> {
  return async (item) => {
    let response: Response;
    const request = apnsRequest(item, token.credentials.topic, token.now());
    try {
      response = await fetch(`${APNS_HOSTS[item.env]}/3/device/${item.token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${await token.get()}`,
          ...request.headers,
          "content-type": "application/json",
        },
        body: request.body,
      });
    } catch {
      // The error text may carry the request URL, and with it the token: name only the kind.
      log("push not sent: network error");
      return "keep";
    }
    if (response.status === 200) return "sent";
    let reason: string | null = null;
    try {
      const body = (await response.json()) as { reason?: unknown };
      reason = typeof body.reason === "string" ? body.reason : null;
    } catch {
      reason = null;
    }
    if (response.status === 403 && reason === "ExpiredProviderToken") token.expire();
    log(`push refused: ${response.status} ${reason ?? ""}`.trimEnd());
    return classify(response.status, reason);
  };
}
