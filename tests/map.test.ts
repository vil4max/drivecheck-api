import { describe, expect, test } from "vitest";
import { ENDPOINT, FeedCoordinator, MAP_ENDPOINT } from "../src/coordinator";
import { regionById } from "../src/regions";
import { route } from "../src/router";
import { mapBehind, swapMap } from "../src/view";
import {
  FakeWorld,
  feedJson,
  hangingUpstream,
  imageResponse,
  jsonResponse,
  snapshotWith,
  T0,
} from "./support";

function setup() {
  const world = new FakeWorld();
  return { world, c: new FeedCoordinator(world.deps()) };
}

const bytesOf = async (image: { bytes: Uint8Array } | null) =>
  image === null ? null : [...image.bytes];

describe("alert map through the coordinator", () => {
  test("REQ-WEB-012 asks the provider's night map once and holds it for 60 s", async () => {
    const { world, c } = setup();
    world.queue(imageResponse([1, 2, 3]), imageResponse([4, 5]));
    const first = await c.currentMap();
    expect(MAP_ENDPOINT).toBe("https://ubilling.net.ua/aerialalerts/?map=nightmode");
    expect(world.requests).toEqual([MAP_ENDPOINT]);
    expect(await bytesOf(first)).toEqual([1, 2, 3]);
    expect(first?.fetchedAt).toBe(T0);
    expect(first?.contentType).toBe("image/png");

    world.now += 59_999;
    expect(await bytesOf(await c.currentMap())).toEqual([1, 2, 3]);
    expect(world.requests).toHaveLength(1);

    world.now += 1;
    expect(await bytesOf(await c.currentMap())).toEqual([1, 2, 3]);
    await c.idle();
    expect(world.requests).toHaveLength(2);
    expect(await bytesOf(await c.currentMap())).toEqual([4, 5]);
  });

  test("REQ-WEB-012 never sends a map request while the JSON request is in flight, or the reverse", async () => {
    const { world, c } = setup();
    world.queue(jsonResponse(feedJson()), imageResponse([1]));
    await c.current();
    await c.currentMap();
    expect(world.requests).toEqual([ENDPOINT, MAP_ENDPOINT]);

    world.now += 60_000;
    world.queue(hangingUpstream);
    await c.current(); // JSON attempt hangs in the background
    expect(await bytesOf(await c.currentMap())).toEqual([1]);
    expect(world.requests).toEqual([ENDPOINT, MAP_ENDPOINT, ENDPOINT]);
    world.timeouts.at(-1)!.fire();
    world.queue(new Error("down"));
    await c.idle();

    world.now += 60_000;
    world.queue(hangingUpstream);
    await c.currentMap(); // map attempt hangs in the background
    await c.current();
    expect(world.requests.filter((u) => u === ENDPOINT)).toHaveLength(3);
    expect(world.requests.at(-1)).toBe(MAP_ENDPOINT);
  });

  test("REQ-WEB-012 the map waits 3 s after a JSON request, as iOS does after the status", async () => {
    const { world, c } = setup();
    world.queue(jsonResponse(feedJson()), imageResponse([1]));
    await c.current();
    world.now += 500;
    expect(await bytesOf(await c.currentMap())).toEqual([1]);
    expect(world.requests).toEqual([ENDPOINT, MAP_ENDPOINT]);
    expect(world.sleeps).toEqual([2_500]);
  });

  test("REQ-WEB-012 a page load's JSON attempt delays the map refresh but never drops it", async () => {
    const { world, c } = setup();
    world.queue(jsonResponse(feedJson()), imageResponse([1]));
    await c.current();
    await c.idle();
    world.now += 3_000;
    await c.currentMap();
    await c.idle();

    // A visitor opens the page a minute later: its request starts a JSON attempt, and its map
    // request arrives 0.1 s after, while that attempt is still in flight.
    world.now += 60_000;
    world.queue(jsonResponse(feedJson()), imageResponse([2]));
    await c.current();
    world.now += 100;
    expect(await bytesOf(await c.currentMap())).toEqual([1]); // the held map, at once
    await c.idle();
    expect(world.requests).toEqual([ENDPOINT, MAP_ENDPOINT, ENDPOINT, MAP_ENDPOINT]);
    expect(world.sleeps.at(-1)).toBe(2_900); // 3 s after the JSON request, not dropped
    const fresh = await c.currentMap();
    expect(await bytesOf(fresh)).toEqual([2]);
    // The Worker reports the new map's own fetch time, which the page's caption ages from.
    expect((await c.current()).mapFetchedAt).toBe(fresh?.fetchedAt);
  });

  test("REQ-WEB-012 a JSON request waits a second after a map request", async () => {
    const { world, c } = setup();
    world.queue(jsonResponse(feedJson()), imageResponse([1]));
    await c.current();
    world.now += 9_600;
    await c.currentMap();
    world.now += 500; // the JSON floor has passed, but the map request was 500 ms ago
    await c.current();
    expect(world.requests).toEqual([ENDPOINT, MAP_ENDPOINT]);
    world.now += 500;
    world.queue(jsonResponse(feedJson()));
    await c.current();
    expect(world.requests).toEqual([ENDPOINT, MAP_ENDPOINT, ENDPOINT]);
  });

  test("REQ-WEB-012 a map 429 holds the JSON requests too", async () => {
    const { world, c } = setup();
    world.queue(imageResponse([1], { status: 429, headers: { "retry-after": "30" } }));
    expect(await c.currentMap()).toBeNull();
    world.now += 10_000;
    const view = await c.current();
    expect(view.rateLimitedUntil).toBe(T0 + 30_000);
    expect(world.requests).toEqual([MAP_ENDPOINT]);
    world.now += 20_000;
    world.queue(jsonResponse(feedJson()));
    await c.current();
    expect(world.requests).toEqual([MAP_ENDPOINT, ENDPOINT]);
  });

  test("REQ-WEB-012 a failed or non-image answer keeps the held image and never invents one", async () => {
    const { world, c } = setup();
    world.queue(new Response("err", { status: 500 }));
    expect(await c.currentMap()).toBeNull();
    world.now += 60_000;
    world.queue(imageResponse([7]));
    await c.currentMap();
    world.now += 60_000;
    world.queue(new Response("<html>", { headers: { "content-type": "text/html" } }));
    await c.currentMap();
    await c.idle();
    const held = await c.currentMap();
    expect(await bytesOf(held)).toEqual([7]);
    expect(held?.fetchedAt).toBe(T0 + 60_000);
  });

  test("REQ-WEB-012 keeps one overwritten image, survives a restart and reports its time", async () => {
    const { world, c } = setup();
    world.queue(imageResponse([1]), imageResponse([2]));
    await c.currentMap();
    world.now += 60_000;
    await c.currentMap();
    await c.idle();
    expect(world.mapStored?.image?.bytes).toEqual(new Uint8Array([2]));
    expect(Object.keys(world.mapStored ?? {}).sort()).toEqual(["image", "lastAttemptAt"]);

    const restarted = new FeedCoordinator(world.deps());
    world.now += 1_000;
    expect(await bytesOf(await restarted.currentMap())).toEqual([2]);
    expect(world.requests).toHaveLength(2);
    world.queue(jsonResponse(feedJson()));
    expect((await restarted.current()).mapFetchedAt).toBe(T0 + 60_000);
  });
});

describe("GET /v1/map", () => {
  const request = (path: string) => new Request(`https://example.test${path}`);
  const base = {
    regionCode: null,
    getView: async () => ({ snapshot: snapshotWith([]), rateLimitedUntil: null, mapFetchedAt: T0 }),
    clock: () => T0,
  };

  test("REQ-WEB-012 serves the held image with a 60 s browser cache", async () => {
    const res = await route({
      ...base,
      request: request("/v1/map"),
      getMap: async () => ({
        bytes: new Uint8Array([9, 9]),
        contentType: "image/png",
        fetchedAt: T0,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 9]);
  });

  test("REQ-WEB-012 answers 503 without an image", async () => {
    const res = await route({ ...base, request: request("/v1/map"), getMap: async () => null });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("map freshness on an open page", () => {
  test("REQ-WEB-012 the Worker tells when its map was fetched", async () => {
    const res = await route({
      request: new Request("https://example.test/v1/map", { method: "HEAD" }),
      regionCode: null,
      getView: async () => ({ snapshot: null, rateLimitedUntil: null }),
      getMap: async () => ({ bytes: new Uint8Array([1]), contentType: "image/png", fetchedAt: T0 }),
      clock: () => T0,
    });
    expect(res.headers.get("x-map-fetched-at")).toBe(String(T0));
  });

  test("REQ-WEB-012 an open page asks for a newer map once its map trails the status by a minute", () => {
    const snapshot = { ...snapshotWith([]), fetchedAt: T0 };
    expect(mapBehind(null, snapshot)).toBe(true);
    expect(mapBehind(T0 - 59_999, snapshot)).toBe(false);
    expect(mapBehind(T0 - 60_000, snapshot)).toBe(true);
    expect(mapBehind(T0, null)).toBe(false);
  });
});

describe("the open page swaps in a newer map", () => {
  const kyiv = regionById("kyiv-city")!;
  const snapshot = { ...snapshotWith(["Львівська область", "Сумська область"]), fetchedAt: T0 };

  test("REQ-WEB-012 the image and the caption change together, from the same map and snapshot", () => {
    const swap = swapMap(snapshot, kyiv, "en", T0 + 30_000, String(T0), T0 - 300_000);
    expect(swap?.imageUrl).toBe(`/v1/map?at=${T0}`);
    // Counted from this snapshot, aged from this map: 30 s rounds up to one minute.
    expect(swap?.model.mapCaption).toBe("2 of 25 regions under alert · 1 min ago");
  });

  test("REQ-WEB-012 an older, equal or unreadable map time leaves the shown map in place", () => {
    expect(swapMap(snapshot, kyiv, "en", T0, String(T0 - 1), T0)).toBeNull();
    expect(swapMap(snapshot, kyiv, "en", T0, String(T0), T0)).toBeNull();
    expect(swapMap(snapshot, kyiv, "en", T0, null, T0 - 300_000)).toBeNull();
    expect(swapMap(snapshot, kyiv, "en", T0, "soon", null)).toBeNull();
  });
});

describe("many pages at once", () => {
  test("REQ-WEB-012 REQ-PROVIDER-002 many concurrent pages queue one map request at most", async () => {
    const world = new FakeWorld();
    const c = new FeedCoordinator(world.deps());
    world.queue(jsonResponse(feedJson()), imageResponse([1]));
    await c.current();
    await c.idle();
    world.now += 3_000;
    await c.currentMap();
    await c.idle();

    world.now += 60_000;
    world.queue(jsonResponse(feedJson()), imageResponse([2]));
    await c.current(); // a JSON attempt is in flight
    const maps = await Promise.all(Array.from({ length: 50 }, () => c.currentMap()));
    expect(maps.every((m) => m?.bytes[0] === 1)).toBe(true);
    await c.idle();
    expect(world.requests.filter((u) => u === MAP_ENDPOINT)).toHaveLength(2);
    expect(world.requests).toHaveLength(4);
  });
});
