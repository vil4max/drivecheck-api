import type { Lang } from "../regions.ts";

export type ApnsEnv = "production" | "sandbox";

/** Everything the server keeps about a device (REQ-PUSHAPI-002): five fields, nothing else. */
export interface DeviceRow {
  token: string;
  /** A catalog region id (`kyiv-city`), not the app's code. */
  region: string;
  env: ApnsEnv;
  lang: Lang;
  lastSeen: number;
}

/** One push waiting to be sent, joined with its device's environment and language. */
export interface OutboxItem {
  id: number;
  token: string;
  region: string;
  env: ApnsEnv;
  lang: Lang;
  createdAt: number;
}

/**
 * The SQL the store needs. The Durable Object passes `ctx.storage.sql`, the tests an in-memory
 * SQLite, so the statements below run the same in both.
 */
export interface SqlRunner {
  all(query: string, ...params: (string | number)[]): Record<string, unknown>[];
  run(query: string, ...params: (string | number)[]): void;
  transaction<T>(work: () => T): T;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_devices (
    token TEXT PRIMARY KEY,
    region TEXT NOT NULL,
    env TEXT NOT NULL,
    lang TEXT NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS push_devices_region ON push_devices (region)",
  "CREATE INDEX IF NOT EXISTS push_devices_seen ON push_devices (last_seen)",
  // A push is queued once per device and change, so a change processed twice queues nothing new.
  `CREATE TABLE IF NOT EXISTS push_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    region TEXT NOT NULL,
    change_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (token, change_id)
  )`,
  // Single overwritten records (the region statuses), never a history.
  "CREATE TABLE IF NOT EXISTS push_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

export class PushStore {
  constructor(private readonly sql: SqlRunner) {
    for (const statement of SCHEMA) sql.run(statement);
  }

  transaction<T>(work: () => T): T {
    return this.sql.transaction(work);
  }

  countDevices(): number {
    return Number(this.sql.all("SELECT COUNT(*) AS n FROM push_devices")[0]?.n ?? 0);
  }

  hasDevice(token: string): boolean {
    return this.sql.all("SELECT 1 FROM push_devices WHERE token = ?", token).length > 0;
  }

  upsertDevice(row: DeviceRow): void {
    this.sql.run(
      `INSERT INTO push_devices (token, region, env, lang, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET
         region = excluded.region, env = excluded.env, lang = excluded.lang,
         last_seen = excluded.last_seen`,
      row.token,
      row.region,
      row.env,
      row.lang,
      row.lastSeen,
    );
  }

  /** Forgets a device and every push still queued for it. */
  deleteDevice(token: string): void {
    this.sql.run("DELETE FROM push_outbox WHERE token = ?", token);
    this.sql.run("DELETE FROM push_devices WHERE token = ?", token);
  }

  /** Deletes devices last heard from before `before`, and their queued pushes. */
  pruneDevices(before: number): void {
    this.sql.run(
      "DELETE FROM push_outbox WHERE token IN (SELECT token FROM push_devices WHERE last_seen < ?)",
      before,
    );
    this.sql.run("DELETE FROM push_devices WHERE last_seen < ?", before);
  }

  loadState(key: string): string | null {
    const row = this.sql.all("SELECT value FROM push_state WHERE key = ?", key)[0];
    return row === undefined ? null : String(row.value);
  }

  saveState(key: string, value: string): void {
    this.sql.run(
      "INSERT INTO push_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** Queues one push for every device registered in `region`. */
  enqueue(region: string, changeId: string, createdAt: number): void {
    this.sql.run(
      `INSERT OR IGNORE INTO push_outbox (token, region, change_id, created_at)
       SELECT token, region, ?, ? FROM push_devices WHERE region = ?`,
      changeId,
      createdAt,
      region,
    );
  }

  takeOutbox(limit: number): OutboxItem[] {
    return this.sql
      .all(
        `SELECT o.id, o.token, o.region, o.created_at, d.env, d.lang
         FROM push_outbox o JOIN push_devices d ON d.token = o.token
         ORDER BY o.id LIMIT ?`,
        limit,
      )
      .map((row) => ({
        id: Number(row.id),
        token: String(row.token),
        region: String(row.region),
        env: row.env as ApnsEnv,
        lang: row.lang as Lang,
        createdAt: Number(row.created_at),
      }));
  }

  deleteOutbox(id: number): void {
    this.sql.run("DELETE FROM push_outbox WHERE id = ?", id);
  }

  dropOutboxBefore(before: number): void {
    this.sql.run("DELETE FROM push_outbox WHERE created_at < ?", before);
  }

  outboxSize(): number {
    return Number(this.sql.all("SELECT COUNT(*) AS n FROM push_outbox")[0]?.n ?? 0);
  }
}
