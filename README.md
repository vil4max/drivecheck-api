# drivecheck-api

The backend and web page for **Drive Check**, a glanceable air-raid alert check for drivers in
Ukraine, with iOS and [Android](https://github.com/vil4max/drivecheck-android) apps.

One Cloudflare Worker fetches the public [Ubilling aerial-alerts
feed](https://wiki.ubilling.net.ua/doku.php?id=aerialalertsapi) once for all clients and serves it
two ways:

- `GET /v1/alerts`: the feed mirrored as JSON (`source`, `cachedat`, `states`) plus `freshness`
  (`fetchedAt`, `checkedAt`, `ageSeconds`, `stale`, `rateLimitedUntil`), for the apps;
- `GET /`: a server-rendered status page in English, Ukrainian or Russian (`?lang=en|uk|ru`), for
  the visitor's region (`?region=kyiv-city`, see `src/regions.ts`): the status, its update time and
  nearby alerts.

## Polite to the data source

Ubilling allows 2 requests per second per host and answers HTTP 429 above it. Here a single
Durable Object is the only upstream client: it makes at most one request per 10 seconds for all
clients together, shares one in-flight request among concurrent callers, retries a network failure
once after 2 s, and honours `Retry-After` (capped at 5 minutes) across restarts.

## Never

No alert history (only the latest answer is kept, in one overwritten record), no accounts, no ads,
no analytics, and nothing stored or logged about visitors. Alert data is informational only; do not
rely on it for critical decisions.

## Develop

```
npm ci
npm run check
```

`check` runs the type-check, Biome lint, Vitest tests and the requirement trace
(`scripts/spec-trace.py`): every approved requirement in `specs/*/spec.md` must be cited by a
passing test. The feature spec, plan and tasks live in
[`specs/001-cached-api-and-status-page`](specs/001-cached-api-and-status-page/spec.md).

## Deploy

Needs a Cloudflare account (the Workers Free plan is enough):

```
npx wrangler@4.147.0 login
npx wrangler@4.147.0 deploy
```
