# Implementation plan: installable web app in the iOS design (slice 2, revised)


Base: 27a8781d86ac8168c27c9fae711fdca331a9aa67
Feature: `002-installable-web-app` · Spec: `specs/002-installable-web-app/spec.md` (revised
2026-10-20; approving this plan approves its `proposed` requirements). Branch
`feat/002-installable-web-app`.

## Context

Slice 1 is a correct but sketch-like page. The owner resumed slice 2 (O5) and asked that the web
follow the iOS Status tab, with the alert map, "one look everywhere"; the page is the project's
public showcase, so visual quality, responsiveness, accessibility and a measured first paint are
acceptance criteria. Decided on 2026-10-20: cookie for the region (O2), `tsc` client build without
new dependencies (O3), manual browser smoke (O4), dark only (O6), "Stay Alert" in scope (O7),
Status + Regions pages, no Details, no crown (O8). Kept from the first plan: PWA (manifest, service
worker, offline, install affordance) and auto-refresh only through `/v1/alerts`.

Reference: the shipping iOS screen (`regional-check/.artifacts/iphone-duo-toolbars/13-iphone17-*`)
and its tokens (`Theme+Redesign.swift`, `DriveCheckColors.swift`, `StatusHeroGraphic.swift`,
`MapCardView.swift`, `RegionListView.swift`); the 2026-09-17 mockups are older and not the reference.

## Baseline

`main` at `33e8069`: `npm run check` green, trace "15 requirements, 15 approved, all approved
cited". Branch commits so far are docs only (`2ecc408`, `e143731`, plus the spec revision).

## Approach

The server stays the source of truth and renders complete HTML for both pages; the browser only
enhances. Pure modules shared by Worker and client: `regions`, `status` (now with the caution
phase), `i18n`, `feed`, `retryAfter`, and a new `view.ts` that turns a status view into the page
model (title, accent, glyph, meta, nearby text, map caption and label). Two renderers use that model:
`page.ts` (Status) and `regionsPage.ts` (Regions), sharing one stylesheet built from the iOS tokens
(`theme.ts`). The coordinator gains the map request behind the same single upstream slot and 429
window. The client (`tsc` → `public/app/`) runs the refresh loop and patches the Status DOM from the
same model; the service worker gives offline. Everything with logic is DOM-free and tested in
Vitest; `app.ts` and `sw.ts` are thin bindings, checked by type-check and the browser smoke.

## Files and types

Changed:
- `src/status.ts` — `Phase` gains `caution`; `isSurrounded()` per REQ-SURF-010 (Kyiv city rule,
  half of neighbours, more than half of the country); stale never caution.
- `src/coordinator.ts` — owns `ENDPOINT` and `MAP_ENDPOINT` (`?map=nightmode`); `currentMap()`:
  one upstream slot shared with the JSON attempt, 60 s map floor, shared 429 window, one stored
  image `{bytes, contentType, fetchedAt, lastAttemptAt}` in a `MapStore`; `CoordinatorView` gains
  `mapFetchedAt`. `Snapshot` moves to `feed.ts` (re-exported).
- `src/worker.ts` — `currentMap()` RPC; map stored under its own key (memory-only fallback on a
  storage error).
- `src/router.ts` — `GET /v1/map` (image, `max-age=60`, 503 without one), `GET /regions`,
  `POST /region` (cookie + 303 to `/`), region order `?region=` › cookie › network › Kyiv, CSP
  (`script-src 'self'; connect-src 'self'; img-src 'self'; worker-src 'self'; manifest-src 'self';
  form-action 'self'`), `vary: Accept-Language, Cookie`.
- `src/page.ts` — Status renderer in the iOS layout; the existing palette and contrast helpers move
  to `theme.ts`.
- `src/i18n.ts` — strings from the iOS String Catalog (keys in the spec's brief): Stay Alert,
  "Last known: %@ · %@", nearby "+N", map caption, minutes/hours ago, map labels, map error,
  Regions title, Current region, Alert Active · N, Other regions, install button, Safari hints.
- `src/api.ts` unchanged except imports; `wrangler.jsonc` (assets, build), `package.json` (build,
  three typechecks, version 0.2.0), `.gitignore` (`build/`, `public/app/`), README.

New:
- `src/theme.ts` — iOS tokens (colours, surfaces, radii, spacing, type scale in rem) and the CSS.
- `src/glyphs.ts` — inline SVG glyphs: checkmark, exclamation, warning triangle, clock, question,
  location arrow, refresh, chevron.
- `src/hero.ts` — hero SVG: 60 ticks on r 74, disc 108, glow, sweep (CSS rotation 4 s, static 45°
  under `prefers-reduced-motion`).
- `src/view.ts` — `statusModel(view, lang, now, map)` and `regionsModel(snapshot, region, lang)`.
- `src/regionsPage.ts`, `src/regionCookie.ts`.
- `src/client/refresh.ts` (RefreshLoop as in the first plan), `src/client/install.ts`,
  `src/client/app.ts`, `src/swStrategy.ts`, `src/sw.ts`.
- `public/manifest.webmanifest`, `public/icons/*` (from the iOS AppIcon via `sips`),
  `public/offline.html`, `public/_headers`; `tsconfig.client.json`, `tsconfig.sw.json`.
- `docs/screenshots/` — phone (375 px) and desktop (1440 px) Status and Regions, alarm and quiet,
  referenced from the PR.

Existing tests whose expectations change because the spec changes them (named in the report):
`tests/router.test.ts` stale wording ("Last known: … · HH:mm" replaces "Last known · Updated") and
the nearby line (two names then "+N"); `tests/status.test.ts` if it asserts the old phases.

## Tests

| REQ | Test | Discriminating cases |
|---|---|---|
| REQ-SURF-010 | `status.test.ts` | Kyiv city quiet + Kyiv Oblast alarm → caution; Kyiv Oblast quiet + Kyiv city alarm → not caution; Volyn (2 neighbours) with Rivne alarm → caution (1×2 ≥ 2); Dnipropetrovsk (7) with 3 → quiet, with 4 → caution; 13 of 25 alarm, own neighbour 1 → caution, 12 → quiet unless half; stale → never caution; region itself alarm → alarm |
| REQ-WEB-011 | `page.test.ts` | per phase: title, accent hex and glyph id (alarm red !, quiet green ✓, caution yellow ▲, stale grey clock, stale alarm stays red); meta "Updated 14:09" vs "Last known: No Alert · 14:09"; nearby "Nearby: A, B +3"; hero has 60 ticks; reduced-motion rule present; only one `h1` |
| REQ-WEB-012 | `coordinator.test.ts`, `router.test.ts`, `page.test.ts` | first `/v1/map` → one upstream map request with `?map=nightmode`; second within 60 s → 0; at +60 001 ms → 1; JSON attempt in flight → map request waits/doesn't start (never two at once); map 429 `Retry-After: 30` → JSON request also held 30 s; failure → old image kept and served; no image → 503; caption "4 of 25 regions under alert · 2 min ago" from map time not status time; label lists the alarm regions |
| REQ-WEB-013 | `regionsPage.test.ts` | 3 alarms → "Alert Active · 3" group first, 22 others; no alarms → no alert group; current region card with pill; every row is a `POST /region` button with its id |
| REQ-WEB-004 | `router.test.ts` | cookie lviv + network 30 → Lviv; `?region=odesa` + cookie → Odesa, no `set-cookie`; bad cookie → network; `POST /region` lviv → 303 `/` + `Set-Cookie: region=lviv; Path=/; Max-Age=31536000; SameSite=Lax; Secure`; unknown → 400, no cookie; log never receives the cookie |
| REQ-WEB-005 | `page.test.ts` | page without its script still has status, time, nearby, map img, Regions link, refresh link; `statusModel` text equals rendered text in en/uk/ru |
| REQ-WEB-006 | `clientGraph.test.ts`, refresh test, router CSP | no `ubilling.net.ua` or external origin in the client graph; every loop request is `/v1/alerts`; CSP has no external source |
| REQ-WEB-010, REQ-WEB-014 | `page.test.ts`, `theme.test.ts` | no `px` font sizes; `-apple-system-body` under `@supports`; `:focus-visible` on every control; `aria-live` only on the status; every text/background pair in the token table ≥ 4.5 (3 for ≥ 24 px text); container `max-width` and no fixed widths over 320 px |
| REQ-REFRESH-001/002/003/005/006/010 | `refresh.test.ts` | as in the first plan: hidden → 0 requests; 54/66 s quiet, 27–33 s alarm, 300 s data saver; retry once at +2 s; 503 `Retry-After: 45` holds polls and Refresh; stale flips at +120 001 ms without a request; floor 10 s from last success, retry not floored |
| REQ-REGION-001, REQ-SURF-005 | `page.test.ts` from an API body | missing key → "Region Unavailable"; neighbours in alarm → nearby card, none → no card |
| REQ-WEB-007 | `manifest.test.ts` | fields; PNG IHDR 192/512/180; page links |
| REQ-WEB-008 | `swStrategy.test.ts` | one entry per kind after repeated loads; offline → cached + offline header; nothing cached → offline page; 503 not cached; POST passthrough; old static cache deleted |
| REQ-WEB-009 | `install.test.ts` | prompt → button; standalone → none; iOS Safari → hint; macOS Safari → hint; CriOS → none |

REQ-WEB-014's performance part (LCP < 2.5 s, FCP < 1.8 s) and the visual parity are proven by the
browser evidence below, not by Vitest.

## Risks

- Upstream politeness: the map adds a second request kind to the same host; one slot plus a 60 s
  map floor keeps the worst case at 2 requests per 10 s, far below 2 per second. A map 429 opens the
  shared window, so JSON freshness can suffer: logged, and REQ-REFRESH-006 marks staleness honestly.
- Storage: the raster size is unknown until fetched; if it exceeds the Durable Object value limit,
  the memory-only fallback applies (tested with a failing store).
- Visual parity without SF fonts and SF Symbols: `ui-rounded` is exact in Safari, system face
  elsewhere (D9); glyphs are drawn SVG. The owner judges parity from the screenshots.
- Animation cost: the sweep is one CSS transform on a composited layer; paused when the page is
  hidden by the browser; static under reduced motion.
- Races and lifecycle: as in the first plan (single flight, timer cleared on hide, offline answers
  counted as failures).
- Existing tests change where the spec changes wording (listed above); no other existing test is
  edited.
- Wrangler `build.command` on the dry run: checked in Group 1; fallback `bundle` runs `build` first.
- Localization: all new strings from the iOS String Catalog in en/uk/ru; Safari menu names from
  Apple's localized UI.

## Tasks

## Group 1: build plumbing (no behaviour change)
- [x] T001 Move `Snapshot`/`ENDPOINT`; `.ts` imports; three tsconfigs; build; assets; `.gitignore`;
  gate green with 15 REQs. Files: `src/*.ts`, `tsconfig*.json`, `package.json`, `wrangler.jsonc`
- [x] T002 Test: `clientGraph.test.ts` proves REQ-WEB-006 (graph part).

## Group 2: status rules
- [x] T003 Test: `status.test.ts` proves REQ-SURF-010.
- [x] T004 Implement caution phase and `isSurrounded`. Files: `src/status.ts`

## Group 3: map through the coordinator
- [ ] T005 Test: coordinator and router tests prove REQ-WEB-012 (server part).
- [ ] T006 Implement `currentMap`, `MapStore`, `/v1/map`, worker binding. Files:
  `src/coordinator.ts`, `src/worker.ts`, `src/router.ts`

## Group 4: region choice and Regions page
- [ ] T007 Test: router and `regionsPage.test.ts` prove REQ-WEB-004 and REQ-WEB-013.
- [ ] T008 Implement `regionCookie.ts`, `regionsPage.ts`, routes. Files: `src/regionCookie.ts`,
  `src/regionsPage.ts`, `src/router.ts`

## Group 5: iOS design for Status
- [ ] T009 Test: `page.test.ts`, `theme.test.ts` prove REQ-WEB-011, REQ-WEB-005, REQ-WEB-010,
  REQ-WEB-014 (static part), REQ-REGION-001, REQ-SURF-005, map card part of REQ-WEB-012, CSP.
- [ ] T010 Implement `theme.ts`, `glyphs.ts`, `hero.ts`, `view.ts`, `page.ts`, strings. Files:
  `src/theme.ts`, `src/glyphs.ts`, `src/hero.ts`, `src/view.ts`, `src/page.ts`, `src/i18n.ts`

## Group 6: refresh loop
- [ ] T011 Test: `refresh.test.ts` proves REQ-REFRESH-001/002/003/005/006/010, REQ-WEB-006 (requests).
- [ ] T012 Implement `src/client/refresh.ts`.

## Group 7: manifest, icons, service worker
- [ ] T013 Test: `manifest.test.ts` (REQ-WEB-007), `swStrategy.test.ts` (REQ-WEB-008).
- [ ] T014 Implement `public/**`, `src/swStrategy.ts`, `src/sw.ts`.

## Group 8: install affordance and client wiring
- [ ] T015 Test: `install.test.ts` proves REQ-WEB-009.
- [ ] T016 Implement `src/client/install.ts`, `src/client/app.ts` (patches Status from `view.ts`,
  SW registration, install button, Refresh without reload).

## Group 9: evidence, docs, review, PR
- [ ] T017 Flip 002 REQs to approved; pointers in spec 001; README; gate `npm run check` and
  `npm run bundle`.
- [ ] T018 Browser evidence on `wrangler dev` (local Worker; the real provider only through the
  coordinator): screenshots phone 375 px and desktop 1440 px, Status alarm/quiet/caution/stale and
  Regions, beside the iOS reference; no-JS check; keyboard pass; SW active, install offered,
  offline reload; FCP/LCP from `PerformanceObserver` on a cold load (local now, deployed after the
  owner's deploy yes). Saved in `build/review/runtime/`, committed shots in `docs/screenshots/`.
- [ ] T019 `spec-driven-dev:code-reviewer`, repairs (at most two rounds), PR with the review packet
  and screenshots; one-line status to ★ orch · Lead. No deploy without the owner's yes.

## Review lows
(filled by implement)

## Verification

`npm run check` (three typechecks, Biome, Vitest, trace with every 002 REQ approved and cited) and
`npm run bundle` green; T018 evidence recorded, side by side with the iOS reference; CI Gate green
on the PR; the deployed FCP/LCP measured after the owner approves the deploy.
