import { DatabaseSync } from "node:sqlite";
import type { ApnsCredentials } from "../src/push/apns";
import { PushStore, type SqlRunner } from "../src/push/registry";

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
