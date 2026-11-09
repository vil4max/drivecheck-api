# Feature specification: all-clear push (server)

Feature: `003-allclear-push` · Created: 2026-11-09
Status: draft; the requirements below are `proposed` until the owner approves the plan
([plan.md](plan.md)), as spec 001's were (its O1).
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
opening the app. Nothing else is pushed: no alert-start push, no history, no account.

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
  language and the time it last heard from the device; it drops a device not heard from for 60
  days, logs no token, and keeps no alert history.
- **AC-7** The notification text exists in English, Ukrainian and Russian.
- **AC-8** (server only) The alarm polls the feed every 30 s only while at least one device is
  registered, through the existing coordinator, so the 10 s floor and the 429 window still hold.

## API contract (from the app's plan, "Contract")

- `PUT /v1/push/registration`, JSON body `{"token","region","env","lang"}`: `token` hex,
  `region` an iOS `AlertRegion` raw value (`kyivCity`, `ivanoFrankivsk`, ...), `env`
  `production|sandbox`, `lang` `en|uk|ru`. Answer 204. The same token again replaces its record and
  refreshes its last-seen time.
- `DELETE /v1/push/registration`, JSON body `{"token"}`. Answer 204, also for an unknown token.
- Any other body: 400; any other method on the path: 405.

## Requirements

### REQ-PUSH-002 — The server pushes only on a confirmed change

Status: proposed (shared with the app; enforced and tested here)

Given the feed is fresh and a region's previous confirmed status was an alarm seen at most 10
minutes earlier\
When the feed shows the region clear\
Then each opted-in device of that region gets one notification; a stale, failing or unknown feed, a
cold start or a longer gap sends nothing (REQ-SURF-009)

### REQ-PUSHAPI-001 — Registration endpoint

Status: proposed

Given a request to `/v1/push/registration`\
When it is a `PUT` with exactly the four valid fields, or a `DELETE` with a token\
Then the server stores or replaces, or deletes, that one device record and answers 204; a body with
a missing, extra or invalid field answers 400 and stores nothing; the response opens no CORS access

### REQ-PUSHAPI-002 — Only five fields, 60 days

Status: proposed

Given the server keeps a device\
When it stores or logs anything about it\
Then the record holds only token, region, environment, language and last-seen time, a record not
refreshed for 60 days is deleted, and no log line contains a token

### REQ-PUSHAPI-003 — Polling only while needed

Status: proposed

Given at least one device is registered\
When the Durable Object alarm fires\
Then it asks the coordinator for the feed at most once per 30 s, never past the coordinator's floor
or 429 window, and it stops re-arming once no device is registered

### REQ-PUSHAPI-004 — Batches within the Free plan

Status: proposed

Given a change to send\
When an invocation sends pushes\
Then it sends at most 45, marks each as sent before sending it, and arms the next invocation for the
rest

### REQ-PUSHAPI-005 — APNs answers

Status: proposed

Given APNs answers a push\
When the status is 410, or 400 with `BadDeviceToken` or `DeviceTokenNotForTopic`\
Then the device record is deleted; other answers delete nothing (whether a 429 or 5xx push is
retried is open: plan, Points to decide)

## Out of scope

An alert-start push, other threat types, Live Activity updates, neighbouring regions, the web app
(no Web Push), creating or rotating the APNs key, App Store Connect changes.

## Decisions

- 2026-11-09 (owner): approach A, a Durable Object alarm, falling back to a Cron Trigger if the
  alarm does not fit the Free plan CPU limit; the 10-minute gap rule; stored fields token, region,
  env, lang, last-seen; the fallback region is never registered (enforced by the app, REQ-PUSH-004);
  30 s polling; 60-day expiry; storing the device token and region is approved, which amends the
  README "Never" rule and REQ-API-003 (spec 001).
