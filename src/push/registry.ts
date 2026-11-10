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
  all(query: string, ...params: (string | number | null)[]): Record<string, unknown>[];
  run(query: string, ...params: (string | number | null)[]): void;
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
  // Spec 004: one row per ActivityKit push-to-start token, apart from the notice devices.
  `CREATE TABLE IF NOT EXISTS push_live_activities (
    start_token TEXT PRIMARY KEY,
    region TEXT NOT NULL,
    env TEXT NOT NULL,
    lang TEXT NOT NULL,
    activity_token TEXT,
    last_seen INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS push_live_activities_region ON push_live_activities (region)",
  "CREATE INDEX IF NOT EXISTS push_live_activities_seen ON push_live_activities (last_seen)",
];

const DEVICE_COUNT_KEY = "deviceCount";
const LIVE_ACTIVITY_COUNT_KEY = "liveActivityCount";

/** Everything the server keeps about a Live Activity (REQ-PUSHAPI-009): six fields, nothing else. */
export interface LiveActivityRow {
  startToken: string;
  /** A catalog region id (`kyiv-city`), not the app's code. */
  region: string;
  env: ApnsEnv;
  lang: Lang;
  /** The update token of the running activity, or null while none runs. */
  activityToken: string | null;
  lastSeen: number;
}

export class PushStore {
  constructor(private readonly sql: SqlRunner) {
    for (const statement of SCHEMA) sql.run(statement);
  }

  transaction<T>(work: () => T): T {
    return this.sql.transaction(work);
  }

  /**
   * The number of devices, kept as a counter: a `COUNT(*)` would read every row on each alarm and
   * each new registration, and rows read are a Free plan daily limit too.
   */
  countDevices(): number {
    return Number(this.loadState(DEVICE_COUNT_KEY) ?? 0);
  }

  private adjustDeviceCount(delta: number): void {
    this.saveState(DEVICE_COUNT_KEY, String(Math.max(0, this.countDevices() + delta)));
  }

  hasDevice(token: string): boolean {
    return this.sql.all("SELECT 1 FROM push_devices WHERE token = ?", token).length > 0;
  }

  upsertDevice(row: DeviceRow): void {
    const isNew = !this.hasDevice(row.token);
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
    if (isNew) this.adjustDeviceCount(1);
  }

  /** Forgets a device and every push still queued for it. */
  deleteDevice(token: string): void {
    if (!this.hasDevice(token)) return;
    this.sql.run("DELETE FROM push_outbox WHERE token = ?", token);
    this.sql.run("DELETE FROM push_devices WHERE token = ?", token);
    this.adjustDeviceCount(-1);
  }

  /** Deletes devices last heard from before `before`, and their queued pushes. */
  pruneDevices(before: number): void {
    // An index range: it reads only the expired rows.
    const expired = Number(
      this.sql.all("SELECT COUNT(*) AS n FROM push_devices WHERE last_seen < ?", before)[0]?.n ?? 0,
    );
    if (expired === 0) return;
    this.sql.run(
      "DELETE FROM push_outbox WHERE token IN (SELECT token FROM push_devices WHERE last_seen < ?)",
      before,
    );
    this.sql.run("DELETE FROM push_devices WHERE last_seen < ?", before);
    this.adjustDeviceCount(-expired);
  }

  /** The number of Live Activity records, kept as a counter like `countDevices`. */
  countLiveActivities(): number {
    return Number(this.loadState(LIVE_ACTIVITY_COUNT_KEY) ?? 0);
  }

  private adjustLiveActivityCount(delta: number): void {
    this.saveState(
      LIVE_ACTIVITY_COUNT_KEY,
      String(Math.max(0, this.countLiveActivities() + delta)),
    );
  }

  liveActivity(startToken: string): LiveActivityRow | null {
    const row = this.sql.all(
      "SELECT * FROM push_live_activities WHERE start_token = ?",
      startToken,
    )[0];
    if (row === undefined) return null;
    return {
      startToken: String(row.start_token),
      region: String(row.region),
      env: row.env as ApnsEnv,
      lang: row.lang as Lang,
      activityToken: row.activity_token === null ? null : String(row.activity_token),
      lastSeen: Number(row.last_seen),
    };
  }

  /** Stores or replaces a record; returns the one it replaced, if any. */
  upsertLiveActivity(row: LiveActivityRow): LiveActivityRow | null {
    const previous = this.liveActivity(row.startToken);
    this.sql.run(
      `INSERT INTO push_live_activities
         (start_token, region, env, lang, activity_token, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (start_token) DO UPDATE SET
         region = excluded.region, env = excluded.env, lang = excluded.lang,
         activity_token = excluded.activity_token, last_seen = excluded.last_seen`,
      row.startToken,
      row.region,
      row.env,
      row.lang,
      row.activityToken,
      row.lastSeen,
    );
    if (previous === null) this.adjustLiveActivityCount(1);
    return previous;
  }

  /** Forgets a record and every push still queued for it. */
  deleteLiveActivity(startToken: string): void {
    if (this.liveActivity(startToken) === null) return;
    this.sql.run("DELETE FROM push_outbox WHERE token = ?", startToken);
    this.sql.run("DELETE FROM push_live_activities WHERE start_token = ?", startToken);
    this.adjustLiveActivityCount(-1);
  }

  /** Deletes records last heard from before `before`, and their queued pushes. */
  pruneLiveActivities(before: number): void {
    const expired = Number(
      this.sql.all("SELECT COUNT(*) AS n FROM push_live_activities WHERE last_seen < ?", before)[0]
        ?.n ?? 0,
    );
    if (expired === 0) return;
    this.sql.run(
      "DELETE FROM push_outbox WHERE token IN (SELECT start_token FROM push_live_activities WHERE last_seen < ?)",
      before,
    );
    this.sql.run("DELETE FROM push_live_activities WHERE last_seen < ?", before);
    this.adjustLiveActivityCount(-expired);
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

  /** Whether a push is queued; reads at most one row. */
  hasOutbox(): boolean {
    return this.sql.all("SELECT 1 FROM push_outbox LIMIT 1").length > 0;
  }
}
