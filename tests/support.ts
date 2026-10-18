import type { CoordinatorDeps, Snapshot, StoredState } from "../src/coordinator";
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

type Step = Response | Error | (() => Promise<Response>);

/** A controllable world: clock, upstream, sleeping and the coordinator's one stored record. */
export class FakeWorld {
  now = T0;
  requests: string[] = [];
  sleeps: number[] = [];
  saves: StoredState[] = [];
  stored: StoredState | undefined;
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
      fetch: async (url) => {
        this.requests.push(url);
        const step = this.steps.shift();
        if (step === undefined) throw new Error("no upstream response queued");
        if (step instanceof Error) throw step;
        if (typeof step === "function") return step();
        return step;
      },
      store: {
        load: async () => this.stored,
        save: async (state) => {
          this.stored = structuredClone(state);
          this.saves.push(structuredClone(state));
        },
      },
    };
  }
}
