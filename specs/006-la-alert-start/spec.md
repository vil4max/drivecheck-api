# Feature specification: the alert's start time in the Live Activity (server)

Feature: `006-la-alert-start` · Created: 2026-11-13
Status: approved by the owner on 2026-11-12 with the app's plan (`regional-check`
`specs/LIVEACT-glance/plan.md`, Group 4, points 1 and 2). Deploy follows the owner's separate
approval.

## Request

Owner, 2026-11-12, in the app repository: «Прокачать Live Activity», with the alert-duration timer
chosen among the criteria ("Таймер тревоги") and its server change accepted.

## Goal

A Live Activity in alarm can say how long ago the alarm started. The feed carries no start time, so
the start is the time this server first saw the alarm.

## Acceptance criteria

- **AC-1** The saved status record keeps, per region in alarm, the `fetchedAt` of the snapshot that
  first confirmed the alarm after a confirmed clear (the same rule as the alert-start notice,
  REQ-PUSH-008). A later fresh snapshot in alarm keeps it; a clear, a cold start and an alarm seen
  only after a gap longer than `GAP_MS` have none. The record is persisted, so a restart keeps it.
- **AC-2** `start` and `update` Live Activity pushes, the walk's 5-minute updates and a resolved
  move carry `alertStartedAt` in `content-state`, in seconds since 2001-01-01 like `checkedAt`,
  when the region has a start; otherwise the key is absent. `end` never carries it.
- **AC-3** An app before 3.4 ignores the key; nothing else in the payload changes.

## Requirements

### REQ-PUSHAPI-015 — Live Activity pushes carry when the alarm started

Status: approved (owner, 2026-11-12)

Given a region in alarm whose start this server confirmed\
When a Live Activity `start` or `update` for that region is sent\
Then its `content-state` holds `alertStartedAt`, the time the server first saw the alarm, kept in
the saved status record across restarts; a region without a confirmed start sends no such key

## Out of scope

A start time from another source, the app side (`regional-check` LIVEACT-glance), the deploy.
