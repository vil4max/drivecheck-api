import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import type { Snapshot } from "../src/feed";
import { LANGS } from "../src/i18n";
import { type AlarmDeps, runAlarm } from "../src/push/alarm";
import {
  APNS_HOSTS,
  type ApnsCredentials,
  apnsSender,
  classify,
  credentialsFrom,
  ProviderToken,
} from "../src/push/apns";
import type { PushStore } from "../src/push/registry";
import { sendBatch } from "../src/push/sender";
import { allClearPayload, allClearText } from "../src/push/text";
import { REGIONS } from "../src/regions";
import { memoryStore, TOKEN_A, TOKEN_B, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const KHARKIV = "Харківська область";

async function testCredentials(): Promise<{ credentials: ApnsCredentials; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const base64 = btoa(String.fromCharCode(...der));
  const key = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    credentials: { key, keyId: "KEYID12345", teamId: "TEAMID1234", topic: "vil4max.RegionalCheck" },
    publicKey: pair.publicKey,
  };
}

const fromBase64Url = (part: string) =>
  Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const decodePart = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake APNs that answers by token and records every request. */
function fakeApns(answer: (token: string) => Response = () => new Response(null, { status: 200 })) {
  const sent: Sent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url: string, init: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body),
    });
    inFlight -= 1;
    return answer(url.split("/").pop()!);
  };
  return { sent, fetch, maxInFlight: () => maxInFlight };
}

function register(
  store: PushStore,
  token: string,
  region = "kharkiv",
  lang: "en" | "uk" | "ru" = "en",
) {
  store.upsertDevice({ token, region, env: "production", lang, lastSeen: T0 });
}

const snap = (alarmKeys: string[], t: number): Snapshot => ({
  ...snapshotWith(alarmKeys),
  fetchedAt: t,
  serverCachedAt: t,
});

describe("sending all-clear pushes", () => {
  test("REQ-PUSH-002 an alarm-to-clear change reaches APNs once per device of the region", async () => {
    const { store } = memoryStore();
    register(store, TOKEN_A);
    register(store, TOKEN_B, "kharkiv", "uk");
    register(store, tokenNo(3), "lviv");
    const { credentials } = await testCredentials();
    const clock = { now: T0 };
    const apns = fakeApns();
    const send = apnsSender(new ProviderToken(credentials, () => clock.now), apns.fetch, () => {});
    let view: CoordinatorView = { snapshot: snap([KHARKIV], T0), rateLimitedUntil: null };
    const deps: AlarmDeps = {
      store,
      refresh: async () => view,
      deadline: () => new Promise<void>(() => {}),
      now: () => clock.now,
      sendBatch: () => sendBatch(store, send, () => {}),
      log: () => {},
    };
    const state = { lastPollAt: null };
    await runAlarm(deps, state);
    clock.now = T0 + 30_000;
    view = { snapshot: snap([], T0 + 30_000), rateLimitedUntil: null };
    expect(await runAlarm(deps, state)).toBe(T0 + 60_000);
    expect(apns.sent.map((s) => s.url).sort()).toEqual([
      `${APNS_HOSTS.production}/3/device/${TOKEN_A}`,
      `${APNS_HOSTS.production}/3/device/${TOKEN_B}`,
    ]);
    const uk = apns.sent.find((s) => s.url.endsWith(TOKEN_B))!;
    expect(JSON.parse(uk.body).aps.alert.title).toBe("Відбій тривоги: Харківська область");
    // The next alarm sends nothing again.
    clock.now = T0 + 60_000;
    await runAlarm(deps, state);
    expect(apns.sent).toHaveLength(2);
  });

  test("REQ-PUSHAPI-004 batches of at most 45 and no duplicates", async () => {
    const { db, store } = memoryStore();
    for (let n = 0; n < 100; n += 1) register(store, tokenNo(n));
    store.enqueue("kharkiv", "kharkiv@1", T0);
    const apns = fakeApns();
    const { credentials } = await testCredentials();
    const send = apnsSender(new ProviderToken(credentials, () => T0), apns.fetch, () => {});

    const counts: number[] = [];
    let before = 0;
    while (store.hasOutbox()) {
      await sendBatch(store, send, () => {});
      counts.push(apns.sent.length - before);
      before = apns.sent.length;
    }
    expect(counts).toEqual([45, 45, 10]);
    expect(new Set(apns.sent.map((s) => s.url)).size).toBe(100);
    expect(apns.maxInFlight()).toBeLessThanOrEqual(6);

    // Rows go before their requests: a run whose every request fails leaves nothing to resend.
    store.enqueue("kharkiv", "kharkiv@2", T0);
    const failing = async () => {
      throw new Error("network down");
    };
    await sendBatch(store, failing, () => {});
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_outbox").all()).toEqual([{ n: 55 }]);

    // The alarm re-arms in 1 s while pushes remain, and polls no feed in between.
    let refreshes = 0;
    const deps: AlarmDeps = {
      store,
      refresh: async () => {
        refreshes += 1;
        return { snapshot: null, rateLimitedUntil: null };
      },
      deadline: () => new Promise<void>(() => {}),
      now: () => T0 + 1_000,
      sendBatch: () => sendBatch(store, send, () => {}),
      log: () => {},
    };
    expect(await runAlarm(deps, { lastPollAt: T0 })).toBe(T0 + 2_000);
    expect(refreshes).toBe(0);
  });

  test("REQ-PUSHAPI-006 every notice carries the calm Drive Check sound", async () => {
    const { store } = memoryStore();
    const langs = ["en", "uk", "ru"] as const;
    for (let n = 0; n < 50; n += 1) register(store, tokenNo(n), "kharkiv", langs[n % 3]);
    for (let n = 50; n < 60; n += 1) {
      store.upsertDevice({
        token: tokenNo(n),
        region: "lviv",
        env: "sandbox",
        lang: "en",
        lastSeen: T0,
      });
    }
    store.enqueue("kharkiv", "kharkiv@1", T0);
    store.enqueue("lviv", "lviv@1", T0);
    // The alert-start notice too (spec 004): calm, never time-sensitive or critical.
    store.enqueue("lviv", "start:lviv@1", T0, "alertstart");
    const apns = fakeApns();
    const { credentials } = await testCredentials();
    const send = apnsSender(new ProviderToken(credentials, () => T0), apns.fetch, () => {});
    while (store.hasOutbox()) await sendBatch(store, send, () => {});
    expect(apns.sent).toHaveLength(70);
    for (const push of apns.sent) {
      const { aps } = JSON.parse(push.body);
      expect(aps.sound).toBe("drivecheck.caf");
      expect(aps["interruption-level"] ?? "active").toBe("active");
    }
  });

  test("REQ-PUSHAPI-005 APNs answers decide what is deleted", async () => {
    const answers: Record<string, [number, string | null]> = {
      [tokenNo(1)]: [410, "Unregistered"],
      [tokenNo(2)]: [400, "BadDeviceToken"],
      [tokenNo(3)]: [400, "DeviceTokenNotForTopic"],
      [tokenNo(4)]: [400, "BadTopic"],
      [tokenNo(5)]: [403, "ExpiredProviderToken"],
      [tokenNo(6)]: [429, "TooManyRequests"],
      [tokenNo(7)]: [500, "InternalServerError"],
      [tokenNo(8)]: [503, "ServiceUnavailable"],
      [tokenNo(9)]: [200, null],
    };
    expect(classify(200, null)).toBe("sent");
    expect(classify(410, "ExpiredToken")).toBe("drop-token");

    const { db, store } = memoryStore();
    for (const token of Object.keys(answers)) register(store, token);
    store.enqueue("kharkiv", "kharkiv@1", T0);
    const apns = fakeApns((token) => {
      const [status, reason] = answers[token]!;
      return new Response(reason === null ? null : JSON.stringify({ reason }), { status });
    });
    const { credentials } = await testCredentials();
    const send = apnsSender(new ProviderToken(credentials, () => T0), apns.fetch, () => {});
    await sendBatch(store, send, () => {});

    expect(db.prepare("SELECT token FROM push_devices ORDER BY token").all()).toEqual(
      [4, 5, 6, 7, 8, 9].map((n) => ({ token: tokenNo(n) })),
    );
    // One request per push: nothing is retried, and nothing is left queued.
    expect(apns.sent).toHaveLength(9);
    expect(store.hasOutbox()).toBe(false);

    // The ExpiredProviderToken answer in the first six makes every later push carry a new token.
    const firstToken = apns.sent.find((s) => s.url.endsWith(tokenNo(5)))!.headers.authorization;
    store.enqueue("kharkiv", "kharkiv@2", T0);
    await sendBatch(store, send, () => {});
    const later = apns.sent.slice(9).map((s) => s.headers.authorization);
    expect(later).toHaveLength(6);
    for (const authorization of later) expect(authorization).not.toBe(firstToken);
  });

  test("REQ-PUSHAPI-005 the provider token", async () => {
    const { credentials, publicKey } = await testCredentials();
    const clock = { now: T0 };
    const token = new ProviderToken(credentials, () => clock.now);
    const jwt = await token.get();
    const [header, claims, signature] = jwt.split(".");
    expect(decodePart(header!)).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(decodePart(claims!)).toEqual({ iss: "TEAMID1234", iat: T0 / 1000 });
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64Url(signature!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);

    clock.now = T0 + 40 * 60_000 - 1;
    expect(await token.get()).toBe(jwt);
    clock.now = T0 + 40 * 60_000;
    const renewed = await token.get();
    expect(decodePart(renewed.split(".")[1]!).iat).toBe(T0 / 1000 + 2400);

    // An ExpiredProviderToken answer makes the next push sign a new token.
    token.expire();
    expect(await token.get()).not.toBe(renewed);

    // Concurrent sends share one signature.
    const fresh = new ProviderToken(credentials, () => T0);
    const tokens = await Promise.all([fresh.get(), fresh.get(), fresh.get()]);
    expect(new Set(tokens).size).toBe(1);
  });

  test("REQ-PUSHAPI-005 missing credentials turn the sender off by name", () => {
    expect(credentialsFrom({ APNS_TOPIC: "vil4max.RegionalCheck" })).toEqual({
      missing: ["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID"],
    });
    expect(
      credentialsFrom({ APNS_KEY: "k", APNS_KEY_ID: "i", APNS_TEAM_ID: "t", APNS_TOPIC: "p" }),
    ).toEqual({ credentials: { key: "k", keyId: "i", teamId: "t", topic: "p" } });
  });

  test("REQ-PUSHAPI-006 the texts and the 5-minute lifetime", async () => {
    expect(allClearText("kharkiv", "uk")).toEqual({
      title: "Відбій тривоги: Харківська область",
      body: "Повітряна тривога закінчилась.",
    });
    expect(allClearText("kyiv-city", "en")).toEqual({
      title: "All clear: Kyiv",
      body: "The air alert has ended.",
    });
    expect(allClearText("odesa", "ru")).toEqual({
      title: "Отбой тревоги: Одесская область",
      body: "Воздушная тревога окончена.",
    });
    for (const region of REGIONS) {
      for (const lang of LANGS) {
        const payload = allClearPayload(region.id, lang);
        expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(4096);
        expect(JSON.parse(payload).aps.alert.title).toContain(region.names[lang]);
      }
    }

    const { store } = memoryStore();
    register(store, TOKEN_A, "kharkiv", "uk");
    store.upsertDevice({
      token: TOKEN_B,
      region: "kharkiv",
      env: "sandbox",
      lang: "en",
      lastSeen: T0,
    });
    store.enqueue("kharkiv", "kharkiv@1", T0);
    const apns = fakeApns();
    const { credentials } = await testCredentials();
    const now = T0 + 1_500;
    await sendBatch(
      store,
      apnsSender(new ProviderToken(credentials, () => now), apns.fetch, () => {}),
      () => {},
    );
    const production = apns.sent.find((s) => s.url.endsWith(TOKEN_A))!;
    expect(production.url).toBe(`https://api.push.apple.com/3/device/${TOKEN_A}`);
    expect(production.headers["apns-topic"]).toBe("vil4max.RegionalCheck");
    expect(production.headers["apns-push-type"]).toBe("alert");
    expect(production.headers["apns-expiration"]).toBe(String(Math.floor(now / 1000) + 300));
    expect(production.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(production.body)).toEqual({
      aps: {
        alert: {
          title: "Відбій тривоги: Харківська область",
          body: "Повітряна тривога закінчилась.",
        },
        sound: "drivecheck.caf",
      },
    });
    expect(apns.sent.find((s) => s.url.endsWith(TOKEN_B))!.url).toBe(
      `https://api.sandbox.push.apple.com/3/device/${TOKEN_B}`,
    );

    // A queued push older than 5 minutes is deleted unsent.
    store.enqueue("kharkiv", "kharkiv@2", T0);
    const late = fakeApns();
    const deps: AlarmDeps = {
      store,
      refresh: async () => ({ snapshot: null, rateLimitedUntil: null }),
      deadline: () => new Promise<void>(() => {}),
      now: () => T0 + 300_001,
      sendBatch: () =>
        sendBatch(
          store,
          apnsSender(new ProviderToken(credentials, () => T0), late.fetch, () => {}),
          () => {},
        ),
      log: () => {},
    };
    await runAlarm(deps, { lastPollAt: T0 + 300_000 });
    expect(late.sent).toEqual([]);
    expect(store.hasOutbox()).toBe(false);
  });

  test("REQ-PUSHAPI-002 a device keeps five fields for 60 days", async () => {
    const { db, store } = memoryStore();
    const DAY = 86_400_000;
    const now = T0 + 60 * DAY;
    register(store, TOKEN_A);
    store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: now - 60 * DAY + 1,
    });
    store.upsertDevice({
      token: TOKEN_B,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: now - 60 * DAY - 1,
    });
    expect(Object.keys(db.prepare("SELECT * FROM push_devices").all()[0]!).sort()).toEqual([
      "env",
      "lang",
      "last_seen",
      "region",
      "token",
    ]);

    const logs: string[] = [];
    const apns = fakeApns(
      () => new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 }),
    );
    const { credentials } = await testCredentials();
    const send = apnsSender(new ProviderToken(credentials, () => now), apns.fetch, (m) =>
      logs.push(m),
    );
    let view: CoordinatorView = { snapshot: snap([KHARKIV], now), rateLimitedUntil: null };
    const clock = { now };
    const deps: AlarmDeps = {
      store,
      refresh: async () => view,
      deadline: () => new Promise<void>(() => {}),
      now: () => clock.now,
      sendBatch: () => sendBatch(store, send, (m) => logs.push(m)),
      log: (m) => logs.push(m),
    };
    const state = { lastPollAt: null };
    await runAlarm(deps, state);
    expect(db.prepare("SELECT token FROM push_devices").all()).toEqual([{ token: TOKEN_A }]);

    // The app's weekly refresh keeps it, then an all-clear goes out and APNs says it is gone.
    store.upsertDevice({
      token: TOKEN_A,
      region: "kharkiv",
      env: "production",
      lang: "en",
      lastSeen: now,
    });
    clock.now = now + 30_000;
    view = { snapshot: snap([], now + 30_000), rateLimitedUntil: null };
    await runAlarm(deps, state);
    expect(apns.sent).toHaveLength(1);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN_A);
      expect(line).not.toContain(TOKEN_B);
    }
  });
});
