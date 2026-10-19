# Performance review — production release authority and scope

## Owner confirmation

On 2026-10-16, the owner stated:

> 现在跟hr开完会了，他们觉得没问题这个可以直接上线到真实版了

This records user-reported HR business acceptance and explicit authority to release the performance-review feature to the real People Hub. It is not an automated technical PASS. The coordinator then asked whether production final submission should also enable the previously confirmed n8n Careers notification. The clarification was submitted and answered:

> 同时启用已确认的 Careers 通知，但不发测试邮件

Do not repeat this release or notification-activation question unless the requested business scope changes.

## Production targets and release path

- Repository: `mobilityaccessmodifications/mam-team-management-system`.
- Production branch: `main`; normal reviewed PR merge triggers Vercel. No direct Vercel deployment.
- Vercel: `ai-7033s-projects/mam-team-management-system`; keep the established production URL.
- Supabase organization/project: `fwlmbmospuwoaosffvmw` / `xtwlrjqbusadghavchqm`, through the approved project credential helper.
- n8n: only the configured MAM project REST API and prescribed verifier in `/Volumes/UG/MAM/opencode/n8n`.
- Fresh GitHub `main` and fetched base: `ff9da87f8d4c5b9b98e7d499e2b21cc91fc09541`.
- Production candidate: branch `codex/performance-review-production-20261016`, in its own initially clean worktree. Existing UAT PR #243 and all prior sources/evidence are preserved; do not merge the complete UAT infrastructure branch as the production feature.

## Included business behavior

- Actual Hub login, Auth UUID and canonical active person/role binding; no fake identities or role-switch authentication.
- Existing self assessment, explicit eligible assigned-manager assessment and HR/Admin/P0 read-only access within this module. Keep other Hub module permissions unchanged.
- Employees never receive manager answers, private manager note, meeting/private activity, manager revision tokens or corresponding private Word content.
- Canonical MAM/Equipsy questions, full rating values, Word layout and audience-safe exports. No salary functionality.
- Manager arranges the meeting externally and records it. Final submission requires the actual meeting end and the manager's explicit held confirmation. No Admin approval or employee confirmation step.
- A successful final submission durably queues exactly one server-owned n8n notification to the already confirmed Careers route. Include the completed Word attachment and manager's note; keep the note separate from the Word file and never deliver it to the employee. Do not inherit the old fake bridge's static people, shared Auth, test window, manual send cap, state storage or historical pending claims.
- Use the existing project's durable notification, exact-origin/no-redirect, claim/receipt and no-resend conventions. Unknown provider outcomes remain held for reconciliation, not automatic duplicate sends.

## Authorized production operations

After their technical review and target gates: apply only the new reviewed versioned performance schema/notification migration, stage/configure/read back the bounded MAM n8n receiver and consumed Production settings, enable future real user-driven final notifications, merge the reviewed production PR, and verify the exact production deployment and fixed URL.

## Exclusions and acceptance boundaries

- No actual test email, invitation, OTP, meeting, calendar or provider-file operation; no historical mail replay or bulk queue drain.
- Do not create/rotate real staff accounts or passwords, use production as a write-test fixture, import UAT identities, seed production reviews, alter existing staff/reporting/leave/payroll data or promote staff roles.
- Preserve all existing production records, protections, RLS/ACLs, credential boundaries and necessary audit. Schema and notification changes require source-bound tests, independent review, exact target and independent readback.
- Keep local/inert/SQL-only, real isolated Auth/HTTP/browser, live schema/configuration, software deployment and actual recipient delivery as separate outcomes. No-send validation cannot claim inbox or attachment delivery.
- The full self-hosted UAT portal is not itself the production release. Reuse already completed relevant checks; pause only genuinely dependent operations. Preserve the isolated database and source work unless a separate cleanup scope is approved.
- GitHub Actions that did not start solely because of billing may use the current repository's documented local-check route; do not call CI green, change billing or waive real test failures.
