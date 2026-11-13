import { DurableObject } from "cloudflare:workers";
import {
  type CoordinatorView,
  FeedCoordinator,
  type MapImage,
  type MapState,
  type StoredState,
} from "./coordinator.ts";
import {
  type AlarmState,
  alarmAfterRegistration,
  runAlarm,
  savedAlertStarts,
} from "./push/alarm.ts";
import { type ApnsEnvVars, apnsSender, credentialsFrom, ProviderToken } from "./push/apns.ts";
import { type LiveActivityRegistration, registerLiveActivity } from "./push/liveActivity.ts";
import { type Registration, register } from "./push/registration.ts";
import { PushStore, type SqlRunner } from "./push/registry.ts";
import { sendBatch, sendUpdates, type WalkEntry } from "./push/sender.ts";
import { route, ukrainianRegionCode } from "./router.ts";

/** `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID` are secrets the owner enters with `wrangler secret put`. */
export interface Env extends ApnsEnvVars {
  FEED: DurableObjectNamespace<FeedCoordinatorObject>;
}

const STATE_KEY = "state";
const MAP_KEY = "map";

/** One instance, named "feed", is the only Ubilling client for every location (spec D1). */
export class FeedCoordinatorObject extends DurableObject<Env> {
  private readonly coordinator: FeedCoordinator;
  /** The all-clear push registry (spec 003), in this object's SQLite. */
  private readonly push: PushStore;
  private readonly alarmState: AlarmState = { lastPollAt: null };
  private providerToken: ProviderToken | null = null;
  private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.push = new PushStore(sqlRunner(ctx.storage));
    const sleep = this.sleep;
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

  async registerDevice(registration: Registration): Promise<204 | 503> {
    const status = register(this.push, registration, Date.now());
    if (status === 204) {
      const next = alarmAfterRegistration(await this.ctx.storage.getAlarm(), Date.now());
      if (next !== null) await this.ctx.storage.setAlarm(next);
    }
    return status;
  }

  forgetDevice(token: string): void {
    this.push.deleteDevice(token);
  }

  /** Spec 004: a Live Activity record arms the loop like a notice device does. */
  async registerLiveActivity(registration: LiveActivityRegistration): Promise<204 | 503> {
    const status = registerLiveActivity(this.push, registration, Date.now());
    if (status === 204) {
      const next = alarmAfterRegistration(await this.ctx.storage.getAlarm(), Date.now());
      if (next !== null) await this.ctx.storage.setAlarm(next);
    }
    return status;
  }

  forgetLiveActivity(startToken: string): void {
    this.push.deleteLiveActivity(startToken);
  }

  /** The all-clear loop (spec 003): poll, detect, send, then schedule the next round or stop. */
  async alarm(): Promise<void> {
    const log = (message: string) => console.log(message);
    const send = this.sender(log);
    const next = await runAlarm(
      {
        store: this.push,
        refresh: () => this.coordinator.refresh(),
        deadline: this.sleep,
        now: () => Date.now(),
        ...(send === null
          ? {}
          : {
              sendBatch: (limit: number) =>
                sendBatch(this.push, send, log, {
                  limit,
                  latest: this.alarmState.latest ?? null,
                  alertStart: savedAlertStarts(this.push),
                  now: () => Date.now(),
                }),
              sendUpdates: (walk: WalkEntry[], limit: number) =>
                sendUpdates(this.push, walk, send, log, {
                  limit,
                  latest: this.alarmState.latest ?? null,
                  alertStart: savedAlertStarts(this.push),
                  now: () => Date.now(),
                }),
            }),
        log,
      },
      this.alarmState,
    );
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** The APNs sender, or null while a credential is missing; the token is cached across alarms. */
  private sender(log: (message: string) => void) {
    const found = credentialsFrom(this.env);
    if ("missing" in found) {
      if (this.push.hasOutbox()) log(`push disabled, missing: ${found.missing.join(", ")}`);
      return null;
    }
    this.providerToken ??= new ProviderToken(found.credentials, () => Date.now());
    return apnsSender(this.providerToken, (url, init) => fetch(url, init), log);
  }
}

/** `ctx.storage.sql` as the push store's runner. */
function sqlRunner(storage: DurableObjectStorage): SqlRunner {
  return {
    all: (query, ...params) => storage.sql.exec(query, ...params).toArray(),
    run: (query, ...params) => {
      storage.sql.exec(query, ...params).toArray();
    },
    transaction: (work) => storage.transactionSync(work),
  };
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
      push: {
        register: (registration) => stub.registerDevice(registration),
        forget: (token) => stub.forgetDevice(token),
      },
      liveActivity: {
        register: (registration) => stub.registerLiveActivity(registration),
        forget: (startToken) => stub.forgetLiveActivity(startToken),
      },
    });
  },
} satisfies ExportedHandler<Env>;
