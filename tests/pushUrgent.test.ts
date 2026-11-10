import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { type AlarmDeps, type AlarmState, runAlarm } from "../src/push/alarm";
import { type ApnsCredentials, apnsSender, ProviderToken } from "../src/push/apns";
import { parseLiveActivity, registerLiveActivity } from "../src/push/liveActivity";
import { parseRegistration, register } from "../src/push/registration";
import { sendBatch, sendUpdates } from "../src/push/sender";
import { memoryStore, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";

async function credentials(): Promise<ApnsCredentials> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const key = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { key, keyId: "KEYID12345", teamId: "TEAMID1234", topic: "vil4max.RegionalCheck" };
}

const snap = (alarmKeys: string[], t: number): Snapshot => ({
  ...snapshotWith(alarmKeys),
  fetchedAt: t,
  serverCachedAt: t,
});

const notice = { token: tokenNo(1), region: "kharkiv", env: "production", lang: "en" };
const record = { startToken: tokenNo(2), region: "kharkiv", env: "production", lang: "en" };

describe("the urgent switch", () => {
  test("REQ-PUSHAPI-013 urgent is a boolean or absent", () => {
    for (const [parse, body] of [
      [parseRegistration, notice],
      [parseLiveActivity, record],
    ] as const) {
      expect(parse({ ...body, urgent: true })?.urgent).toBe(true);
      expect(parse({ ...body, urgent: false })?.urgent).toBe(false);
      // Absent means false, so builds without the switch keep working.
      expect(parse(body)?.urgent).toBe(false);
      for (const urgent of ["true", 1, 0, null, {}]) {
        expect(parse({ ...body, urgent }), JSON.stringify(urgent)).toBeNull();
      }
    }

    const { db, store } = memoryStore();
    register(store, parseRegistration({ ...notice, urgent: true })!, T0);
    registerLiveActivity(store, parseLiveActivity({ ...record, urgent: true })!, T0);
    expect(db.prepare("SELECT urgent FROM push_devices").all()).toEqual([{ urgent: 1 }]);
    expect(db.prepare("SELECT urgent FROM push_live_activities").all()).toEqual([{ urgent: 1 }]);
    // The weekly re-send without the field turns it off again.
    register(store, parseRegistration(notice)!, T0 + 1);
    registerLiveActivity(store, parseLiveActivity(record)!, T0 + 1);
    expect(db.prepare("SELECT urgent FROM push_devices").all()).toEqual([{ urgent: 0 }]);
    expect(db.prepare("SELECT urgent FROM push_live_activities").all()).toEqual([{ urgent: 0 }]);
  });

  test("REQ-PUSHAPI-013 urgent alerts break through Focus, the all-clear never does", async () => {
    const { store } = memoryStore();
    // Notice devices 0x11 to 0x13 and records 0x21 to 0x23: urgent on, off, and absent.
    const switches = [{ urgent: true }, { urgent: false }, {}];
    switches.forEach((flag, n) => {
      register(store, parseRegistration({ ...notice, token: tokenNo(0x11 + n), ...flag })!, T0);
      registerLiveActivity(
        store,
        parseLiveActivity({ ...record, startToken: tokenNo(0x21 + n), ...flag })!,
        T0,
      );
    });
    const sent: { token: string; aps: Record<string, unknown> }[] = [];
    const clock = { now: T0 };
    const send = apnsSender(
      new ProviderToken(await credentials(), () => clock.now),
      async (url, init) => {
        sent.push({ token: url.split("/").pop()!, aps: JSON.parse(String(init.body)).aps });
        return new Response(null, { status: 200 });
      },
      () => {},
    );
    let view: CoordinatorView = { snapshot: null, rateLimitedUntil: null };
    const state: AlarmState = { lastPollAt: null };
    const deps: AlarmDeps = {
      store,
      refresh: async () => view,
      deadline: () => new Promise<void>(() => {}),
      now: () => clock.now,
      sendBatch: (limit) =>
        sendBatch(store, send, () => {}, {
          limit,
          latest: state.latest ?? null,
          now: () => clock.now,
        }),
      sendUpdates: (walk, limit) =>
        sendUpdates(store, walk, send, () => {}, { limit, latest: state.latest ?? null }),
      log: () => {},
    };
    const at = async (t: number, snapshot: Snapshot) => {
      clock.now = t;
      view = { snapshot, rateLimitedUntil: null };
      await runAlarm(deps, state);
    };
    await at(T0, snap([], T0));
    await at(T0 + 30_000, snap([KHARKIV], T0 + 30_000));
    const level = (token: string) => sent.find((s) => s.token === token)?.aps["interruption-level"];
    expect([0x11, 0x12, 0x13].map((n) => level(tokenNo(n)))).toEqual([
      "time-sensitive",
      "active",
      "active",
    ]);
    expect([0x21, 0x22, 0x23].map((n) => level(tokenNo(n)))).toEqual([
      "time-sensitive",
      "active",
      "active",
    ]);
    for (const push of sent) {
      const alert = push.aps.alert as { sound?: string } | undefined;
      expect(push.aps.sound ?? alert?.sound).toBe("drivecheck.caf");
    }

    // The all-clear for the same devices: calm for everyone, the urgent one too.
    sent.length = 0;
    await at(T0 + 60_000, snap([], T0 + 60_000));
    // No record holds an activity token yet, so the clear sends the three notices only.
    expect(sent.map((s) => s.token).sort()).toEqual([0x11, 0x12, 0x13].map(tokenNo));
    for (const push of sent) {
      expect(push.aps["interruption-level"] ?? "active").toBe("active");
      expect(push.aps.sound).toBe("drivecheck.caf");
    }
  });
});
