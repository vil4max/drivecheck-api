import { DatabaseSync } from "node:sqlite";
import { PushStore, type SqlRunner } from "../src/push/registry";

/** A push store on an in-memory SQLite, with the database for direct reads in assertions. */
export function memoryStore(): { db: DatabaseSync; store: PushStore } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    all: (query, ...params) => db.prepare(query).all(...params),
    run: (query, ...params) => {
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
  return { db, store: new PushStore(sql) };
}

export const TOKEN_A = "a".repeat(64);
export const TOKEN_B = "b".repeat(64);

/** A 64-hex-digit token numbered `n`, for registering many devices. */
export const tokenNo = (n: number): string => n.toString(16).padStart(64, "0");
