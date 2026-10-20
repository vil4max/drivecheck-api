import { describe, expect, test } from "vitest";
import { alertsResponse } from "../src/api";
import { ALERTS_PATH, RefreshLoop } from "../src/client/refresh";
import type { Snapshot } from "../src/feed";
import { snapshotWith, T0 } from "./support";

type Answer = Response | Error | "hang";

/** One injected clock for timers, the 15 s request timeout and the answers' ages. */
class World {
  now = T0;
  timers: { id: number; at: number; run: () => void }[] = [];
  next = 1;
  paths: string[] = [];
  requestTimes: number[] = [];
  renders: { at: number; snapshot: Snapshot | null }[] = [];
  answers: Answer[] = [];
  random = 0;
  saveData = false;

  loop(snapshot: Snapshot | null = snapshotWith([])) {
    return new RefreshLoop(
      {
        now: () => this.now,
        setTimer: (run, ms) => {
          const id = this.next++;
          this.timers.push({ id, at: this.now + ms, run });
          return id;
        },
        clearTimer: (id) => {
          this.timers = this.timers.filter((t) => t.id !== id);
        },
        timeoutSignal: (ms) => {
          const controller = new AbortController();
          const id = this.next++;
          this.timers.push({
            id,
            at: this.now + ms,
            run: () => controller.abort(new Error("timeout")),
          });
          return controller.signal;
        },
        fetch: (path, signal) => {
          this.paths.push(path);
          this.requestTimes.push(this.now);
          const answer = this.answers.shift() ?? new Error("no answer queued");
          if (answer === "hang") {
            return new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason)),
            );
          }
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
        random: () => this.random,
        saveData: () => this.saveData,
        inAlarm: (s) => s.feed.states["м. Київ"]?.alertnow === true,
        render: (s) => this.renders.push({ at: this.now, snapshot: s }),
      },
      { snapshot, receivedAt: this.now },
    );
  }

  /** An answer as the Worker gives it, fetched and cached at the current time. */
  ok(alarmKeys: string[] = []): Response {
    const s = snapshotWith(alarmKeys);
    const at = this.now;
    const snapshot = { ...s, fetchedAt: at, serverCachedAt: at };
    snapshot.feed.cachedat = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Kyiv",
      dateStyle: "short",
      timeStyle: "medium",
    }).format(at);
    return alertsResponse({ snapshot, rateLimitedUntil: null }, at);
  }

  async advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (due === undefined || due.at > target) break;
      this.timers.shift();
      this.now = due.at;
      due.run();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function started(world: World, visible = true, snapshot?: Snapshot | null) {
  const loop = world.loop(snapshot);
  loop.start(visible);
  return loop;
}

describe("RefreshLoop", () => {
  test("REQ-REFRESH-001 asks only while visible, and at once when visible again", async () => {
    const world = new World();
    const loop = started(world);
    await world.advance(53_999);
    expect(world.paths).toEqual([]); // the page itself carried the first answer
    world.answers.push(world.ok());
    await world.advance(1);
    expect(world.requestTimes).toEqual([T0 + 54_000]);

    loop.setVisible(false);
    await world.advance(600_000);
    expect(world.paths).toHaveLength(1);

    world.answers.push(world.ok());
    loop.setVisible(true);
    await flush();
    expect(world.requestTimes).toEqual([T0 + 54_000, T0 + 654_000]);
  });

  test("REQ-REFRESH-002 60 s ± 10 % when quiet, 30 s in alarm, 300 s with data saver", async () => {
    const world = new World();
    world.random = 1;
    started(world);
    world.answers.push(world.ok(["м. Київ"]));
    await world.advance(66_000);
    expect(world.requestTimes).toEqual([T0 + 66_000]);
    // The answer turned the region red: the next poll follows the alarm interval, 30 s + 10 %.
    world.answers.push(world.ok(["м. Київ"]));
    await world.advance(32_999);
    expect(world.requestTimes).toEqual([T0 + 66_000]);
    await world.advance(1);
    expect(world.requestTimes).toEqual([T0 + 66_000, T0 + 99_000]);

    const saver = new World();
    saver.saveData = true;
    started(saver, true, snapshotWith(["м. Київ"]));
    await saver.advance(269_999);
    expect(saver.paths).toEqual([]);
    saver.answers.push(saver.ok());
    await saver.advance(1);
    expect(saver.requestTimes).toEqual([T0 + 270_000]);
  });

  test("REQ-REFRESH-003 retries a thrown or timed-out request once after 2 s, not an HTTP error", async () => {
    const world = new World();
    const loop = started(world);
    world.answers.push(new Error("offline"), new Error("still offline"));
    await world.advance(54_000);
    await world.advance(2_000);
    await world.advance(10_000);
    expect(world.requestTimes).toEqual([T0 + 54_000, T0 + 56_000]);

    const hang = new World();
    started(hang);
    hang.answers.push("hang", hang.ok());
    await hang.advance(54_000);
    await hang.advance(15_000); // the timeout fires
    await hang.advance(2_000);
    expect(hang.requestTimes).toEqual([T0 + 54_000, T0 + 71_000]);

    const http = new World();
    started(http);
    http.answers.push(new Response("boom", { status: 500 }));
    await http.advance(54_000);
    await http.advance(5_000);
    expect(http.requestTimes).toEqual([T0 + 54_000]);
    loop.stop();
  });

  test("REQ-REFRESH-005 Retry-After holds polls and Refresh; without it the client backs off", async () => {
    const world = new World();
    const loop = started(world);
    world.answers.push(new Response("{}", { status: 503, headers: { "retry-after": "45" } }));
    await world.advance(54_000);
    await world.advance(30_000);
    await loop.refresh();
    expect(world.requestTimes).toEqual([T0 + 54_000]);
    await world.advance(16_000);
    world.answers.push(world.ok());
    await loop.refresh();
    expect(world.requestTimes).toEqual([T0 + 54_000, T0 + 100_000]);

    const bare = new World();
    const b = started(bare);
    bare.answers.push(new Response("{}", { status: 503 }), new Response("{}", { status: 429 }));
    await bare.advance(54_000);
    await bare.advance(29_000);
    await b.refresh();
    expect(bare.requestTimes).toEqual([T0 + 54_000]);
    await bare.advance(1_000);
    await b.refresh();
    expect(bare.requestTimes).toEqual([T0 + 54_000, T0 + 84_000]);
    await bare.advance(59_000);
    await b.refresh();
    expect(bare.requestTimes).toHaveLength(2); // the second hold is 60 s

    const huge = new World();
    const h = started(huge);
    huge.answers.push(new Response("{}", { status: 503, headers: { "retry-after": "99999" } }));
    await huge.advance(54_000);
    huge.answers.push(huge.ok());
    await huge.advance(299_999);
    await h.refresh();
    expect(huge.requestTimes).toEqual([T0 + 54_000]);
    await huge.advance(1); // the poll falls due exactly when the 5 min cap ends
    expect(huge.requestTimes).toEqual([T0 + 54_000, T0 + 354_000]);
  });

  test("REQ-REFRESH-006 turns stale at checkedAt + 2 min without a request, and failures keep the status", async () => {
    const world = new World();
    const alarm = snapshotWith(["м. Київ"]); // checkedAt T0
    started(world, true, alarm);
    world.random = 0.5; // 30 s ± 0 in alarm
    world.answers.push(new Error("down"), new Error("down"));
    await world.advance(120_001);
    const staleRender = world.renders.find((r) => r.at === T0 + 120_001);
    expect(staleRender?.snapshot).toBe(alarm);
    // Every render after a failure still shows the held alarm, never "nothing".
    expect(world.renders.every((r) => r.snapshot === alarm)).toBe(true);
  });

  test("REQ-REFRESH-006 an answer the service worker served offline counts as a failure", async () => {
    const world = new World();
    const held = snapshotWith([]);
    started(world, true, held);
    const offline = world.ok(["м. Київ"]);
    offline.headers.set("x-drivecheck-offline", "1");
    world.answers.push(offline, new Error("down"));
    await world.advance(54_000);
    await world.advance(2_000);
    expect(world.requestTimes).toEqual([T0 + 54_000, T0 + 56_000]); // retried like a failure
    expect(world.renders.every((r) => r.snapshot === held)).toBe(true);
  });

  test("REQ-REFRESH-010 no request within 10 s of the last success, whatever the trigger", async () => {
    const world = new World();
    const loop = started(world);
    await world.advance(5_000);
    await loop.refresh();
    loop.setVisible(false);
    loop.setVisible(true);
    await flush();
    expect(world.paths).toEqual([]);
    expect(world.renders.length).toBeGreaterThan(0); // Refresh inside the floor re-draws
    await world.advance(5_001);
    world.answers.push(world.ok());
    await loop.refresh();
    expect(world.requestTimes).toEqual([T0 + 10_001]);
  });

  test("REQ-WEB-006 the loop asks nothing but this origin's /v1/alerts", async () => {
    const world = new World();
    const loop = started(world);
    world.answers.push(world.ok(), new Error("x"), world.ok());
    await world.advance(54_000);
    await world.advance(60_000);
    await world.advance(2_000);
    await loop.refresh();
    expect(world.paths.length).toBeGreaterThan(1);
    expect(new Set(world.paths)).toEqual(new Set(["/v1/alerts"]));
    expect(ALERTS_PATH).toBe("/v1/alerts");
  });
});
