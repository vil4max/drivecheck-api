# Feature specification: the alert's start time in the Live Activity (server)

Feature: `006-la-alert-start` · Created: 2026-11-13
Status: approved by the owner on 2026-11-12 with the app's plan (`regional-check`
`specs/LIVEACT-glance/plan.md`, Group 4), its time source set on 2026-11-13. Deploy follows the
owner's separate approval.

## Request

Owner, 2026-11-12, in the app repository: «Прокачать Live Activity», with the alert-duration timer
chosen among the criteria ("Таймер тревоги") and its server change accepted. Owner, 2026-11-13:
«Время показываем из респонса. Не когда получили, а когда начала и отбой в респонс»; on the
all-clear, which the response does not carry: "Не показывать отбой".

## What the feed carries (measured 2026-11-12 and 2026-11-13, three snapshots)

Each region has `changed`, Kyiv wall-clock time. For a region in alarm it is the start of the
current alarm (Kyiv Oblast 2026-11-13 08:29:04). For a clear region it equals the response's
`cachedat` in every case seen (26 of 26), so it carries no all-clear time.

## Acceptance criteria

- **AC-1** `start` and `update` Live Activity pushes, the walk's 5-minute updates and a resolved
  move carry `alertStartedAt` in `content-state`: the region's `changed` from the snapshot the push
  carries, read as Kyiv time, in seconds since 2001-01-01 like `checkedAt`. A region without
  `changed` sends no key.
- **AC-2** `end` never carries it, and a clear region's `changed` is never read as an all-clear
  time.
- **AC-3** An app before 3.4 ignores the key; nothing else in the payload changes.

## Requirements

### REQ-PUSHAPI-015 — Live Activity pushes carry when the alarm started, as the feed says

Status: approved (owner, 2026-11-12; source owner, 2026-11-13)

Given a region in alarm whose feed state has `changed`\
When a Live Activity `start` or `update` for that region is sent\
Then its `content-state` holds `alertStartedAt`, that `changed` read as Kyiv time; a region
without it sends no such key, and no push carries an all-clear time

## Out of scope

An all-clear time (the feed has none), the app side (`regional-check` LIVEACT-glance), the deploy.
