import { DatabaseSync } from "node:sqlite";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, type AlarmState, runAlarm, savedAlertStarts } from "../src/push/alarm";
import type { ApnsCredentials } from "../src/push/apns";
import { registerLiveActivity } from "../src/push/liveActivity";
import { register } from "../src/push/registration";
import { PushStore, type SqlRunner } from "../src/push/registry";
import { type Send, sendBatch, sendUpdates } from "../src/push/sender";
import { route } from "../src/router";
import { snapshotWith, T0 } from "./support";

/**
 * A push store on an in-memory SQLite, with the database for direct reads in assertions and the
 * statements the store ran.
 */
export function memoryStore(): { db: DatabaseSync; store: PushStore; queries: string[] } {
  return storeOn(new DatabaseSync(":memory:"));
}

/** A push store on `db`, which may already hold an older schema, as a deployed object does. */
export function storeOn(db: DatabaseSync): {
  db: DatabaseSync;
  store: PushStore;
  queries: string[];
} {
  const queries: string[] = [];
  const sql: SqlRunner = {
    all: (query, ...params) => {
      queries.push(query);
      return db.prepare(query).all(...params);
    },
    run: (query, ...params) => {
      queries.push(query);
      db.prepare(query).run(...params);
    },
    transaction: (work) => {
      db.exec("BEGIN");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, store: new PushStore(sql), queries };
}

export const TOKEN_A = "a".repeat(64);
export const TOKEN_B = "b".repeat(64);

/** A 64-hex-digit token numbered `n`, for registering many devices. */
export const tokenNo = (n: number): string => n.toString(16).padStart(64, "0");

/** APNs credentials with a key generated for the test; no key file exists. */
export async function generatedCredentials(): Promise<ApnsCredentials> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const key = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { key, keyId: "KEYID12345", teamId: "TEAMID1234", topic: "vil4max.RegionalCheck" };
}

/**
 * The push alarm wired as the Worker wires it, sending through `send` on `clock`; `alarm` runs one
 * invocation at `t` that sees `snapshot` (null: the feed failed) and the 429 window.
 */
export function alarmLoop(store: PushStore, send: Send, clock: { now: number }) {
  let view: CoordinatorView = { snapshot: null, rateLimitedUntil: null };
  const state: AlarmState = { lastPollAt: null };
  // As the Worker wires it, so a test of the loop also covers the saved alarm starts.
  const options = (limit: number) => ({
    limit,
    latest: state.latest ?? null,
    alertStart: savedAlertStarts(store),
    now: () => clock.now,
  });
  const deps: AlarmDeps = {
    store,
    refresh: async () => view,
    deadline: () => new Promise<void>(() => {}),
    now: () => clock.now,
    sendBatch: (limit) => sendBatch(store, send, () => {}, options(limit)),
    sendUpdates: (walk, limit) => sendUpdates(store, walk, send, () => {}, options(limit)),
    log: () => {},
  };
  return {
    state,
    alarm: (t: number, snapshot: Snapshot | null, rateLimitedUntil: number | null = null) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil };
      return runAlarm(deps, state);
    },
  };
}

/** The router with both push endpoints wired to `store`, as the Worker wires the object. */
export function pushClient(path: string, store: PushStore, clock = { now: T0 }) {
  const view: CoordinatorView = { snapshot: snapshotWith([]), rateLimitedUntil: null };
  return (method: string, body?: unknown, raw?: string) =>
    route({
      request: new Request(`https://drivecheck.example${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(raw !== undefined || body !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
      }),
      regionCode: null,
      getView: async () => view,
      getMap: async () => null,
      clock: () => clock.now,
      push: {
        register: async (registration) => register(store, registration, clock.now),
        forget: async (token) => store.deleteDevice(token),
      },
      liveActivity: {
        register: async (registration) => registerLiveActivity(store, registration, clock.now),
        forget: async (startToken) => store.deleteLiveActivity(startToken),
      },
    });
}
