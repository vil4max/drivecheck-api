import { describe, expect, test } from "vitest";
import type { CoordinatorView } from "../src/coordinator";
import { MAX_DEVICES, register } from "../src/push/registration";
import type { PushStore } from "../src/push/registry";
import { route } from "../src/router";
import { memoryStore, TOKEN_A, TOKEN_B, tokenNo } from "./pushSupport";
import { snapshotWith, T0 } from "./support";

const PATH = "/v1/push/registration";

/** The router with its push endpoint wired to `store`, as the Worker wires it to the object. */
function client(store: PushStore, clock = { now: T0 }) {
  const view: CoordinatorView = { snapshot: snapshotWith([]), rateLimitedUntil: null };
  return (method: string, body?: unknown, raw?: string) =>
    route({
      request: new Request(`https://drivecheck.example${PATH}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(raw !== undefined || body !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
      }),
      regionCode: null,
      getView: async () => view,
      getMap: async () => null,
      clock: () => clock.now,
      push: {
        register: async (registration) => register(store, registration, clock.now),
        forget: async (token) => store.deleteDevice(token),
      },
    });
}

const valid = { token: TOKEN_A, region: "kharkiv", env: "production", lang: "uk" };

describe("PUT /v1/push/registration", () => {
  test("REQ-PUSHAPI-001 PUT validates the four fields", async () => {
    const { db, store } = memoryStore();
    const clock = { now: T0 };
    const send = client(store, clock);

    const ok = await send("PUT", valid);
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(db.prepare("SELECT * FROM push_devices").all()).toEqual([
      { token: TOKEN_A, region: "kharkiv", env: "production", lang: "uk", last_seen: T0 },
    ]);

    // The weekly re-send and a region change: still one row, region and last-seen refreshed.
    clock.now = T0 + 7 * 86_400_000;
    expect((await send("PUT", { ...valid, region: "kyivCity" })).status).toBe(204);
    expect(db.prepare("SELECT region, last_seen FROM push_devices").all()).toEqual([
      { region: "kyiv-city", last_seen: T0 + 7 * 86_400_000 },
    ]);

    const refused = [
      { ...valid, lat: 50.4 },
      { ...valid, region: "kyiv-city" },
      { ...valid, region: "crimea" },
      { ...valid, env: "dev" },
      { ...valid, lang: "de" },
      { ...valid, token: "not-hex" },
      { ...valid, token: "" },
      { token: TOKEN_B, region: "kharkiv", env: "production" },
      [valid],
      null,
    ];
    for (const body of refused) {
      expect((await send("PUT", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send("PUT", undefined, "{not json")).status).toBe(400);
    expect(db.prepare("SELECT token FROM push_devices").all()).toEqual([{ token: TOKEN_A }]);
  });

  test("REQ-PUSHAPI-001 other methods on the path answer 405", async () => {
    const { store } = memoryStore();
    const send = client(store);
    for (const method of ["GET", "POST"]) {
      const response = await send(method, method === "GET" ? undefined : valid);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("PUT, DELETE");
    }
  });

  test("REQ-PUSHAPI-007 the device cap refuses new tokens with 503", async () => {
    const { db, store } = memoryStore();
    const send = client(store);
    for (let n = 0; n < MAX_DEVICES; n += 1) {
      store.upsertDevice({
        token: tokenNo(n),
        region: "lviv",
        env: "production",
        lang: "en",
        lastSeen: T0,
      });
    }
    expect((await send("PUT", { ...valid, token: tokenNo(MAX_DEVICES) })).status).toBe(503);
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_devices").all()).toEqual([
      { n: MAX_DEVICES },
    ]);
    // A device already registered still refreshes at the cap.
    expect((await send("PUT", { ...valid, token: tokenNo(7) })).status).toBe(204);
    expect(db.prepare("SELECT region FROM push_devices WHERE token = ?").all(tokenNo(7))).toEqual([
      { region: "kharkiv" },
    ]);
  });
});

describe("DELETE /v1/push/registration", () => {
  test("REQ-PUSHAPI-001 DELETE forgets the device", async () => {
    const { db, store } = memoryStore();
    const send = client(store);
    await send("PUT", valid);
    await send("PUT", { ...valid, token: TOKEN_B });
    store.enqueue("kharkiv", "kharkiv@1", T0);

    const gone = await send("DELETE", { token: TOKEN_A });
    expect(gone.status).toBe(204);
    expect(db.prepare("SELECT token FROM push_devices").all()).toEqual([{ token: TOKEN_B }]);
    expect(db.prepare("SELECT token FROM push_outbox").all()).toEqual([{ token: TOKEN_B }]);

    expect((await send("DELETE", { token: TOKEN_A })).status).toBe(204);
    expect((await send("DELETE", { token: TOKEN_B, region: "kharkiv" })).status).toBe(400);
    expect((await send("DELETE", {})).status).toBe(400);
    expect(db.prepare("SELECT token FROM push_devices").all()).toEqual([{ token: TOKEN_B }]);
  });
});
