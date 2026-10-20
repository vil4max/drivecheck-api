# Feature specification: cached API and status page

Feature: `001-cached-api-and-status-page` · Created: 2026-10-18
Status: approved by the owner on 2026-10-18 (see "Owner decisions"). Requirements shared with the
apps keep the status the owner gave them in `regional-check`.
Input: the owner's decision of 2026-10-18 (a backend and web proof for Drive Check, slice 1: cached
API plus status page).

## Summary

One Cloudflare Worker serves two things from a single cached copy of the Ubilling aerial-alerts
feed:

- `GET /v1/alerts`: the feed mirrored as JSON, plus freshness metadata, for the iOS and Android
  apps;
- `GET /`: a server-rendered page with the same glanceable status as the apps: the current region's
  status, its update time, and nearby alerts when there are any.

One Durable Object is the only thing that talks to Ubilling. However many clients and Cloudflare
locations ask, it makes at most one upstream request per 10 seconds, honours HTTP 429 and
`Retry-After` for everyone, and keeps only the latest answer.

Requirement text comes from the iOS app, `regional-check` `docs/requirements/`. Each shared
requirement keeps its iOS ID, states its backend text, and says what differs and why.

## Out of scope for slice 1

No alert history, accounts, ads or analytics, ever (core, "Never"). Not in this slice: the "Stay
Alert" surrounded state (REQ-SURF-010), freshness tiers beyond one stale flag, the alert map image,
client-side refresh, switching the apps to this API, and the deployment itself (the owner's
Cloudflare account and sign-in).

## User scenarios and testing

### User story 1: an app reads the status through the API (priority P1)

An app asks `GET /v1/alerts` and decodes `states[region].alertnow` and `cachedat` exactly as it
decodes the Ubilling feed today, and can also read how fresh the answer is.

Independent test: with a fake upstream, the response body mirrors the fixture feed and carries the
freshness fields.

Acceptance scenarios:

1. Given the upstream answered within the last 10 s, when a client asks, then the response is the
   held snapshot and no upstream request is made.
2. Given the held snapshot is older than 10 s, when several clients ask at once, then exactly one
   upstream request is made and every client gets its answer.
3. Given the upstream answers HTTP 429 with `Retry-After: 45`, when clients ask during the next
   45 s, then no upstream request is made, they get the held snapshot marked with the window, or
   HTTP 503 with `Retry-After` when there is none.
4. Given the upstream fails and a snapshot is held, when a client asks, then it gets the held
   snapshot with its original times, never an error in place of a known status.

### User story 2: a person opens the web page (priority P1)

A person opens the page and sees, in their language, whether their region is under an air raid
alert, when the data was last updated, and which neighbouring regions are under alert.

Independent test: the renderer, given a snapshot, a region and a language, produces the expected
text; the router picks the region and language from the request.

Acceptance scenarios:

1. Given Kyiv city has `alertnow: true`, when the page renders in English, then it shows "Air Raid
   Alert", "Kyiv" and "Updated HH:mm" in Kyiv time from `cachedat`.
2. Given Kyiv Oblast and Chernihiv Oblast are under alert and Kyiv city is quiet, when the page
   renders for Kyiv city, then it shows "No Alert" and "Nearby: Kyiv Oblast, Chernihiv Oblast".
3. Given the browser asks for Ukrainian, when the page renders, then every visible string, the
   region names and `<html lang>` are Ukrainian.
4. Given the snapshot is older than 2 minutes, when the page renders, then it keeps the last known
   status and says it is not current.
5. Given no snapshot exists and the upstream fails, when the page renders, then it shows
   "Unavailable" with HTTP 503.

## Requirements

### REQ-PROVIDER-001 — Default JSON endpoint

Status: approved (iOS, 2026-09-17)

Given the backend needs the status\
When it requests the provider\
Then it uses the default JSON endpoint `https://ubilling.net.ua/aerialalerts/` and reads
`states[region].alertnow` and `cachedat` (Europe/Kyiv)

Difference from iOS: none. The backend also keeps `states[region].changed` and `source` because the
API mirrors the feed.

### REQ-PROVIDER-002 — Polite load

Status: approved (iOS, 2026-09-17, amended 2026-09-23)

Given any number of clients and Cloudflare locations\
When they ask for the status\
Then all upstream requests go through one coordinator (one Durable Object instance), at most one
request is in flight, a request is made only when a client asks and the held snapshot is outside
the fetch floor (REQ-REFRESH-010), and HTTP 429 is honoured (REQ-REFRESH-005)

Difference from iOS: the iOS clauses count app triggers. The backend has a single trigger, a client
request, and replaces the per-device timer with a global floor: at most 0.1 requests per second for
all clients together, against Ubilling's 2 requests per second per host. Counted, not assumed: a
fixture session counts upstream requests against client requests.

### REQ-PROVIDER-003 — Informational source

Status: approved (iOS, 2026-09-17)

Given the page shows provider data\
When it renders\
Then it states that the data is informational, as the provider does

Difference from iOS: the page has no Details tab; the note sits under the status.

### REQ-REFRESH-003 — One retry for transient errors

Status: approved (iOS, 2026-09-17)

Extended to the web client by spec 002.

Given an upstream fetch fails with a transient error (network failure or a 15 s timeout)\
When the failure happens\
Then the coordinator retries once after 2 s

Difference from iOS: a Worker sees a thrown `fetch` or an abort, not `URLError`.

### REQ-REFRESH-005 — Rate limit backoff

Status: approved (iOS, 2026-09-17, amended 2026-10-15)

Extended to the web client by spec 002.

Given the provider returns HTTP 429\
When the next upstream request would be due\
Then the coordinator waits for `Retry-After` (seconds or HTTP date, capped at 5 min; a past,
negative or non-finite value counts as now or falls back to the backoff) or backs off 30 s → 60 s →
… up to 5 min, and makes no upstream request inside that window

Difference from iOS: there is no manual refresh on the server, so nothing passes the window. The
window is stored, so a restarted coordinator still honours it.

### REQ-REFRESH-006 — Stale threshold

Status: approved (iOS, 2026-09-17)

Extended to the web client by spec 002; the page's stale line now uses the iOS wording "Last known: {status} · HH:mm".

Given a snapshot with `checkedAt` (server `cachedat`, else the backend's fetch time)\
When `now − checkedAt` exceeds 2 × 60 s\
Then the page keeps the last known alert phase and marks it as not current, and the API reports
`stale: true`; a failed request never replaces a held phase with an unavailable one

Difference from iOS: the base interval is fixed at 60 s; the server has no power or alarm modes.

### REQ-REFRESH-010 — Fetch floor and cache serving

Status: approved (iOS, 2026-09-17)

Extended to the web client by spec 002, "Web client parts of requirements defined in slice 1".

Given an upstream attempt started less than 10 s ago, whatever its outcome\
When any client asks\
Then no upstream request is sent and the held snapshot is served (or the API-002 answer when there
is none); the 2 s retry of REQ-REFRESH-003 belongs to its attempt and is not held. Outside the
floor, a caller with a held snapshot gets it at once while the attempt runs in the background, so a
slow upstream never delays an answer that is already known

Difference from iOS: the floor is shared by every client instead of one device, and it also counts
failed attempts. iOS floors only after a success because one device's retries are already bounded;
a server shared by many clients would otherwise send one request per client to a failing upstream.

### REQ-REGION-001 — Catalog of 25 regions

Status: approved (iOS, 2026-09-17)

Extended to the web client by spec 002.

Given a provider response\
When it contains unknown keys or lacks the shown region\
Then the page ignores unknown keys and shows "Region Unavailable" for a missing region, distinct
from "Unavailable"

Difference from iOS: the API mirrors every key, unknown ones included, because the apps already
ignore them; only the page applies the catalog.

### REQ-SURF-005 — Nearby alerts in every status

Status: approved (iOS, 2026-09-17)

Extended to the web client by spec 002, which also shows at most two names and then "+N", as iOS does.

Given neighbouring regions are under alert\
When the page shows the current region, whether quiet or in alarm\
Then the nearby-alerts line lists them, using the iOS neighbour table; with none, the line is absent

### REQ-API-001 — Versioned mirror endpoint

Status: approved (owner, 2026-10-18,; see "Owner decisions")

Given a client asks `GET /v1/alerts`\
When a snapshot is held\
Then the response is HTTP 200 JSON with `apiVersion: 1`, the feed's `source`, `cachedat` and
`states` unchanged, and a `freshness` object with `fetchedAt`, `checkedAt`, `ageSeconds`, `stale`
and `rateLimitedUntil` (ISO 8601 UTC or `null`), with `Cache-Control: public, max-age=10` and CORS
open for `GET`

Reason: an app switches to the backend by changing one URL and keeps its decoder; the freshness
fields let it judge staleness without trusting its own clock alone.

### REQ-API-002 — No snapshot, no fake status

Status: approved (owner, 2026-10-18,; see "Owner decisions")

Given no snapshot is held\
When the upstream fails, has not answered within 5 s, or a 429 window is open\
Then the API answers HTTP 503 JSON `{"apiVersion":1,"error":"unavailable"}` with `Retry-After`
when a window is open, and the page shows "Unavailable" with HTTP 503

### REQ-API-003 — No history and no personal data

Status: approved (owner, 2026-10-18,; see "Owner decisions")

Given the coordinator stores state\
When it saves a snapshot or a rate-limit window\
Then it overwrites a single record, keeps no earlier snapshot, and stores and logs nothing about
clients (no IP, no region, no language)

Reason: core "Never" forbids alert history and analytics; a public proof must show it.

### REQ-WEB-001 — Language

Status: approved (owner, 2026-10-18,; see "Owner decisions")

Given a page request\
When `?lang=` names `en`, `uk` or `ru`, or else `Accept-Language` prefers one of them\
Then the page renders in that language, English otherwise, with `<html lang>` set and links to the
other two languages

### REQ-WEB-002 — Current region

Status: approved (owner, 2026-10-18,; see "Owner decisions")

Amended 2026-10-20 by spec 002: REQ-WEB-004 puts the visitor's region cookie between `?region=` and the network region, and supersedes the sentence about no region picker.

Given a page request\
When `?region=` names a catalog region id, or else Cloudflare's `request.cf.regionCode` for a
Ukrainian address maps to a region\
Then the page shows that region, Kyiv city otherwise (an unknown code, a non-Ukrainian address or no
code), and the region code is neither stored nor logged

Reason: the apps follow device location and fall back to Kyiv (REQ-REGION-009). A web page without
a location prompt gets the nearest honest equivalent, the region of the visitor's network address,
which Cloudflare resolves at the edge without anything being stored. `?region=` is for links and
checks; the page offers no region picker, as the apps offer none since 2026-09-20.

### REQ-WEB-003 — Accessible glanceable status

Status: approved (owner, 2026-10-18,; see "Owner decisions")

Amended 2026-10-20 by spec 002: REQ-WEB-005 lets the page load an external enhancing script; it still needs none, and no inline script runs.

Given the page renders a status\
When it is read by a screen reader or seen without colour\
Then the status is the text of the page's only `h1`, colour only repeats it, every text colour has
a contrast of at least 4.5:1 on the iOS background, and the page needs no JavaScript

## Decisions, with reasons

### D1 — Runtime and hosting: Cloudflare Workers with one Durable Object

Chosen: a Worker for routing and rendering, and one SQLite-backed Durable Object as the only
upstream client.

- Free plan: Workers and SQLite-backed Durable Objects are on the Workers Free plan (Cloudflare
  Durable Objects pricing page, read 2026-10-18); the expected load is far below its daily limits.
- A public `workers.dev` URL, no server to run or patch.
- "Fetch once for all clients" needs one place that decides. The Cache API is per Cloudflare
  location, so every location would fetch on its own and a 429 seen in one would not stop another.
  Workers KV is global but eventually consistent, and a write per refresh exceeds the free daily
  write limit. A single Durable Object is global, single-threaded and persistent, so the floor, the
  in-flight request and the 429 window are shared exactly.
- Alternatives rejected: a Node server (a machine to run), Vercel or Netlify functions (no
  coordination primitive on the free tier without an external store).

Cost: every API call reaches one Durable Object; at the free tier's 100,000 requests per day that
is ample for a proof, and `Cache-Control: max-age=10` lets clients and proxies absorb repeats.

### D2 — API shape: mirror plus freshness under `/v1`

`/v1/alerts` returns the feed's own fields unchanged plus `freshness` (REQ-API-001). A mirrored body
keeps the apps' decoders and their REQ-PROVIDER-001 tests valid; the version prefix lets a later
shape change ship as `/v2` without breaking released apps.

### D3 — Web page: server-rendered HTML, no JavaScript

The Worker renders the page on each request from the held snapshot. No build step, no client
bundle, works with JavaScript off, and the status is in the first response, which a glanceable
page needs. Refresh is a link that reloads the page; the page does not poll, so it adds no load and
no automatic trigger (REQ-PROVIDER-002). Colours come from `DriveCheckColors.swift`: background
`#0C0E11`, clear `#7CC39B`, alert `#F07C7C`, no-data `#C6CAD0`, text `#F2F3F5` and `#A3A7AE`.
Strings and region names come from the Android resources, which follow the iOS String Catalogs.

### D4 — Tooling

TypeScript 6.0.3 (TypeScript 7 is a new native compiler, too new for a proof), Vitest 5.0.3 for
tests in Node with the Worker's logic kept free of Cloudflare imports, Biome 2.5.15 for lint and
format, `@cloudflare/workers-types` for types, Wrangler 4.147.0 for the CI dry-run bundle and the
owner's deploy, pinned in the lockfile. Every version was published before 2026-10-04.

## Owner decisions

On 2026-10-18 the owner chose option A. The question offered A, the
visitor's region from Cloudflare's IP region, else Kyiv city; or B, always Kyiv city. It also said
the six slice 1 requirements count as approved together with the answer.

- O1, decided 2026-10-18: REQ-API-001 to REQ-API-003 and REQ-WEB-001 to REQ-WEB-003 are approved as
  written.
- O2, decided 2026-10-18 (A): REQ-WEB-002 uses the visitor's network region. The region is neither
  stored nor logged, and an unknown or non-Ukrainian region falls back to Kyiv city.
- O3, done 2026-10-18: the owner approved the deploy and ran it from the owner's Cloudflare account
  from the owner's account. Wrangler 4.147.0 deployed `main` at 468ae3c to https://drivecheck-api.vil4max.workers.dev
  (version ee9dcce7). Smoke test: `/v1/alerts` answers 200 with 26 states and freshness, `/` renders
  in en, uk and ru, an unknown path answers 404, and three calls inside 10 s share one `fetchedAt`.
