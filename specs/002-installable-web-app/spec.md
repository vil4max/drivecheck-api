# Feature specification: installable web app

Feature: `002-installable-web-app` · Created: 2026-10-20
Status: parked on 2026-10-20 by the owner (relayed by the orchestrator): no code; the web app waits for
a later decision. The plan was approved before parking. New requirements stay `proposed` until
then; shared requirements keep the status the owner gave them in `regional-check` or in slice 1.
Input: the owner's decisions PD-107 (Drive Check is the multiplatform testbed of his agentic loops)
and PD-108, option A (an installable web app served by the same Worker), and his answers of
2026-10-20 (see "Owner decisions").

## Summary

The status page of slice 1 becomes an installable web app (PWA) served by the same Worker:

- a region picker whose choice is kept in the visitor's browser;
- automatic refresh in the open page, only through `GET /v1/alerts`, following the apps' refresh
  policy and the Worker's 10 s floor;
- a web app manifest, icons and a service worker, so Chrome, Edge and Safari can install it, and the
  last known status opens offline;
- an install button where the browser offers one, and a short hint in Safari, which does not.

The server-rendered page stays complete without JavaScript: status, update time, nearby alerts,
the region picker and the refresh link work with scripts off. JavaScript only enhances it.

## Out of scope for slice 2

No alert history, accounts, ads or analytics, ever (core, "Never"). Not in this slice: push or
system notifications, background sync or periodic background refresh, the Chrome extension
(PD-108 "may follow later"), the device Geolocation API, the "Stay Alert" status (REQ-SURF-010),
a light theme, switching the apps to this API, and the deployment (the owner's yes).

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

1. Given a person picks Lviv Oblast with JavaScript on, when the choice is made, then the page shows
   Lviv Oblast at once from the held data, without a network request, and remembers it.
2. Given scripts are off, when the person submits the picker, then the server remembers the choice
   and shows Lviv Oblast.
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

Given the page renders\
When the person picks a region from the picker\
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
Then the server-rendered page alone shows the status, its time, nearby alerts, the picker, the
refresh link and the language links; with scripts on, the client renders the same strings, colours
and structure from the same modules as the server (REQ-SURF-001, one wording each), and the status
keeps being the text of the only `h1`

### REQ-WEB-006 — One data path for the client

Status: proposed

Given the client needs the status\
When it makes any request\
Then it asks only the same-origin `GET /v1/alerts`, never Ubilling or a third party, and the page's
Content Security Policy allows scripts, connections and the service worker from its own origin only

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
When the page or `/v1/alerts` is requested\
Then it tries the network first and keeps only the latest successful answer of each (one page, one
alerts response, overwritten); offline it serves those, marked as offline so the client counts them
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

## Owner decisions

- O1, 2026-10-20: PD-107 and PD-108 option A, as relayed in this session's brief: an installable web
  app on the same Worker with region choice, auto-refresh and installation; the region stored only
  in the browser; the no-JS page stays the fallback; refresh only through `/v1/alerts`.
- O2, 2026-10-20: the region choice is kept in a cookie («Cookie (Recommended)»).
- O3, 2026-10-20: the client is compiled by `tsc`, no new dependency («tsc, no new dep»).
- O4, 2026-10-20: browser-level checks are a recorded manual smoke («Manual smoke»).
