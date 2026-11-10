# Feature specification: alert-start push and server-driven Live Activity (server)

Feature: `004-alert-push-live-activity` · Created: 2026-11-10
Status: draft, waiting for the owner's approval with the plan ([plan.md](plan.md), Points to decide).
App side: `regional-check`, branch `claude/alert-push` at 504d252, spec `specs/ALERT-push/` and
`docs/requirements/push.md` (REQ-PUSH-008, REQ-PUSH-009). That spec, its plan with the owner's
answers of 2026-11-10, and the app code on that branch are the source of the contract below; where
the app's plan text and its code differ, the code is quoted and the difference is listed in the
plan.

## Request

Paraphrased; this public repository records decisions, not quotes. On 2026-11-10 the owner decided
that the push should report not only the end of an alert but also its start, and that the push may
start the app's Live Activity: red while the alert lasts, refreshed every 5 minutes, green at the
all-clear, then removed. At the app's plan gate the same day he decided: one switch covers both
notices; the alert-start notice is time-sensitive; Live Activity tokens go to the server whenever
Live Activities are on, keyed by the push-to-start token, whatever the notice switch; the alert-start
wording "Air raid alert: <region>" in three languages; a stale date 15 minutes after the check; the
green activity is removed 5 minutes after the all-clear.

## Goal

A driver learns that the alert in their region started and ended without opening the app: a
time-sensitive notice (if notices are on) and a red Live Activity started by push (if Live
Activities are on) at the start, the activity kept current every 5 minutes while the alert lasts,
and at the all-clear the existing notice plus a green activity that leaves the Lock Screen after
5 minutes.

## Acceptance criteria

Numbered for the server; the app's criteria they serve are in brackets.

- **AC-1** [app AC-2, AC-9] `PUT /v1/push/live-activity` with exactly `startToken`, `region`,
  `env`, `lang` and an optional `activityToken`, each valid, stores or replaces the one record keyed
  by `startToken` and answers 204; `DELETE /v1/push/live-activity` with `{"startToken"}` deletes it
  and answers 204, also for an unknown token. Any other body answers 400 and stores nothing; any
  other method answers 405. The record is independent of `/v1/push/registration`.
- **AC-2** [app AC-3] Given a fresh feed in which a region is in alarm and its previous confirmed
  status was clear, seen at most 10 minutes earlier, then every notice device of that region gets one
  time-sensitive alert-start notice, and every Live Activity record of that region gets one
  Live Activity `start` push; the same alarm on later polls sends nothing more.
- **AC-3** [app AC-4] While that alarm lasts, every record of the region with an `activityToken`
  gets an `update` push at priority 5 about every 5 minutes, carrying the latest fresh check time and
  a stale date 15 minutes after it.
- **AC-4** [app AC-5] Given a confirmed all-clear (spec 003 REQ-PUSH-002), every notice device gets
  the all-clear notice as today, and every record of the region with an `activityToken` gets the green
  content and an `end` push with a dismissal date 5 minutes after it is sent; the server then forgets
  that `activityToken`.
- **AC-5** [app AC-6] A stale, failing, rate-limited or unknown feed, a cold start, or a gap of more
  than 10 minutes since the previous confirmed status sends no notice, no `start`, no `update` and no
  `end`.
- **AC-6** [app AC-8] The alert-start notice and the Live Activity alert exist in English, Ukrainian
  and Russian, and `regionTitle` is the app's region name in the record's language.
- **AC-7** The Live Activity record holds only the start token, the region code, the APNs
  environment, the language, the optional activity token and the time the server last heard from it;
  it is deleted after 60 days without contact; no log line contains a token.
- **AC-8** APNs answers are handled per token: a start token that APNs calls gone or bad deletes its
  record; an activity token that APNs calls gone or bad clears only that token; other answers delete
  nothing, and nothing is retried.
- **AC-9** The polling alarm keeps running while either a notice device or a Live Activity record
  exists, within the existing coordinator rules, and every invocation stays within 50 subrequests.

## API contract (from the app's code at 504d252)

- `PUT /v1/push/live-activity`, JSON body
  `{"startToken","region","env","lang"[,"activityToken"]}`: both tokens lowercase hex, `region` an iOS
  `AlertRegion` raw value (`kyivCity`, ...), `env` `production|sandbox`, `lang` `en|uk|ru`;
  `activityToken` is absent when the app holds no activity (Swift's synthesized `Codable` omits a
  `nil` optional). The app sends it again whenever a field changes and at least every 7 days. Any
  2xx is success for the app; the server answers 204.
- `DELETE /v1/push/live-activity`, JSON body `{"startToken"}`. Answer 204.
- The app sends a new start token as a PUT of the new record followed by a DELETE of the old one.

## APNs payloads (from the app's spec and plan, checked against Apple's documentation in the plan)

Live Activity pushes go to `/3/device/<token>` with `apns-push-type: liveactivity` and
`apns-topic: <APNS_TOPIC>.push-type.liveactivity` (`vil4max.RegionalCheck.push-type.liveactivity`).
`content-state` is `{"phase","regionTitle","checkedAt","sourceLabel","isStale"}`, `checkedAt` in
seconds since 2001-01-01 00:00 UTC; `timestamp`, `stale-date` and `dismissal-date` in seconds since
1970.

- `start` (to the start token, priority 10): `event` `start`, `timestamp`, `attributes-type`
  `DriveCheckActivityAttributes`, `attributes` `{}`, `input-push-token` `1`, `stale-date` = check
  time + 15 min, `alert` with the alert-start text, `content-state` phase `alarm`, `isStale` false.
- `update` (to the activity token, priority 5): `event` `update`, `timestamp`, `stale-date`, phase
  `alarm` with the new check time.
- `end` (to the activity token, priority 10): `event` `end`, `timestamp`, phase `quiet`,
  `dismissal-date` = now + 300 s.
- The alert-start notice (to the notice token, `apns-push-type: alert`, topic `APNS_TOPIC`):
  `aps.alert` with the alert-start text, `aps."interruption-level"` `time-sensitive`.

## Requirements

### REQ-PUSH-008 — Alert start and a server-driven Live Activity

Status: proposed (owner, 2026-11-10; shared with the app, enforced and tested here)

Given a fresh feed in which a region's alarm follows a clear status seen at most 10 minutes earlier\
When the server polls\
Then each notice device of the region gets one time-sensitive alert-start notice, each Live Activity
record of the region gets one `start` push, the activity is updated about every 5 minutes at
priority 5 with a stale date 15 minutes after its check, and at a confirmed all-clear it turns
green and ends with a dismissal 5 minutes later; a stale, failing or unknown feed, a cold start or a
longer gap sends nothing (REQ-SURF-009)

### REQ-PUSHAPI-008 — Live Activity endpoint

Status: proposed (owner, 2026-11-10)

Given a request to `/v1/push/live-activity`\
When it is a `PUT` with exactly the four required fields and at most the optional `activityToken`,
each valid, or a `DELETE` with a start token\
Then the server stores or replaces, or deletes, that one record and answers 204; any other body
answers 400 and stores nothing, any other method 405, and the response opens no CORS access

### REQ-PUSHAPI-009 — Six fields, 60 days

Status: proposed (owner, 2026-11-10)

Given the server keeps a Live Activity record\
When it stores or logs anything about it\
Then the record holds only start token, region, environment, language, optional activity token and
last-seen time, a record not refreshed for 60 days is deleted, and no log line contains a token

### REQ-PUSHAPI-010 — Live Activity payloads

Status: proposed (owner, 2026-11-10)

Given a Live Activity push\
When it is built\
Then it carries the headers and `aps` fields of "APNs payloads" above, the `content-state` decodes
as the app's `DriveCheckActivityAttributes.ContentState`, `regionTitle` is the region's name in the
record's language, and the payload is at most 4 KB

### REQ-PUSHAPI-011 — Answers per token kind

Status: proposed (owner, 2026-11-10)

Given APNs answers a Live Activity push\
When the status is 410, or 400 with `BadDeviceToken` or `DeviceTokenNotForTopic`\
Then a start token's record is deleted, an activity token is cleared from its record, other answers
change nothing, and no push is retried

### REQ-PUSHAPI-012 — The alert-start text

Status: proposed (owner, 2026-11-10)

Given an alert-start notice or a Live Activity `start` for a region\
When it is built\
Then its title is, in the device's language, with the region's name in that language: en "Air raid
alert: {region}"; uk "Повітряна тривога: {region}"; ru "Воздушная тревога: {region}"

## Out of scope

Notices for neighbouring regions, other threat types, broadcast channels (`input-push-channel`), the
web app (no Web Push), monetization, creating or rotating the APNs key, App Store Connect and
Developer portal changes, the app side.

## Decisions

- 2026-11-10 (owner, at the app's plan gate): the request and the answers listed under "Request".
- Spec 003's decisions stand for what this spec does not change: one APNs key for both
  environments, the 10-minute gap rule, no retry, at most 45 sends per invocation, the 20 s feed
  deadline, the 60-day expiry, 400 and 405 answers with strict body validation.

## Assumptions

- The app's minimum iOS is 27 (app plan, Risks), so push-to-start (iOS 17.2) and `input-push-token`
  (iOS 18) are always available.
- The values still open (alert-start body and sound, the push lifetimes, the gap rule for `end`,
  the fan-out design, caps) are listed in the plan's Points to decide and are not filled in here.
