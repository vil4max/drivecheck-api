import { ENDPOINT, type Feed, kyivTimeToEpochMs, parseFeed } from "./feed";
import { rateLimitDeadline } from "./retryAfter";

export const FETCH_FLOOR_MS = 10_000;
export const TRANSIENT_RETRY_MS = 2_000;
export const UPSTREAM_TIMEOUT_MS = 15_000;
const USER_AGENT = "DriveCheckAPI/0.1 (+https://github.com/vil4max/drivecheck-api)";

export interface Snapshot {
  feed: Feed;
  fetchedAt: number;
  serverCachedAt: number | null;
}

export interface CoordinatorView {
  snapshot: Snapshot | null;
  rateLimitedUntil: number | null;
}

/** The single stored record (REQ-API-003): overwritten on every attempt, never appended. */
export interface StoredState {
  snapshot: Snapshot | null;
  lastAttemptAt: number | null;
  rateLimitedUntil: number | null;
  rateLimitStreak: number;
}

export interface StateStore {
  load(): Promise<StoredState | undefined>;
  save(state: StoredState): Promise<void>;
}

export interface CoordinatorDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  store: StateStore;
  /** Resolves when a caller without any snapshot stops waiting for the upstream. */
  waitCap: (ms: number) => Promise<void>;
  /** Keeps an attempt running after its caller got the held snapshot. */
  background: (work: Promise<void>) => void;
  timeoutSignal?: (ms: number) => AbortSignal;
  log?: (message: string) => void;
}

/** How long a caller with nothing to serve waits for the upstream before REQ-API-002's answer. */
export const NO_SNAPSHOT_WAIT_MS = 5_000;

class TransientFailure extends Error {}

/**
 * The only Ubilling client. One instance runs in one Durable Object, so the fetch floor, the
 * in-flight request and the 429 window are shared by every caller everywhere (REQ-PROVIDER-002).
 */
export class FeedCoordinator {
  private state: StoredState | null = null;
  private loading: Promise<StoredState> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  async current(): Promise<CoordinatorView> {
    const state = await this.load();
    if (this.inFlight === null && this.mayAttempt(state, this.deps.now())) {
      this.inFlight = this.attempt(state).finally(() => {
        this.inFlight = null;
      });
      this.deps.background(this.inFlight);
    }
    // A held snapshot is served at once (REQ-REFRESH-010); a slow upstream refreshes it later.
    if (this.inFlight !== null && state.snapshot === null) {
      await Promise.race([this.inFlight, this.deps.waitCap(NO_SNAPSHOT_WAIT_MS)]);
    }
    return { snapshot: state.snapshot, rateLimitedUntil: this.openWindow(state) };
  }

  /** Resolves once no upstream attempt is running. */
  async idle(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }

  private load(): Promise<StoredState> {
    if (this.state !== null) return Promise.resolve(this.state);
    this.loading ??= this.deps.store.load().then(
      (stored) => {
        this.state = stored ?? {
          snapshot: null,
          lastAttemptAt: null,
          rateLimitedUntil: null,
          rateLimitStreak: 0,
        };
        return this.state;
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  private mayAttempt(state: StoredState, now: number): boolean {
    if (state.rateLimitedUntil !== null && now < state.rateLimitedUntil) return false;
    return state.lastAttemptAt === null || now - state.lastAttemptAt >= FETCH_FLOOR_MS;
  }

  private openWindow(state: StoredState): number | null {
    const until = state.rateLimitedUntil;
    return until !== null && this.deps.now() < until ? until : null;
  }

  private async attempt(state: StoredState): Promise<void> {
    state.lastAttemptAt = this.deps.now();
    // Stored before the request, so a coordinator restarted mid-request still honours the floor.
    await this.save(state);
    try {
      let response: Response;
      try {
        response = await this.request();
      } catch (error) {
        if (!(error instanceof TransientFailure)) throw error;
        this.deps.log?.(`transient upstream failure, retrying once: ${error.message}`);
        await this.deps.sleep(TRANSIENT_RETRY_MS);
        response = await this.request();
      }
      await this.accept(state, response);
    } catch (error) {
      this.deps.log?.(`upstream attempt failed: ${(error as Error).message}`);
    }
    await this.save(state);
  }

  // The in-memory state stays authoritative, so a failed write must not fail the callers.
  private async save(state: StoredState): Promise<void> {
    try {
      await this.deps.store.save(state);
    } catch (error) {
      this.deps.log?.(`state save failed: ${(error as Error).message}`);
    }
  }

  private async request(): Promise<Response> {
    const timeoutSignal = this.deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    try {
      return await this.deps.fetch(ENDPOINT, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: timeoutSignal(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TransientFailure((error as Error).message);
    }
  }

  private async accept(state: StoredState, response: Response): Promise<void> {
    const now = this.deps.now();
    if (response.status === 429) {
      state.rateLimitStreak += 1;
      state.rateLimitedUntil = rateLimitDeadline(
        response.headers.get("retry-after"),
        now,
        state.rateLimitStreak,
      );
      throw new Error(`HTTP 429, holding until ${new Date(state.rateLimitedUntil).toISOString()}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) throw new Error(`content type ${contentType}`);
    const feed = parseFeed(await response.json());
    // Only a decoded answer ends the backoff: a 5xx says nothing about the rate limit.
    state.rateLimitStreak = 0;
    state.rateLimitedUntil = null;
    state.snapshot = { feed, fetchedAt: now, serverCachedAt: kyivTimeToEpochMs(feed.cachedat) };
  }
}
