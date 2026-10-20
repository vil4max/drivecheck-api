import type { Snapshot } from "../feed.ts";
import { glyph } from "../glyphs.ts";
import { heroGraphic } from "../hero.ts";
import { DEFAULT_REGION, type Lang, regionById } from "../regions.ts";
import { type SwDeps, seedPage, seedStatic } from "../swStrategy.ts";
import { VERSION } from "../version.ts";
import { mapBehind, type StatusModel, statusModel, swapMap } from "../view.ts";
import { installAffordance } from "./install.ts";
import { RefreshLoop } from "./refresh.ts";

// The browser binding of the pure modules: it patches the server-rendered page and never
// replaces it, so the page stays complete without this script (REQ-WEB-005).

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const byId = (id: string) => document.getElementById(id);

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // The worker cannot see the load that registers it, so that page is saved here, as the
  // server sent it, unless it shows someone else's region from a shared link.
  const firstVisit = navigator.serviceWorker.controller === null;
  const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
  // tsc emits ES modules, so the worker is a module worker (Chrome, Edge, Safari 16+).
  navigator.serviceWorker
    .register("/app/sw.js", { scope: "/", type: "module" })
    .then(async () => {
      if (!firstVisit) return;
      const deps: SwDeps = {
        origin: location.origin,
        version: VERSION,
        now: () => Date.now(),
        fetch: (request) => fetch(request),
        open: (name) => caches.open(name),
        keys: () => caches.keys(),
        delete: (name) => caches.delete(name),
      };
      const loaded = performance.getEntriesByType("resource").map((entry) => entry.name);
      await seedStatic(deps, loaded);
      // A page rendered without data ("Unavailable") must not replace a saved status.
      const state = byId("main")?.dataset.state;
      const empty = state !== undefined && JSON.parse(state).snapshot === null;
      if (empty || new URLSearchParams(location.search).has("region")) return;
      await seedPage(deps, location.pathname, html);
    })
    .catch(() => {
      // Offline support is an enhancement; the page works without it.
    });
}

function setUpInstall(): void {
  const button = byId("install");
  const hint = byId("install-hint");
  if (button === null || hint === null) return;
  let deferred: InstallPromptEvent | null = null;
  const standalone = () =>
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const update = () => {
    const kind = installAffordance({
      standalone: standalone(),
      promptAvailable: deferred !== null,
      userAgent: navigator.userAgent,
    });
    button.classList.toggle("is-shown", kind === "button");
    hint.textContent =
      kind === "safari-ios"
        ? (hint.dataset.ios ?? "")
        : kind === "safari-mac"
          ? (hint.dataset.mac ?? "")
          : "";
    hint.classList.toggle("is-shown", hint.textContent !== "");
  };
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    update();
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    update();
  });
  button.addEventListener("click", () => {
    void deferred?.prompt();
    deferred = null;
    update();
  });
  update();
}

function setUpMap(): void {
  const card = byId("map");
  if (card === null) return;
  // The map is a CSS background, which draws nothing when it fails; this probe (the same cached
  // request) tells the card to say so, as the iOS card does.
  const probe = new Image();
  probe.addEventListener("error", () => card.classList.add("is-failed"));
  probe.src = "/v1/map";
}

function patch(model: StatusModel, last: { model: StatusModel | null }): void {
  document.title = model.documentTitle;
  document.body.className = `accent-${model.accent}`;
  const status = byId("status");
  // Changing the live region's text only on a new status announces it once (REQ-WEB-010).
  if (status !== null && status.textContent !== model.title) status.textContent = model.title;
  const meta = byId("meta");
  if (meta !== null) meta.textContent = model.meta;
  if (last.model?.symbol !== model.symbol) {
    const radar = document.querySelector(".radar");
    if (radar !== null) radar.outerHTML = heroGraphic(model.symbol);
  }
  let nearby = byId("nearby");
  if (model.nearby === null) {
    nearby?.remove();
  } else {
    if (nearby === null) {
      nearby = document.createElement("p");
      nearby.className = "card nearby";
      nearby.id = "nearby";
      nearby.innerHTML = `${glyph("triangle")}<span></span>`;
      byId("hero")?.after(nearby);
    }
    const text = nearby.querySelector("span");
    if (text !== null) text.textContent = model.nearby;
  }
  const caption = byId("map-caption");
  if (caption !== null && model.mapCaption !== null) caption.textContent = model.mapCaption;
  const card = byId("map");
  card?.setAttribute("aria-label", model.mapLabel);
  last.model = model;
}

function setUpStatus(): void {
  const main = byId("main");
  const hero = byId("hero");
  const state = main?.dataset.state;
  if (hero === null || state === undefined) return;
  const parsed = JSON.parse(state) as { snapshot: Snapshot | null; mapFetchedAt: number | null };
  const region = regionById(hero.dataset.region ?? "") ?? DEFAULT_REGION;
  const lang = document.documentElement.lang as Lang;
  const last: { model: StatusModel | null } = { model: null };
  let checkingMap = false;
  const render = (snapshot: Snapshot | null) => {
    patch(statusModel(snapshot, region, lang, Date.now(), parsed.mapFetchedAt), last);
    // A page left open keeps its first map; once that trails the status by a minute, take the
    // Worker's newer one, so the map and the caption's count describe the same moment.
    if (checkingMap || !mapBehind(parsed.mapFetchedAt, snapshot)) return;
    checkingMap = true;
    fetch("/v1/map", { method: "HEAD" })
      .then((response) => {
        if (!response.ok) return;
        const header = response.headers.get("x-map-fetched-at");
        const swap = swapMap(snapshot, region, lang, Date.now(), header, parsed.mapFetchedAt);
        if (swap === null) return;
        parsed.mapFetchedAt = Number(header);
        const image = document.querySelector<HTMLElement>("#map .image");
        if (image !== null) image.style.backgroundImage = `url(${swap.imageUrl})`;
        byId("map")?.classList.remove("no-image", "is-failed");
        patch(swap.model, last);
      })
      .catch(() => {})
      .finally(() => {
        checkingMap = false;
      });
  };

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const loop = new RefreshLoop(
    {
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      fetch: (path, signal) => fetch(path, { signal, headers: { accept: "application/json" } }),
      timeoutSignal: (ms) => AbortSignal.timeout(ms),
      random: Math.random,
      saveData: () => connection?.saveData === true,
      inAlarm: (snapshot) => snapshot.feed.states[region.apiKey]?.alertnow === true,
      render,
    },
    { snapshot: parsed.snapshot, receivedAt: Date.now() },
  );
  // An offline copy of the page may be old: draw it against the current time at once.
  render(parsed.snapshot);
  loop.start(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", () =>
    loop.setVisible(document.visibilityState === "visible"),
  );
  byId("refresh")?.addEventListener("click", (event) => {
    event.preventDefault();
    void loop.refresh();
  });
}

registerServiceWorker();
setUpInstall();
setUpMap();
setUpStatus();
