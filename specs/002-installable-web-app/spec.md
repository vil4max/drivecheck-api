# Feature specification: installable web app

Feature: `002-installable-web-app` · Created: 2026-10-20
Status: draft, resumed on 2026-10-20 by the owner (O5) with the iOS design and the alert map in
scope; waiting for the owner's approval of the revised plan. Requirements below are `proposed`
until then; shared requirements keep the status the owner gave them in `regional-check` or in
slice 1.
Input: the owner's decisions PD-107 (Drive Check is the multiplatform testbed of his agentic loops)
and PD-108, option A (an installable web app served by the same Worker), and his answers of
2026-10-20 (see "Owner decisions").

## Summary

The status page of slice 1 becomes an installable web app (PWA) served by the same Worker:

- the look of the iOS Status tab, which is the single reference: the radar hero, the status in the
  traffic-light colours including the yellow "Stay Alert", the nearby card and the inline alert map,
  served by the Worker; the page is the project's public showcase, so visual quality is an
  acceptance criterion, not later polish;
- a Regions page, opened from the map as in iOS, which lists every region's status and is where a
  visitor picks their region; the choice is kept in the visitor's browser;
- automatic refresh in the open page, only through `GET /v1/alerts`, following the apps' refresh
  policy and the Worker's 10 s floor;
- a web app manifest, icons and a service worker, so Chrome, Edge and Safari can install it, and the
  last known status opens offline;
- an install button where the browser offers one, and a short hint in Safari, which does not.

The server-rendered pages stay complete without JavaScript: status, update time, nearby alerts,
the map, the Regions page with its region choice, and the refresh link work with scripts off.
JavaScript only enhances them.

## Out of scope for slice 2

No alert history, accounts, ads or analytics, ever (core, "Never"). Not in this slice: push or
system notifications, background sync or periodic background refresh, the Chrome extension
(PD-108 "may follow later"), the device Geolocation API, the iOS Details tab, the Pro crown (the web
sells nothing), a light theme (O6: the apps are dark only, one look everywhere), switching the apps
to this API, and the deployment (the owner's yes).

## User scenarios and testing

### User story 1: a person keeps the page open (priority P1)

A person opens the page and leaves it open. The status changes without a reload when the alert
state changes, and the page never asks the Worker more often than the apps would.

Independent test: the refresh loop, given a fake clock, a fake `fetch` and a visibility signal,
makes requests only at the expected instants.

Acceptance scenarios:

1. Given the page is visible and its region is quiet, when 60 s ± 10 % pass, then it asks
   `/v1/alerts` once and updates the status, the time and the nearby line in place.
2. Given its region is in alarm, when the next poll is scheduled, then the interval is 30 s ± 10 %.
3. Given the page is hidden, when time passes, then it makes no request; when it becomes visible
   again more than 10 s after the last success, it asks at once.
4. Given the Worker answers 503 with `Retry-After: 45`, when polls fall due in the next 45 s, then
   none is sent.
5. Given the network fails, when the failure happens, then the page retries once after 2 s and keeps
   the status it shows.

### User story 2: a person picks a region (priority P1)

A person outside their network region, or whose network region is wrong, picks their region once
and sees it on every later visit.

Acceptance scenarios:

1. Given a person opens Regions from the map and picks Lviv Oblast, when the choice is made, then
   the Status page shows Lviv Oblast and the choice is remembered, with or without JavaScript.
2. Given the Regions page, when it renders, then the current region sits in its own card with a
   status pill, regions under alert are grouped first under "Alert Active · N", the rest under
   "Other regions", each row with its status dot, as in iOS.
3. Given a remembered choice, when the person opens `/` again, then the first response already
   shows that region; a link with `?region=` shows its region without changing the remembered one.

### User story 3: a person installs the app and opens it offline (priority P2)

A person installs the app from Chrome, Edge or Safari, then opens it on a train without signal.

Acceptance scenarios:

1. Given Chrome or Edge offers installation, when the page loads, then an "Install app" button
   appears; when it is installed or running as an app, the button is absent.
2. Given Safari, when the page loads outside an installed app, then a one-line hint names the
   browser's own menu path ("Share → Add to Home Screen", "File → Add to Dock").
3. Given the app was opened online before, when it opens offline, then it shows the last known
   status with its update time, marked as not current once older than 2 minutes, never a browser
   error page.
4. Given it was never opened online, when it opens offline, then it shows "Unavailable" in the
   three languages.

## Shared requirements

New in this repository; the text is the iOS one with the web's difference.

### REQ-REFRESH-001 — Fetch only for an active surface

Status: proposed (approved in iOS on 2026-09-17; applies here once slice 2 resumes)

Given the web app's page is visible\
When it opens, becomes visible again, or the person activates Refresh\
Then the client asks `/v1/alerts` at once (subject to REQ-REFRESH-010), and it sends no request
while the page is hidden

Difference from iOS: the active surface is a visible document (`document.visibilityState`), not
the Status tab or CarPlay. The first answer comes with the page itself, so opening the page does
not add a request; becoming visible again does.

### REQ-REFRESH-002 — Adaptive shared polling interval

Status: proposed (approved in iOS on 2026-09-17; applies here once slice 2 resumes)

Given the page is visible\
When the next poll is scheduled\
Then the base interval is 60 s, 30 s while the shown region is in alarm, 300 s when the browser
reports a data saver (`navigator.connection.saveData`, wins over alarm), with ±10 % jitter and one
timer per page

Difference from iOS: a browser exposes no Low Power Mode or thermal state; the data saver stands in
for the constrained path. Each page has its own timer; the Worker's floor (REQ-REFRESH-010) bounds
all pages together.

### Web client parts of requirements defined in slice 1

These IDs are defined in `specs/001-cached-api-and-status-page/spec.md`, which keeps their single
definition; slice 2 extends each to the browser client, and tests of the client cite the same ID.

- REQ-REFRESH-003 (one retry): a client request that throws or times out after 15 s is retried
  once after 2 s; an HTTP error answer is not retried.
- REQ-REFRESH-005 (rate limit): a `503` or `429` from the Worker with `Retry-After` holds every
  scheduled poll and Refresh until then (capped at 5 min); without the header the client backs off
  30 s → 60 s → … up to 5 min. The client reuses the Worker's parser.
- REQ-REFRESH-006 (stale): the client marks the shown status as not current when `now − checkedAt`
  exceeds 2 × 60 s, re-evaluated at that instant even when no request is due; a failed request or an
  offline answer never replaces a known phase with "Unavailable".
- REQ-REFRESH-010 (floor): the client sends no request within 10 s of its last successful answer,
  whatever triggered it (visibility, Refresh, a region change); inside the floor it re-renders the
  held data. The retry of REQ-REFRESH-003 is not floored.
- REQ-REGION-001 (catalog): the client shows "Region Unavailable" for a region the answer lacks.
- REQ-SURF-005 (nearby): the client updates the nearby line from the same neighbour table.

## New requirements

### REQ-WEB-004 — Region choice kept in the browser

Status: proposed

Given the Regions page renders\
When the person picks a region from its list\
Then the choice is saved in a first-party cookie `region` (the catalog id only, `Path=/`,
`SameSite=Lax`, `Secure`, one year), the page shows that region, and the region shown is chosen in
this order: `?region=`, the cookie, the network region (REQ-WEB-002), Kyiv city; an unknown cookie
value is ignored; the Worker neither stores nor logs the cookie

Reason: the owner chose the cookie on 2026-10-20 (O2): the first response already shows the chosen
region, with or without JavaScript. Difference from iOS: the apps have no manual region since 3.0
(REQ-REGION-003, retired); the web has no device location without a prompt, so PD-108 brings the
choice back for the web only. This supersedes the sentence "the page offers no region picker" in
REQ-WEB-002's reason.

### REQ-WEB-005 — JavaScript enhances, never gates

Status: proposed

Given the page is served\
When scripts are off, blocked or fail\
Then the server-rendered pages alone show the status, its time, nearby alerts, the map, the
Regions page and its region choice, the refresh link and the language links; with scripts on, the client renders the same strings, colours
and structure from the same modules as the server (REQ-SURF-001, one wording each), and the status
keeps being the text of the only `h1`

### REQ-WEB-006 — One data path for the client

Status: proposed

Given the client needs the status\
When it makes any request\
Then it asks only the same origin (`GET /v1/alerts`, the map `GET /v1/map`, its own static files),
never Ubilling or a third party, and the page's Content Security Policy allows scripts,
connections, images, fonts and the service worker from its own origin only

Reason: the Worker's coordinator is the only Ubilling client (REQ-PROVIDER-002); a browser asking
Ubilling directly would bypass the floor and the 429 window.

### REQ-WEB-007 — Installable manifest

Status: proposed

Given a browser checks whether the site is installable\
When it reads the page and `/manifest.webmanifest`\
Then the manifest has `id` and `start_url` `/`, `scope` `/`, `display: standalone`, name and short
name "Drive Check", background and theme colour `#0C0E11`, and PNG icons of 192 and 512 px; the page
links it and an `apple-touch-icon` of 180 px

### REQ-WEB-008 — Service worker and offline

Status: proposed

Given the service worker is installed\
When a page, `/v1/alerts` or `/v1/map` is requested\
Then it tries the network first and keeps only the latest successful answer of each (one Status
page, one Regions page, one alerts response, one map, overwritten); offline it serves those, marked as offline so the client counts them
as failures, and with no saved page an offline page that says "Unavailable" in en, uk and ru; the
app's own static files come from a versioned cache that a new version replaces

Reason: core "Never" forbids alert history; one overwritten entry is the same rule the coordinator
follows (REQ-API-003).

### REQ-WEB-009 — Install affordance

Status: proposed

Given the page is not running as an installed app\
When the browser offers installation (`beforeinstallprompt`, Chrome and Edge)\
Then an "Install app" button appears and opens the browser's prompt; in Safari, which has no such
event, a one-line hint names the menu path; when installed, both are absent

### REQ-WEB-010 — Scaling and keyboard

Status: proposed

Given a person who enlarges text or uses a keyboard\
When the page renders\
Then every font size is relative to the browser's text size (Safari's `-apple-system-body` where
available, the Dynamic Type equivalent), the layout reflows without horizontal scrolling at 200 %
and 320 px, every control is reachable by Tab with a visible focus ring, and a status change is
announced politely once, not on every refresh

### REQ-WEB-011 — The iOS Status design on the web

Status: proposed

Given the web page or the web app shows the status\
When it renders\
Then it follows the iOS phone Status tab as it ships (`regional-check` `StatusView`, its theme
tokens in `Theme+Redesign.swift` and `DriveCheckColors.swift`), top to bottom: a toolbar with the
centred title "Drive Check" and Refresh where iOS has the crown; the hero (radar ring of 60 ticks,
tinted disc, status glyph, a sweep turning once per 4 s and still under reduced motion, a glow in
the accent), the status title in the accent, the region with a location glyph, the meta line
("Updated HH:mm", or "Last known: {status} · HH:mm" when stale); the nearby card (warning glyph in
`#E8BA62`, at most two names then "+N"); the map card (REQ-WEB-012); then the informational note,
languages and API link in the footer. The palette, the translucent surfaces, radii (22 cards),
paddings (screen 20, cards 18/16) and the type scale (largeTitle 34 bold, title3 20 semibold,
body 17, subheadline 15 tabular, caption 12) are the iOS tokens, with the rounded system face; the
glyphs are SVG drawings in the spirit of the SF Symbols the app uses (SF Symbols themselves may not
ship on the web)

Reason: the owner, 2026-10-20, after seeing the slice 1 page: «нужна карта и брать за референс иос
дизайн - везде один вид»; and, relayed by the orchestrator, that the page must not stay poor-looking
(«нельзя оставлять ужасным»). The slice 1 page shares only the palette.

### REQ-WEB-012 — The alert map through the Worker

Status: proposed

Given a page shows the map card\
When the browser loads `GET /v1/map`\
Then the Worker answers with the latest held Ubilling `?map=nightmode` raster (1000 × 670); the
coordinator asks the provider for it only when a client asks and the held image is older than
60 s, never while a JSON request is in flight or a 429 window is open, never sooner than 3 s
after a JSON request (as iOS loads its map 3 s after the status; without an image it waits that
long), and a JSON request keeps 1 s clear of a map request; it keeps one overwritten
image, and answers 503 when it holds none; the card reserves the 1000 : 670 frame, shows the
caption "N of 25 regions under alert · N min ago" (age from the image's own fetch time) and an
accessible label naming the regions under alert, and its whole surface links to the Regions page;
without an image it shows "Couldn't load the map." and no earlier image

Reason: the iOS card fetches the same raster once per session (`MapImageSource`, `MapViewModel`);
one coordinator for both requests keeps the host below Ubilling's 2 requests per second and
honours its 429 for both (REQ-PROVIDER-002).

### REQ-WEB-013 — The Regions page

Status: proposed

Given a visitor opens Regions from the map card or the address `/regions`\
When it renders\
Then it follows the iOS region list: the title "Regions" with a way back to Status, the current
region in its own card with a location glyph and a status pill, the regions under alert grouped
first under "Alert Active · N" (shown only when there are any) and the rest under "Other regions",
each row a status dot and the name; every row is a control that makes that region the visitor's
region (REQ-WEB-004) and returns to Status, with and without JavaScript

Difference from iOS: the iOS list is read-only, because the app follows device location; on the
web the list is where the visitor picks the region (O8).

### REQ-WEB-014 — Responsive, fast, accessible showcase

Status: proposed

Given a visitor on a phone from 375 px wide up to a desktop\
When the Status or Regions page renders\
Then there is no horizontal scrolling, the content keeps the iOS single-column composition centred
with a maximum width on wide screens, every text colour reaches WCAG AA contrast (4.5 : 1, 3 : 1
for large text) on its own background, and a cold load of `/` on the deployed Worker reaches a
Largest Contentful Paint under 2.5 s and a First Contentful Paint under 1.8 s as measured in the
browser and stated in the PR, with phone and desktop screenshots

### REQ-SURF-010 — A yellow "stay alert" status when alerts surround a quiet region

Status: proposed (approved in iOS on 2026-09-17, amended 2026-09-23; applies here with O7)

Given the shown region is quiet on fresh data and at least one neighbouring region is under alert\
When half or more of its neighbours are under alert, or more than half of the country is, or, for
Kyiv city, Kyiv Oblast is\
Then the web Status hero shows "Stay Alert" in yellow `#E8BA62` with the warning glyph instead of
"No Alert", and the nearby card keeps naming the neighbours; stale data never turns yellow

Difference from iOS: none in the rule; the web reads it from the server's neighbour table, which is
the iOS `NearbyRegionPolicy` table (slice 1).

## Decisions, with reasons

### D5 — Client build: TypeScript compiled by `tsc`, served as static assets

Chosen (owner, 2026-10-20, O3): a second and third `tsconfig` compile the client and the service
worker to ES modules in `public/app/` with `rewriteRelativeImportExtensions`; Workers Static Assets
serve `public/`; Wrangler's `build.command` runs the build before `deploy`, `dev` and the dry-run
bundle. The client imports the server's pure modules (`regions`, `i18n`, `status`, `feed`,
`retryAfter`, the page model), so the wording and rules cannot drift. No new dependency.

Rejected: an esbuild bundle (a dependency change for one fewer request per load); a hand-written
JavaScript copy of the rules (drift).

### D6 — Region choice in a cookie

Chosen (owner, 2026-10-20, O2) over `localStorage`, which would show the network region first and
switch after the script runs, a wrong-region flash on a safety page, and would not work without
scripts. The cookie holds one catalog id, is read for the response only, and is set by the client
or, without scripts, by `POST /region` followed by a redirect to `/`.

### D7 — Verification in a browser: a recorded manual smoke

Chosen (owner, 2026-10-20, O4): Vitest covers every rule as pure logic (refresh loop, service worker
strategy with fake caches, manifest and icon sizes, page model, cookie, routing). Installability,
service worker registration and an offline reload are checked once by hand in the built-in browser
on `wrangler dev`, and the evidence goes into the PR's review packet. No Playwright.

### D8 — Icons from the iOS app icon

The icons are the iOS `AppIcon.png` (1024 px, `regional-check`, already public in the App Store),
scaled with macOS `sips` to 512, 192 and 180 px and committed; nothing generates them in CI.

### D9 — The rounded system face, no web font

The type uses `ui-rounded` (SF Pro Rounded in Safari, as in the app), then `system-ui`. A
self-hosted rounded web font would match Chrome on every platform more closely, but adds a
download to the first paint (REQ-WEB-014) and a binary of another origin's licence to the
repository; the owner may still ask for one when approving the plan.

### D10 — The map raster in the Durable Object

The coordinator that already owns the JSON request owns the map request too, so one place
serialises every request to the host and one 429 window covers both. The image is kept in the
object's storage as one overwritten value with its fetch time, so a restarted object serves it at
once; if the raster ever exceeds the storage value limit, it is kept in memory only. The
browser caches `/v1/map` for 60 s (`Cache-Control: public, max-age=60`).

## Owner decisions

- O1, 2026-10-20: PD-107 and PD-108 option A, as relayed in this session's brief: an installable web
  app on the same Worker with region choice, auto-refresh and installation; the region stored only
  in the browser; the no-JS page stays the fallback; refresh only through `/v1/alerts`.
- O2, 2026-10-20: the region choice is kept in a cookie («Cookie (Recommended)»).
- O3, 2026-10-20: the client is compiled by `tsc`, no new dependency («tsc, no new dep»).
- O4, 2026-10-20: browser-level checks are a recorded manual smoke («Manual smoke»).
- O5, 2026-10-20: after parking, the owner resumed slice 2 in this session («Сделать сейчас») with
  the iOS design as the reference and the alert map; relayed by the orchestrator the same day,
  visual quality, responsive layout, accessibility, a measured first paint and screenshots in the
  PR are acceptance criteria.
- O6, 2026-10-20: dark theme only, as the apps («Только тёмная»); this overrides the
  orchestrator's request for a light theme.
- O7, 2026-10-20: the yellow "Stay Alert" status is in scope, as in iOS («Да, как в iOS»).
- O8, 2026-10-20: Status and Regions in this slice; Details later; no Pro crown
  («Status + Regions»).
