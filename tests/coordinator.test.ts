import { describe, expect, test } from "vitest";
import { FeedCoordinator } from "../src/coordinator";
import { ENDPOINT } from "../src/feed";
import { FakeWorld, feedJson, hangingUpstream, jsonResponse, T0 } from "./support";

function setup() {
  const world = new FakeWorld();
  return { world, coordinator: () => new FeedCoordinator(world.deps()) };
}

/** Asks, lets the background attempt finish, and asks again. */
async function refreshed(c: FeedCoordinator) {
  await c.current();
  await c.idle();
  return c.current();
}

describe("FeedCoordinator", () => {
  test("REQ-PROVIDER-001 fetches the default JSON endpoint and keeps server and fetch times", async () => {
    const { world, coordinator } = setup();
    world.queue(jsonResponse(feedJson()));
    const view = await coordinator().current();
    expect(world.requests).toEqual([ENDPOINT]);
    expect(view.snapshot?.fetchedAt).toBe(T0);
    expect(view.snapshot?.serverCachedAt).toBe(Date.UTC(2026, 7, 1, 21, 0, 0));
  });

  test("REQ-REFRESH-010 serves the held snapshot inside 10 s and fetches again after", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(
      jsonResponse(feedJson({ source: "first" })),
      jsonResponse(feedJson({ source: "second" })),
    );
    await c.current();
    world.now += 9_999;
    expect((await c.current()).snapshot?.feed.source).toBe("first");
    expect(world.requests).toHaveLength(1);
    world.now += 1;
    expect((await refreshed(c)).snapshot?.feed.source).toBe("second");
    expect(world.requests).toHaveLength(2);
  });

  test("REQ-REFRESH-010 serves a held snapshot at once while the upstream hangs", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(jsonResponse(feedJson()), hangingUpstream);
    await c.current();
    world.now += 10_000;
    const view = await c.current();
    expect(view.snapshot?.fetchedAt).toBe(T0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.requests).toHaveLength(2);
  });

  test("REQ-API-002 without a snapshot a caller stops waiting for a hanging upstream", async () => {
    const { world, coordinator } = setup();
    world.capWaits = true;
    world.queue(hangingUpstream);
    const view = await coordinator().current();
    expect(view.snapshot).toBeNull();
    expect(world.capWaitMs).toEqual([5_000]);
  });

  test("REQ-PROVIDER-002 an attempt still in flight past the floor blocks a second one", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.capWaits = true;
    world.queue(hangingUpstream);
    await c.current();
    world.now += 15_000;
    await c.current();
    expect(world.requests).toHaveLength(1);
  });

  test("REQ-REFRESH-010 hands the background attempt to the platform to keep alive", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    let release: (r: Response) => void = () => {};
    world.queue(
      jsonResponse(feedJson()),
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    await c.current();
    world.now += 10_000;
    await c.current();
    expect(world.backgrounded).toHaveLength(2);
    let settled = false;
    const work = world.backgrounded[1]?.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release(jsonResponse(feedJson({ source: "later" })));
    await work;
    expect((await c.current()).snapshot?.feed.source).toBe("later");
  });

  test("REQ-REFRESH-010 counts a failed attempt, so a failing upstream is asked once per 10 s", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(new Response("down", { status: 500 }), jsonResponse(feedJson()));
    await c.current();
    world.now += 5_000;
    expect((await c.current()).snapshot).toBeNull();
    expect(world.requests).toHaveLength(1);
    world.now += 5_000;
    expect((await c.current()).snapshot).not.toBeNull();
  });

  test("REQ-PROVIDER-002 makes one upstream request for many concurrent clients", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    let release: (r: Response) => void = () => {};
    world.queue(() => new Promise<Response>((resolve) => (release = resolve)));
    const views = [c.current(), c.current(), c.current()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(jsonResponse(feedJson()));
    const answers = await Promise.all(views);
    expect(world.requests).toHaveLength(1);
    for (const view of answers) expect(view.snapshot?.feed.source).toBe("fixture");
  });

  test("REQ-PROVIDER-002 counted session: 60 client requests over 60 s cause 6 upstream requests", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    for (let i = 0; i < 6; i++) world.queue(jsonResponse(feedJson()));
    for (let second = 0; second < 60; second++) {
      await c.current();
      await c.idle();
      world.now += 1_000;
    }
    expect(world.requests).toHaveLength(6);
  });

  test("REQ-REFRESH-003 retries a transient failure once after 2 s and no more", async () => {
    const { world, coordinator } = setup();
    world.queue(new TypeError("network"), new TypeError("network"));
    const view = await coordinator().current();
    expect(world.sleeps).toEqual([2_000]);
    expect(world.requests).toHaveLength(2);
    expect(view.snapshot).toBeNull();
  });

  test("REQ-REFRESH-003 a request times out after 15 s and is retried once", async () => {
    const { world, coordinator } = setup();
    world.queue(hangingUpstream, jsonResponse(feedJson()));
    const pending = coordinator().current();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.timeouts.map((t) => t.ms)).toEqual([15_000]);
    world.timeouts[0]?.fire();
    const view = await pending;
    expect(world.requests).toHaveLength(2);
    expect(world.sleeps).toEqual([2_000]);
    expect(view.snapshot).not.toBeNull();
  });

  test("REQ-REFRESH-003 does not retry an HTTP error", async () => {
    const { world, coordinator } = setup();
    world.queue(new Response("bad", { status: 502 }));
    await coordinator().current();
    expect(world.requests).toHaveLength(1);
    expect(world.sleeps).toEqual([]);
  });

  test("REQ-REFRESH-005 holds every request inside the Retry-After window and keeps the snapshot", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(
      jsonResponse(feedJson()),
      new Response("slow down", { status: 429, headers: { "retry-after": "45" } }),
      jsonResponse(feedJson({ source: "after" })),
    );
    await c.current();
    world.now += 10_000;
    const limited = await refreshed(c);
    expect(limited.rateLimitedUntil).toBe(world.now + 45_000);
    expect(limited.snapshot?.feed.source).toBe("fixture");
    world.now += 44_999;
    await refreshed(c);
    expect(world.requests).toHaveLength(2);
    world.now += 1;
    const after = await refreshed(c);
    expect(after.snapshot?.feed.source).toBe("after");
    expect(after.rateLimitedUntil).toBeNull();
  });

  test("REQ-REFRESH-005 escalates the backoff on consecutive 429s without Retry-After", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(new Response("", { status: 429 }), new Response("", { status: 429 }));
    expect((await c.current()).rateLimitedUntil).toBe(T0 + 30_000);
    world.now += 30_000;
    expect((await c.current()).rateLimitedUntil).toBe(world.now + 60_000);
  });

  test("REQ-REFRESH-005 the backoff restarts at 30 s after a successful fetch", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(
      new Response("", { status: 429 }),
      jsonResponse(feedJson()),
      new Response("", { status: 429 }),
    );
    await c.current();
    world.now += 30_000;
    await c.current();
    world.now += 10_000;
    expect((await refreshed(c)).rateLimitedUntil).toBe(world.now + 30_000);
  });

  test("REQ-REFRESH-005 a restarted coordinator still honours a stored window", async () => {
    const { world, coordinator } = setup();
    world.queue(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    await coordinator().current();
    world.now += 60_000;
    const restarted = await coordinator().current();
    expect(world.requests).toHaveLength(1);
    expect(restarted.rateLimitedUntil).toBe(T0 + 120_000);
  });

  test("REQ-REFRESH-010 the attempt time is stored before the request is sent", async () => {
    const { world, coordinator } = setup();
    world.queue(hangingUpstream);
    void coordinator().current();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.stored?.lastAttemptAt).toBe(T0);
    world.now += 5_000;
    await coordinator().current();
    expect(world.requests).toHaveLength(1);
  });

  test("REQ-REFRESH-006 a failed fetch keeps the held snapshot", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(
      jsonResponse(feedJson()),
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await c.current();
    world.now += 10_000;
    const view = await refreshed(c);
    expect(view.snapshot?.fetchedAt).toBe(T0);
  });

  test("REQ-REFRESH-006 a failed storage write or read does not fail the callers for good", async () => {
    const { world, coordinator } = setup();
    world.failSaves = true;
    world.queue(jsonResponse(feedJson()));
    expect((await coordinator().current()).snapshot).not.toBeNull();
    world.failSaves = false;
    world.failNextLoad = true;
    const c = coordinator();
    await expect(c.current()).rejects.toThrow("storage unavailable");
    world.queue(jsonResponse(feedJson()));
    expect((await c.current()).snapshot).not.toBeNull();
  });

  test("REQ-API-003 stores one record holding only the latest snapshot and no client data", async () => {
    const { world, coordinator } = setup();
    const c = coordinator();
    world.queue(
      jsonResponse(feedJson({ source: "old" })),
      jsonResponse(feedJson({ source: "new" })),
    );
    await c.current();
    world.now += 10_000;
    await refreshed(c);
    expect(Object.keys(world.stored ?? {}).sort()).toEqual(
      ["lastAttemptAt", "rateLimitStreak", "rateLimitedUntil", "snapshot"].sort(),
    );
    expect(JSON.stringify(world.stored)).not.toContain('"old"');
    expect(world.stored?.snapshot?.feed.source).toBe("new");
  });
});
