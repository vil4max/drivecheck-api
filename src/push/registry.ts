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
  // Only the records holding an activity token, by region: the 5-minute walk and the end sweep.
  `CREATE INDEX IF NOT EXISTS push_live_activities_held
     ON push_live_activities (region, start_token) WHERE activity_token IS NOT NULL`,
];

/**
 * What a queued row sends. Notice kinds name a device token, Live Activity kinds a start token;
 * the activity token of `la-end` and `la-move` is read at send time.
 */
export type OutboxKind = "allclear" | "alertstart" | "la-start" | "la-end" | "la-move";
export const NOTICE_KINDS: readonly OutboxKind[] = ["allclear", "alertstart"];

/** How long a queued row may wait: as long as its push lives (plan gate, critic point 1). */
export const PUSH_LIFETIME_MS: Record<OutboxKind, number> = {
  allclear: 5 * 60_000,
  alertstart: 5 * 60_000,
  "la-start": 5 * 60_000,
  "la-move": 5 * 60_000,
  "la-end": 4 * 3_600_000,
};

// Spec 004 adds `kind` to the spec 003 outbox; rows queued before it are all-clear pushes.
const ADD_KIND = "ALTER TABLE push_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'allclear'";

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
    try {
      sql.run(ADD_KIND);
    } catch (error) {
      // Every start after the first finds the column; anything else is a real failure.
      if (!/duplicate column/i.test((error as Error).message)) throw error;
    }
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

  /** Queues one notice for every device registered in `region`. */
  enqueue(
    region: string,
    changeId: string,
    createdAt: number,
    kind: "allclear" | "alertstart" = "allclear",
  ): void {
    this.sql.run(
      `INSERT OR IGNORE INTO push_outbox (token, region, change_id, created_at, kind)
       SELECT token, region, ?, ?, ? FROM push_devices WHERE region = ?`,
      changeId,
      createdAt,
      kind,
      region,
    );
  }

  /** Queues one Live Activity `start` for every record in `region` (spec 004, P2: always). */
  enqueueLiveActivityStarts(region: string, changeId: string, createdAt: number): void {
    this.sql.run(
      `INSERT OR IGNORE INTO push_outbox (token, region, change_id, created_at, kind)
       SELECT start_token, region, ?, ?, 'la-start' FROM push_live_activities WHERE region = ?`,
      changeId,
      createdAt,
      region,
    );
  }

  /**
   * Queues one `end` for every record holding an activity token in one of `regions`. The fixed
   * change id keeps one pending end per record, however many snapshots see the region clear.
   */
  enqueueEnds(regions: readonly string[], createdAt: number): void {
    if (regions.length === 0) return;
    this.sql.run(
      `INSERT OR IGNORE INTO push_outbox (token, region, change_id, created_at, kind)
       SELECT start_token, region, 'end', ?, 'la-end' FROM push_live_activities
       WHERE activity_token IS NOT NULL AND region IN (${regions.map(() => "?").join(", ")})`,
      createdAt,
      ...regions,
    );
  }

  /** Queues the one push that moves a running activity to its record's new region (AC-10). */
  enqueueMove(startToken: string, region: string, createdAt: number): void {
    this.sql.run(
      `INSERT OR IGNORE INTO push_outbox (token, region, change_id, created_at, kind)
       VALUES (?, ?, 'move', ?, 'la-move')`,
      startToken,
      region,
      createdAt,
    );
  }

  takeOutbox(limit: number): OutboxItem[] {
    return this.sql
      .all(
        `SELECT o.id, o.token, o.region, o.created_at, d.env, d.lang
         FROM push_outbox o JOIN push_devices d ON d.token = o.token
         WHERE o.kind = 'allclear'
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

  /** Deletes unsent every queued row older than its push's lifetime. */
  dropExpiredOutbox(now: number): void {
    this.sql.run(
      `DELETE FROM push_outbox
       WHERE (kind = 'la-end' AND created_at < ?) OR (kind <> 'la-end' AND created_at < ?)`,
      now - PUSH_LIFETIME_MS["la-end"],
      now - PUSH_LIFETIME_MS.allclear,
    );
  }

  /** Whether a push is queued; reads at most one row. */
  hasOutbox(): boolean {
    return this.sql.all("SELECT 1 FROM push_outbox LIMIT 1").length > 0;
  }
}
