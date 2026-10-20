import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { OFFLINE_HEADER } from "../src/client/refresh";
import { PAGE_CSP } from "../src/csp";
import {
  activate,
  handle,
  install,
  PRECACHE,
  type SwDeps,
  seedPage,
  seedStatic,
} from "../src/swStrategy";
import { VERSION } from "../src/version";

const ORIGIN = "https://drivecheck.example";

/** Caches keyed by name, each holding responses by path; what the Cache API would hold. */
class World {
  caches = new Map<string, Map<string, Response>>();
  network: (request: Request) => Promise<Response> = async () => new Response("net");
  fetched: string[] = [];

  deps(version = VERSION): SwDeps {
    return {
      origin: ORIGIN,
      version,
      fetch: (request) => {
        this.fetched.push(new URL(request.url).pathname);
        return this.network(request);
      },
      open: async (name) => {
        const cache = this.caches.get(name) ?? new Map<string, Response>();
        this.caches.set(name, cache);
        return {
          match: async (key) => cache.get(key)?.clone(),
          put: async (key, response) => {
            cache.set(key, response);
          },
        };
      },
      keys: async () => [...this.caches.keys()],
      delete: async (name) => this.caches.delete(name),
    };
  }

  entries(name: string): string[] {
    return [...(this.caches.get(name)?.keys() ?? [])];
  }
}

const page = (path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { accept: "text/html,application/xhtml+xml" } });
const get = (path: string) => new Request(`${ORIGIN}${path}`);
const offline = async () => {
  throw new TypeError("Failed to fetch");
};

describe("service worker strategy", () => {
  test("REQ-WEB-008 pages and data come from the network first, keeping one answer of each", async () => {
    const world = new World();
    let n = 0;
    world.network = async () => new Response(`answer ${++n}`, { status: 200 });
    for (const path of [
      "/?lang=en",
      "/?lang=uk",
      "/regions?lang=en",
      "/v1/alerts",
      "/v1/alerts",
      "/v1/map",
    ]) {
      const request = path.startsWith("/v1") ? get(path) : page(path);
      await handle(request, world.deps());
    }
    expect(world.entries("data").sort()).toEqual(["/", "/regions", "/v1/alerts", "/v1/map"]);
    expect(await (await world.caches.get("data")!.get("/v1/alerts")!.clone()).text()).toBe(
      "answer 5",
    );
  });

  test("REQ-WEB-008 offline, the saved answer is served and marked as offline", async () => {
    const world = new World();
    world.network = async () => new Response("live page");
    await handle(page("/"), world.deps());
    world.network = offline;
    const res = await handle(page("/?lang=uk"), world.deps());
    expect(await res.text()).toBe("live page");
    expect(res.headers.get(OFFLINE_HEADER)).toBe("1");
  });

  test("REQ-WEB-008 offline with nothing saved, the offline page says Unavailable", async () => {
    const world = new World();
    world.network = async () => new Response("static");
    await install(world.deps());
    world.network = offline;
    const res = await handle(page("/"), world.deps());
    expect(await res.text()).toBe("static");
    expect(world.fetched).toContain("/offline.html");
    const alerts = await handle(get("/v1/alerts"), world.deps());
    expect(alerts.status).toBe(503);
  });

  test("REQ-WEB-008 an error answer is passed on but never replaces the saved one", async () => {
    const world = new World();
    world.network = async () => new Response("good");
    await handle(get("/v1/alerts"), world.deps());
    world.network = async () => new Response("down", { status: 503 });
    expect((await handle(get("/v1/alerts"), world.deps())).status).toBe(503);
    world.network = offline;
    expect(await (await handle(get("/v1/alerts"), world.deps())).text()).toBe("good");
  });

  test("REQ-WEB-008 a POST and other origins pass through untouched and uncached", async () => {
    const world = new World();
    const post = new Request(`${ORIGIN}/region`, { method: "POST", body: "region=lviv" });
    await handle(post, world.deps());
    await handle(new Request("https://other.example/x.js"), world.deps());
    expect(world.fetched).toEqual(["/region", "/x.js"]);
    expect(world.caches.size).toBe(0);
  });

  test("REQ-WEB-008 static files come from a versioned cache that a new version replaces", async () => {
    const world = new World();
    world.network = async () => new Response("v1 file");
    await install(world.deps("0.1.0"));
    expect(world.entries("static-0.1.0").sort()).toEqual([...PRECACHE].sort());
    await handle(get("/app/client/app.js"), world.deps("0.1.0"));
    world.fetched = [];
    await handle(get("/app/client/app.js"), world.deps("0.1.0"));
    expect(world.fetched).toEqual([]); // cache first

    await install(world.deps("0.2.0"));
    await handle(page("/"), world.deps("0.2.0"));
    await activate(world.deps("0.2.0"));
    expect([...world.caches.keys()].sort()).toEqual(["data", "static-0.2.0"]);
  });

  test("REQ-WEB-008 the page of the first, uncontrolled visit is saved for offline", async () => {
    const world = new World();
    await seedPage(world.deps(), "/", "<html>first visit</html>");
    await seedPage(world.deps(), "/v1/alerts", "not a page");
    expect(world.entries("data")).toEqual(["/"]);
    world.network = offline;
    const res = await handle(page("/"), world.deps());
    expect(await res.text()).toBe("<html>first visit</html>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
  });

  test("REQ-WEB-008 the first visit's own modules are saved, so the page works offline", async () => {
    const world = new World();
    world.network = async (request) => new Response(`module ${new URL(request.url).pathname}`);
    await seedStatic(world.deps(), [
      `${ORIGIN}/app/client/app.js`,
      `${ORIGIN}/app/view.js`,
      `${ORIGIN}/v1/map`,
      "https://other.example/app/x.js",
    ]);
    expect(world.entries(`static-${VERSION}`).sort()).toEqual([
      "/app/client/app.js",
      "/app/view.js",
    ]);
    world.network = offline;
    const res = await handle(get("/app/view.js"), world.deps());
    expect(await res.text()).toBe("module /app/view.js");
  });

  test("REQ-WEB-008 a shared ?region= link does not replace the visitor's own saved page", async () => {
    const world = new World();
    world.network = async () => new Response("my region");
    await handle(page("/?lang=en"), world.deps());
    world.network = async () => new Response("odesa");
    await handle(page("/?region=odesa&lang=en"), world.deps());
    world.network = offline;
    expect(await (await handle(page("/"), world.deps())).text()).toBe("my region");
  });

  test("REQ-WEB-008 the cache version is the package version", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
