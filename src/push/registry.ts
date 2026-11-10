import type { Snapshot } from "../feed.ts";
import type { Lang } from "../regions.ts";

export type ApnsEnv = "production" | "sandbox";

/** Everything the server keeps about a device (REQ-PUSHAPI-002): six fields, nothing else. */
export interface DeviceRow {
  token: string;
  /** A catalog region id (`kyiv-city`), not the app's code. */
  region: string;
  env: ApnsEnv;
  lang: Lang;
  lastSeen: number;
  /** The app's urgent switch (spec 004 AC-12); absent is false. */
  urgent?: boolean;
}

/** One push waiting to be sent, joined with its device's environment and language. */
export interface OutboxItem {
  /** The outbox row, or 0 for an update the walk builds without one. */
  id: number;
  /** What to send; a queued `la-move` is resolved to `la-update` or `la-end` before sending. */
  kind: SendKind;
  /** The record the row belongs to: a device token, or a Live Activity start token. */
  key: string;
  /** The token the push goes to; null when an activity token was cleared since queueing. */
  token: string | null;
  region: string;
  env: ApnsEnv;
  lang: Lang;
  createdAt: number;
  /** The device's urgent switch: its alert-start alerts are time-sensitive (AC-12). */
  urgent: boolean;
  /** The feed state a Live Activity push carries. */
  snapshot?: Snapshot;
}

export type SendKind = OutboxKind | "la-update";

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
    last_seen INTEGER NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0
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

/**
 * Column changes to the spec 003 tables, applied once each and in order; the number reached is
 * kept in `push_state`, since Durable Object SQLite has no `PRAGMA user_version` (Cloudflare,
 * "Rules of Durable Objects", migrations).
 */
const MIGRATIONS = [
  // Spec 004: rows queued before it are all-clear pushes.
  "ALTER TABLE push_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'allclear'",
  // Spec 004 AC-12: the urgent switch; devices registered before it are not urgent.
  "ALTER TABLE push_devices ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0",
];
const SCHEMA_VERSION_KEY = "schemaVersion";

const DEVICE_COUNT_KEY = "deviceCount";
const LIVE_ACTIVITY_COUNT_KEY = "liveActivityCount";

/** Everything the server keeps about a Live Activity (REQ-PUSHAPI-009): seven fields, nothing else. */
export interface LiveActivityRow {
  startToken: string;
  /** A catalog region id (`kyiv-city`), not the app's code. */
  region: string;
  env: ApnsEnv;
  lang: Lang;
  /** The update token of the running activity, or null while none runs. */
  activityToken: string | null;
  lastSeen: number;
  /** The app's urgent switch (spec 004 AC-12); absent is false. */
  urgent?: boolean;
}

export class PushStore {
  constructor(private readonly sql: SqlRunner) {
    for (const statement of SCHEMA) sql.run(statement);
    const done = Number(this.loadState(SCHEMA_VERSION_KEY) ?? 0);
    for (let version = done; version < MIGRATIONS.length; version += 1) {
      // Each step and its version mark commit together, so a failed start retries that step.
      sql.transaction(() => {
        sql.run(MIGRATIONS[version]!);
        this.saveState(SCHEMA_VERSION_KEY, String(version + 1));
      });
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
      `INSERT INTO push_devices (token, region, env, lang, last_seen, urgent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET
         region = excluded.region, env = excluded.env, lang = excluded.lang,
         last_seen = excluded.last_seen, urgent = excluded.urgent`,
      row.token,
      row.region,
      row.env,
      row.lang,
      row.lastSeen,
      row.urgent === true ? 1 : 0,
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
      urgent: Number(row.urgent) === 1,
    };
  }

  /** Stores or replaces a record; returns the one it replaced, if any. */
  upsertLiveActivity(row: LiveActivityRow): LiveActivityRow | null {
    const previous = this.liveActivity(row.startToken);
    this.sql.run(
      `INSERT INTO push_live_activities
         (start_token, region, env, lang, activity_token, last_seen, urgent)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (start_token) DO UPDATE SET
         region = excluded.region, env = excluded.env, lang = excluded.lang,
         activity_token = excluded.activity_token, last_seen = excluded.last_seen,
         urgent = excluded.urgent`,
      row.startToken,
      row.region,
      row.env,
      row.lang,
      row.activityToken,
      row.lastSeen,
      row.urgent === true ? 1 : 0,
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
       WHERE activity_token IS NOT NULL AND region IN (${regions.map(() => "?").join(", ")})
         AND start_token NOT IN (SELECT token FROM push_outbox WHERE kind = 'la-move')`,
      createdAt,
      ...regions,
    );
  }

  /**
   * Queues the one push that moves a running activity to its record's new region (AC-10). An end
   * still queued for the record goes: both would show the record's region at send time, so one
   * push per record is enough.
   */
  enqueueMove(startToken: string, region: string, createdAt: number): void {
    this.sql.run("DELETE FROM push_outbox WHERE token = ? AND kind = 'la-end'", startToken);
    this.sql.run(
      `INSERT OR IGNORE INTO push_outbox (token, region, change_id, created_at, kind)
       VALUES (?, ?, 'move', ?, 'la-move')`,
      startToken,
      region,
      createdAt,
    );
  }

  /**
   * The oldest queued rows, joined with their device or record. A Live Activity push takes the
   * record's region at send time; a notice keeps the region it was queued for.
   */
  takeOutbox(limit: number): OutboxItem[] {
    return this.sql
      .all(
        `SELECT o.id, o.kind, o.token AS key, o.region AS queued_region, o.created_at,
                d.env AS d_env, d.lang AS d_lang, d.urgent AS d_urgent,
                l.env AS l_env, l.lang AS l_lang, l.region AS l_region, l.activity_token,
                l.urgent AS l_urgent
         FROM push_outbox o
         LEFT JOIN push_devices d
           ON o.kind IN ('allclear', 'alertstart') AND d.token = o.token
         LEFT JOIN push_live_activities l
           ON o.kind IN ('la-start', 'la-end', 'la-move') AND l.start_token = o.token
         WHERE d.token IS NOT NULL OR l.start_token IS NOT NULL
         ORDER BY o.id LIMIT ?`,
        limit,
      )
      .map((row) => {
        const kind = row.kind as OutboxKind;
        const key = String(row.key);
        const notice = NOTICE_KINDS.includes(kind);
        const activity = row.activity_token === null ? null : String(row.activity_token);
        return {
          id: Number(row.id),
          kind,
          key,
          token: notice || kind === "la-start" ? key : activity,
          // A Live Activity push shows the record's region now (the driver may have moved since).
          region: String(notice ? row.queued_region : row.l_region),
          env: (notice ? row.d_env : row.l_env) as ApnsEnv,
          lang: (notice ? row.d_lang : row.l_lang) as Lang,
          createdAt: Number(row.created_at),
          urgent: Number(notice ? row.d_urgent : row.l_urgent) === 1,
        };
      });
  }

  /** Up to `limit` records of `region` holding an activity token, after `after` in key order. */
  heldLiveActivities(region: string, after: string, limit: number): LiveActivityRow[] {
    return this.sql
      .all(
        `SELECT start_token, region, env, lang, activity_token, last_seen
         FROM push_live_activities
         WHERE region = ? AND activity_token IS NOT NULL AND start_token > ?
         ORDER BY start_token LIMIT ?`,
        region,
        after,
        limit,
      )
      .map((row) => ({
        startToken: String(row.start_token),
        region: String(row.region),
        env: row.env as ApnsEnv,
        lang: row.lang as Lang,
        activityToken: String(row.activity_token),
        lastSeen: Number(row.last_seen),
      }));
  }

  /** Forgets an activity token, unless the app has sent a newer one since. */
  clearActivityToken(startToken: string, activityToken: string): void {
    this.sql.run(
      "UPDATE push_live_activities SET activity_token = NULL WHERE start_token = ? AND activity_token = ?",
      startToken,
      activityToken,
    );
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
