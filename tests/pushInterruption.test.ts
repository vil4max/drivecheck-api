import { describe, expect, test } from "vitest";
import type { Snapshot } from "../src/feed";
import { apnsSender, ProviderToken } from "../src/push/apns";
import { parseLiveActivity, registerLiveActivity } from "../src/push/liveActivity";
import { parseRegistration, register } from "../src/push/registration";
import { alarmLoop, generatedCredentials, memoryStore, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";

const snap = (alarmKeys: string[], t: number): Snapshot => ({
  ...snapshotWith(alarmKeys),
  fetchedAt: t,
  serverCachedAt: t,
});

const notice = { token: tokenNo(1), region: "kharkiv", env: "production", lang: "en" };
const record = { startToken: tokenNo(2), region: "kharkiv", env: "production", lang: "en" };

describe("interruption levels", () => {
  test("REQ-PUSHAPI-013 an urgent key is refused like any unknown key", () => {
    // The app never sends it; Focus breakthrough is the system's Time Sensitive setting.
    for (const [parse, body] of [
      [parseRegistration, notice],
      [parseLiveActivity, record],
    ] as const) {
      expect(parse(body)).not.toBeNull();
      for (const urgent of [true, false]) {
        expect(parse({ ...body, urgent }), JSON.stringify(urgent)).toBeNull();
      }
    }
  });

  test("REQ-PUSHAPI-013 every alert start breaks through Focus, the all-clear never does", async () => {
    const { store } = memoryStore();
    // Notice devices 0x11 to 0x13 and records 0x21 to 0x23.
    for (let n = 0; n < 3; n += 1) {
      register(store, parseRegistration({ ...notice, token: tokenNo(0x11 + n) })!, T0);
      registerLiveActivity(
        store,
        parseLiveActivity({ ...record, startToken: tokenNo(0x21 + n) })!,
        T0,
      );
    }
    const sent: { token: string; aps: Record<string, unknown> }[] = [];
    const clock = { now: T0 };
    const send = apnsSender(
      new ProviderToken(await generatedCredentials(), () => clock.now),
      async (url, init) => {
        sent.push({ token: url.split("/").pop()!, aps: JSON.parse(String(init.body)).aps });
        return new Response(null, { status: 200 });
      },
      () => {},
    );
    const loop = alarmLoop(store, send, clock);
    const at = (t: number, snapshot: Snapshot) => loop.alarm(t, snapshot);
    await at(T0, snap([], T0));
    await at(T0 + 30_000, snap([KHARKIV], T0 + 30_000));
    const level = (token: string) => sent.find((s) => s.token === token)?.aps["interruption-level"];
    expect([0x11, 0x12, 0x13, 0x21, 0x22, 0x23].map((n) => level(tokenNo(n)))).toEqual(
      Array(6).fill("time-sensitive"),
    );
    for (const push of sent) {
      const alert = push.aps.alert as { sound?: string } | undefined;
      expect(push.aps.sound ?? alert?.sound).toBe("drivecheck.caf");
    }

    // The all-clear for the same devices: calm for everyone.
    sent.length = 0;
    await at(T0 + 60_000, snap([], T0 + 60_000));
    // No record holds an activity token yet, so the clear sends the three notices only.
    expect(sent.map((s) => s.token).sort()).toEqual([0x11, 0x12, 0x13].map(tokenNo));
    for (const push of sent) {
      // No level means `active` to APNs; nothing in the all-clear may raise it.
      expect(push.aps["interruption-level"] ?? "active").toBe("active");
      expect(push.aps.sound).toBe("drivecheck.caf");
    }
  });
});
