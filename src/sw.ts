/// <reference lib="webworker" />
import { activate, handle, install, type SwDeps } from "./swStrategy.ts";
import { VERSION } from "./version.ts";

declare const self: ServiceWorkerGlobalScope;

const deps: SwDeps = {
  origin: self.location.origin,
  version: VERSION,
  fetch: (request) => fetch(request),
  open: (name) =>
    caches.open(name).then((cache) => ({
      match: (key) => cache.match(key),
      put: (key, response) => cache.put(key, response),
    })),
  keys: () => caches.keys(),
  delete: (name) => caches.delete(name),
};

self.addEventListener("install", (event) => {
  event.waitUntil(install(deps).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activate(deps).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request, deps));
});
