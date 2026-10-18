# drivecheck-api

Repository visibility: **PUBLIC** (once created on GitHub). Nothing private goes into files or history.

A backend and web front for Drive Check (DriveCheckUA). It fetches the Ubilling aerial-alerts feed
once for all clients, caches it within Ubilling's polite-load rules, serves it to the iOS and
Android apps through a small API, and shows the same glanceable status on a web page. Product
rules come from the iOS app, `regional-check` (`docs/core.md`, `docs/requirements/`): one current
region, one state, one data provider, no account, no ads, no third-party analytics, and no alert
history.

## How work runs

- Specs in `specs/<NNN-slug>/` (`spec.md`, `plan.md`, `tasks.md`, GitHub Spec Kit layout). Behaviour
  shared with the apps keeps their `REQ-` ids; backend-only rules get new ids. Every approved
  requirement is cited by a test name, and CI checks it.
- Each task: a failing test first, then the code.
- One pull request per feature; an independent review before merge; merge after the owner's yes.
- Gate: the project's test, lint and type-check commands; CI runs the same commands.
