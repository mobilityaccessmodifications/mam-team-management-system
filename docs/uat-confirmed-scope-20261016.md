# People Hub UAT — confirmed delivery scope

## Approval and source

On 2026-10-16 (Australia/Melbourne), after the proposal for a real People Hub pre-release acceptance environment, the user instructed: “那就按照你说的做吧”. This confirms the preceding bounded plan; it does not require another general approval interview.

- Use the actual People Hub application and repository, with a dedicated feature branch and isolated Preview/UAT configuration. Do not maintain a parallel fake product as the eventual integration.
- Give HR a stable remotely accessible acceptance site, genuine test-Auth logins, synthetic directory/reviews and a short self-test checklist. No dependency on the owner's laptop for the delivered hosted acceptance site.
- First feature scope is the already confirmed performance-review journey: shared employee/assigned-manager/HR-read-only data, employee privacy, existing questions and meeting-ended-plus-explicit-held rule, and canonical MAM/Equipsy Word exports. No salary, new HR approvals, employee acknowledgement or unconfirmed meeting requirements.
- Isolate database, Auth, file storage, credentials and outbound effects. Do not copy real staff records, production Auth users, production keys or existing browser records into UAT.
- Preserve the formal release path and all existing People Hub modules. This approval is for UAT, not a merge into production, production migration, real-employee operation, billing change or recipient delivery.
- Existing frozen fake candidate `4065c0acc17f595995b65f997bb54ad857f42f6a` and its evidence remain unchanged. Its rules and renderer may be reused only after native Hub identity/authorization integration; its simulated Auth/browser result is not real Hub acceptance.

## Effect boundaries

Permitted now: scoped read-only discovery, local isolated worktrees, TDD implementation and fixtures, local checks, independent review, and a reviewed branch-only UAT deployment after its target/resources/access gates pass.

Not permitted: upgrading a plan, creating billable resources, changing billing, pausing/reusing People Hub or Drafty production databases, using another company's resources, importing production people/data/keys, editing protected instructions to bypass limits, production merge/deployment/schema/Auth changes, actual mail or Auth email, business webhooks, calendar/file provider writes or restarting completed live-flow tests. Any later cost choice must be explicit; only the operation depending on it remains held.

The earlier rejected instruction-file annotation is preserved and must not be retried or reached through another path. No AGENTS.md edit is part of this task.

## Working baseline and ownership

- Repository: `mobilityaccessmodifications/mam-team-management-system`.
- Fresh fetched main: `ff9da87f8d4c5b9b98e7d499e2b21cc91fc09541`.
- Parent integration worktree: `/Volumes/UG/MAM/opencode/.worktrees/mam-people-hub-uat-performance-20261016`.
- Branch: `codex/people-hub-uat-performance-20261016`.
- The original main checkout and all other owners' worktrees/untracked files are protected and remain untouched. Parent is the sole provider/configuration/deployment writer. Read-only discovery children cannot create cloud resources, read secrets, deploy, commit or mutate the parent source.

## Acceptance

1. HR can open the stable UAT address and pass its deployment/application access gates without a developer terminal.
2. Genuine test identities exercise the actual Hub login, directory relationship and review authorization, not a frontend role switch or intercepted Auth.
3. Employee submit → assigned manager read/write → HR read-only use one persistent review. The employee never receives manager fields or private activity, including through API responses, version tokens, reload or delayed responses.
4. MAM/Equipsy Word exports preserve the approved templates and audience restrictions. Meeting registration does not automatically mean held or permit early finalization.
5. Outbound integrations and production targets fail closed. Missing UAT configuration cannot fall back to production; only synthetic UAT data can be reset.
6. Actual local, native-Auth, hosted, HR-access and business-side-effect results are reported separately. An unavailable paid resource, missing target verifier or inaccessible HR deployment gate remains BLOCKED, not PASS.
7. No actual mail, Auth invitation, meeting or provider-file test is part of this acceptance.
