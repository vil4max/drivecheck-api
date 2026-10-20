# drivecheck-api

The backend and web app for **Drive Check**, a glanceable air-raid alert check for drivers in
Ukraine, with iOS and [Android](https://github.com/vil4max/drivecheck-android) apps.

Host: <https://drivecheck.vil4max.com> (the `workers.dev` address answers too). It serves what is
deployed from `main`; a merged change goes live only with the next approved deploy.

One Cloudflare Worker fetches the public [Ubilling aerial-alerts
feed](https://wiki.ubilling.net.ua/doku.php?id=aerialalertsapi) and its alert map once for all
clients and serves them as:

- `GET /v1/alerts`: the feed mirrored as JSON (`apiVersion`, `source`, `cachedat`, `states`) plus
  `freshness` (`fetchedAt`, `checkedAt`, `ageSeconds`, `stale`, `rateLimitedUntil`), for the apps;
- `GET /v1/map`: the provider's night alert map image with its fetch time (`x-map-fetched-at`);
- `GET /`: an installable web app in the design of the iOS Status screen, in English, Ukrainian or
  Russian (`?lang=en|uk|ru`): the status with the radar hero (including the yellow "Stay Alert"
  when alerts surround a quiet region), its update time, nearby alerts and the alert map;
- `GET /regions`: every region's status, where a visitor picks their region; `POST /region` keeps
  the choice in a `region` cookie in the browser only. The region shown is `?region=`, else that
  cookie, else the region of the visitor's network, else Kyiv;
- `GET /offline?lang=`: the Unavailable page the service worker shows offline before any status
  was saved.

The pages are complete without JavaScript. With it, the open Status page refreshes itself through
`/v1/alerts` on the apps' schedule (60 s, 30 s during an alert, 300 s with a data saver, only while
visible, never more than once per 10 s), a service worker opens the last known status offline, and
Chrome, Edge and Safari can install it as an app. Screenshots on a phone and a desktop are in
[`docs/screenshots/`](docs/screenshots/).

## Polite to the data source

Ubilling allows 2 requests per second per host and answers HTTP 429 above it. Here a single
Durable Object is the only upstream client: it makes at most one status request per 10 seconds and
one map request per minute for all clients together, never two at once, never a map request within
3 s of a status request nor a status request within 1 s of a map request, retries a failed status
request once after 2 s, and honours `Retry-After` (capped at 5 minutes) for both across restarts.
Browsers never ask Ubilling.

## Never

No alert history (only the latest answer and map are kept, each in one overwritten record), no
accounts, no ads, no analytics, and nothing stored or logged about visitors on the server; the
region choice and the offline copy stay in the visitor's browser. Alert data is informational only;
do not rely on it for critical decisions.

## Develop

Needs Node 22 or later and Python 3 (for the requirement trace).

```
npm ci
npm run check
npx wrangler dev
```

`check` runs the type-check (Worker, browser client and service worker), Biome lint, Vitest tests
and the requirement trace (`scripts/spec-trace.py`): every approved requirement in
`specs/*/spec.md` must be cited by a passing test. `npm run build` compiles the browser client and
the service worker into `public/app/` and lists the modules for the service worker; Wrangler runs
it before `dev`, `deploy` and the dry-run `npm run bundle`. `wrangler dev` serves the Worker at
<http://localhost:8787>. Feature specs and plans live in [`specs/`](specs/).

## Deploy

Needs a Cloudflare account (the Workers Free plan is enough):

```
npm ci
npx wrangler login
npx wrangler deploy
```

The custom domain is attached to the Worker in the Cloudflare dashboard, not in `wrangler.jsonc`;
a fresh account gets only the `workers.dev` address.
