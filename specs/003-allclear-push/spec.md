# Feature specification: all-clear push (server)

Feature: `003-allclear-push` · Created: 2026-11-09
Status: approved by the owner on 2026-11-09 with the plan ([plan.md](plan.md), Points to decide),
as spec 001's requirements were (its O1).
App side: `regional-check`, spec `specs/ALLCLEAR-push/` and `docs/requirements/push.md`
(REQ-PUSH-001 to REQ-PUSH-007), branch `claude/allclear-push`. That spec and its plan are the source
of the API contract below.

## Request

Paraphrased; this public repository records decisions, not quotes. On 2026-11-09 the owner decided
that the server sends an "all clear" push to an opted-in iPhone when the air-raid alert in its
region ends, from this free Worker (Durable Object, alarm or Cron, APNs with a token), and approved
storing the device token and region. The APNs key is the owner's; he creates and stores it himself.

## Goal

A driver who opted in on iOS gets one notification when the alert in their region ends, without
opening the app. Nothing else is pushed: no alert-start push, no history, no account. (Widened on
2026-11-10 by [spec 004](../004-alert-push-live-activity/spec.md): the alert-start notice and the
server-driven Live Activity.)

## Acceptance criteria

Numbered as in the app's spec (`regional-check` `specs/ALLCLEAR-push/spec.md`), server half only.

- **AC-1** Given an opted-in device whose region goes from alarm to clear in a fresh feed, and the
  alarm was last confirmed at most 10 minutes earlier, then the device gets one notification for
  that region; a region that was already clear sends none.
- **AC-2** Given a stale, failing or rate-limited feed, a cold start, or a gap of more than 10 minutes
  since the last confirmed alarm, then no all-clear push is sent.
- **AC-3** Given `DELETE /v1/push/registration` with a token, then the server forgets that token and
  its region at once.
- **AC-4** Given APNs answers that a token is unregistered, expired or bad, then the server deletes
  it; any other error deletes nothing.
- **AC-5** Given one change touches more devices than one invocation may send, then following
  invocations send the rest, each within 50 subrequests, and no device gets two pushes for one change.
- **AC-6** The server stores per device only the token, the region code, the APNs environment, the
  language, the urgent switch (since spec 004) and the time it last heard from the device; it drops
  a device not heard from for 60
  days, logs no token, and keeps no alert history.
- **AC-7** The notification text exists in English, Ukrainian and Russian.
- **AC-8** (server only) The alarm polls the feed every 30 s only while at least one device is
  registered, through the existing coordinator, so the 10 s floor and the 429 window still hold.

## API contract (from the app's plan, "Contract")

- `PUT /v1/push/registration`, JSON body `{"token","region","env","lang"}`: `token` hex,
  `region` an iOS `AlertRegion` raw value (`kyivCity`, `ivanoFrankivsk`, ...), `env`
  `production|sandbox`, `lang` `en|uk|ru`. Answer 204. The same token again replaces its record and
  refreshes its last-seen time. Since spec 004 the body may also carry `"urgent"`, a boolean,
  absent meaning false.
- `DELETE /v1/push/registration`, JSON body `{"token"}`. Answer 204, also for an unknown token.
- Any other body: 400; any other method on the path: 405.

## Requirements

### REQ-PUSH-002 — The server pushes only on a confirmed change

Status: approved (owner, 2026-11-09; shared with the app, enforced and tested here)

Given the feed is fresh and a region's previous confirmed status was an alarm seen at most 10
minutes earlier\
When the feed shows the region clear\
Then each opted-in device of that region gets one notification; a stale, failing or unknown feed, a
cold start or a longer gap sends nothing (REQ-SURF-009)

### REQ-PUSHAPI-001 — Registration endpoint

Status: approved (owner, 2026-11-09)

Given a request to `/v1/push/registration`\
When it is a `PUT` with exactly the four valid fields (plus, since spec 004, an optional `urgent`
boolean, REQ-PUSHAPI-013), or a `DELETE` with a token\
Then the server stores or replaces, or deletes, that one device record and answers 204; a body with
a missing, extra or invalid field answers 400 and stores nothing; the response opens no CORS access

### REQ-PUSHAPI-002 — Only six fields, 60 days

Status: approved (owner, 2026-11-09; the urgent switch added 2026-11-10, spec 004)

Given the server keeps a device\
When it stores or logs anything about it\
Then the record holds only token, region, environment, language, the urgent switch and last-seen
time, a record not refreshed for 60 days is deleted, and no log line contains a token

### REQ-PUSHAPI-003 — Polling only while needed

Status: approved (owner, 2026-11-09)

Given at least one device is registered\
When the Durable Object alarm fires\
Then it asks the coordinator for the feed at most once per 30 s, never past the coordinator's floor
or 429 window, and it stops re-arming once no device is registered (since spec 004: no device and
no Live Activity record)

### REQ-PUSHAPI-004 — Batches within the Free plan

Status: approved (owner, 2026-11-09)

Given a change to send\
When an invocation sends pushes\
Then it sends at most 45, marks each as sent before sending it, and arms the next invocation for the
rest

### REQ-PUSHAPI-005 — APNs answers

Status: approved (owner, 2026-11-09)

Given APNs answers a push\
When the status is 410, or 400 with `BadDeviceToken` or `DeviceTokenNotForTopic`\
Then the device record is deleted; other answers delete nothing, and no push is retried

### REQ-PUSHAPI-006 — The all-clear text and its lifetime

Status: approved (owner, 2026-11-09)

Given an all-clear push for a region\
When it is built\
Then its title and body are, in the device's language, with the region's name in that language:
en "All clear: {region}" / "The air alert has ended."; uk "Відбій тривоги: {region}" /
"Повітряна тривога закінчилась."; ru "Отбой тревоги: {region}" / "Воздушная тревога окончена.";
it plays the short, calm Drive Check sound the app bundles (`"sound": "drivecheck.caf"`; iOS
falls back to the default sound while a build lacks the file; owner, 2026-11-10, replacing the
default sound decided earlier the same day);
it expires 5 minutes after it is sent (`apns-expiration`), and a queued push older than 5 minutes
is deleted unsent

### REQ-PUSHAPI-007 — Bounded registry and alarm

Status: approved (owner, 2026-11-09)

Given the registry holds 10,000 devices, or a feed refresh hangs\
When a new token is registered, or the alarm has waited 20 s for the feed\
Then the registration answers 503 and stores nothing (a known token still refreshes), and the
alarm processes nothing and re-arms

## Out of scope

An alert-start push and Live Activity updates (both since brought in by spec 004), other threat
types, neighbouring regions, the web app
(no Web Push), creating or rotating the APNs key, App Store Connect changes.

## Decisions

- 2026-11-09 (owner): approach A, a Durable Object alarm, falling back to a Cron Trigger if the
  alarm does not fit the Free plan CPU limit; the 10-minute gap rule; stored fields token, region,
  env, lang, last-seen; the fallback region is never registered (enforced by the app, REQ-PUSH-004);
  30 s polling; 60-day expiry; storing the device token and region is approved, which amends the
  README "Never" rule and REQ-API-003 (spec 001).
- 2026-11-09 (owner, at the plan gate): the host stays `https://drivecheck.vil4max.com`; one APNs
  key enabled for both environments; topic `vil4max.RegionalCheck`; the push texts of
  REQ-PUSHAPI-006; no retry, a 5-minute push lifetime and outbox; the alarm waits at most 20 s for
  the feed; the region statuses are one overwritten record; at most 10,000 devices, 503 above; 400
  and 405 answers and strict body validation. A dashboard rate-limiting rule on the path is
  optional and the owner's.
