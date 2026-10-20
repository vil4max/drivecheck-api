import { OFFLINE_HEADER } from "./client/refresh.ts";

/** The part of the Cache API the strategy needs, keyed by path. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface SwDeps {
  origin: string;
  version: string;
  fetch: (request: Request) => Promise<Response>;
  open: (name: string) => Promise<CacheLike>;
  keys: () => Promise<string[]>;
  delete: (name: string) => Promise<boolean>;
}

/** Saved on install, so a first offline open still has its offline page and icons. */
export const PRECACHE: readonly string[] = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon-180.png",
];

/** One answer per kind, overwritten: never a history of statuses (REQ-WEB-008, REQ-API-003). */
const DATA_CACHE = "data";
const LATEST: readonly string[] = ["/", "/regions", "/v1/alerts", "/v1/map"];
const STATIC_PREFIXES = ["/app/", "/icons/"];
const STATIC_FILES = ["/manifest.webmanifest", "/offline.html"];

const staticCache = (version: string) => `static-${version}`;

export async function install(deps: SwDeps): Promise<void> {
  const cache = await deps.open(staticCache(deps.version));
  await Promise.all(
    PRECACHE.map(async (path) => {
      const response = await deps.fetch(new Request(`${deps.origin}${path}`));
      if (response.ok) await cache.put(path, response);
    }),
  );
}

/** Drops the static caches of earlier versions; the data cache carries over. */
export async function activate(deps: SwDeps): Promise<void> {
  const keep = new Set([DATA_CACHE, staticCache(deps.version)]);
  for (const name of await deps.keys()) {
    if (!keep.has(name)) await deps.delete(name);
  }
}

function markedOffline(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(OFFLINE_HEADER, "1");
  return new Response(response.body, { status: response.status, headers });
}

async function networkFirst(request: Request, key: string, deps: SwDeps): Promise<Response> {
  const cache = await deps.open(DATA_CACHE);
  try {
    const response = await deps.fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch {
    const saved = await cache.match(key);
    if (saved !== undefined) return markedOffline(saved);
    if (key === "/" || key === "/regions") {
      const page = await (await deps.open(staticCache(deps.version))).match("/offline.html");
      if (page !== undefined) return page;
    }
    return new Response("Offline", { status: 503, headers: { [OFFLINE_HEADER]: "1" } });
  }
}

async function cacheFirst(request: Request, key: string, deps: SwDeps): Promise<Response> {
  const cache = await deps.open(staticCache(deps.version));
  const saved = await cache.match(key);
  if (saved !== undefined) return saved;
  const response = await deps.fetch(request);
  if (response.ok) await cache.put(key, response.clone());
  return response;
}

/** Network first for the pages and data, cache first for the app's own static files. */
export async function handle(request: Request, deps: SwDeps): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== deps.origin) return deps.fetch(request);
  if (LATEST.includes(url.pathname)) return networkFirst(request, url.pathname, deps);
  const isStatic =
    STATIC_FILES.includes(url.pathname) || STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
  return isStatic ? cacheFirst(request, url.pathname, deps) : deps.fetch(request);
}
