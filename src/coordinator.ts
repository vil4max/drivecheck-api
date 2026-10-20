import { kyivTimeToEpochMs, parseFeed, type Snapshot } from "./feed.ts";
import { rateLimitDeadline } from "./retryAfter.ts";

export const ENDPOINT = "https://ubilling.net.ua/aerialalerts/";
export const FETCH_FLOOR_MS = 10_000;
export const TRANSIENT_RETRY_MS = 2_000;
export const UPSTREAM_TIMEOUT_MS = 15_000;
const USER_AGENT = "DriveCheckAPI/0.1 (+https://github.com/vil4max/drivecheck-api)";

export type { Snapshot };

export interface CoordinatorView {
  snapshot: Snapshot | null;
  rateLimitedUntil: number | null;
  /** When the held map image was fetched; absent where a caller has no map (slice 1 views). */
  mapFetchedAt?: number | null;
}

/** The provider's night-mode alert map, as the iOS card loads it (`MapImageSource`). */
export const MAP_ENDPOINT = `${ENDPOINT}?map=nightmode`;
/** The map changes with the alerts but nobody needs it more often than once a minute. */
export const MAP_FLOOR_MS = 60_000;
/**
 * Ubilling allows 2 requests per second per host and answered a map request sent 0.3 s after the
 * JSON one with 429. iOS loads the map 3 s after the status; the web keeps that spacing, and a
 * JSON request keeps a second clear of a map request.
 */
export const MAP_AFTER_JSON_MS = 3_000;
export const JSON_AFTER_MAP_MS = 1_000;

export interface MapImage {
  bytes: Uint8Array;
  contentType: string;
  fetchedAt: number;
}

/** The map's single stored record, overwritten like the snapshot's (REQ-API-003). */
export interface MapState {
  image: MapImage | null;
  lastAttemptAt: number | null;
}

export interface MapStore {
  load(): Promise<MapState | undefined>;
  save(state: MapState): Promise<void>;
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
  mapStore: MapStore;
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
  private map: MapState | null = null;
  /** The one upstream request of either kind, so the host never sees two at once. */
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
    const map = await this.loadMap();
    return {
      snapshot: state.snapshot,
      rateLimitedUntil: this.openWindow(state),
      mapFetchedAt: map.image?.fetchedAt ?? null,
    };
  }

  /**
   * The alert map (REQ-WEB-012). It takes the same single upstream slot as the JSON request, so
   * the two never overlap, and it obeys and feeds the same 429 window.
   */
  async currentMap(): Promise<MapImage | null> {
    const [state, map] = await Promise.all([this.load(), this.loadMap()]);
    const now = this.deps.now();
    const windowOpen = state.rateLimitedUntil !== null && now < state.rateLimitedUntil;
    const floorPassed = map.lastAttemptAt === null || now - map.lastAttemptAt >= MAP_FLOOR_MS;
    const sinceJson = state.lastAttemptAt === null ? Infinity : now - state.lastAttemptAt;
    const wait = Math.max(0, MAP_AFTER_JSON_MS - sinceJson);
    // Without an image, wait out the spacing; with one, serve it and let a later visitor refresh.
    if (
      this.inFlight === null &&
      !windowOpen &&
      floorPassed &&
      (wait === 0 || map.image === null)
    ) {
      this.inFlight = this.attemptMap(state, map, wait).finally(() => {
        this.inFlight = null;
      });
      this.deps.background(this.inFlight);
    }
    if (this.inFlight !== null && map.image === null) {
      await Promise.race([this.inFlight, this.deps.waitCap(NO_SNAPSHOT_WAIT_MS)]);
    }
    return map.image;
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

  // An unreadable map record is not worth failing for: the map is refetched within a minute.
  private async loadMap(): Promise<MapState> {
    if (this.map !== null) return this.map;
    let stored: MapState | undefined;
    try {
      stored = await this.deps.mapStore.load();
    } catch (error) {
      this.deps.log?.(`map load failed: ${(error as Error).message}`);
    }
    this.map ??= stored ?? { image: null, lastAttemptAt: null };
    return this.map;
  }

  private async attemptMap(state: StoredState, map: MapState, wait: number): Promise<void> {
    if (wait > 0) await this.deps.sleep(wait);
    map.lastAttemptAt = this.deps.now();
    try {
      const timeoutSignal = this.deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
      const response = await this.deps.fetch(MAP_ENDPOINT, {
        headers: { "user-agent": USER_AGENT, accept: "image/*" },
        signal: timeoutSignal(UPSTREAM_TIMEOUT_MS),
      });
      if (response.status === 429) {
        state.rateLimitStreak += 1;
        state.rateLimitedUntil = rateLimitDeadline(
          response.headers.get("retry-after"),
          this.deps.now(),
          state.rateLimitStreak,
        );
        await this.save(state);
        throw new Error("map HTTP 429");
      }
      if (!response.ok) throw new Error(`map HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) throw new Error(`map content type ${contentType}`);
      map.image = {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType,
        fetchedAt: this.deps.now(),
      };
    } catch (error) {
      this.deps.log?.(`map attempt failed: ${(error as Error).message}`);
    }
    try {
      await this.deps.mapStore.save(map);
    } catch (error) {
      this.deps.log?.(`map save failed, kept in memory: ${(error as Error).message}`);
    }
  }

  private mayAttempt(state: StoredState, now: number): boolean {
    if (state.rateLimitedUntil !== null && now < state.rateLimitedUntil) return false;
    const mapAt = this.map?.lastAttemptAt ?? null;
    if (mapAt !== null && now - mapAt < JSON_AFTER_MAP_MS) return false;
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
