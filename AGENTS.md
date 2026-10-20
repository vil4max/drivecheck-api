# drivecheck-api

Repository visibility: **PUBLIC**. Nothing private goes into files or history; specs, comments and
commits carry requirements and decisions only.

A backend and web app for Drive Check (DriveCheckUA). It fetches the Ubilling aerial-alerts feed
and alert map once for all clients, caches them within Ubilling's polite-load rules, serves them to
the iOS and Android apps through a small API, and shows the same glanceable status as an
installable web app in the iOS design. Product rules come from the iOS app's repository,
`regional-check` (its `docs/core.md` and `docs/requirements/`): one current region, one state, one
data provider, no account, no ads, no third-party analytics, and no alert history.

## How work runs

- Specs in `specs/<NNN-slug>/` (`spec.md`, `plan.md`, and the task checklist in `tasks.md` or in the
  plan's "Tasks" section; GitHub Spec Kit layout). Behaviour shared with the apps keeps their
  `REQ-` ids; backend-only rules get new ids. Every approved requirement is cited by a test name,
  and CI checks it.
- Each task: a failing test first, then the code.
- One pull request per feature; an independent review before merge; merge after the owner's yes.
- Gate: `npm run check` (three type-checks, Biome lint, Vitest and the requirement trace) and
  `npm run bundle`; CI runs the same commands plus the trace script's contract tests.
