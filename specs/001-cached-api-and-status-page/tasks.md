# Tasks: cached API and status page

Feature: `001-cached-api-and-status-page` · Spec: [spec.md](spec.md) · Plan: [plan.md](plan.md)

One pull request. Inside each group the tests come first and are seen failing before the code.

## Group 0 — spec

- [x] T001 Write spec, plan and tasks with the runtime, API and page decisions.
- [x] T002 [Owner] Approve the proposed requirements and answer O1 to O3.

## Group 1 — skeleton and gate

- [x] T010 `package.json`, `tsconfig.json`, `biome.json`, `wrangler.jsonc`, pinned versions.
- [x] T011 `scripts/spec-trace.py` and its contract tests.
- [x] T012 GitHub Actions gate: type-check, lint, test, trace, dry-run bundle.

## Group 2 — provider and coordinator

- [x] T020 Tests: feed validation and Kyiv time (REQ-PROVIDER-001), Retry-After (REQ-REFRESH-005).
- [x] T021 Tests: coordinator floor, single flight, retry, 429 window, persistence, one stored
  record (REQ-PROVIDER-002, REQ-REFRESH-003, REQ-REFRESH-005, REQ-REFRESH-010, REQ-API-003).
- [x] T022 Code: `feed.ts`, `retryAfter.ts`, `coordinator.ts`.

## Group 3 — API and page

- [x] T030 Tests: API body and errors (REQ-API-001, REQ-API-002, REQ-REFRESH-006).
- [x] T031 Tests: status view, nearby, catalog (REQ-REGION-001, REQ-SURF-005).
- [x] T032 Tests: page language, region, accessibility, informational note (REQ-WEB-001 to 003,
  REQ-PROVIDER-003).
- [x] T033 Code: `regions.ts`, `status.ts`, `i18n.ts`, `page.ts`, `api.ts`, `router.ts`,
  `worker.ts`.

## Group 4 — release of the slice

- [x] T040 Independent review; the owner's yes; merge.
- [x] T041 [Owner] Deploy with Wrangler and share the URL.
