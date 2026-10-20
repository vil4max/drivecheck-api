import { DurableObject } from "cloudflare:workers";
import {
  type CoordinatorView,
  FeedCoordinator,
  type MapImage,
  type MapState,
  type StoredState,
} from "./coordinator.ts";
import { route, ukrainianRegionCode } from "./router.ts";

export interface Env {
  FEED: DurableObjectNamespace<FeedCoordinatorObject>;
}

const STATE_KEY = "state";
const MAP_KEY = "map";

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
      // A raster over the storage value limit fails to save; the coordinator then keeps it in
      // memory only (spec 002, D10).
      mapStore: {
        load: () => ctx.storage.get<MapState>(MAP_KEY),
        save: (state) => ctx.storage.put(MAP_KEY, state),
      },
      log: (message) => console.log(message),
    });
  }

  current(): Promise<CoordinatorView> {
    return this.coordinator.current();
  }

  currentMap(): Promise<MapImage | null> {
    return this.coordinator.currentMap();
  }
}

export default {
  fetch(request, env): Promise<Response> {
    const stub = env.FEED.get(env.FEED.idFromName("feed"));
    const regionCode = ukrainianRegionCode(request.cf);
    return route({
      request,
      regionCode,
      getView: () => stub.current(),
      getMap: () => stub.currentMap(),
      clock: Date.now,
    });
  },
} satisfies ExportedHandler<Env>;
