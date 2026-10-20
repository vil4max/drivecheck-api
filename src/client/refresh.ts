import { type Snapshot, snapshotFromApi } from "../feed.ts";
import { rateLimitDeadline } from "../retryAfter.ts";
import { checkedAt, STALE_AFTER_MS } from "../status.ts";

export type TimerHandle = unknown;

export const ALERTS_PATH = "/v1/alerts";
/** The service worker marks a cached answer it served because the network failed. */
export const OFFLINE_HEADER = "x-drivecheck-offline";

const FLOOR_MS = 10_000;
const RETRY_MS = 2_000;
const TIMEOUT_MS = 15_000;
const BASE_MS = 60_000;
const ALARM_MS = 30_000;
const SAVER_MS = 300_000;

export interface RefreshDeps {
  now: () => number;
  setTimer: (run: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /** A same-origin GET; the loop only ever asks `ALERTS_PATH` (REQ-WEB-006). */
  fetch: (path: string, signal: AbortSignal) => Promise<Response>;
  timeoutSignal: (ms: number) => AbortSignal;
  random: () => number;
  saveData: () => boolean;
  /** Whether the shown region is under alert in this snapshot (30 s polling). */
  inAlarm: (snapshot: Snapshot) => boolean;
  /** Draws the status: after a new answer, inside the floor, and when it turns stale. */
  render: (snapshot: Snapshot | null) => void;
}

type Outcome = "ok" | "transient" | "held" | "failed";

/**
 * The open page's refresh, the iOS refresh policy in a browser: only while visible
 * (REQ-REFRESH-001), 60/30/300 s with ±10 % jitter (REQ-REFRESH-002), one retry after 2 s
 * (REQ-REFRESH-003), the Worker's Retry-After or a 30 s → 5 min backoff (REQ-REFRESH-005), a
 * stale redraw at checkedAt + 2 min (REQ-REFRESH-006) and a 10 s floor (REQ-REFRESH-010).
 */
export class RefreshLoop {
  private snapshot: Snapshot | null;
  private lastSuccessAt: number;
  private holdUntil: number | null = null;
  private limitStreak = 0;
  private visible = false;
  private pollTimer: TimerHandle | null = null;
  private staleTimer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  /** No attempt has run since the page opened. */
  private firstPending = true;

  constructor(
    private readonly deps: RefreshDeps,
    initial: { snapshot: Snapshot | null; receivedAt: number },
  ) {
    this.snapshot = initial.snapshot;
    // The page arrived with its answer, so opening it adds no request.
    this.lastSuccessAt = initial.receivedAt;
  }

  start(visible: boolean): void {
    this.visible = visible;
    this.armStale();
    this.schedulePoll();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) void this.trigger();
    else this.clearPoll();
  }

  /** The Refresh control; a request only outside the floor and any hold. */
  refresh(): Promise<void> {
    return this.trigger();
  }

  stop(): void {
    this.visible = false;
    this.clearPoll();
    if (this.staleTimer !== null) this.deps.clearTimer(this.staleTimer);
    this.staleTimer = null;
  }

  private trigger(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const now = this.deps.now();
    const held = this.holdUntil !== null && now < this.holdUntil;
    if (held || now - this.lastSuccessAt < FLOOR_MS) {
      this.deps.render(this.snapshot);
      // A tap inside the floor or a hold must not push the poll that is already due later.
      if (this.pollTimer === null) this.schedulePoll();
      return Promise.resolve();
    }
    this.clearPoll();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      this.firstPending = false;
      this.schedulePoll();
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    if ((await this.attempt()) !== "transient") return;
    await new Promise<void>((resolve) => this.deps.setTimer(resolve, RETRY_MS));
    await this.attempt();
  }

  private async attempt(): Promise<Outcome> {
    let response: Response;
    try {
      response = await this.deps.fetch(ALERTS_PATH, this.deps.timeoutSignal(TIMEOUT_MS));
    } catch {
      return "transient";
    }
    // A cached answer means the network failed; the held status stays (REQ-REFRESH-006).
    if (response.headers.get(OFFLINE_HEADER) !== null) return "transient";
    const now = this.deps.now();
    if (response.status === 503 || response.status === 429) {
      this.limitStreak += 1;
      this.holdUntil = rateLimitDeadline(
        response.headers.get("retry-after"),
        now,
        this.limitStreak,
      );
      return "held";
    }
    if (!response.ok) return "failed";
    try {
      this.snapshot = snapshotFromApi(await response.json());
    } catch {
      return "failed";
    }
    this.lastSuccessAt = now;
    this.limitStreak = 0;
    this.holdUntil = null;
    this.deps.render(this.snapshot);
    this.armStale();
    return "ok";
  }

  private interval(): number {
    const base = this.deps.saveData()
      ? SAVER_MS
      : this.snapshot !== null && this.deps.inAlarm(this.snapshot)
        ? ALARM_MS
        : BASE_MS;
    return base * (0.9 + 0.2 * this.deps.random());
  }

  private schedulePoll(): void {
    this.clearPoll();
    if (!this.visible || this.inFlight !== null) return;
    const now = this.deps.now();
    // After an idle spell the Worker serves its old answer and refreshes in the background; like
    // the first fetch of an iOS session, a page that opened with old or no data asks again as
    // soon as the floor allows, until its first attempt.
    const old = this.snapshot === null || now - checkedAt(this.snapshot) > STALE_AFTER_MS;
    const delay = this.firstPending && old ? this.lastSuccessAt + FLOOR_MS - now : this.interval();
    const at = Math.max(now + delay, this.holdUntil ?? 0);
    this.pollTimer = this.deps.setTimer(() => {
      this.pollTimer = null;
      void this.trigger();
    }, at - now);
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) this.deps.clearTimer(this.pollTimer);
    this.pollTimer = null;
  }

  /** Redraws when the held answer turns stale, even if no request is due then. */
  private armStale(): void {
    if (this.staleTimer !== null) this.deps.clearTimer(this.staleTimer);
    this.staleTimer = null;
    if (this.snapshot === null) return;
    const due = checkedAt(this.snapshot) + STALE_AFTER_MS + 1 - this.deps.now();
    if (due <= 0) return;
    this.staleTimer = this.deps.setTimer(() => {
      this.staleTimer = null;
      this.deps.render(this.snapshot);
    }, due);
  }
}
