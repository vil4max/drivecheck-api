# Implementation plan: installable web app (slice 2)

Status: parked on 2026-10-20, no code. Base when resumed: the then-current `main`.

Feature: `002-installable-web-app` · Spec: `specs/002-installable-web-app/spec.md` (written this
session; new REQs `proposed`, approving this plan approves them and flips them to `approved`).

## Context

PD-108 option A: the slice 1 status page becomes an installable PWA on the same Worker, with region
choice (cookie, O2), auto-refresh only through `/v1/alerts` under the iOS refresh policy and the
Worker's 10 s floor, a manifest, a service worker with offline last-known status, and an install
affordance. The no-JS page stays complete. Owner answers of 2026-10-20: cookie (O2), `tsc` client
build with no new dependency (O3), manual browser smoke instead of Playwright (O4).

## Baseline

Commit `33e8069` (main). `npm run check` on the untouched tree: green — typecheck, Biome, Vitest,
trace "15 requirements, 15 approved, all approved cited". Log: `build/verify/baseline.log`.

## Approach

Keep the server the source of truth and share its pure modules with the browser. Split `page.ts`
into a pure `pageModel(view, lang)` (texts, phase, colour, nearby, meta) and the HTML renderer, so
server and client render the same wording. The client is a few small ES modules compiled by a second
`tsconfig` (DOM lib) to `public/app/`, the service worker by a third (WebWorker lib); Workers Static
Assets serve `public/`, Wrangler's `build.command` runs the build before `deploy`, `dev` and the
CI dry-run. All policy lives in DOM-free modules with injected clock, `fetch`, timers and caches,
so Vitest tests it in Node; `app.ts` and `sw.ts` are thin wiring, covered by type-check and the
manual smoke.

## Files and types

Changed:
- `src/feed.ts` — gains `Snapshot` (moved from `coordinator.ts`, re-exported there) and a
  `snapshotFromApi(body)` parser for the `/v1/alerts` mirror (rejects `apiVersion ≠ 1`).
- `src/coordinator.ts` — owns `ENDPOINT` (moved from `feed.ts`), so no Ubilling URL is in the
  client graph.
- Relative imports in the shared modules (`regions`, `i18n`, `status`, `feed`, `retryAfter`,
  `page`) take a `.ts` extension; main `tsconfig.json` adds `allowImportingTsExtensions` and
  excludes `src/client/app.ts` and `src/sw.ts`.
- `src/page.ts` — `pageModel()`; `renderPage` adds the region picker form (`POST /region`), install
  slot, manifest/icon/theme-color links, `<script type="module" src="/app/client/app.js">`, ids on
  live nodes, `aria-live="polite"` on the status, relative font sizes (`rem`, `-apple-system-body`
  under `@supports`), focus rings on every control.
- `src/i18n.ts` — strings: region label, choose, install button, Safari hints, offline line.
- `src/router.ts` — region order `?region=` › cookie › network › Kyiv (`regionCookie.ts`);
  `POST /region` sets the cookie and 303s to `/` (unknown id → 400, no cookie); new CSP
  (`script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self';
  form-action 'self'`); `vary: Accept-Language, Cookie`.
- `wrangler.jsonc` — `assets: { directory: "./public", html_handling: "none" }`,
  `build: { command: "npm run build" }`.
- `package.json` — `build` (both client `tsc -p`), `typecheck` runs all three projects.
- `.gitignore` — `build/`, `public/app/`. README — PWA section.
- `specs/001-.../spec.md` — one pointer line under REQ-REFRESH-003/005/006/010, REQ-REGION-001,
  REQ-SURF-005 and REQ-WEB-002 to the client parts in 002 (single definition kept in 001).

New:
- `src/regionCookie.ts` — `parseRegionCookie(header)`, `regionCookie(id)` (shared by router and
  client).
- `src/client/refresh.ts` — `RefreshLoop`: visibility, interval 60/30/300 s ±10 % jitter, 10 s
  floor from last success, one 2 s retry after a throw or 15 s timeout, `Retry-After` / backoff via
  `rateLimitDeadline` from `retryAfter.ts`, stale timer at `checkedAt + 120 s`, offline-marked
  answers count as failures. Injected `{now, setTimer, clearTimer, fetchAlerts, random,
  saveData, onSnapshot}`.
- `src/client/install.ts` — `installAffordance({standalone, promptAvailable, userAgent})` →
  `"button" | "safari-ios" | "safari-mac" | "none"`.
- `src/client/app.ts` — DOM wiring: apply `pageModel` to the nodes, picker (sets cookie, re-renders
  from held snapshot, no request), Refresh click → loop, `beforeinstallprompt`, SW registration.
- `src/sw.ts` + `src/swStrategy.ts` — strategy is pure (`handle(request, {fetch, cache, version})`):
  network-first for navigations and `/v1/alerts` keeping one entry each, offline header
  `x-drivecheck-offline: 1`, `offline.html` fallback, cache-first for versioned static files, old
  caches deleted on activate; `sw.ts` binds it to `self`.
- `public/manifest.webmanifest`, `public/icons/{icon-192,icon-512,apple-touch-icon-180}.png` (from
  the iOS `AppIcon.png` via `sips`), `public/offline.html` (en/uk/ru "Unavailable", palette, no
  JS), `public/_headers` (`/app/sw.js`: `Service-Worker-Allowed: /`, `Cache-Control: no-cache`).
- `tsconfig.client.json`, `tsconfig.sw.json` (emit to `public/app/`, `rewriteRelativeImportExtensions`).
- `tests/refresh.test.ts`, `tests/swStrategy.test.ts`, `tests/manifest.test.ts`,
  `tests/install.test.ts`, `tests/page.test.ts` (or extend `router.test.ts`), `tests/clientGraph.test.ts`.

## Tests

| REQ | Test | Discriminating cases |
|---|---|---|
| REQ-REFRESH-001 | `refresh.test.ts` "fetches only while visible" | hidden for 10 min → 0 requests; visible again 11 s after last success → 1 request at once; page open → no request until the first interval |
| REQ-REFRESH-002 | "interval by phase, data saver and jitter" | quiet + random 0/1 → 54 s/66 s; alarm → 27–33 s; saveData + alarm → 300 s ±10 %; phase flips after an answer → next delay follows the new phase |
| REQ-REFRESH-003 | "one retry after 2 s" | throw → retry at +2 s → success; second throw → no third request; 15 s abort counts as throw; HTTP 500 → no retry |
| REQ-REFRESH-005 | "Retry-After and backoff hold every trigger" | 503 `Retry-After: 45` → no request at +30 s (poll due) nor on Refresh, request after +45 s; no header → 30 s then 60 s; `Retry-After: 99999` → capped 5 min |
| REQ-REFRESH-006 | "stale at checkedAt + 120 s without a request"; page model test | stale flag flips at exactly +120 001 ms with no fetch; failure after a held alarm keeps "Air Raid Alert" (never "Unavailable"); offline-marked answer → failure, held phase kept |
| REQ-REFRESH-010 | "floor 10 s from last success" | Refresh at +5 s → 0 requests, re-render; at +10 001 ms → 1; retry at +2 s after a failure is sent despite the floor |
| REQ-REGION-001, REQ-SURF-005 | client model test from an API body | region key missing → "Region Unavailable"; Kyiv Oblast + Chernihiv in alarm, Kyiv city quiet → "No Alert" + "Nearby: Kyiv Oblast, Chernihiv Oblast" |
| REQ-WEB-004 | `router.test.ts` | cookie `region=lviv` + network `30` → Lviv; `?region=odesa` + cookie lviv → Odesa and no `set-cookie`; cookie `region=../x` → network region; `POST /region` `region=lviv` → 303 `/` with `Set-Cookie: region=lviv; Path=/; Max-Age=31536000; SameSite=Lax; Secure`; unknown id → 400 without cookie |
| REQ-WEB-005 | `page.test.ts` | rendered page contains picker form with all 25 regions and the current one `selected`, refresh link, nearby text — all present with the script removed; `pageModel` strings equal `renderPage` strings for en/uk/ru; exactly one `h1` |
| REQ-WEB-006 | `refresh.test.ts` + `clientGraph.test.ts` + router CSP | every client request URL is `/v1/alerts`; no file in the client import graph contains `ubilling.net.ua` or an `http(s)://` origin; CSP has `connect-src 'self'` and no `*` |
| REQ-WEB-007 | `manifest.test.ts` | fields as spec; icon files exist and PNG IHDR width/height = 192, 512, 180; page links manifest and apple-touch-icon |
| REQ-WEB-008 | `swStrategy.test.ts` (fake cache + fetch) | online `/` → network answer, cache holds exactly 1 page entry after two loads; offline `/` → cached page with offline header; offline, nothing cached → `offline.html`; `/v1/alerts` 503 → not cached, previous kept; POST `/region` → passthrough, never cached; activate deletes `static-v1` when version is v2 |
| REQ-WEB-009 | `install.test.ts` | prompt available → button; standalone → none even with prompt; iPhone Safari UA → safari-ios; macOS Safari → safari-mac; Chrome on iOS (CriOS) / Edge without prompt → none |
| REQ-WEB-010 | `page.test.ts` + existing contrast test | no `px` font sizes in CSS; `@supports (font:-apple-system-body)` present; every interactive element has `:focus-visible`; `aria-live="polite"` only on the status node, not on the time line; new colours ≥ 4.5:1 on `#0C0E11` |

## Risks

- Races: a Refresh while a request is in flight joins it (single flight in the loop); a region
  change re-renders from the held snapshot and never fetches; a slow answer that arrives after the
  page was hidden still renders but schedules nothing.
- Timers and lifecycle: the loop clears its timer on hide and on every reschedule, so a hidden page
  cannot leak a poll; tests assert the count of pending timers.
- Service worker: a stale `sw.js` would pin old assets — `Cache-Control: no-cache` on it, and the
  static cache name carries the `package.json` version (bumped to 0.2.0). Offline answers must be
  marked, or the loop would treat a cached answer as success and reset its floor.
- Cookie privacy: the router reads the cookie for this response only; tests assert `log` is never
  called with it (REQ-API-003 stays).
- Test host: Vitest runs in Node; `app.ts` and `sw.ts` touch `document`/`self` and are not imported
  by tests. Shared modules gain `.ts` import extensions — esbuild (Wrangler) and Vitest accept them;
  verified by `npm run bundle` in the gate.
- Localization: new strings in en/uk/ru. Safari localizes its menus, so the hint uses Apple's
  localized names in each language, checked against Apple's support pages during implementation.
- Wrangler `build.command` on `deploy --dry-run`: assumed to run; checked in Group 1 by running
  `npm run bundle` on a clean `public/app/`. If not, `bundle` script runs `npm run build` first.

## Tasks

## Group 1: build plumbing and shared modules (no behaviour change)
- [ ] T001 Move `Snapshot` to `feed.ts`, `ENDPOINT` to `coordinator.ts`; `.ts` import extensions;
  three tsconfigs; `build` script; `wrangler.jsonc` assets + build; `.gitignore`. Gate green with
  the existing 15 REQs. Files: `src/*.ts`, `tsconfig*.json`, `package.json`, `wrangler.jsonc`
- [ ] T002 Test: `clientGraph.test.ts` proves REQ-WEB-006 (no Ubilling or external origin in the
  client graph). Files: `tests/clientGraph.test.ts`

## Group 2: region choice
- [ ] T003 Test: router tests prove REQ-WEB-004 (order, POST /region, invalid cookie, no set-cookie
  on `?region=`). Files: `tests/router.test.ts`
- [ ] T004 Implement `regionCookie.ts`, router order, `POST /region`, `vary`. Files: `src/regionCookie.ts`, `src/router.ts`

## Group 3: page model and enhanced page
- [ ] T005 Test: `page.test.ts` proves REQ-WEB-005, REQ-WEB-010, REQ-REFRESH-006 (stale text),
  REQ-REGION-001 and REQ-SURF-005 via `pageModel` from an API body; CSP part of REQ-WEB-006.
  Files: `tests/page.test.ts`, `tests/router.test.ts`
- [ ] T006 Implement `pageModel`, `snapshotFromApi`, new strings, picker, links, CSS, CSP. Files:
  `src/page.ts`, `src/feed.ts`, `src/i18n.ts`, `src/router.ts`

## Group 4: refresh loop
- [ ] T007 Test: `refresh.test.ts` proves REQ-REFRESH-001, -002, -003, -005, -006, -010 and the
  request-URL part of REQ-WEB-006, one injected clock per sequence. Files: `tests/refresh.test.ts`
- [ ] T008 Implement `RefreshLoop`. Files: `src/client/refresh.ts`

## Group 5: manifest, icons, service worker
- [ ] T009 Test: `manifest.test.ts` proves REQ-WEB-007; `swStrategy.test.ts` proves REQ-WEB-008.
  Files: `tests/manifest.test.ts`, `tests/swStrategy.test.ts`
- [ ] T010 Implement manifest, icons (`sips`), `offline.html`, `_headers`, `swStrategy.ts`, `sw.ts`.
  Files: `public/**`, `src/swStrategy.ts`, `src/sw.ts`

## Group 6: install affordance and wiring
- [ ] T011 Test: `install.test.ts` proves REQ-WEB-009. Files: `tests/install.test.ts`
- [ ] T012 Implement `install.ts` and `app.ts` (DOM wiring, picker, Refresh, SW registration).
  Files: `src/client/install.ts`, `src/client/app.ts`

## Group 7: docs, trace, smoke
- [ ] T013 Flip 002 REQs to approved (owner approval of this plan); pointers in 001; README PWA
  section; `plan.md`/`tasks.md` in `specs/002-...`. Gate: `npm run check` + `npm run bundle`.
- [ ] T014 Manual smoke on `wrangler dev` in the built-in browser: manifest detected, SW active,
  install offered (Chrome engine), status updates without reload, region pick persists across
  reload, JS disabled page complete, offline reload shows last known. Evidence (screenshots +
  notes) into the PR review packet; nothing calls Ubilling more than the coordinator allows
  (`wrangler dev` uses the real upstream through the coordinator only).
- [ ] T015 Independent review (`spec-driven-dev:code-reviewer`), repairs, PR with review packet;
  status line to ★ orch · Lead. No deploy without the owner's yes.

## Review lows
(filled by implement)

## Verification

`npm run check` (typecheck ×3, Biome, Vitest, trace with the 002 REQs approved) and
`npm run bundle` (build + Wrangler dry run) green; the manual smoke of T014 recorded; CI Gate green
on the PR.
