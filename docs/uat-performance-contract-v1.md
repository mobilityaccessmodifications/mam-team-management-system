# Native People Hub performance review / UAT implementation contract v1

This contract freezes the implementation seam for the user-approved isolated, self-hosted UAT. The accepted scope and resource decisions remain in `uat-confirmed-scope-20261016.md` and `uat-resource-decision-20261016.md`. The user subsequently selected exactly “整套 UAT 自托管，正式 Vercel 站保持不变”; both UAT app and test backend may run as isolated services on CODEX-MAM-VPS. Formal Vercel, production databases and existing n8n remain unchanged.

## Frozen common source

Base: People Hub `ff9da87f8d4c5b9b98e7d499e2b21cc91fc09541`. Parent integration root is `/Volumes/UG/MAM/opencode/.worktrees/mam-people-hub-uat-performance-20261016`.

- `src/lib/performance-review-types.ts` is the exact shared TypeScript contract. Child worktrees receive byte-identical copies; only the parent can revise it.
- `src/lib/performance-review-word.mjs` and `performance-review-questions.mjs` will be byte-identical copies of the reviewed pure renderer and questions from fake commit `4065c0acc17f595995b65f997bb54ad857f42f6a`. Do not port that app's identity, login, cookies, DOM overlay, memberships, singleton storage or mail bridge.
- Only backend-owner code defines RPCs and Action runtime validators. The frontend consumes the frozen types and Actions; it must not invent alternative envelopes. Parent owns shared shell, safety/configuration, gate registration, Word adapter, provider access, secrets, integration and deployment.

## Identity and business scope

Native `auth.uid()` and the unchanged real Hub getUser/canonical role policy authenticate and authorize each request. Auth UUID and internal_org_people UUID are distinct. No caller-supplied actor/role/profile impersonation. Admin and P0 are observers in this module, not managers; their other Hub permissions stay unchanged. Employee/Account and a Manager's own review receive self-only records. Only the assigned active same-company linked Manager can write another person's manager assessment. UAT seeds make this relationship explicit. Missing/invalid/admin-only/cross-company assignment fails closed; exception/reassignment policy for real production staff is outside this UAT.

One review per `(employee_person_id, cycle)` with native UUID review identity. cycle is four digits and dueDate is a real ISO date. Stable manager assignment and safe identity snapshots are fixed at creation. No salary, HR approval, acknowledgement or new report workflow. Existing 12 prompts, required answers [0,3,4,5,6,7,8,9,10], ratings [0,1,2,6,7,8,9], exact rating labels and 8000 UTF-16-unit text limit remain. self submission locks self fields. Manager completion requires original required answers/ratings, summary, overall rating and private manager note. Saving manager edits clears completion. Meeting registration never implies held; final requires completed assessment, explicit Boolean held:true and actual Melbourne meeting end <= trusted database time. Reject invalid/nonexistent/ambiguous local timestamps instead of silently using a process timezone. Do not schedule providers or send messages.

## DTOs, revisions and receipts

The shared type file is the exact key/union contract. No extra provider/database/private fields may pass Action parsers. Self audience has only self fields, safe subject/manager identities, self activity and its three capabilities. Manager fields never enter employee payload, token, sorting, cache or Word. HR has readRevision but no manager write token. All audience capabilities are server/SQL derived, never trust browser fields.

- selfRevision = `self:<self_version>`; managerRevision = `manager:<self_version>:<manager_version>`; readRevision = `read:<self_version>:<manager_version>`. Decimal components are nonnegative integers. Employee SQL CAS compares self version only; manager changes must leave employee response and CAS unchanged.
- `selfStatus` is awaiting_employee or manager_review solely according to self submission, never manager progress/final status. Employee activity only contains that real actor's self events, `{kind,at}`. List ordering uses visible cycle/due/code, not private update times.
- Each mutation carries one UUID operationId and one exact body, submits once, and receives a matching transactional receipt. Same actor/key/body replays do not mutate again. Changed body/key collision rejects. Business record, event and operation receipt commit atomically.
- Use native semantic `PT409` for stale revision/idempotency conflicts, NOT 40001 (PostgREST retries genuine serialization failures). Direct HTTP409 must be tested later. Authorization 42501 and input 22023 remain safe typed failures.
- After dispatched timeout/5xx/bad receipt, return uncertain:true, keep the draft and block repeat writes. Only explicit receipt reconciliation may confirm success. not_found is not proof of no commit and never authorizes automatic replay. Do not synthesize a next version or known commit.
- Native cookies/refresh stay in the existing Supabase SSR/browser/proxy implementation. On logout, definitive auth/permission loss or scope/selection generation retirement, clear private state and ignore old continuations, including A→B→A. Transient unavailable/conflict errors must not be mislabeled as definitive denial.

## Actual Action/RPC interface

`src/app/performance-reviews/actions.ts` exports exactly these server-facing functions (types in the frozen file):

1. `loadPerformanceReviews(): Promise<PerformanceLoadResult>` → authenticated `performance_review_workspace()`.
2. `startPerformanceReview(input: PerformanceStartInput): Promise<PerformanceStartResult>` → `start_performance_review(p_operation_id,p_employee_person_id,p_cycle,p_due_date)`.
3. `mutatePerformanceReview(input: PerformanceMutationInput): Promise<PerformanceMutationResult>` → `mutate_performance_review(p_operation_id,p_review_id,p_expected_revision,p_command,p_input)`.
4. `reconcilePerformanceReviewOperation(input: PerformanceReconcileInput): Promise<PerformanceReconcileResult>` → `get_performance_review_operation(p_operation_id,p_review_id)`.
5. `getPerformanceReviewDocument(reviewId: string): Promise<PerformanceDocumentResult>` → `get_performance_review_document(p_review_id)`.

The corresponding RPC returns the closed payload without Action-level ok. Workspace payload is `{viewerContext,reviews,startablePeople}`. Start payload is `{committed:true,operationId,review,existing}`. Mutation payload is `{committed:true,operationId,review}`. Reconcile payload is `{status,review}`. Document RPC directly returns the closed PerformanceDocument (not `{document:...}`). All use native caller JWT/RLS authorization, not service-role mediation. RPC functions revoke PUBLIC/anon/service_role EXECUTE explicitly and grant only authenticated (internal helpers do not). No direct browser table grants; private tables force RLS. Preserve existing auth/role fences and fixed lock order; recheck after waiting on review/assignment locks. Native audit records actual Auth actor separately from subject person.

`MAM_PERFORMANCE_REVIEW_ENABLED` must be exactly true for these new Actions to run. Parent passes the server-derived enable Boolean into the real shell; no browser flag authorizes anything. Production defaults off and receives no new migration or call by this task.

## Frontend and Word seam

- New `PerformanceReviewWorkspace` default export takes no impersonation/role/person props and loads the actual Action workspace. Parent only mounts it for the actual, non-preview session and keys it to actor/scope lifetime. Do not add a second login form, iframe, fake role picker, localStorage or reset/sample buttons.
- Use the real Hub's card/form/navigation style and standard React controls. Employee input, manager input, meeting registration/final explicit held, read-only HR and Word downloads follow the native DTO capabilities. Preserve drafts on conflict/unknown, duplicate-submit protection, and session/selection generation fences.
- Parent's `src/lib/performance-review-document.ts` exports `buildPerformanceReviewDownload(document: PerformanceDocument): {bytes:Uint8Array;fileName:string;mimeType:string}`. Call only after `getPerformanceReviewDocument` succeeds. It uses the unchanged renderer/questions. All documents omit managerNote; employee docs contain no manager assessment or meeting keys. Revoke Blob URLs on completion/unmount. No mail/meeting provider routes are called.

## SQL and cold-bootstrap boundary

The first release target is self-hosted UAT only. Add the new schema at `deploy/uat/performance-review-schema.sql`; do not append it to production migrations or change any of the existing 195 bytes. It is a new independently tested native schema delta, not an admitted production migration. Existing identity-history/retired-reference/purge protections remain fail-closed; no cascade of review history or broadened purge.

For the existing Hub schema, a separately reviewed schema-only bootstrap may be generated from the successful unchanged current migration replay on an owned synthetic local PostgreSQL instance. It must export complete application tables/types/functions/views/RLS/ACL/triggers and required platform structure, NOT fake Auth users/helpers/schema or production rows. Real GoTrue owns Auth. Keep bootstrap provenance distinct from native historical replay and never fabricate migration history. No hosted production dump or credential copy. Any required fresh UAT control rows or synthetic profile seeds must be explicit, finite, reviewed and target-owned, not a blind fingerprint refresh. Native provider sign-in, current account/capability and real HTTP authorization must actually pass before UAT is called ready.

## Parallel ownership

- Backend owner: new performance-review rules/parsers, Actions, UAT schema SQL and focused Node/native SQL/CAS tests. No shared shell/types/config changes or provider operations.
- Frontend owner: new workspace component/CSS, component fixture/spec and focused tests. No shell/types/backend/config/Word changes or browser/provider operation.
- Bootstrap owner: new UAT-only source-schema builder, bootstrap scripts and safety checks/tests under `deploy/uat/` plus own evidence. Cannot write performance-review-schema.sql, shared application source or old migrations/fixtures. Local owned socket-only PostgreSQL permitted; no Docker/Colima/SSH/remote provider operation.
- Parent: all shared shell/config/safety, Word adapter, integration, actual runtime/provider/SSH writes and final independent review.

Every implementation uses vertical TDD, preserves RED/failed attempts and actual exit/log/source bindings, and reports native SQL, mocked Auth, real Auth, browser and remote acceptance separately. No one changes AGENTS.md, accesses real staff/secrets or bypasses an existing guard to make a test green.
