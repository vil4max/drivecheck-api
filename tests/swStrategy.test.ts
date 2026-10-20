import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { OFFLINE_HEADER } from "../src/client/refresh";
import { PAGE_CSP } from "../src/csp";
import { renderPage } from "../src/page";
import { regionById } from "../src/regions";
import { renderRegions } from "../src/regionsPage";
import { redrawSaved } from "../src/savedPage";
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
import { regionsModel, statusModel } from "../src/view";
import { snapshotWith, T0 } from "./support";

const ORIGIN = "https://drivecheck.example";

/** Caches keyed by name, each holding responses by path; what the Cache API would hold. */
class World {
  caches = new Map<string, Map<string, Response>>();
  network: (request: Request) => Promise<Response> = async () => new Response("net");
  fetched: string[] = [];
  now = T0;

  deps(version = VERSION): SwDeps {
    return {
      origin: ORIGIN,
      version,
      now: () => this.now,
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
    world.network = async (request) => {
      const url = new URL(request.url);
      return new Response(`offline ${url.searchParams.get("lang") ?? url.pathname}`);
    };
    await install(world.deps());
    expect(world.fetched.filter((p) => p === "/offline")).toHaveLength(3);
    world.network = offline;
    // In the visitor's language: the page's ?lang=, else the browser's Accept-Language.
    expect(await (await handle(page("/?lang=uk"), world.deps())).text()).toBe("offline uk");
    const ru = new Request(`${ORIGIN}/`, {
      headers: { accept: "text/html", "accept-language": "ru-RU,ru;q=0.9" },
    });
    expect(await (await handle(ru, world.deps())).text()).toBe("offline ru");
    expect(await (await handle(page("/regions"), world.deps())).text()).toBe("offline en");
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

describe("review repairs, M2", () => {
  test("REQ-WEB-008 install saves every app module the build lists, per version", async () => {
    const world = new World();
    world.network = async (request) => {
      const path = new URL(request.url).pathname;
      return path === "/app/assets.json"
        ? new Response(JSON.stringify(["/app/client/app.js", "/app/view.js"]))
        : new Response(`file ${path}`);
    };
    await install(world.deps("0.2.1"));
    expect(world.entries("static-0.2.1")).toEqual(
      expect.arrayContaining(["/app/client/app.js", "/app/view.js"]),
    );
    world.network = offline;
    expect(await (await handle(get("/app/view.js"), world.deps("0.2.1"))).text()).toBe(
      "file /app/view.js",
    );
  });

  test("REQ-REFRESH-006 a saved page served offline is redrawn for now, so old data never reads as fresh", async () => {
    const world = new World();
    const snapshot = snapshotWith([]); // checked at T0, quiet
    const html = renderPage(statusModel(snapshot, regionById("kyiv-city")!, "en", T0, null), {
      snapshot,
      mapFetchedAt: null,
    });
    expect(html).toContain("Updated 12:00");
    world.network = async () => new Response(html, { headers: { "content-type": "text/html" } });
    await handle(page("/"), world.deps());
    world.network = offline;
    world.now = T0 + 3 * 3_600_000;
    const res = await handle(page("/"), world.deps());
    const text = await res.text();
    expect(text).toContain("Last known: No Alert · 12:00");
    expect(text).not.toContain("Updated 12:00");
    expect(res.headers.get(OFFLINE_HEADER)).toBe("1");
  });

  test("REQ-WEB-008 a saved page without data is served as it was", async () => {
    const world = new World();
    world.network = async () => new Response("<html>regions</html>");
    await handle(page("/regions"), world.deps());
    world.network = offline;
    expect(await (await handle(page("/regions"), world.deps())).text()).toBe(
      "<html>regions</html>",
    );
  });
});

describe("every saved page shows its age offline", () => {
  const snapshot = snapshotWith(["Львівська область"]);

  test("REQ-REFRESH-006 REQ-WEB-008 a saved Regions page served hours later reads Last known", async () => {
    const world = new World();
    const html = renderRegions(regionsModel(snapshot, regionById("kyiv-city")!, "en", null, T0), {
      snapshot,
      mapFetchedAt: null,
    });
    expect(html).toContain("Updated 12:00");
    world.network = async () => new Response(html, { headers: { "content-type": "text/html" } });
    await handle(page("/regions?lang=en"), world.deps());
    world.network = offline;
    world.now = T0 + 3 * 3_600_000;
    const text = await (await handle(page("/regions"), world.deps())).text();
    expect(text).toContain("Last known · Updated 12:00");
    expect(text).not.toContain(">Updated 12:00<");
  });

  test("REQ-REFRESH-006 the redraw reads attributes, not exact markup", () => {
    const html = renderPage(statusModel(snapshot, regionById("kyiv-city")!, "en", T0, null), {
      snapshot,
      mapFetchedAt: null,
    })
      .replace('<html lang="en">', '<html data-theme="dark" lang="en" dir="ltr">')
      .replace('<main id="main"', '<main class="x" id="main"');
    const redrawn = redrawSaved(html, T0 + 3 * 3_600_000);
    expect(redrawn).toContain("Last known: No Alert · 12:00");
  });
});
