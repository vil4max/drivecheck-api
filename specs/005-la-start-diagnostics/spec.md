# Feature specification: diagnostics for the Live Activity start (server)

Feature: `005-la-start-diagnostics` · Created: 2026-11-12
Status: approved by the owner on 2026-11-12 as point 1 of the app's plan
(`regional-check` `specs/BUG-LA-push-start/plan.md`, task T005). Deploy follows the owner's
separate approval.

## Request

Owner, 2026-11-12, in the app repository: «лайвактисвити запускается только после открыия апп на
карплей», and «пуши приходят, но не запускают лайвактивити - для этого нужен открыть апп». The
Drive Check 3.3.0 alert-start notice arrives, but the server's `start` push does not show the Live
Activity. Today's Worker log cannot tell which step fails: `push batch: N sent` does not say which
kind it sent, and a queued `start` that `resolve` drops is not logged at all.

## Goal

The live Worker log (`wrangler tail --search push`) shows, without any token, whether an alarm
start queued a Live Activity `start` for the region, and what became of each kind of push.

## Acceptance criteria

- **AC-1** When an alarm starts in a region, the alarm log line gives the number of Live Activity
  records the `start` was queued for in that region (`0` included).
- **AC-2** A batch log line gives, per push kind, how many were sent, refused with a deleted token,
  failed, and dropped unsent by `resolve`.
- **AC-3** A push APNs refuses, or one the network does not deliver, is logged with its kind next
  to the APNs status and reason (`push refused: la-start 400 InvalidPushType`).
- **AC-4** No log line holds a device token, a start token or an activity token.

## Requirements

### REQ-PUSHAPI-014 — Push logs say what was queued and sent, by kind

Status: approved (owner, 2026-11-12)

Given an alarm start in a region, or a batch of queued pushes\
When the Worker processes it\
Then the alarm line gives the number of Live Activity `start` pushes queued for the region, the
batch line gives per kind the sent, token-deleted, failed and dropped counts, a refused push is
logged with its kind next to the APNs status, and no line holds a token

## Out of scope

Persisted logs or Workers Observability, metrics, any change to what is sent, the app side.
