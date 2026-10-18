# Implementation plan: cached API and status page

Feature: `001-cached-api-and-status-page` · Spec: [spec.md](spec.md) · Tasks: [tasks.md](tasks.md)

## Technical context

- Language: TypeScript 6.0.3, ES2022 modules, strict.
- Runtime: Cloudflare Workers, one SQLite-backed Durable Object (spec D1).
- Tests: Vitest 5.0.3 in Node 24. Logic modules import nothing from `cloudflare:*`, so they run in
  Node with fakes for `fetch`, the clock, sleeping and storage. Only `src/worker.ts` binds them to
  the platform; CI checks it by type-checking and by a Wrangler dry-run bundle.
- Lint and format: Biome 2.5.15 (warnings fail; `noNonNullAssertion` is off because
  `noUncheckedIndexedAccess` makes `!` the explicit mark of a known index). Types:
  `@cloudflare/workers-types` 5.20261003.1. Bundle and deploy: Wrangler 4.147.0.

## Structure

```
src/
  feed.ts         feed types, validation, Kyiv local time → instant
  retryAfter.ts   Retry-After parsing and 429 backoff
  coordinator.ts  FeedCoordinator: floor, single flight, retry, 429 window, persistence
  regions.ts      25-region catalog: API key, ISO 3166-2 code, names in en/uk/ru, neighbours
  status.ts       snapshot + region → status view (phase, checkedAt, stale, nearby)
  i18n.ts         strings in en/uk/ru, language negotiation
  page.ts         HTML renderer and palette
  api.ts          /v1/alerts body and headers
  router.ts       request → response, given a function that returns the coordinator's view
  worker.ts       Worker entry and the Durable Object class
tests/            one *.test.ts per module, plus fixtures/aerialalerts.json
scripts/          spec-trace.py and its contract tests
```

## Data flow

1. A request reaches the Worker in any Cloudflare location.
2. The Worker asks the one Durable Object (`idFromName("feed")`) for its view over RPC.
3. The coordinator answers from memory. Outside the floor and the 429 window it starts the single
   upstream attempt (kept alive with `ctx.waitUntil`): a caller with a held snapshot gets it at
   once, a caller without one waits for the attempt for at most 5 s.
4. The router reads the clock after the coordinator answers and renders JSON or HTML.

Stored state is one record, `state`: the latest snapshot, the last attempt time, the rate-limit
window and the 429 streak (REQ-API-003). Two writes per attempt (the attempt time before the
request, the outcome after), so at most 17,280 rows per day, under the free plan's 100,000. A failed
write is logged and does not fail callers; the in-memory state stays authoritative.

## Requirement trace check

`scripts/spec-trace.py` reads every `REQ-` heading in `specs/*/spec.md` and its `Status:` word. A
test cites a requirement when its title starts with the ID (`test("REQ-PROVIDER-001 reads ...")`).
With `--results <vitest JSON report>`, a citing test must also have passed. It fails when an
approved requirement has no citing test, when a test cites an undefined ID, or when an ID is
defined twice. Proposed requirements are cited too, but only approved ones are enforced.

## Gate

`npm run check` runs type-check, lint, tests with a JSON report, and the trace check. CI runs the
same steps on every pull request and on `main`, plus the trace script's contract tests and a
Wrangler dry-run bundle.

## Deploy (the owner's step)

```
npm ci
npx wrangler login
npx wrangler deploy
```

The first deploy creates the `FeedCoordinatorObject` namespace from the `v1` migration in
`wrangler.jsonc`. No secrets are needed: the Ubilling API is public.
