# Implementation plan: all-clear push (server)

Base: 0dd2c75 (`main`) · Feature: `003-allclear-push` · Spec: [spec.md](spec.md) · Branch
`feat/allclear-push-server`. App half: `regional-check` draft PR #25, branch `claude/allclear-push`
(its `specs/ALLCLEAR-push/` is the source of the contract). Stage 1: plan and spike research only,
no production code; the owner's approval of this plan approves the spec's requirements.

## Business rules (read first)

| # | Rule | Source |
|---|---|---|
| B1 | Push only on a confirmed alarm → clear change; a stale, failing or unknown feed never counts as clear | REQ-SURF-009 via app REQ-PUSH-002; spec AC-1, AC-2 |
| B2 | Gap rule: the previous confirmed alarm was seen at most 10 minutes before the clear; a cold start or a longer gap resets the baseline silently | owner, 2026-11-09 (app plan, Points to decide 1) |
| B3 | "Fresh" means not stale by the existing rule: checked at most 2 minutes ago | REQ-REFRESH-006, `src/status.ts:5`, `isStale` |
| B4 | Store per device only token, region, env, lang, last-seen | owner, 2026-11-09 (app plan point 2; app REQ-PUSH-006) |
| B5 | Drop a device not heard from for 60 days | owner, 2026-11-09 (app plan point 5) |
| B6 | Poll the feed every 30 s, only while a device is registered | owner, 2026-11-09 (app plan point 5); the 30 s is above the 10 s floor (`src/coordinator.ts:6`) |
| B7 | At most 45 pushes per invocation | app plan "Risks" (50 subrequests − feed fetch and its one retry − margin) |
| B8 | One upstream client, 10 s floor, 429 window, one request in flight | README "Polite to the data source"; REQ-PROVIDER-002, REQ-REFRESH-005/010 |
| B9 | The fallback region is never registered | owner, 2026-11-09; enforced by the app (REQ-PUSH-004); the server cannot tell a fallback from a choice |
| B10 | Region codes are iOS `AlertRegion` raw values (camelCase), mapped to the catalog | app `PushRegistration.swift` and `AlertRegion.swift`; server catalog ids are kebab-case (`src/regions.ts:14`) |
| B11 | APNs: HTTP/2, `POST /3/device/<token>`, `authorization: bearer <JWT ES256>`, `apns-topic`, `apns-push-type: alert`; JWT re-signed no more often than every 20 min and at least every 60 min; 4 KB payload | Apple, "Sending notification requests to APNs" and "Establishing a token-based connection to APNs" (Spike) |
| B12 | Delete the token on 410, or 400 `BadDeviceToken` / `DeviceTokenNotForTopic` | Apple, "Handling notification responses from APNs" (do-not-retry list) |
| B13 | The APNs `.p8` key, key id and team id are entered by the owner with `wrangler secret put`; never in chat, files, logs or tests | owner, 2026-11-09 (app spec Request; dispatch) |

No rule without a source. Open values (push wording, `apns-expiration`, retry of 429/5xx) are in
Points to decide, not filled in.

## Acceptance criteria and blast radius

AC-1 to AC-8 of [spec.md](spec.md).

Blast radius:
- New: `src/push/registration.ts` (body validation, region map), `src/push/registry.ts` (store
  interface and its pure logic), `src/push/changes.ts` (baseline and change detection),
  `src/push/apns.ts` (JWT, request building, answer classification), `src/push/sender.ts`
  (batch loop), `src/push/text.ts` (three-language text).
- Changed: `src/router.ts` (one path, PUT and DELETE), `src/worker.ts` (`Env` secrets, RPC methods,
  `alarm()`, the SQL adapter), `src/coordinator.ts` (a method the alarm can await, see Approach),
  `wrangler.jsonc` (a `vars` entry for the topic; no new binding or migration), README, spec 001
  (REQ-API-003 amendment), tests.
- Stored formats: new SQLite tables in the existing `FeedCoordinatorObject`; the existing `state`
  and `map` records are unchanged.
- Public contract: a new endpoint the released app will call; `/v1/alerts`, `/v1/map` and the
  pages are unchanged.
- Must not touch: the web app (client, service worker, pages), `/v1/alerts` shape, the map path,
  the coordinator's polite-load rules.

Risk class: **high** (persisted personal data, a public contract, credentials, a privacy statement).

## Baseline

`0dd2c75` (`main`): `npm run check` exit 0; trace "29 requirements, 29 approved, all approved cited".

## Spike (read-only research, 2026-11-09)

| Question | Finding | Source |
|---|---|---|
| Free CPU per Worker HTTP request | 10 ms of CPU; waiting on `fetch()` does not count | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Free CPU per Cron Trigger | 10 ms | same page |
| Subrequests per invocation, Free | 50 (internal services 1,000) | same page |
| Simultaneous connections | 6 waiting for response headers; a 7th is queued | same page |
| CPU of a Durable Object alarm | The DO limits page gives one value for both plans: 30 s of active CPU by default per invocation, and lists the alarm as an invocation; the Workers limits page states no Free value for DOs. Not stated for Free in so many words. Wall time of an alarm: 15 min | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Subrequests inside a DO alarm | Not stated separately; plan assumes 50 | DO limits; Workers limits |
| Alarms on Free | Not stated either way; SQLite DOs are on Free; each `setAlarm()` is one row written | [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Alarm semantics | One alarm per object; at-least-once; retried up to 6 times with backoff from 2 s only when the handler throws | Alarms API |
| Free daily DO limits | 100,000 requests (whether alarms count is said only for Paid), 100,000 rows written, 5 M rows read, 5 GB; over a limit, operations of that type fail until 00:00 UTC | DO pricing |
| Outbound protocol of `fetch()` | No Cloudflare page states which HTTP version outbound `fetch()` uses or whether an origin that requires HTTP/2 works. Unverified | [Protocols](https://developers.cloudflare.com/workers/reference/protocols/), [fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/) |
| What APNs requires | HTTP/2 and TLS 1.2+; `api.push.apple.com:443` (production), `api.sandbox.push.apple.com:443` (development), port 2197 as an alternative; payload ≤ 4096 bytes | [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) |
| JWT | `alg` ES256, `kid` key id, `iss` team id, `iat`; refresh no more than once per 20 min and at least once per 60 min; Apple recommends environment-specific keys | [Establishing a token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns) |
| ES256 in WebCrypto | The Workers page lists ECDSA sign and `importKey`, but names neither the P-256 curve nor the PKCS#8 format. (WebCrypto signs ECDSA in the raw r‖s form JWS needs.) Earlier local timing: about 0.06 ms per signature in Node, not measured in workerd | [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/); app spec spike table |
| Third-party evidence | A Workers fork of `apns2` exists and claims HTTP/2 to APNs; its README names no Workers API. Not a primary source | [@fivesheepco/cloudflare-apns2](https://unpkg.com/@fivesheepco/cloudflare-apns2@13.0.0/README.md) |

Conclusion: the subrequest budget fits (1 to 2 feed requests + 45 pushes ≤ 50); CPU is not the
bottleneck if the alarm gets the DO's 30 s; with the JWT cached, signing happens a few times an
hour. Two points only a real send proves: that `fetch()` reaches APNs over HTTP/2, and the CPU an
alarm actually gets on Free. Group 0 measures both with the owner's key.

## Approach

Options, neutral order:

- **A. Durable Object alarm** (approved). `FeedCoordinatorObject` arms an alarm when the first device
  registers; each alarm awaits a feed refresh through the coordinator, detects changes, enqueues
  pushes and sends up to 45, then re-arms: in 30 s, or in 1 s while the queue is not empty.
  Cost: largest change (alarm loop, tables, sender); risk: alarm CPU on Free unconfirmed.
  Counterargument: it puts a constant load on the one object that serves every page and API call.
- **B. Cron Trigger every minute calling the object** (approved fallback). Same tables and sender,
  no alarm loop. Cost: same code minus the loop; up to 60 s more delay, and the 30 s poll (B6)
  cannot hold. Counterargument: whether a cron-invoked DO RPC runs under the cron's 10 ms or the
  DO's own limit is not stated; if 10 ms, 45 pushes per run is unmeasured and tight.

Agent's lean: **A**, as approved, with B kept as a switch of the trigger only (the detection and
sender modules do not know what woke them), chosen by the Group 0 measurement.

How the alarm reads the feed: the coordinator serves a held snapshot at once and refreshes in the
background (`src/coordinator.ts:96-111`). The alarm instead needs the result of the attempt it
started, so the coordinator gets `refresh(): Promise<CoordinatorView>` that starts an attempt when
allowed (same `mayAttempt`, same `inFlight` slot) and awaits it. Clients keep `current()`.

Change detection (B1 to B3): a table `region_status(region PRIMARY KEY, alert, seen_at)` holds the
last confirmed status per region (overwritten, no history). A snapshot is processed once, only if
it is fresh and newer than the last processed `fetchedAt`. For each region: no row → insert, no push
(cold start); row alert and now clear and `fetchedAt − seen_at ≤ 600 000 ms` → a change; row older
than that → baseline reset, no push. A row is written only when its status changes or when an alarm
is re-confirmed (alert rows only), so 25 rows are not rewritten every 30 s (row-write budget). The
change id is `region` + the clear snapshot's `fetchedAt`.

Sending (B7, AC-5): in one transaction the change inserts one `outbox(token, change_id)` row per
device of the region and updates the baseline. Each invocation takes up to 45 rows, deletes each
row before its `fetch` (at most once: an alarm retry cannot send it again), sends at most 6 at a
time (connection limit), classifies the answer (B12) and re-arms while rows remain.

Storage: SQLite through `ctx.storage.sql` in the existing object (it is the one that holds the
snapshot); tables `devices(token PRIMARY KEY, region, env, lang, last_seen)`, `region_status`,
`outbox`. The 60-day prune runs at most once a day inside the alarm.

Credentials: `APNS_KEY` (`.p8` PEM), `APNS_KEY_ID`, `APNS_TEAM_ID` as Worker secrets the owner
enters with `npx wrangler secret put <NAME>`; `APNS_TOPIC` as a plain `vars` value (the bundle id,
public in the app's project file). With any secret missing the sender is off: registrations still
work, the alarm still tracks changes, nothing is sent, and one log line names the missing variable,
never a value. The JWT is cached in memory and re-signed after 40 min (inside B11's 20 to 60 min).
Tests use a key generated at test time; no key file is committed.

Changes from the plan gate (Points to decide): the region statuses are one overwritten record
(`push-statuses` in the object's key-value storage: per region `{alert, seenAt}`, plus the last
processed `fetchedAt`), written once per processed snapshot, not a `region_status` table; outbox
rows carry their creation time and are deleted unsent after 5 min; pushes carry
`apns-expiration` = send time + 5 min and are never retried; the alarm waits at most 20 s for the
feed; at most 10,000 devices.

## Files and types

- `src/push/registration.ts`: `parseRegistration(body): Registration | null`,
  `parseDeletion(body)`, `regionFromAppCode("ivanoFrankivsk") → "ivano-frankivsk"`.
- `src/push/registry.ts`: `PushStore` interface (upsert, delete, devicesIn(region, limit),
  prune(before), outbox ops, region status ops); the SQL implementation lives in `worker.ts`, a map
  implementation in `tests/support.ts`.
- `src/push/changes.ts`: `detectChanges(snapshot, statuses, now)` → `{changes, writes}`; reuses
  `isStale`, `checkedAt` and `REGIONS`.
- `src/push/apns.ts`: `providerToken(key, keyId, teamId, now)`, `apnsRequest(device, text)`,
  `classify(status, reason) → "ok" | "drop-token" | "keep"`.
- `src/push/sender.ts`: `sendBatch(store, send, now)` → `{sent, dropped, remaining}`.
- `src/push/text.ts`: `allClearText(regionId, lang)` from the region names in `src/regions.ts`.
- `src/worker.ts`: `registerDevice`, `forgetDevice` RPCs, `alarm()`, SQL adapter, `Env` secrets.
- `src/router.ts`: `/v1/push/registration` PUT and DELETE before the GET-only branch.

## Tests

| AC | Test | Discriminating cases |
|---|---|---|
| AC-1 | `REQ-PUSH-002 a confirmed alarm-to-clear sends one push per device of that region` | region A alarm at t, clear at t+30 s, two devices in A, one in B → two pushes, none to B; region already clear → none |
| AC-1, AC-2 | `REQ-PUSH-002 the 10-minute gap rule` (one test, one injected clock) | alarm seen, clear seen 600 000 ms later → send; 600 001 ms later → none; alarm → stale snapshot → clear inside 10 min where the stale one was skipped → send only if the last confirmed alarm is within 10 min |
| AC-2 | `REQ-PUSH-002 a stale, missing or rate-limited feed sends nothing` | `isStale` true → none and no baseline write; snapshot null → none; 429 window open → no upstream call and none; the same snapshot processed twice → one push |
| AC-2 | `REQ-PUSH-002 a cold start sets the baseline silently` | empty `region_status`, feed shows A clear and B alarm → no push, two rows written |
| AC-3 | `REQ-PUSHAPI-001 DELETE forgets the device` | registered token → 204, gone from `devices` and `outbox`; unknown token → 204; malformed body → 400 |
| AC-3, AC-6 | `REQ-PUSHAPI-001 PUT validates the four fields` | valid → 204 and one row; same token, new region → still one row with the new region; extra key `"lat"` → 400; `region: "kyiv-city"` (server id, not app code) → 400; `env: "dev"` → 400; non-hex token → 400; response has no `access-control-allow-origin`; GET → 405 |
| AC-4 | `REQ-PUSHAPI-005 APNs answers decide what is deleted` | 410 `Unregistered` → deleted; 400 `BadDeviceToken` → deleted; 400 `BadTopic` → kept; 403 `ExpiredProviderToken` → kept and the JWT re-signed next time; 429, 500, 503 → kept |
| AC-5 | `REQ-PUSHAPI-004 batches of at most 45 and no duplicates` | 100 devices → invocations send 45, 45, 10, and the alarm is re-armed twice; the second invocation throws mid-batch and is retried → total sends 100, no token twice; at most 6 sends in flight |
| AC-6 | `REQ-PUSHAPI-002 a device keeps five fields for 60 days` | stored row keys equal exactly {token, region, env, lang, last_seen}; last_seen 60 days − 1 ms → kept, 60 days + 1 ms → pruned; captured log lines contain no token |
| AC-7 | `REQ-PUSHAPI-001 the all-clear text exists in en, uk and ru` | every `Lang` × every region gives a non-empty title and body naming the region in that language; payload ≤ 4096 bytes |
| AC-8 | `REQ-PUSHAPI-003 the alarm polls every 30 s only while devices exist` | first PUT arms the alarm; alarm with devices → one `refresh()` and re-arm at +30 s; an alarm 5 s after a client-triggered attempt → no upstream call (floor); last DELETE → no re-arm |
| — | `REQ-API-003 stores one record holding only the latest snapshot and no client data` (existing) | unchanged; still passes, since the device tables are a separate store |
| AC-7 | `REQ-PUSHAPI-006 the texts and the 5-minute lifetime` | uk Kharkiv → title "Відбій тривоги: Харківська область"; en Kyiv city → "All clear: Kyiv"; `apns-expiration` = send second + 300; an outbox row 300 001 ms old → deleted unsent |
| — | `REQ-PUSHAPI-007 the device cap and the alarm deadline` | 10,000 stored, new token → 503 and no row, known token → 204; a hanging refresh → after 20 s no processing and a re-arm at +30 s |
| — | `REQ-PUSHAPI-005 the provider token` | header `{alg: ES256, kid}`, claims `{iss, iat}`; signature verifies with the test public key; reused at +39 min, re-signed at +40 min |

## Risks

Collision audit (read-only):

| Source | Behaviour implied | Scope | Decision that stands |
|---|---|---|---|
| `README.md:40-45` "Never" | "nothing stored or logged about visitors on the server" | whole service | owner, 2026-11-09: token and region storage approved; amended in this branch (devices that opt in on iOS only; web visitors unchanged) |
| `specs/001-cached-api-and-status-page/spec.md:232-241` REQ-API-003 | the coordinator stores nothing about clients | coordinator state | owner, 2026-11-09; amended in this branch: the coordinator record is unchanged, the push registry is the one exception, defined by spec 003 |
| `AGENTS.md:9-11` product rules | no account, no history | product | holds: a token is not an account, `region_status` keeps only the latest status |
| `specs/001-.../spec.md:252-263` REQ-WEB-002, O2 (`:343`) | the region code is neither stored nor logged | web pages | holds: applies to web visitors' network region; push regions come only from an opted-in app |
| `specs/002-installable-web-app/spec.md:33-34` | push is out of scope | slice 2 | scope of slice 2 only; spec 003 brings app push in, no Web Push |
| `README.md:31-38` "Polite" | the upstream is asked only when clients ask | load | holds with B6: the alarm adds at most one request per 30 s, within the 10 s floor; README to say so (Group 4) |
| `specs/001-.../spec.md:302-305` D1 cost | ~35 always-open pages reach the 100k daily requests | Free plan | the alarm adds 2,880 invocations a day if they count (Paid page says alarms count) |

Other risks:
- Row writes: 100,000 per day on Free. Today about 2 writes per feed attempt; the alarm adds one
  `setAlarm` per 30 s (2,880) plus its attempts (up to 5,760). `region_status` must not be rewritten
  each poll (25 rows × 2,880 = 72,000). Over the limit, writes fail until 00:00 UTC and the
  coordinator falls back to memory (`src/coordinator.ts:224-231`).
- Abuse: the endpoint is public and unauthenticated; a flood of PUTs spends the daily row-write
  budget and fills the table. Mitigation is open (Points to decide).
- Races: the alarm and client requests share one object and one `inFlight` slot; `refresh()` must
  join an attempt in flight, not start a second. Alarms run one at a time per object.
- At-least-once alarms: deleting the outbox row before the send trades a lost push on a crash for no
  duplicate (AC-5).
- Two environments: a device registered as `sandbox` goes to the sandbox host; the key must allow
  that environment (Points to decide).
- Test host: tests never reach APNs or Ubilling; `fetch` is injected as today
  (`tests/support.ts`). The key for JWT tests is generated in the test.
- Localization: the push text needs en, uk and ru wording from the owner.
- Unverified until Group 0: HTTP/2 through `fetch()`, the alarm's CPU on Free.

## Tasks

## Group 0: Spike with the owner's key (no merge)
- [ ] T001 [Owner] Create the APNs key in the Apple Developer portal; run `npx wrangler secret put APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` on a throwaway Worker; give a sandbox device token from a debug build.
- [ ] T002 Throwaway Worker (not committed to `main`): sign a JWT, send one alert push from `fetch` and from an alarm; record the HTTP answer, `apns-id`, and CPU time from `wrangler tail`. Decide A or B by the result.

## Group 1: Registration
- [x] T003 Test: `REQ-PUSHAPI-001 PUT validates the four fields`, `REQ-PUSHAPI-001 DELETE forgets the device` prove AC-3, AC-6. Files: `tests/pushRegistration.test.ts`, `tests/router.test.ts`, `tests/support.ts`
- [x] T004 Implement: `src/push/registration.ts`, `src/push/registry.ts`, router path, `worker.ts` RPCs and SQL adapter.

## Group 2: Change detection and the alarm
- [x] T005 Test: the four `REQ-PUSH-002` tests and `REQ-PUSHAPI-003` prove AC-1, AC-2, AC-8. Files: `tests/pushChanges.test.ts`, `tests/coordinator.test.ts`
- [x] T006 Implement: `src/push/changes.ts`, `FeedCoordinator.refresh()`, `alarm()` arming and re-arming.

## Group 3: Sender
- [x] T007 Test: `REQ-PUSHAPI-004`, `REQ-PUSHAPI-005` (answers, provider token), `REQ-PUSHAPI-002` (fields, 60 days, logs), the text test prove AC-4, AC-5, AC-6, AC-7. Files: `tests/pushSender.test.ts`, `tests/apns.test.ts`
- [x] T008 Implement: `src/push/apns.ts`, `src/push/sender.ts`, `src/push/text.ts`, secrets in `Env`, `APNS_TOPIC` in `wrangler.jsonc`.

## Group 4: Docs and approval of requirements
- [x] T009 Docs: requirement statuses to approved; README endpoint list, "Polite" (30 s alarm), "Deploy" (the four `wrangler secret put` lines, never values). Files: `specs/003-allclear-push/spec.md`, `README.md`

Deploy and an end-to-end send to a TestFlight device follow the owner's separate approval; the app
PR #25 merges only after the server is deployed.

## Review lows

Round 1 (2026-11-09), not fixed; the mediums of that round were repaired:
- `src/push/sender.ts:19-23`: a batch is read once; a DELETE arriving while earlier chunks are in
  flight removes the device, but its already-read item is still sent seconds later.
- `src/push/apns.ts:144`: a failing `importKey` or `sign` (a malformed `APNS_KEY`) is logged as
  "network error", so a bad key looks like an outage.
- `src/push/apns.ts:133-143`: the APNs `fetch` has no timeout; a hanging connection holds the
  alarm (15 min wall limit), and no poll runs meanwhile.
- `src/worker.ts:93-101`: `this.sender()` and `setAlarm(next)` run outside `runAlarm`'s
  catch-all; a storage error there leaves the loop unarmed until the next new PUT arms it.
- `src/push/alarm.ts:77`: the 60-day prune runs on every alarm, not once a day as "Storage" says;
  it reads only expired rows through the `last_seen` index, so the daily schedule was not kept.

## Verification

`npm run check` and `npm run bundle` per group; Group 0's tail log; `wrangler dev` with a local
PUT, DELETE and a forced alarm against a fake APNs host.

## Points to decide

Plan critic findings (separate pass, 2026-11-09), unchanged, each with the agent's proposed answer:

1. [1] plan "Sending", Tests AC-4: a push whose APNs answer is 429 `TooManyRequests`, 500 or 503
   (Apple: retry 5xx after 15 min) is neither retried nor re-queued, and no rule says whether a late
   all-clear is still wanted. Proposed: no retry and an `apns-expiration` of now + 10 min, so a
   push that cannot arrive within the gap rule's window is never delivered late. Owner decides.
   - Decision: accepted with a change: no retry, and `apns-expiration` is now + 5 min (owner,
     2026-11-09).
2. [1] plan "Change detection": a change detected while the sender is off (a secret missing, or the
   key revoked) still writes outbox rows that the next invocations send once the key exists, perhaps
   hours later. Proposed: outbox rows older than 10 min are deleted unsent. Owner decides.
   - Decision: accepted with a change: outbox rows older than 5 min are deleted unsent (owner,
     2026-11-09).
3. [2] `src/coordinator.ts:96-111` and plan "How the alarm reads the feed": `refresh()` awaiting an
   attempt holds the alarm while the coordinator's transient retry sleeps 2 s and the upstream may
   take up to 15 s (`src/coordinator.ts:7-8`); plan needs the alarm's own deadline. Proposed: the
   alarm awaits at most 20 s, then processes nothing and re-arms. Fixed in the plan: no; owner
   decides.
   - Decision: accepted (owner, 2026-11-09).
4. [2] plan "Change detection" and Risks "Row writes": re-confirming every alerting region each poll
   rewrites its `region_status` row every 30 s; with 15 regions in alarm that is about 43,000 writes a
   day, on top of the rest, against the 100,000 Free limit. Proposed: keep the 25 statuses in one
   overwritten record (one write per processed snapshot, at most 2,880 a day). Owner decides.
   - Decision: accepted (owner, 2026-11-09).
5. [1] plan Risks "Abuse": no limit on registrations; a flood of PUTs can spend the 100,000 daily
   row writes and stop the coordinator saving its state. Proposed: a cap on stored devices (for
   example 10,000) answering 503 above it, and a rate-limiting rule on the path in the Cloudflare
   dashboard (owner's account; Free availability not verified here). Owner decides.
   - Decision: accepted: a cap of 10,000 stored devices, 503 above it; the dashboard rate-limiting
     rule is optional and left to the owner (owner, 2026-11-09).

Contract check against the app (PR #25, commit f842802): `PUT /v1/push/registration` with
`{token, region, env, lang}` and `DELETE /v1/push/registration` with `{token}`, both 204, base URL
`https://drivecheck.vil4max.com`; `region` the `AlertRegion` raw value (`kharkiv`, `kyivCity`),
`env` `production|sandbox`, `lang` `en|uk|ru`; the app re-sends the same body at least weekly, so
PUT is an idempotent upsert that refreshes last-seen. The plan matches each point. Differences,
all additions the app's contract does not state:

- D1 Error answers: 400 for an invalid body, 405 for another method, 204 for a DELETE of an unknown
  token. The app treats any non-2xx as a failure and retries on the next foreground, so a 400
  would be retried forever for a body the server will never accept. Proposed: keep 400 and 405;
  the app needs no change, since its body is always valid. Owner decides.
  - Decision: accepted (owner, 2026-11-09).
- D2 Validation detail the app does not state: the token must be hex (the app sends lowercase hex,
  `PushRegistration.tokenString`), and a body with an extra key is refused. Owner decides.
  - Decision: accepted (owner, 2026-11-09).

Questions for the owner beyond the critic:

- Q1 Host: the app calls `https://drivecheck.vil4max.com` (`PushRegistration.swift`). The custom
  domain is attached in the dashboard, not in `wrangler.jsonc` (README "Deploy"). Keep it as the
  permanent API host for released apps?
  - Decision: yes (owner, 2026-11-09).
- Q2 Key environments: debug builds register `sandbox`, TestFlight and App Store builds
  `production`. One key enabled for both environments, two keys (`APNS_KEY_SANDBOX` and
  `APNS_KEY`), or production only with `sandbox` registrations refused?
  - Decision: one key enabled for both environments (owner, 2026-11-09).
- Q3 Wording of the push (title and body) in en, uk and ru.
  - Decision: the texts in spec 003, REQ-PUSHAPI-006 (owner, 2026-11-09).
- Q4 `apns-topic`: the bundle id `vil4max.RegionalCheck` from the app's project file, as a plain
  `vars` value. Confirm.
  - Decision: confirmed (owner, 2026-11-09).

The 10-minute gap rule for change detection is unchanged; the 5 minutes above apply to the push's
lifetime and the outbox only. The requirements of spec 003 become approved with Group 4 (T009),
once tests cite them, so the requirement trace stays green after every group.
