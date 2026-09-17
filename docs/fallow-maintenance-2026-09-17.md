# Fallow maintenance — 2026-09-17

## Scope and baseline

Maintenance following the Fallow 3.26.0 report, without business-rule changes. The user subsequently authorized committing, pushing, merging and production release on 2026-09-17 after the clean external review.

- Worktree: `/Users/nixon/.codex/worktrees/d5e4/MAM team management system`.
- Branch: `codex/fallow-maintenance`, based on `origin/main` at `84026f02f0a7fbbf7ff2d3b9044dbbcd4e414eb6`.
- The original review branch HEAD `1b00e4e4b6813307c117da33f9b876d50410661b` had the same source tree.
- Initial checkout was clean; no unrelated changes were overwritten.
- No database, role, n8n, credential, environment or dependency changes; this release requires no database migration. Production deployment must follow the reviewed GitHub merge to `main`.

## Implemented

1. Replace undefined Leave brand tokens with the existing company-scoped `--accent`, `--accent-deep`, and `--accent-soft`. Both MAM and Equipsy retain their existing colours. Calendar uses `var(--font-geist-sans, Arial), sans-serif`, with an actual custom-property fallback.
2. Share asset-owner submission between the asset register and employee device panel through `useAssetOwnerChange`. Preserve employee validation, asset version, server authorization, focus restoration and error messages. A synchronous ref lock also prevents duplicate requests before the busy-state render.
3. Extract `LeaveRequestDialog`, `AttachmentList`, sequential attachment upload, file validation and time options. Role-scoped state and mutations remain in `LeaveDemo`; the dialog owns its focus lifecycle. Existing attachment deletion confirmation, failed-upload cleanup, request-person scope and date alignment remain intact.
4. Extract Organisation filter and view controls. Filter-open state is local to the menu; selecting a filter still invalidates stale work-contact data in the parent. Editing permissions, keyboard dismissal, focus restoration and zoom bounds are unchanged.
5. Remove the unreachable `read-only-directory.tsx` and its stylesheet, five unused Check-in read actions and their now-unreachable DAL readers/parser, and unused `SPRING_LAYOUT` / `SPRING_PRESS`. Deleted tracked code is recoverable from Git. Active browser/RPC readers, completion actions and their authentication/HR guards remain.

The React Best Practices review guided the state boundaries: independent control state moves with its component, while authorization context and mutation ownership stay with the existing workspace. This is a first-stage decomposition, not a claim that the two large components are fully refactored.

## Comparable Fallow results

Same version, default configuration, telemetry disabled and cache disabled; no suppression rules added.

| Metric | Before | After |
| --- | ---: | ---: |
| Maintenance score | 74.1 / B | 75.7 / B |
| Unused-code and related candidates | 109 | 87 |
| Unused files | 3 | 1 |
| Unused Server Actions | 5 | 0 |
| Clone groups | 109 | 103 |
| Estimated duplicated lines | 3,255 | 3,016 |
| Estimated duplication | 6.53% | 6.10% |
| LeaveDemo cyclomatic / cognitive complexity | 202 / 342 | 188 / 308 |
| OrganisationTree cyclomatic / cognitive complexity | 112 / 256 | 101 / 235 |
| Unresolved imports / circular dependencies | 0 / 0 | 0 / 0 |

These are static-maintenance indicators, not bug counts, runtime speed measurements, security certification or real test coverage. The remaining health candidates are 456; the overall hotspot/large-function problem is not solved by this patch. Some complexity is now measured in dedicated components, as intended.

## Verification

- Baseline: 210 tests passed.
- Updated suite: 220 tests passed, including ten new maintenance tests. Existing tests now follow extracted source locations without removing their assertions.
- New coverage: file validation, sequential upload completion/failure/cleanup, asset-owner scope/version/concurrent-submit/error retry, chart permissions/zoom bounds, request dates/team selection/busy feedback, and Check-in authentication/HR checks.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- `npm run build`: passed with normal system permissions. The sandbox build stalled during compilation and was stopped; the identical system-level build completed successfully, including TypeScript and static-page generation.
- No live HR data or production mutations were used in tests.
- Browser visual/E2E and database/RLS execution tests were not run for this local maintenance pass.
- External Codex autoreview: passed on 2026-09-17 after the user authorized read-only review of this specific internal-code diff. The helper exited 0, returned an empty findings array and `patch is correct` (confidence 0.93). No findings required acceptance, rejection or code changes. This authorization does not include pushing, merging or deployment.
- After authorization, typecheck, lint and all 220 tests passed again. File hashes before/after the reviewer matched: it did not modify the worktree.

Review command (with an additional prompt limiting inspection to this diff and directly related local source/synthetic tests, excluding secrets and production access):

```sh
env GH_CONFIG_DIR='/Users/nixon/.github-profiles/mam' PYTHONUNBUFFERED=1 \
  /Users/nixon/.codex/skills/autoreview/scripts/autoreview \
  --mode local --engine codex --no-web-search --stream-engine-output \
  --output /private/tmp/mam-fallow-review.cxES7E/autoreview.txt \
  --json-output /private/tmp/mam-fallow-review.cxES7E/autoreview.json
```

The reviewer confirmed that form behavior, attachment validation/upload cleanup, company token scope, dialog focus lifecycle, asset version/duplicate-submit checks and active authenticated Check-in readers remain intact. Its source-only review is separate from the local test/build results above; it did not execute tests or access remote services/production data. Only this result-recording documentation was updated after the clean review; implementation code was unchanged.

Local evidence is in `/private/tmp/mam-fallow-review.cxES7E/`: `review.md`, `full.json`, `health.json`, `after-full.json`, `after-health.json`, `tests-before.tap`, `tests-after.tap`, `tests-review.tap`, `autoreview.txt`, and `autoreview.json`. Temporary artifacts are not intended as permanent repository files.

Reproduce the static scans from the repository:

```sh
DO_NOT_TRACK=1 npx --yes fallow@3.26.0 --no-cache --format json --score
DO_NOT_TRACK=1 npx --yes fallow@3.26.0 health --css --score --complexity --file-scores --hotspots --targets --no-cache --format json
```

The health command returns 1 when findings remain; this is not a scanner crash.

## Deliberately retained and follow-up

- `leave-accrual.ts` is dynamically loaded by tests; its unused-file warning is not grounds for deletion.
- DayFlow `:global(.df-...)` overrides and dynamic CSS usages need consumer-aware review, not bulk deletion.
- Valid async Server Actions imported by client components are not automatically client/server security leaks. No permission or network guard was removed to silence findings.
- Follow-up stages should separate Leave navigation/approval details and Organisation editor/layout state with their own behavioral tests. The large Leave stylesheet needs a separate cascade/visual-regression audit before consolidating overrides.
- At review completion this patch was uncommitted and had not been pushed, merged or deployed. The user's subsequent release authorization covers this reviewed maintenance patch. GitHub PR/merge history and the matching Vercel deployment are the release-status evidence.
