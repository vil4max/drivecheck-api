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
  was saved;
- `PUT /v1/push/registration` (`{"token","region","env","lang"}`) and `DELETE
  /v1/push/registration` (`{"token"}`), both 204: the iOS app's opt-in for the all-clear push
  ([spec 003](specs/003-allclear-push/spec.md)). While a device is registered, a Durable Object
  alarm reads the feed every 30 s, and when a region's alarm confirmed at most 10 minutes earlier
  turns clear in a fresh answer, each device of that region gets one notification through APNs;
  when a region's clear status confirmed at most 10 minutes earlier turns to alarm, it gets the
  alert-start notification. Every notification plays the app's own short, calm sound; the alert
  start is time-sensitive, so it reaches the driver through Focus unless Time Sensitive
  Notifications are off for the app in Settings, and the all-clear is not;
- `PUT /v1/push/live-activity` (`{"startToken","region","env","lang"[,"activityToken"]}`) and
  `DELETE /v1/push/live-activity` (`{"startToken"}`), both 204: the iOS app's Live Activity tokens
  ([spec 004](specs/004-alert-push-live-activity/spec.md)), kept whatever the notification switch.
  The same alarm starts the Live Activity in red at a confirmed alert start, updates it every
  5 minutes while the alert lasts, and ends it in green, removed 5 minutes later, as soon as a fresh
  answer shows the region clear.

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
The push alarm goes through the same object and rules, so it adds at most one status request
per 30 s, and none while no device and no Live Activity is registered; the Live Activity updates
reuse the answer it already has. Browsers never ask Ubilling.

## Never

No alert history (only the latest answer and map are kept, each in one overwritten record), no
accounts, no ads, no analytics, and nothing stored or logged about web visitors on the server; the
region choice and the offline copy stay in the visitor's browser. One exception, approved on
2026-11-09 for the all-clear push ([spec 003](specs/003-allclear-push/spec.md)): for an iPhone whose
driver switched the push on, the server keeps the push token, the region code, the APNs environment,
the language and the time it last heard from the device, deletes them when the driver switches the
push off or after 60 days without contact, and never logs a token. A second exception, approved
on 2026-11-10 ([spec 004](specs/004-alert-push-live-activity/spec.md)): for an iPhone with Live
Activities on, the server keeps the Live Activity start token, the update token of the running
activity, the region code, the APNs environment, the language and the last-contact time, under
the same deletion rules. Alert data is informational only; do not rely on it for critical
decisions.

## Develop

Needs Node 22.13 or later (the push registry's tests run its SQL on `node:sqlite`) and Python 3
(for the requirement trace).

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

The all-clear push needs an APNs authentication key (`.p8`) enabled for both the sandbox and the
production environment. Its owner enters it, its key id and the team id as secrets, typing or
pasting each value only at Wrangler's prompt, never into a file or a chat:

```
npx wrangler secret put APNS_KEY
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
```

`APNS_TOPIC` (the app's bundle id) is a plain variable in `wrangler.jsonc`. Without the secrets the
Worker still accepts registrations and tracks changes, sends nothing, and its log names the missing
secrets. The same key signs the Live Activity pushes; their topic is `APNS_TOPIC` with
`.push-type.liveactivity` appended, so no further variable is needed. Optional: a rate-limiting
rule on `/v1/push/registration` and `/v1/push/live-activity` in the Cloudflare dashboard.
