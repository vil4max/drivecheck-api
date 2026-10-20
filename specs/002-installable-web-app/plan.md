# Implementation plan: installable web app in the iOS design (slice 2)

Base: 58afa34 (the spec revision commit) · Feature: `002-installable-web-app` · Spec:
[spec.md](spec.md) · Branch `feat/002-installable-web-app`. Approving this plan approved the spec's
requirements; the implementation-time refinements are O9 in the spec.

## Context

Slice 1 is a correct but plain page. Slice 2 makes it an installable web app that follows the iOS
Status tab, with the alert map, one look on every surface (O5); the page is the project's public
showcase, so visual quality, responsiveness, accessibility and a measured first paint are
acceptance criteria. Decided: cookie for the region (O2), `tsc` client build without new
dependencies (O3), manual browser checks (O4), dark only (O6), "Stay Alert" in scope (O7), Status
and Regions pages, no Details, no crown (O8). Also in scope: manifest, service worker, offline,
install affordance, and auto-refresh only through `/v1/alerts`.

Reference: the shipping iOS screen (`regional-check/.artifacts/iphone-duo-toolbars/13-iphone17-*`)
and its tokens (`Theme+Redesign.swift`, `DriveCheckColors.swift`, `StatusHeroGraphic.swift`,
`MapCardView.swift`, `RegionListView.swift`); the 2026-09-17 mockups are older and not the
reference.

## Baseline

`main` at `33e8069`: `npm run check` green, trace "15 requirements, 15 approved, all approved
cited".

## Approach

The server stays the source of truth and renders complete HTML for every page; the browser only
enhances. Pure modules shared by Worker, client and service worker: `regions`, `status` (with the
`surrounded` flag), `i18n`, `feed`, `retryAfter`, and `view.ts`, which turns a status view into the
page model (title, accent, glyph, meta, nearby text, map caption and label). The renderers use that
model: `page.ts` (Status and the offline page) and `regionsPage.ts` (Regions), sharing one
stylesheet built from the iOS tokens (`theme.ts`). The coordinator owns the map request behind the
same single upstream slot and 429 window. The client (`tsc` → `public/app/`) runs the refresh loop
and patches the Status DOM from the same model; the service worker gives offline and draws a saved
page again for the current time (`savedPage.ts`). Everything with logic is DOM-free and tested in
Vitest; `app.ts` and `sw.ts` are thin bindings, checked by type-check and the browser checks.

## Files and types

Changed:
- `src/status.ts`: `StatusView` gains `surrounded` (quiet, fresh, and `isSurrounded()` per
  REQ-SURF-010); `view.ts` maps it to the `caution` accent. `Phase` is unchanged.
- `src/coordinator.ts`: owns `ENDPOINT` and `MAP_ENDPOINT` (`?map=nightmode`); `currentMap()`
  queues one map attempt behind the shared upstream slot (60 s map floor, 3 s after a JSON request,
  JSON keeps 1 s clear, shared 429 window); one stored image `{bytes, contentType, fetchedAt}` with
  `lastAttemptAt` in a `MapStore`; `CoordinatorView` gains `mapFetchedAt`. `Snapshot` moves to
  `feed.ts` (re-exported), with `snapshotFromApi` for the client.
- `src/worker.ts`: `currentMap()` RPC; the map stored under its own key (memory-only fallback on a
  storage error).
- `src/router.ts`: `GET`/`HEAD /v1/map` (image, `x-map-fetched-at`, `max-age=60`, 503 without one),
  `GET /regions`, `GET /offline` (no coordinator call), `POST /region` (cookie, 303 to `/?lang=`,
  403 cross-site), region order `?region=` › cookie › network › Kyiv, links keep `?region=`, the CSP
  from `src/csp.ts`, `vary: Accept-Language, Cookie`.
- `src/page.ts`: Status and offline renderers in the iOS layout; palette and contrast helpers live
  in `theme.ts` (re-exported).
- `src/i18n.ts`: strings from the iOS String Catalog: Stay Alert, "Last known: %@ · %@", retry
  hints, nearby "+N", map caption, minutes/hours ago, map labels, map error, Regions title, Current
  region, Alert Active · N, Other regions, install button, Safari hints, offline note.
- `wrangler.jsonc` (assets, build), `package.json` (build with the asset list, three typechecks,
  version 0.2.0), `.gitignore` (`build/`, `public/app/`), README.

New:
- `src/theme.ts` (iOS tokens and the CSS), `src/glyphs.ts` (checkmark, exclamation, warning
  triangle, clock, question, location, refresh, back, chevron, offline), `src/hero.ts` (60 ticks on
  r 74, disc 108, glow, sweep turning clockwise in 4 s, static at 45° under reduced motion),
  `src/view.ts` (`statusModel`, `regionsModel`, `mapBehind`), `src/regionsPage.ts`,
  `src/regionCookie.ts`, `src/csp.ts` (the pages' CSP, shared with the saved page),
  `src/version.ts` (cache version, equal to `package.json`), `src/savedPage.ts`.
- `src/client/refresh.ts` (`RefreshLoop`: visibility, interval, retry, hold, stale timer, floor,
  first ask after a stale open), `src/client/install.ts`, `src/client/app.ts`,
  `src/swStrategy.ts`, `src/sw.ts`.
- `public/manifest.webmanifest`, `public/icons/*` (from the iOS AppIcon via `sips`),
  `public/_headers`; `scripts/app-assets.mjs` (writes `public/app/assets.json`);
  `tsconfig.client.json`, `tsconfig.sw.json`; `tests/node.d.ts`.
- `docs/screenshots/`: phone (375 px) Status alarm after idle, Stay Alert (en, uk), quiet, stale,
  Regions and offline (uk); desktop (1440 px) Status alarm and Regions (uk).

Existing test expectations changed because the spec changes them: in `tests/router.test.ts`, the
stale wording ("Last known: … · HH:mm" replaces "Last known · Updated"), the removed no-`<script>`
assertion (REQ-WEB-005 allows an external module script, never an inline one) and "Stay Alert" in
place of "No Alert" for Kyiv city with Kyiv Oblast in alarm (REQ-SURF-010). `tests/coordinator.test.ts`
changed its imports only; `tests/support.ts` gained map fakes.

## Tests

| REQ | Test | Discriminating cases |
|---|---|---|
| REQ-SURF-010 | `status.test.ts`, `page.test.ts` | Kyiv city quiet + Kyiv Oblast alarm → surrounded; the reverse → not; Volyn (2 neighbours) with Rivne → surrounded; Dnipropetrovsk (7) with 3 → no, with 4 → yes; 13 of 25 in alarm with one neighbour → yes, 12 → no; no alerting neighbour → no; stale → never; accent `#E8BA62` |
| REQ-WEB-011 | `page.test.ts` | title, accent and glyph per status (stale alarm stays red); meta lines; "A, B +N"; 60 ticks; reduced motion; clockwise sweep; one `h1`; accent hex values |
| REQ-WEB-012 | `map.test.ts`, `page.test.ts` | night-map URL; 60 s floor; never two upstream requests at once; queued behind a page load's JSON attempt and sent 3 s after it; JSON 1 s after a map; a map 429 holds JSON; failures keep the image; 503 without one; `x-map-fetched-at`; `mapBehind`; caption ages from the map; no-JS failure text |
| REQ-WEB-013 | `page.test.ts` | "Alert Active · 3" first, 22 others; no alert group without alerts; current card with pill; 25 `POST /region` buttons; `lang` input |
| REQ-WEB-004 | `router.test.ts`, `regionCookie.test.ts`, `page.test.ts` | order `?region=` › cookie › network › Kyiv; `?region=` sets no cookie and stays in links; bad cookie ignored; POST → 303 `/?lang=` with the cookie; unknown → 400; cross-site → 403, own form with `Origin: null` → 303; the cookie never reaches a log |
| REQ-WEB-005 | `page.test.ts` | complete without its script; same words as the model in en/uk/ru; only an external module script |
| REQ-WEB-006 | `clientGraph.test.ts`, `refresh.test.ts`, `router.test.ts` | no external origin in the client or worker graph; loop asks only `/v1/alerts`; exact CSP |
| REQ-WEB-010, REQ-WEB-014 | `page.test.ts` | no `px` font sizes; `-apple-system-body`; focus rings, inset in Regions rows; one `aria-live`; AA contrast on background, surface and alert group; no hidden overflow; glow clipped at the hero; radar within the column; card wraps; max width |
| REQ-REFRESH-001/002/003/005/006/010 | `refresh.test.ts` | hidden → 0 requests; stale open → ask at the floor, also when opened hidden; 54/66 s quiet, 27–33 s alarm, 300 s data saver; one retry at +2 s; Retry-After and backoff hold polls and Refresh; stale redraw at +120 001 ms; offline-marked answer is a failure; 10 s floor |
| REQ-REGION-001, REQ-SURF-005 | `page.test.ts` | missing key → "Region Unavailable" with its hint; nearby card only with neighbours in alarm |
| REQ-WEB-007 | `manifest.test.ts` | fields; PNG IHDR 192/512/180; page links |
| REQ-WEB-008 | `swStrategy.test.ts`, `page.test.ts`, `router.test.ts` | one entry per kind; offline answer marked; offline page per language; 503 not cached; POST passthrough; old static cache deleted; first-visit page and modules saved; shared `?region=` page never saved; listed modules precached per version; saved page redrawn as "Last known" |
| REQ-WEB-009 | `install.test.ts` | prompt → button; standalone → none; iOS Safari and macOS Safari → hints; Chrome on iOS → none |

REQ-WEB-014's first-paint part (LCP < 2.5 s, FCP < 1.8 s on the deployed Worker) and the visual
parity are proven by browser evidence, not by Vitest.

## Risks

- Upstream politeness: the map adds a second request kind to the same host; one slot, a 60 s map
  floor and the 3 s / 1 s spacing keep the host far below 2 requests per second. A map 429 opens
  the shared window, so JSON freshness can suffer; REQ-REFRESH-006 marks staleness honestly.
- Durable Object load: every page, map request and client poll reaches the object; one
  always-open Status page is about 1,440 status and up to 1,440 map requests a day, so roughly 35
  always-open pages reach the free plan's 100,000 requests a day.
- Visual parity without SF fonts and SF Symbols: `ui-rounded` is exact in Safari, system face
  elsewhere (D9); glyphs are drawn SVG.
- Animation cost: one CSS transform; static under reduced motion.
- Localization: new strings from the iOS String Catalog in en/uk/ru.

## Tasks

## Group 1: build plumbing (no behaviour change)
- [x] T001 Move `Snapshot`/`ENDPOINT`; `.ts` imports; three tsconfigs; build; assets; `.gitignore`.
- [x] T002 Test: `clientGraph.test.ts` proves REQ-WEB-006 (graph part).

## Group 2: status rules
- [x] T003 Test: `status.test.ts` proves REQ-SURF-010.
- [x] T004 Implement `isSurrounded` and the `surrounded` flag. Files: `src/status.ts`

## Group 3: map through the coordinator
- [x] T005 Test: `map.test.ts` proves REQ-WEB-012 (server part).
- [x] T006 Implement `currentMap`, `MapStore`, `/v1/map`, worker binding.

## Group 4: region choice
- [x] T007 Test: router and cookie tests prove REQ-WEB-004.
- [x] T008 Implement `regionCookie.ts`, the region order and `POST /region`.

## Group 5: iOS design for Status and Regions
- [x] T009 Test: `page.test.ts` proves REQ-WEB-011, -005, -010, -013, -014 (static part),
  REQ-REGION-001, REQ-SURF-005 and the map card part of REQ-WEB-012.
- [x] T010 Implement `theme.ts`, `glyphs.ts`, `hero.ts`, `view.ts`, `page.ts`, `regionsPage.ts`,
  strings.

## Group 6: refresh loop
- [x] T011 Test: `refresh.test.ts` proves REQ-REFRESH-001/002/003/005/006/010 and REQ-WEB-006.
- [x] T012 Implement `src/client/refresh.ts`.

## Group 7: manifest, icons, service worker
- [x] T013 Test: `manifest.test.ts` (REQ-WEB-007), `swStrategy.test.ts` (REQ-WEB-008).
- [x] T014 Implement `public/**`, `src/swStrategy.ts`, `src/sw.ts`.

## Group 8: install affordance and client wiring
- [x] T015 Test: `install.test.ts` proves REQ-WEB-009.
- [x] T016 Implement `src/client/install.ts`, `src/client/app.ts`.

## Group 9: evidence, docs, review, PR
- [x] T017 Approve the requirements; pointers in spec 001; README; gate and bundle.
- [x] T018 Browser evidence on `wrangler dev`: screenshots, no-JS check, keyboard pass, reflow at
  320 px and 200 %, service worker, installability, offline reload, local first paint. The deployed
  first paint waits for the deploy.
- [x] T019 Independent review, repairs, PR with the review packet and screenshots. No deploy
  without the owner's yes.

## Review rounds

1. `spec-driven-dev:code-reviewer` on d2f4c9b: CHANGES (2 high, 6 medium); repaired in c412654.
2. `spec-driven-dev:code-reviewer` on the repair diff: CHANGES (2 high); repaired in the next
   commit, checked in Chrome.
3. The PR's independent review on a51e1ad: CHANGES (3 medium, lows); repaired on the branch
   (map queue, client precache and saved-page redraw, Regions focus and overflow), with this plan
   and the spec brought up to date.

## Review lows

Not fixed unless the owner asks:
- The 2 s retry timer is not tracked, so a page hidden within those 2 s still sends the retry
  (`src/client/refresh.ts`, `run`).
- The 3 s map gap counts from the JSON attempt's start, not from its 2 s retry.
- The map's `lastAttemptAt` is saved after the request, so a coordinator restarted mid-request
  loses the 60 s map floor; the failing map store has no test.
- iPadOS Safari reports a Macintosh user agent and gets the Mac "File → Add to Dock" hint.
- `/app/*` is cache-first keyed by `VERSION`; a deploy that changes the client without bumping
  `package.json` keeps installed users on the old script.
- A page loaded without data has no `#map-caption`, and the client never adds it later.
- On Regions, quiet and missing regions differ only by dot colour.
- The browser wiring of the first-visit seed has no unit test; it was checked by hand in Chrome.
- `.failed` sits under the map image on `no-image` pages; the night map is opaque, so a late image
  covers the text, but a transparent raster would show both.
- Group 1 and the "never logs the cookie" test have no behaviour red: both are guards written after
  the behaviour.

## Verification

`npm run check` (three typechecks, Biome, Vitest, trace with every slice 2 requirement approved and
cited) and `npm run bundle` green; browser evidence recorded beside the iOS reference; CI Gate
green on the PR; the deployed first paint measured after the owner approves the deploy.
