import { DurableObject } from "cloudflare:workers";
import { type CoordinatorView, FeedCoordinator, type StoredState } from "./coordinator.ts";
import { route, ukrainianRegionCode } from "./router.ts";

export interface Env {
  FEED: DurableObjectNamespace<FeedCoordinatorObject>;
}

const STATE_KEY = "state";

/** One instance, named "feed", is the only Ubilling client for every location (spec D1). */
export class FeedCoordinatorObject extends DurableObject<Env> {
  private readonly coordinator: FeedCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    this.coordinator = new FeedCoordinator({
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      sleep,
      waitCap: sleep,
      background: (work) => ctx.waitUntil(work),
      store: {
        load: () => ctx.storage.get<StoredState>(STATE_KEY),
        save: (state) => ctx.storage.put(STATE_KEY, state),
      },
      log: (message) => console.log(message),
    });
  }

  current(): Promise<CoordinatorView> {
    return this.coordinator.current();
  }
}

export default {
  fetch(request, env): Promise<Response> {
    const stub = env.FEED.get(env.FEED.idFromName("feed"));
    const regionCode = ukrainianRegionCode(request.cf);
    return route({ request, regionCode, getView: () => stub.current(), clock: Date.now });
  },
} satisfies ExportedHandler<Env>;
