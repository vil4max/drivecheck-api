# drivecheck-api

The backend and web page for **Drive Check**, a glanceable air-raid alert check for drivers in
Ukraine, with iOS and [Android](https://github.com/vil4max/drivecheck-android) apps.

Live: <https://drivecheck.vil4max.com> (web app) and
<https://drivecheck.vil4max.com/v1/alerts> (API); the `workers.dev` address keeps working.

One Cloudflare Worker fetches the public [Ubilling aerial-alerts
feed](https://wiki.ubilling.net.ua/doku.php?id=aerialalertsapi) once for all clients and serves it
as:

- `GET /v1/alerts`: the feed mirrored as JSON (`source`, `cachedat`, `states`) plus `freshness`
  (`fetchedAt`, `checkedAt`, `ageSeconds`, `stale`, `rateLimitedUntil`), for the apps;
- `GET /v1/map`: the provider's alert map image, fetched at most once a minute;
- `GET /`: an installable web app in the design of the iOS Status screen, in English, Ukrainian or
  Russian (`?lang=en|uk|ru`): the status with the radar hero (including the yellow "Stay Alert"
  when alerts surround a quiet region), its update time, nearby alerts and the alert map;
- `GET /regions`: every region's status, where a visitor picks their region (kept in a `region`
  cookie in the browser only; otherwise the region of the visitor's network, else Kyiv).

The pages are complete without JavaScript. With it, the open page refreshes itself through
`/v1/alerts` on the apps' schedule (60 s, 30 s during an alert, only while visible, never more
than once per 10 s), a service worker opens the last known status offline, and Chrome, Edge and
Safari can install it as an app.

## Polite to the data source

Ubilling allows 2 requests per second per host and answers HTTP 429 above it. Here a single
Durable Object is the only upstream client: it makes at most one status request per 10 seconds and
one map request per minute for all clients together, never two at once and never a map request
within 3 s of a status request, retries a network failure once after 2 s, and honours
`Retry-After` (capped at 5 minutes) for both across restarts. Browsers never ask Ubilling.

## Never

No alert history (only the latest answer is kept, in one overwritten record), no accounts, no ads,
no analytics, and nothing stored or logged about visitors. Alert data is informational only; do not
rely on it for critical decisions.

## Develop

```
npm ci
npm run check
```

`check` runs the type-check (Worker, browser client and service worker), Biome lint, Vitest tests
and the requirement trace (`scripts/spec-trace.py`): every approved requirement in
`specs/*/spec.md` must be cited by a passing test. `npm run build` compiles the browser client and
the service worker into `public/app/`; Wrangler runs it before `dev` and `deploy`. Feature specs
and plans live in [`specs/`](specs/).

## Deploy

Needs a Cloudflare account (the Workers Free plan is enough):

```
npm ci
npx wrangler login
npx wrangler deploy
```
