import type { CoordinatorDeps, MapState, Snapshot, StoredState } from "../src/coordinator";
import type { Feed } from "../src/feed";
import fixture from "./fixtures/aerialalerts.json";

export const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);

export function feedJson(overrides: Partial<Feed> = {}): Feed {
  return { ...structuredClone(fixture as Feed), ...overrides };
}

/** A snapshot fetched at T0 whose cachedat is T0 too (12:00 Kyiv time), with these keys in alarm. */
export function snapshotWith(alarmKeys: string[], drop: string[] = []): Snapshot {
  const feed = feedJson({ cachedat: "2026-10-18 12:00:00" });
  for (const [key, state] of Object.entries(feed.states)) state.alertnow = alarmKeys.includes(key);
  for (const key of drop) delete feed.states[key];
  return { feed, fetchedAt: T0, serverCachedAt: T0 };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

export function imageResponse(bytes: number[], init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png" },
    ...init,
  });
}

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

/** A controllable world: clock, upstream, sleeping and the coordinator's one stored record. */
export class FakeWorld {
  now = T0;
  requests: string[] = [];
  sleeps: number[] = [];
  saves: StoredState[] = [];
  stored: StoredState | undefined;
  /** Whether a caller without a snapshot stops waiting at once (true) or never (false). */
  capWaits = false;
  capWaitMs: number[] = [];
  /** Attempts handed to the platform to keep alive after their caller returned. */
  backgrounded: Promise<void>[] = [];
  mapStored: MapState | undefined;
  mapSaves: MapState[] = [];
  failSaves = false;
  failNextLoad = false;
  /** Timeouts requested for upstream requests, with the controller that fires each one. */
  timeouts: { ms: number; fire: () => void }[] = [];
  private steps: Step[] = [];

  queue(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  deps(): CoordinatorDeps {
    return {
      now: () => this.now,
      sleep: async (ms) => {
        this.sleeps.push(ms);
        this.now += ms;
      },
      waitCap: (ms) => {
        this.capWaitMs.push(ms);
        return this.capWaits ? Promise.resolve() : new Promise<void>(() => {});
      },
      background: (work) => {
        this.backgrounded.push(work);
      },
      timeoutSignal: (ms) => {
        const controller = new AbortController();
        this.timeouts.push({ ms, fire: () => controller.abort(new Error("timeout")) });
        return controller.signal;
      },
      fetch: async (url, init) => {
        this.requests.push(url);
        const step = this.steps.shift();
        if (step === undefined) throw new Error("no upstream response queued");
        if (step instanceof Error) throw step;
        if (typeof step === "function") return step(init);
        return step;
      },
      store: {
        load: async () => {
          if (this.failNextLoad) {
            this.failNextLoad = false;
            throw new Error("storage unavailable");
          }
          return this.stored;
        },
        save: async (state) => {
          if (this.failSaves) throw new Error("storage unavailable");
          this.stored = structuredClone(state);
          this.saves.push(structuredClone(state));
        },
      },
      mapStore: {
        load: async () => this.mapStored,
        save: async (state) => {
          if (this.failSaves) throw new Error("storage unavailable");
          this.mapStored = structuredClone(state);
          this.mapSaves.push(structuredClone(state));
        },
      },
    };
  }
}

/** An upstream that never answers until the request's timeout signal fires. */
export function hangingUpstream(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}
