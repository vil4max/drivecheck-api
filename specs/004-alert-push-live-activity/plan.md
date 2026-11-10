# Implementation plan: alert-start push and server-driven Live Activity (server)

Base: 6420229 (`main`) · Feature: `004-alert-push-live-activity` · Spec: [spec.md](spec.md) · Branch
`feat/alert-push-live-activity`. App half: `regional-check` branch `claude/alert-push` at 504d252
(`specs/ALERT-push/`, `RegionalCheck/Push/LiveActivityPushRegistrar.swift`). Stage 1: spec and plan
only, no production code; the owner's approval of this plan approves the spec's requirements.

## Business rules (read first)

| # | Rule | Source |
|---|---|---|
| B1 | Only a fresh feed acts; stale, failing, rate-limited or unknown changes nothing | REQ-SURF-009; spec 003 REQ-PUSH-002; `src/push/alarm.ts:51`, `src/push/changes.ts:44` |
| B2 | Alert start counts only when the previous confirmed status was clear and seen at most 10 min earlier; a cold start or a longer gap only sets the baseline | owner, 2026-11-10 (app REQ-PUSH-008); `GAP_MS`, `src/push/changes.ts:6` |
| B3 | One switch in the app; the server keeps two independent stores: notice devices (`push_devices`) and Live Activity records keyed by start token, whatever the notice switch | owner, 2026-11-10 (app plan, point 2 option a); app `LiveActivityPushRegistrar.swift` |
| B4 | Alert-start notice: `"interruption-level": "time-sensitive"` and `"sound": "drivecheck.caf"` (owner, 2026-11-10; see P6 and P10); title en "Air raid alert: {region}", uk "Повітряна тривога: {region}", ru "Воздушная тревога: {region}" | owner, 2026-11-10 (app plan, point 4) |
| B5 | Live Activity `start` to every record of the region, priority 10, with `alert`, `attributes-type`, `attributes`, `input-push-token: 1`, `stale-date` = check + 15 min | owner, 2026-11-10 (app plan, Approach 3 and point 5); Apple (Spike) |
| B6 | `update` about every 5 min while the alarm lasts, priority 5, new check time and stale date | owner, 2026-11-10 (app spec Request, AC-4) |
| B7 | All-clear: green content, `end`, `dismissal-date` = now + 300 s; the all-clear notice as in spec 003 | owner, 2026-11-10 (app plan, last paragraph) |
| B8 | `regionTitle` is the app's region name in the record's language; it equals `src/regions.ts` names (Spike, 0 mismatches of 75) | app `AlertRegion.title(locale:)`, DriveCheckKit `Localizable.xcstrings` |
| B9 | `checkedAt` = `serverCachedAt ?? fetchedAt`, sent as seconds since 2001-01-01 | app `AlertsSnapshot.checkedAt`; `src/status.ts:18`; app spec Assumptions |
| B10 | `sourceLabel` = the app's `StatusSourceLabel.displayName(source)`: "Alert feed" / "Стрічка тривог" / "Лента тревог" when `feed.source` contains `mørk`, `mork` or `skogen` (case-insensitive), else "External feed" / "Зовнішнє джерело" / "Внешний источник" | app `StatusSourceLabel.swift`, app `Localizable.xcstrings` (see contract D2) |
| B11 | Record: start token, region, env, lang, optional activity token, last seen; 60-day expiry; app refresh every 7 days | owner, 2026-11-09 (REQ-PUSH-006) and 2026-11-10; app `refreshInterval` |
| B12 | At most 45 sends per invocation, 6 in flight, no retry; delete a token on 410 or 400 `BadDeviceToken` / `DeviceTokenNotForTopic` | spec 003 REQ-PUSHAPI-004, -005; `src/push/sender.ts:5-7` |
| B13 | The Live Activity topic is the bundle id plus `.push-type.liveactivity`; the same token-based key signs it | Apple, "Sending notification requests to APNs" (push type `liveactivity`); `wrangler.jsonc:14` |

No rule without a source. Open values (the alert-start body and sound, lifetimes of the new pushes,
the gap rule for `end`, the fan-out design, the record cap) are in Points to decide.

## Acceptance criteria and blast radius

AC-1 to AC-9 of [spec.md](spec.md).

Blast radius:
- New: `src/push/liveActivity.ts` (body validation, record type, payload builders),
  `src/push/alertText.ts` or an extension of `src/push/text.ts` (alert-start text, source label).
- Changed: `src/push/changes.ts` (`detectChanges` also returns `started` and the regions due for an
  update), `src/push/registry.ts` (table `push_live_activities`, a `kind` column on `push_outbox`,
  counters), `src/push/alarm.ts` (keeps running while either store is non-empty, enqueues the new
  kinds, drives the 5-minute updates), `src/push/apns.ts` (per-kind headers and topic, per-kind
  answer handling), `src/push/sender.ts` (dispatch by kind), `src/router.ts` (one path),
  `src/worker.ts` (RPCs), README, spec 003 cross-references, tests.
- Stored formats: new table `push_live_activities`; `push_outbox` gains `kind` (default the
  all-clear kind, so rows queued before the deploy keep their meaning); the `statuses` record gains
  per region the time of the last Live Activity update. `state` and `map` records are unchanged.
- Public contract: a new endpoint the app calls; APNs payloads the app decodes (`content-state`
  must match its Swift type exactly, or the update fails on the device).
- Must not touch: the web app, `/v1/alerts`, `/v1/map`, the coordinator's polite-load rules,
  `/v1/push/registration`'s contract.

Risk class: **high** (persisted device data, a public contract with the app, a privacy statement,
credentials reused for a new push type).

## Baseline

`6420229` (`main`): `npm run check` exit 0; 156 tests passed in 15 files; trace "37 requirements,
37 approved, all approved cited".

## Spike (read-only research, 2026-11-10)

Apple documentation, read as the documentation JSON of each page:

| Question | Finding | Source |
|---|---|---|
| Headers | `apns-push-type: liveactivity`; `apns-topic: <bundleID>.push-type.liveactivity`; `apns-priority` 5 or 10 | [Starting and updating Live Activities with ActivityKit push notifications](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications), "Construct the ActivityKit remote push notification payload" |
| Priority budget | Priority 10 (also the default) counts toward an hourly budget and may be throttled; priority 5 does not count | same page, "Determine the update frequency" |
| `timestamp` | Seconds since 1970 | same page |
| Start payload | `event: start`, an `alert`, `attributes-type` and `attributes` are required | same page, "Construct the payload that starts a Live Activity" |
| `input-push-token: 1` | iOS 18 and later: starts the activity and issues a new update token; the system wakes the app, which receives the token (through the activity's `pushTokenUpdates`) and sends it to the server | same page, "Start Live Activities with ActivityKit push notifications" |
| Push-to-start token reuse | The token "allows you to start new Live Activities"; it can change, and the server updates it and invalidates the old one. No single-use rule is stated | same page, same section |
| `content-state` | Must match `ContentState`; the system decodes with default strategies, custom strategies fail | same page |
| `Date` default | `JSONDecoder`'s default date strategy is `deferredToDate`; `Date`'s reference date is 2001-01-01 00:00 UTC | [dateDecodingStrategy](https://developer.apple.com/documentation/foundation/jsondecoder/datedecodingstrategy-swift.property), [timeIntervalSinceReferenceDate](https://developer.apple.com/documentation/foundation/date/timeintervalsincereferencedate-swift.property) |
| `end` and dismissal | Include the final content state; default removal up to 4 h after the end; `dismissal-date` in the past removes at once, else within a 4-hour window | first page, "End the Live Activity with a custom dismissal date" |
| Late pushes | The system ignores a push that arrives after the activity ended | first page |
| Lifetime and size | Active at most 8 h, then ended by the system, on the Lock Screen at most 4 h more; data at most 4 KB | [Displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities) |
| Time-sensitive | `aps."interruption-level"`: `passive`, `active`, `time-sensitive`, `critical` | [Generating a remote notification](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification) |
| `apns-expiration` | UNIX seconds; 0 = one attempt, not stored | [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) |
| Answers | 410 `Unregistered` / `ExpiredToken`; 400 `BadDeviceToken`, `DeviceTokenNotForTopic`; do not retry those; 429 may be retried later | [Handling notification responses from APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns) |

Documentation gaps (not stated by Apple; each is checked in Group 0 or settled by the app's tests):
- G1 The unit of `stale-date` and `dismissal-date` is not named; the `dismissal-date` example
  (`1663177260`) is UNIX seconds, so both are taken as UNIX seconds.
- G2 That `Date` encodes as seconds since the reference date under `deferredToDate` is not stated
  ("formatting from the Date structure"); the app spec assumes it. A shared fixture decoded by an app
  test closes it.
- G3 Whether `"attributes": {}` decodes for an attributes type with no stored property.
- G4 Whether APNs answers an update or end to the token of an ended activity with an error or with
  200 (the system "ignores" it); the server cannot rely on an error to clear such a token.
- G5 Whether `interruption-level` inside a Live Activity `alert` has any effect.
- G6 Whether `apns-expiration` applies to `liveactivity` pushes the same way.
- G7 No limit on how often one push-to-start token may start activities is stated.

Cloudflare (from spec 003's Spike, unchanged, and the DO pricing page re-read 2026-11-10): Free plan
50 subrequests per invocation (DO alarm value not stated separately); daily 100,000 DO requests
(alarm invocations count on Paid, not stated for Free), 100,000 rows written, 5 M rows read; deletes
count as rows written; each `setAlarm()` is one row written; whether an index adds written rows is not
stated ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

## Budget, worst case: all 25 regions in alarm all day

Terms: N notice devices, L Live Activity records holding an activity token. Baseline writes per day,
from spec 003's figures: 2,880 `setAlarm` + 2,880 status record + about 5,760 coordinator writes =
**11,520** (web traffic not counted). One 5-minute update cycle sends L pushes; 288 cycles a day.
An invocation sends at most 45 and re-arms in 1 s (one `setAlarm`, one DO request); at about
150 ms per round of 6 parallel sends, one invocation of 45 takes about 2.2 s.

| L | Update pushes / day | Invocations / day (288 × ⌈L/45⌉) | Rows written, option B | DO requests (alarm only) |
|---|---|---|---|---|
| 100 | 28,800 | 864 | 12,384 | 3,744 |
| 1,000 | 288,000 | 6,624 | 18,144 | 9,504 |
| 6,000 | 1,728,000 | 38,592 | 50,112 | 41,472 |
| 10,000 | 2,880,000 | 64,224 | 75,744 | 67,104 |

- Option A (every update through the outbox): each push costs an insert and a delete, 2 rows, or 4
  if the `UNIQUE (token, change_id)` index counts. Then L ≤ 88,480 / (288 × (2 to 4)) ≈ **76 to
  152** records before the daily write limit, after which the coordinator's own writes fail until
  00:00 UTC (`src/coordinator.ts:224-231`).
- Option B (updates read straight from the record table): about 1/45 row per push, so the write
  limit allows L ≈ **13,800**; the time limit is lower: 300 s / 2.2 s ≈ 136 invocations ≈ **6,100**
  updates per 5-minute cycle; above it cycles overrun, and the 5-minute outbox lifetime drops queued
  events. DO requests reach 67,104 at L = 10,000, which with web traffic can pass 100,000 (spec 001
  D1: about 35 always-open pages reach it alone).
- Events, if every region starts and clears once, N = L = 1,000: 2N + 3L = 5,000 pushes through the
  outbox (start notice, `start`, all-clear notice, `update`, `end`), 10,000 to 20,000 rows and 112
  invocations; without the separate green `update` (Points to decide P3), 4,000 pushes.
- Rows read for option B: 288 × L per day (2.88 M at 10,000), within 5 M.
- Subrequests per invocation: at most 45 sends plus the feed request and its retry = 47 ≤ 50, as
  in spec 003.

## Approach

Options for the 5-minute updates, neutral order:

- **A. Everything through the outbox.** Each update is an outbox row of kind `la-update`, like the
  events. Cost: smallest code change (one queue, one sender), at-most-once per row. Risk: the write
  budget allows only about 76 to 152 records in a whole-day all-region alarm. Counterargument: fails
  the Free plan at a size a small app can reach.
- **B. Events through the outbox, updates straight from the records.** Notices, `start`, `end`
  (and a green `update` if kept) are outbox rows; the 5-minute update walks
  `push_live_activities` of the due regions with an in-memory cursor, 45 per invocation. A lost
  cursor (object evicted) restarts the walk and repeats some updates, which is harmless: an update is
  idempotent and `timestamp` orders it. Cost: a second send path; risk: duplicate updates after an
  eviction. Counterargument: two send paths with different delivery guarantees to test.
- **C. Broadcast channels.** One channel per region; `start` with `input-push-channel`, updates and
  `end` as one broadcast per region. Cost: changes the app's contract (token push type), needs the
  broadcast capability enabled on the Developer portal and channel management requests to APNs.
  Counterargument: outside both specs; the app is built for tokens.

Agent's lean: **B**, with a record cap (Points to decide P8) below the measured cycle limit.

Change detection: `detectChanges` returns `started` (alarm after a clear seen at most `GAP_MS`
earlier) next to `cleared`; the `statuses` record keeps, per region, `lastUpdateAt`, the time of the
last Live Activity start or update, so the update is due on the first fresh, processed snapshot at
least 5 minutes after it. A region in alarm whose alarm the server did not see start (cold start, or
an activity the app started itself) still gets updates and the `end`, since each carries the fresh
state; a region in alarm with no fresh snapshot gets nothing, and the activity turns stale at its
stale date (AC-5).

Sending: `push_outbox` gains `kind` (`allclear`, `alertstart`, `la-start`, `la-end`, and
`la-quiet` if kept); notice kinds join `push_devices`, Live Activity kinds join
`push_live_activities`. A Live Activity row holds the start token (the record's key) and the
`UNIQUE (token, change_id)` dedupe works on it; the activity token is read from the record at send
time, so a PUT that replaces it before the send is honoured, and a DELETE of the record removes its
queued rows as `deleteDevice` does today (`src/push/registry.ts:101-107`). One sender dispatches by
kind; the answer handling deletes the record for
a gone start token and clears `activity_token` for a gone activity token. After an `end` is sent,
the server clears that `activity_token`.

## Files and types

- `src/push/liveActivity.ts`: `parseLiveActivity(body)`, `parseLiveActivityDeletion(body)`,
  `LiveActivityRecord`, `contentState(region, lang, snapshot, phase)`, `startPayload`,
  `updatePayload`, `endPayload`, `appleReferenceSeconds(ms)`; reuses `regionFromAppCode`,
  `checkedAt` and `REGIONS`.
- `src/push/text.ts`: `alertStartText(regionId, lang)`, `alertStartPayload`, `sourceLabel(source,
  lang)`.
- `src/push/registry.ts`: `push_live_activities (start_token PRIMARY KEY, region, env, lang,
  activity_token, last_seen)` with indexes on region and last_seen, a record counter, `kind` on the
  outbox, `enqueueLiveActivity`, `liveActivitiesIn(region, after, limit)`, `clearActivityToken`.
- `src/push/changes.ts`: `started`, `updateDue`, `lastUpdateAt` in `RegionStatus`.
- `src/push/alarm.ts`: runs while `countDevices() + countLiveActivities() > 0`.
- `src/push/apns.ts`: `apnsRequest(item)` chooses push type, topic, priority and expiration by kind;
  `classify` unchanged, its consequence by token kind.
- `src/router.ts`: `/v1/push/live-activity` PUT and DELETE; `src/worker.ts`: the RPCs.

## Tests

| AC | Test | Discriminating cases |
|---|---|---|
| AC-1 | `REQ-PUSHAPI-008 PUT and DELETE of a Live Activity record` | valid without `activityToken` → 204, one row, `activity_token` NULL; same `startToken` with `activityToken` → still one row, token set; then without it → token cleared; extra key `"token"` → 400; `activityToken: null` → 400 (the app omits it); `region: "kyiv-city"` → 400; uppercase hex → stored lowercase; DELETE unknown → 204; GET → 405; no `access-control-allow-origin`; a record does not create a `push_devices` row |
| AC-2, AC-5 | `REQ-PUSH-008 an alarm after a recent clear starts once` (one test, one clock) | clear at t, alarm at t+600,000 ms → one notice per device and one `start` per record in that region, none in another; alarm at t+600,001 → none; same alarm on the next poll → none; cold start in alarm → none; stale snapshot → none and no baseline write |
| AC-2 | `REQ-PUSH-008 notices and Live Activities are independent` | region with 1 notice device and no record → 1 notice, 0 `start`; 0 devices and 1 record → 0 notices, 1 `start`, and the alarm keeps polling |
| AC-3 | `REQ-PUSH-008 updates every 5 minutes while the alarm lasts` (one clock) | `start` at t; fresh snapshots every 30 s → `update` at the first snapshot ≥ t+300,000 ms, not at t+270,000; record without `activityToken` → no update; priority 5; `stale-date` = check + 900 s; feed stale at the due time → none, and the next fresh one sends it |
| AC-4 | `REQ-PUSH-008 a fresh clear ends the activity in green` | alarm → clear within 10 min → all-clear notice and one `end` with phase `quiet`, `dismissal-date` = send second + 300, priority 10, no `update` before it; then `activity_token` cleared and no further push; clear after a gap of 11 min → `end` but no notice; cold start clear with a held token → `end`; record without token → no `end`; an `end` answered 500 → token cleared, not sent again |
| AC-5 | `REQ-PUSH-008 nothing is sent on a stale, rate-limited or unknown feed` | 429 window open → nothing; region missing from the feed → nothing; stale clear → no `end` |
| AC-10 | `REQ-PUSH-008 a region change moves the activity` | record holding a token moves Kharkiv → Lviv in alarm → one `update` titled "Lviv Oblast", phase `alarm`; moves to a clear region → one `end` titled with the new region, `quiet`; move without a token → nothing; move while the feed is stale → nothing |
| AC-11 | `REQ-PUSHAPI-008 at most 5,000 records` | 5,000 stored, new start token → 503 and no row; known start token → 204 |
| AC-12 | `REQ-PUSHAPI-013 an urgent key is refused like any unknown key`, `REQ-PUSHAPI-013 every alert start breaks through Focus, the all-clear never does` | `urgent` true or false → 400 on both endpoints, the body without it → accepted; three devices and three records → every alert start `time-sensitive`; the all-clear to the same three → never `time-sensitive`; every push `drivecheck.caf` |
| AC-6 | `REQ-PUSHAPI-012 the alert-start text in three languages` | uk Kharkiv → "Повітряна тривога: Харківська область"; en Kyiv city → "Air raid alert: Kyiv"; ru Odesa → "Воздушная тревога: Одесская область"; notice has `"interruption-level": "time-sensitive"` and `"sound": "drivecheck.caf"`, never `critical` |
| AC-6 | `REQ-PUSHAPI-010 the payloads decode as the app's content state` | `content-state` keys exactly {phase, regionTitle, checkedAt, sourceLabel, isStale}; `checkedAt` for 2026-11-10T00:00:00Z = 815,961,600; `timestamp` = 1,794,268,800 for the same instant; headers `liveactivity`, topic `vil4max.RegionalCheck.push-type.liveactivity`; `start` has `attributes-type`, `attributes: {}`, `input-push-token: 1`, `alert`; every payload ≤ 4096 bytes; `source` "Mørk Skogen" → "Alert feed", "fixture" → "External feed" |
| AC-7 | `REQ-PUSHAPI-009 a record keeps six fields for 60 days` | row keys exactly the six; 60 d − 1 ms kept, 60 d + 1 ms pruned with its outbox rows; captured logs contain neither token |
| AC-8 | `REQ-PUSHAPI-011 APNs answers by token kind` | `start` 410 → record deleted; `update` 410 → record kept, `activity_token` NULL; 400 `BadDeviceToken` on `end` → token cleared; 429, 500 → nothing changed, no retry |
| AC-9 | `REQ-PUSHAPI-003 the alarm runs while either store has an entry` | first Live Activity PUT with no devices arms the alarm; last DELETE of both → no re-arm; an update walk of 100 records → 45, 45, 10 per invocation, at most 47 subrequests with the poll; an eviction mid-walk → walk restarts, no record skipped |
| — | existing spec 003 tests | unchanged; an outbox row from before the migration is sent as an all-clear |

## Risks

Collision audit (read-only):

| Source | Behaviour implied | Scope | Decision that stands |
|---|---|---|---|
| `specs/003-allclear-push/spec.md:20` Goal | "Nothing else is pushed: no alert-start push" | push | owner, 2026-11-10 (app spec ALERT-push) widens it; spec 003 gets a pointer to spec 004 |
| `specs/003-allclear-push/spec.md:133` Out of scope | "An alert-start push, ... Live Activity updates" | push | same; superseded by spec 004 |
| `specs/003-allclear-push/spec.md:37-39`, REQ-PUSHAPI-002 `:74-81` | the server keeps only five fields per device | stored data | owner, 2026-11-10 (app plan point 2a, privacy text widened); a second record kind, REQ-PUSHAPI-009 |
| REQ-PUSHAPI-003 `:87-90`, `src/push/alarm.ts:83,91` | the alarm stops once no device is registered | alarm loop | changes: also counts Live Activity records (AC-9); no decision needed beyond this spec |
| REQ-PUSHAPI-006 `:113-120` | the 5-minute lifetime and the default sound are stated for the all-clear only | push text | none found for the new pushes: P4, P5 |
| REQ-PUSHAPI-007 `:126-129` | at most 10,000 devices | registry | none found for Live Activity records: P8 |
| `README.md:24-28` | the only push endpoint is `/v1/push/registration`; one all-clear notification | README | amended in Group 5 |
| `README.md:46-55` "Never" | the server keeps five fields for a device that switched the all-clear push on | privacy | owner, 2026-11-10; amended in Group 5 |
| `README.md:43-44` "Polite" | the alarm adds at most one status request per 30 s | load | holds: no new feed request; README adds the Live Activity loop |
| `wrangler.jsonc:12-14` | `APNS_TOPIC` is the bundle id; topic of the all-clear | config | holds; the Live Activity topic is derived from it, no new variable |
| `src/push/apns.ts:138` | `apns-push-type: alert` for every push | sender | changes per kind |
| `src/push/sender.ts:5` | 45 per invocation | sender | holds for both send paths |
| app `specs/ALERT-push/plan.md` Approach 1 | `liveActivityStartToken` in `/v1/push/registration` and `/v1/push/activity {token, activityToken}` | contract | superseded by the app's code at 504d252 and the owner's point 2a; see contract D1 |
| app spec AC-9 vs dispatch rule "a gap of more than 10 minutes sends nothing" | an activity must not hang stale after a missed all-clear, yet a clear after a gap sends no `end` | Live Activity | none found: P1 |

Other risks:
- Free plan throughput: above about 6,100 records holding an activity token, a 5-minute update cycle
  does not finish in 5 minutes (Budget).
- Two alerts at the start: a device with both switches on gets the alert-start notice and the
  `start` alert; the server cannot pair a notice token with a start token (P7).
- Duplicate activity: when the app already holds an activity (it started one in the foreground), a
  `start` creates a second one; the app ends the newer one (app AC-7) while it runs. The app plan
  accepts a short window of two (app plan, Risks). P2.
- Activities longer than 8 hours are ended by the system; later updates are ignored (Spike).
  An alarm that lasts longer leaves no activity until the next alarm; no restart is planned.
- An update token the server keeps after the user removed the activity is never cleared by APNs
  (G4); it costs one ignored push per cycle until the app's next PUT or the 60-day expiry.
- Races: a PUT that changes `activityToken` while a walk is in flight; the walk reads the current
  row per batch, so at most one update goes to the old token. Alarms run one at a time per object.
- Background wake: the app must reach its registrar when the system wakes it for the new token;
  that is app-side and outside this plan.
- Test host: tests never reach APNs or Ubilling; `fetch` is injected (`tests/support.ts`).
- Localization: the alert-start body text has no source (P4).

## Tasks

## Group 0: Spike with the owner's key (no merge)
- [ ] T001 [Owner] A debug build of the app branch with Live Activities on gives a sandbox start token.
- [ ] T002 Throwaway Worker (not committed to `main`): send `start`, then `update`, then `end` to the sandbox; record each answer and what the device shows; check G1, G3, G4, G6; measure the wall time of one invocation of 45 sends to the sandbox host, which replaces the assumed 2.2 s of "Budget" and sets the cap of P8.

## Group 1: Live Activity endpoint and record
- [x] T003 Test: `REQ-PUSHAPI-008 PUT and DELETE of a Live Activity record`, `REQ-PUSHAPI-009 a record keeps six fields for 60 days` prove AC-1, AC-7. Files: `tests/pushLiveActivity.test.ts`, `tests/router.test.ts`, `tests/pushSupport.ts`
- [x] T004 Implement: `src/push/liveActivity.ts` parsing, table and counter in `src/push/registry.ts`, router path, `worker.ts` RPCs, prune in the alarm.

## Group 2: Payloads and text
- [x] T005 Test: `REQ-PUSHAPI-010 the payloads decode as the app's content state`, `REQ-PUSHAPI-012 the alert-start text in three languages` prove AC-6. Files: `tests/pushPayloads.test.ts`
- [x] T006 Implement: payload builders, `alertStartText`, `sourceLabel`. Files: `src/push/liveActivity.ts`, `src/push/text.ts`

## Group 3: Detection, events and the alarm
- [x] T007 Test: the `REQ-PUSH-008` start, independence, end, move and lifetime tests, `REQ-PUSHAPI-003 the alarm runs while either store has an entry` prove AC-2, AC-4, AC-5, AC-9, AC-10. Files: `tests/pushAlertStart.test.ts`
- [x] T008 Implement: `started`, `quiet` and `alarm` in `changes.ts`, the end sweep and the move row, outbox `kind` with its migration, enqueue in `alarm.ts`, alarm run condition.

## Group 4: Sender and updates
- [x] T009 Test: `REQ-PUSH-008 updates every 5 minutes while the alarm lasts`, the start, end and move sending tests, `REQ-PUSHAPI-011 APNs answers by token kind`, `REQ-PUSHAPI-004 the update walk sends at most 45 per invocation` prove AC-3, AC-4, AC-8, AC-9, AC-10. Files: `tests/pushLiveActivitySender.test.ts`
- [x] T010 Implement: per-kind request in `apns.ts`, dispatch and token clearing in `sender.ts`, the update walk of the chosen option. Files: `src/push/apns.ts`, `src/push/sender.ts`, `src/push/alarm.ts`

## Group 5: Docs and approval of requirements
- [x] T011 Docs: requirement statuses to approved; README endpoints, "Never", "Polite"; spec 003 pointers to spec 004. Files: `specs/004-alert-push-live-activity/spec.md`, `specs/003-allclear-push/spec.md`, `README.md`

Deploy and an end-to-end run on a TestFlight device follow the owner's separate approval; the app
branch merges only after the server is deployed.

## Review lows

Independent review, 2026-11-10 (spec-driven-dev code-reviewer, on the change after 6420229 up to
the docs group): no high findings; three mediums, all test gaps, repaired with tests in
`tests/pushEdges.test.ts`:
- M1 the 45-send budget shared by queued events and the update walk: now tested.
- M2 nothing sent for a rate-limited feed or a region missing from the feed: now tested for Live
  Activity pushes.
- M3 the migration of a spec 003 outbox: tested on the old schema with a queued row and a second
  start. The column changes now run as numbered migrations tracked in `push_state` instead of an
  `ALTER` that relied on a duplicate-column error, since Durable Object SQLite has no
  `PRAGMA user_version` (Cloudflare, "Rules of Durable Objects").

Lows:
- L1 a queued `end` kept its old region after a move: repaired; an end and a move show the record's
  region at send time, and a move replaces a pending end, so a record gets one push.
- L2 a queued `start` was not re-checked: repaired; a start goes only to a region the last fresh
  snapshot still shows in alarm.
- L3 the AC-7 log assertion checked nothing: repaired; the test now sends through a refusing APNs
  and checks every log line, and that the expired record's queued push goes with it.
- L4 the update walk kept sending from a stale snapshot: repaired; the walk stops once the last
  fresh snapshot is stale.
- L5 no behavioural test goes through `src/worker.ts` (its wiring was checked by reading): not
  fixed; the Worker runtime is not available to the unit tests. Backlog.
- L6 the token regex was copied: repaired with the urgent-switch commit (shared helpers).

The urgent switch (P10) arrived after the review and was not reviewed by it.

Second review, 2026-11-10 (same reviewer, fresh context, on the urgent switch and the repairs
above): no high or medium findings; six lows, tests in `tests/pushEdges.test.ts`:
- R1 a queued end that resolves to a red update did not check freshness: repaired; a red update
  needs a fresh snapshot like a move, a green end does not.
- R2 a queued start kept its queued region after a move: repaired; every Live Activity push takes
  the record's region at send time, so a start goes to the new region only if it is in alarm.
- R3 a walk abandoned on a stale feed left its regions due 5 minutes after planning: repaired; the
  alarm forgets their last update time, so the next fresh poll walks them again.
- R4 AC-1, the API contract and REQ-PUSHAPI-008 did not name the optional `urgent`: repaired.
- R5 a stale "six fields" comment on the record type: repaired.
- R6 migrations run in the coordinator's constructor, so a failing step would take down
  `/v1/alerts` too; the one known case is a database created by the unreleased commit f4236d5,
  which has `kind` but no `schemaVersion`. Not fixed: nothing persisted ran that build; checked
  before deploy.

Third review, 2026-11-10 (same reviewer, fresh context, on the commit that removes the urgent
switch): no high or medium findings; four lows:
- U1 the AC-6 row of the Tests table still named `active`: repaired.
- U2 a local database where the removed urgent migration ran keeps an unused column and a version
  above the list, so a later migration would be skipped there: not fixed in code; only local
  `wrangler dev` state from the branch can have it, and nothing was deployed with it.
- U3 the spec 003 migration test checked one absent column: repaired; it pins the five columns.
- U4 the 400 for an `urgent` body was proved at the parser only: repaired; both endpoint tests
  refuse it and store nothing.

Budget correction: Cloudflare's SQLite storage page states that every index row update counts as
an extra row written, so option A costs the upper figure, 4 rows per queued push.

## Verification

`npm run check` and `npm run bundle` per group; Group 0's device observations; `wrangler dev` with a
local PUT, DELETE and a forced alarm against a fake APNs host.

## Contract check against the app (504d252)

Matches: endpoint path and methods, body fields and their formats (`LiveActivityPushRecord`), the
record keyed by start token and independent of the notice switch, PUT on any change and every 7
days, PUT-new-then-DELETE-old on a token change, 2xx as success, the topic, the content-state type,
`checkedAt` as a default-encoded `Date`, phases `alarm` and `quiet`, the 15-minute stale date, the
5-minute dismissal, the notice and its titles. Differences:

- D1 The app's plan, Approach 1, still describes the earlier contract (`liveActivityStartToken` in
  `/v1/push/registration`, and `/v1/push/activity {token, activityToken}`); its code, its decision
  2a and the dispatch use `/v1/push/live-activity` keyed by `startToken`. This plan follows the code;
  the app's plan text should be corrected by its session.
- D2 "`sourceLabel`: the value the app sends": the app sends no source label to the server. It writes
  `StatusSourceLabel.displayName(source)` into the content state, localized, and the Live Activity
  view does not show it (`RegionalCheckWidgets/DriveCheckLiveActivity.swift` reads only `regionTitle`
  of the text fields). B10 reproduces the app's rule.
- D3 The alert-start notice has a title only; the app's sources give no body and no sound (P4).
- D4 The app's AC-9 asks that an activity never hangs stale after a missed all-clear; the gap rule
  blocks an `end` after a gap of more than 10 minutes (P1).
- D5 `activityToken` is absent, never `null`, when the app holds no activity; this plan refuses
  `null`, following spec 003's strict validation (D2 there).
- D6 The app's plan Risks give priority 10 for `start` and `end`; the dispatch states it for `start`
  only. This plan uses 10 for both.

## Points to decide

Plan critic findings (separate pass, 2026-11-10), unchanged, each with the agent's proposed answer:

1. [2] plan "Sending" and P5, `src/push/alarm.ts:14,81`: every outbox row older than 5 minutes is
   deleted unsent, so an `end` given a longer lifetime (P5) would still be dropped after 5 minutes ->
   decide the outbox lifetime per kind. Proposed: each kind's row lives as long as its push's
   `apns-expiration`; owner decides with P5.
   - Decision: accepted, each queued row lives as long as its push's lifetime (owner, 2026-11-10).
2. [4] spec AC-5 ("a cold start ... sends no `update` and no `end`") and plan "Change detection"
   (a cold-start region in alarm still gets updates and the `end`): the plan and the spec disagree ->
   decide which holds. Proposed: as P1 (b): `update` and `end` follow any fresh state of a held
   activity token, notices and `start` keep the confirmed-change rule, and AC-5 is narrowed to them;
   owner decides with P1.
   - Decision: accepted, `update` and `end` follow any fresh state, and AC-5 is narrowed to
     notices and `start` (owner, 2026-11-10).
3. [1] plan "Change detection" and "Sending": a record whose `region` changes while its activity
   runs is walked under the new region, so the old region's red activity is never updated or ended
   when the new region is quiet -> decide what a region change does to a held activity. Proposed: a
   PUT that changes the region of a record holding an activity token queues one push with the new
   region's fresh state, `update` if it is in alarm, `end` if it is clear. Owner decides.
   - Decision: accepted, kept simple: the region follows the driver's location in the app, so a PUT
     that moves a record holding an activity sends one push with the new region's fresh state under
     the new region's name, a red `update` in alarm, the green `end` with the 5-minute dismissal when
     clear; a stale red for the old region must never stay on screen (owner, 2026-11-10; spec AC-10).
4. [2] plan "Sending", `src/push/registry.ts:46-53,101-107`: the plan did not say which token a Live
   Activity outbox row holds, so the dedupe key, a token change before the send and a DELETE with
   queued rows were undefined -> decide the key. Proposed: the start token, the activity token read
   at send time. Fixed in the plan ("Sending").
   - Decision: accepted (owner, 2026-11-10).
5. [3] plan "Budget" (about 150 ms per round, 2.2 s per invocation): the throughput limit of about
   6,100 records and the cap of P8 rest on an unmeasured latency -> measure it before the cap is set.
   Proposed: Group 0 measures one invocation of 45 sends. Fixed in the plan (T002).
   - Decision: accepted; Group 0 waits for the owner's debug build (owner, 2026-11-10).

Questions for the owner beyond the critic, neutral order of options, the agent's lean last:

- P1 `end` after a gap. (a) Keep the gap rule for every push: a clear after a feed gap of more than
  10 minutes sends nothing, and the activity stays red and stale up to its 8-hour limit.
  Counterargument: contradicts the app's AC-9. (b) The gap rule holds for notices only; a fresh
  clear always sends `end` to a held activity token. Counterargument: widens AC-5 and the shared
  REQ-PUSH-008 text. Agent's lean: (b), since `end` shows a fresh state and no notice is sent.
  - Decision: (b), stated more strongly: once a region is clear in a fresh feed, the activity always
    ends in green, also after a gap or a cold start, and the green stays visible for 5 minutes; it
    never vanishes from red. The gap and cold-start rule holds for notices and `start` only; spec
    AC-4 and AC-5 amended (owner, 2026-11-10).
- P2 A record that already has an activity token at an alarm start. (a) Always `start`, as the
  contract says; the app ends the extra one. Counterargument: two activities while the app is not
  running. (b) `update` the held token to red with an alert instead. Counterargument: a token of an
  activity the user removed is silently ignored (G4), so no red activity appears. Agent's lean: (a).
  - Decision: (a), always `start` (owner, 2026-11-10).
- P3 The green `update` before `end`. (a) Send both, as the dispatch says. Counterargument: one
  extra push per record; Apple puts the final content in `end`. (b) Send `end` only, with the green
  content. Counterargument: deviates from the dispatch text. Agent's lean: (b).
  - Decision: (b), one `end` with the green final content and the 5-minute dismissal; the green is a
    separate, visible all-clear state (owner, 2026-11-10).
- P4 Alert-start body and sound: no source. Proposed: no body, default sound as the all-clear.
  Owner decides.
  - Decision: accepted, title only and the default sound (owner, 2026-11-10).
  - Decision changed (owner, 2026-11-10, later the same day): the sound of every push from this
    server, the all-clear included, is `drivecheck.caf`, a short, calm custom sound the app will
    bundle; iOS plays the default sound while a build lacks it. Spec 003 REQ-PUSHAPI-006 amended.
- P5 Lifetimes (`apns-expiration`) of the new pushes: no source. Proposed: 5 minutes for the
  notice, `start` and `update`; for `end`, 4 hours, so a late `end` still clears a red activity.
  Owner decides.
  - Decision: accepted (owner, 2026-11-10).
- P6 The Live Activity alert's interruption level: no source, and its effect is not documented
  (G5). Proposed: the same `time-sensitive` as the notice. Owner decides.
  - Decision: accepted, time-sensitive (owner, 2026-11-10).
  - Decision changed (owner, 2026-11-10, later the same day): pushes are calm and informational,
    not alarming; the alert-start notice and the Live Activity alert use the normal level
    `active`, never `time-sensitive` or `critical`. This replaces the time-sensitive notice of the
    app's plan as well; the app's time-sensitive entitlement is no longer needed by this server.
- P7 Two alerts at the start for a device with both switches on (Risks). (a) Accept both, as the
  contract says. Counterargument: the driver hears two alerts for one event. (b) Send the `start`
  without `alert`. Counterargument: Apple requires an `alert` in `start`. (c) The app stops
  registering the notice token while Live Activities are on. Counterargument: app change, and a
  driver who removes the activity loses the alert. Agent's lean: (a).
  - Decision: (a), two alerts accepted (owner, 2026-11-10).
- P8 Cap on Live Activity records: no source. Proposed: 5,000, answering 503 above it as
  REQ-PUSHAPI-007, below the 6,100 cycle limit. Owner decides.
  - Decision: accepted, 5,000, revisited after Group 0 (owner, 2026-11-10).
- P9 The fan-out option A, B or C (Approach). Agent's lean: B.
  - Decision: B (owner, 2026-11-10).
- P10 Added by the owner after the calm-push change (2026-11-10): an in-app switch, off by
  default, lets a driver choose to have alerts break through Focus.
  - Decision (owner, 2026-11-10): an optional `urgent` boolean in both PUT bodies, stored with the
    record, absent meaning false so older builds keep working, any other value refused with 400;
    with it on, that device's alert-start notice and Live Activity `start` alert are
    time-sensitive, otherwise active; the all-clear stays active for everyone, and the sound is
    `drivecheck.caf` in every case. Spec AC-12 and REQ-PUSHAPI-013; the app adds the field on its
    side.
  - Decision changed (owner, 2026-11-10, later the same day): no app switch. Whether an alert
    breaks through Focus is the user's system setting (Time Sensitive Notifications for the app in
    Settings), so neither PUT body takes `urgent` and a body with it is refused like any unknown
    key; no column stores it. The alert-start notice and the Live Activity `start` alert are always
    `time-sensitive`, the all-clear stays `active`, and every push plays `drivecheck.caf`. The app
    drops the field on its side, and it needs the Time Sensitive Notifications capability again
    (the note under P6 that it was no longer needed no longer holds). AC-12 and REQ-PUSHAPI-013 are
    rewritten to this rule; the one migration left adds `kind` to the outbox.

How the decisions shape the build (Stage 2):
- The all-clear `end` needs no confirmed change: each fresh, newly processed snapshot queues one
  `end` for every record holding an activity token in a region that snapshot shows clear. This one
  rule covers the confirmed all-clear, a gap, a cold start and a record moved into a clear region.
- An `end` is tried once; its activity token is then cleared whatever APNs answers, so it is not
  repeated (spec AC-8).
- The 5-minute updates walk the records of each region in alarm, from memory (option B); the
  per-region update times are memory only, so after an eviction a region in alarm is updated at once.
- Queued Live Activity rows that need the feed state (`start`, `end`, the region-change push) take
  it from the last fresh snapshot the alarm processed; with none in memory the row is dropped unsent,
  and the region-change push also needs that snapshot to be fresh when it is sent.
