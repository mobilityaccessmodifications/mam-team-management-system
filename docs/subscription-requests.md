# Subscription Requests — confirmed implementation baseline

## Authority and provenance

Coordinator: `20261004_205501_c3975c`. Sole implementation owner: `20260929_104922_38a8b5`.
User's exact reply to the coordinator's three consolidated recommendations: **“按建议，我记得我已经跟其中一个人做过grillme了啊”**.
This confirms those recommendations prospectively. The user states an earlier grill-me already happened; absence of its standalone file is not absence of a decision. Do not repeat that interview or require historical chat retrieval. The recovered detailed design remains in `REPORT.md` section 2C (verified SHA256 `d3a1848459edf15d0bbb0738c698fa5cdf44171a8ac3acbc771d050cd57b14e4`). Its original provenance limitation remains historical; this document is the current confirmation, not a fabricated recovery of the earlier interview.

## Agreed outcome and retained full design

- Requests tab covers new purchase, renewal, added seats and plan changes.
- Admin/P0 and explicit subscription register-management delegates may apply. Vault-only grants do not confer request-management authority. Existing roles and the two independent delegation capabilities remain separate.
- Penny is the sole designated approver and may approve her own requests. Use uniquely verified stable identity and explicit approval capability; no name-string authority or first-match fallback. Existing Admin status does not itself grant approval rights.
- Lifecycle: draft → submission → approve/return/reject → pending procurement → actual information and vault requirements → activation. Retain immutable submitted versions, decisions and changes.
- Procurement differences from approved terms are recorded and notified, without mandatory reapproval. This does not waive the requirement to apply for new purchases/renewals/seat/plan changes.
- Benefiting company and payer are separate; Both does not imply accounting allocation. Usage duration and billing cadence are separate. Preserve original currency/tax, AUD estimate and actual debit as distinct values. Missing quote needs a reason, not zero.
- Card label/holder is conditionally required for card payments; never collect card number, expiry or CVC. Support non-card payment.
- Responsible person defaults to the applicant, may be another valid employee, and must be definite before activation. Actual users are confirmed at procurement; selection does not grant vault access or provision accounts.
- Optional attachments are private request evidence, not credential storage. Reuse the encrypted vault for credentials; explicit not-applicable reason supports SSO and other valid cases.
- Paid Active/Paused quarterly reminders include existing subscriptions, on the first Victorian business day of each quarter: To responsible person, CC Penny. Calendar, fixed email and manual Mark review complete remain distinct; the fixed email does not depend on or automatically perform manual review.
- Offboarding password rotation remains out of scope. No automatic purchase, external-account creation or real-person grants.

## First implementation milestone

Deliver the core development/test milestone: form → submit → approve/return/reject → immutable history, including the confirmed draft/withdraw rules and notifications' tested contracts. Procurement, activation and quarterly emails remain in the full design but are subsequent milestones, not silently removed or represented as completed by this first stage.
Do not build premature activation or paid-register bypasses to make the first milestone appear complete. Approval alone does not create an active subscription, purchase anything, or grant credentials. Any minimum integration needed to preserve existing safety must remain narrowly scoped.

## Confirmed visibility, editing and notifications

- Draft: applicant-only visibility/editing through this workflow; no implied new blanket administrative draft exposure.
- Submitted: request managers within their authorized scope and Penny may view. Preserve the submitted version rather than editing it in place.
- Returned: applicant can edit and resubmit with history retained.
- Applicant may withdraw before procurement begins; preserve history. Do not implement an irreversible procurement state based on invented policy.
- Submission: notify Penny.
- Approve/return/reject: notify applicant.
- Withdrawal: notify Penny.
- Procurement differences: notify applicant and Penny.
- No additional broadcast/CC audience except the separately confirmed quarterly rule. Keep request contents, private attachments and credentials out of unrelated audiences.

## Execution and acceptance boundaries

Development and synthetic testing are authorized. Production deployment, schema/data changes, real-recipient mail, Auth actions and real grants are NOT authorized by this confirmation. Do not reuse the six existing background workers' production permission for new subscription mail.
Use an independent fresh verified-main implementation checkout; preserve shared dirty work, existing release artifacts and other owners' trees. Normal MAM draft PR/CI may be used to deliver the reviewed development candidate, but never merge or apply production migrations under this milestone. Reuse existing supported infrastructure; technical implementation choices do not require repeated user approval.
Exercise form validation and allowed/denied actors, independent grants, sole-approver/self-approval, immutable versions, stale/duplicate decisions, return/resubmit, withdrawal cutoff, private visibility/attachments, safe notification contracts and no purchase/activation/grant side effects. Use synthetic identities only. Report exact source/test bindings and PASS/FAIL/BLOCKED/NOT RUN; no provider acceptance or mock mail as Inbox proof.

## Communication

One consolidated implementation prompt, then let the owner work. Owner returns the completed milestone or a concrete blocker needing a decision; do not send repeated nudges or interviews. Year-end/annual-leave work remains separate and highest priority; do not take over its owner or paths. The coordinator must not describe this milestone as the entire Subscription workflow being complete or live.

## Milestone 1 implementation boundary

- This is a development candidate, not a deployed feature. The migration starts disabled with no designated production identity. An eventual reviewed release must uniquely verify Penny's stable Auth/person pair, validate that same active pair, and explicitly configure the private singleton. No name matching or role-derived approval is used. Configuration is inaccessible to app and service roles.
- Requests are stored privately with RLS and no direct table grants. Authenticated RPCs recheck the canonical active account and current register grant. Role-control/actor/configuration fences precede request CAS and immutable event insertion. Penny's separate configured approval capability allows self-approval, without authorizing every Admin.
- Submitted snapshots and evidence remain immutable. Applicants see their draft history; other authorized viewers see submitted/decision history only. Returned unsent edits stay private until resubmission. Evidence supports up to three PDF/PNG/JPEG files, 500 KB total, with type/signature checks and authenticated download; no public Storage URL. Prior evidence is retained, not silently deleted.
- Approved means pending procurement. No procurement-start/activation endpoint, active-register creation, external account creation, role change or vault grant exists in this milestone. Thus every approved request remains before procurement and is withdrawable. The later procurement milestone must add and test the authoritative cutoff.
- When this workflow is enabled, a database trigger denies new paid register entries, service replacement, renewal/seat/plan/billing-price or billing-anchor changes, and cancelled paid reactivation through every predecessor/direct table path. Ownership, benefiting-company, membership, review and existing active/paused maintenance remain available. This is a fail-closed interim boundary, not a fake procurement implementation. Existing register operation stays unchanged while the feature is disabled. The future controlled activation path needs separate implementation/review.
- Atomic immutable metadata-only notification intents implement submit→Penny, decisions→applicant and withdrawal→Penny, with no CC. Draft withdrawal does not reveal its draft content or grant Penny draft-read access. Envelope contracts are tested; there is no sender, worker, webhook, production activation, provider send or Inbox evidence. Actual delivery remains a separate authorized follow-up.
- Original quote currency/tax, AUD estimate, payer, beneficiary, duration and cadence are separate. Null original quote requires a reason. Card payments require label/holder only. Actual debit/actual users/credential applicability/quarterly emails remain later-stage work.

### Migration catalog boundary

- The transition inventories the onboarding predecessor's complete 22 catalog classes. It permits only 116 exact kind/identity/definition-hash additions, including explicit PostgreSQL 16/17 owner-ACL variants. There is no name-prefix authorization or ACL normalization.
- Fixed initial expanded-metadata pins are bound to the same captured inventory. Only the initial semantic role comparison omits cluster-allocated role OIDs; the complete captured before/after role rows retain them. Native aggregate/window metadata retains owner OIDs and the predecessor's supported-major validation.
- The original initial pins retain their synthetic native-platform provenance. The user approved a separately dated current-structure compatibility baseline on 9 October 2026. The candidate additionally admits only the complete fixed current fingerprint on PostgreSQL 17 as non-superuser `postgres`; this does not recover missing historical source or approve a production apply. Unknown platform metadata still fails closed. Neither native pin is refreshed from observed state.
- Published PR221 (`9ff635a92568eee29b58192405bcfa0b45cce8f2`) and PR222 (`582913e40045a53c4bc37d25aeb5a43ea799af43`) remain unchanged predecessors. PR221's exact `20261008140000_employee_team_manager_defaults.sql` source is bound to raw SHA256 `bfff1d20066382230ba1f6b2deed21beb53aa7dc2542e69e2522079a267be69e`. Only the unpublished Requests migration moved to `20261008160000_subscription_requests_milestone1.sql`, after the published annual source-bank version. Published files, production history and earlier review evidence are not rewritten.
- Initial compatibility enumerates 24 exact published metadata additions and one exact creation-RPC definition transition, including the two new composite/array type identities and explicit PostgreSQL 16/17 ACL variants. Every current after-definition is checked before subtraction. Substituting the pinned original creation definition and removing only these exact new rows must reproduce the original initial aggregate; neither original hash is refreshed from observed state. The raw post-PR221 catalog remains in the complete before/after guard.
- The published purge collector is unchanged. Existing account, identity, delegation, register, vault, audit and Team Manager configuration data remain unchanged. The new private defaults table is locked and included in the full protected-data comparison. Production's private six configurations are not imported into this candidate or its fixtures. Deferred constraints drain before and after the one-row predecessor-hash CAS refresh. Fresh exact-catalog checks and a retained-candidate ledger comparison run before COMMIT.
- The catalog runner retains the original 35 synthetic fault/benign cases and adds ten PR221 integration faults with a nonempty synthetic defaults row. Its `main221` group runs only the new ten cases and a same-baseline actual COMMIT control; unchanged old cases inherit their byte-bound PG16/17 results rather than being replayed solely for this predecessor update. Generated queries, complete input hashes and rollback digests remain in the task-owned test evidence.
- PR222 compatibility admits 108 exact added identities and 18 exact retained before-definition substitutions. The annual source-bank migration remains byte-identical. All three annual source, receipt and payroll-calendar tables join the existing protected-data and lock contract, for 19 protected tables in total. The separate annual catalog regression runner verifies nonempty synthetic rows, native COMMIT and direct/deferred data and metadata rollback cases.

### PR #223 update — 9 October 2026

The user's later conditional release approval supersedes the original development-only authority for this same first milestone, but does not waive production gates. This update publishes the corrected candidate to the existing PR for new-head review and CI; it does not merge, deploy, apply the migration, enable the workflow or configure a real approver.

Earlier failed compatibility observations and review-process verdicts remain retained failures. A saved native COMMIT response has been reconciled, but it is not independent postcommit readback; that rehearsal gate remains incomplete. Production apply/readback, explicit Penny configuration and fixed-alias acceptance remain separate release steps. No procurement, activation, real notification sender or quarterly delivery is added by this update.

### Verification commands

`node --test tests/subscription-request*.test.mjs`

`npm run test:sql` (includes full cold replay, request contracts, all 45 catalog cases and observable PostgreSQL races)

`node tests/subscription-requests-browser.mjs` (real production component → actual Server Action → owned disposable SQL; synthetic authentication boundary, not a real JWT login)

`npm run check`

All fixtures use synthetic identities. The source baseline above preserves the current confirmation and does not fabricate the missing historical interview.

### 14 October 2026 — simplified requests and Penny approval email

The owner authorizes production release after the existing checks. Luke's later requirements supersede the earlier fixed Marketing routing: submission emails now go to the uniquely verified, configured Penny approver and CC the applicant's database-resolved work email. The email requests approval, uses the existing MAM leave-email theme and signature, and links directly to `/?view=people&tab=tasks`, including after sign-in. Other event delivery remains outside this email addition.

Delivery uses a private token-bound submission queue and the existing durable notification-receipt bridge. Missing applicant or approver work email keeps the event unsent. Submission does not depend on immediate email success. Publish the new authenticated n8n receiver at `/webhook/mam-subscription-request-mail-v2` from `scripts/build-subscription-request-penny-mail-workflow.mjs`, using the verified MAM Outlook and notification-header credentials. The worker uses the existing MAM webhook origin and secret. Preserve the active V1 workflow and its five-minute scheduler: it retries the protected `/api/cron/subscription-requests` endpoint, which dispatches through V2 after the application release. Do not add another scheduler. The dedicated `MAM_SUBSCRIPTION_REQUEST_CRON_SECRET` and its separately verified Header Auth credential remain unchanged. Permanent reservations, including historical Marketing sends and unknown send outcomes, are never replayed.

Free subscriptions remain directly creatable and editable by the existing register managers. They do not create an approval request, request history or application email.

New requests use the simplified AUD form: authenticated Requested by, service/purpose, intended users, ongoing/3-month/12-month usage, independent monthly and annual prices (or an explanation for an unavailable alternative), preferred billing and company-card label/holder. An authorised Register manager can register an approved V2 new-purchase request with its unchanged selected price, billing dates, seats, responsible person and access members. Registration is atomic and version-checked, records immutable request/approval provenance and ends withdrawal eligibility. It does not purchase anything or load credentials. Vault delegates separately add credentials after selecting Credentials. Luke and Victoria retain their existing Register/vault permissions; Lily has vault access only. Legacy requests retain their original terms and pending-procurement workflow. Quarterly review assignment/reminders and confirmed-departure password Tasks follow `docs/business-rules.md`.

#### Release order and acceptance

Run the required local checks and structured review against the frozen branch. Fence new submissions before changing the mail contract: under the exclusive singleton configuration lock and short `EXCLUSIVE NOWAIT` locks on requests, mail deliveries and notification receipts, require zero submitted requests, zero undelivered subscription mail rows and zero subscription receipts in `processing` or `legacy_unknown`. Retain the exact original Penny pair in an owned `0600` recovery journal, then temporarily clear only `approver_user_id` and `approver_person_id`. Keep `enabled=true` so the paid-register approval gate remains enforced. Submission and withdrawal fail atomically while the approver is unavailable; drafts and free subscriptions remain available. An in-flight claim makes the fence fail and roll back. Reconcile uncertain outcomes read-only, without retrying a mutation blindly.

After independent readback proves that fence, use the MAM Supabase credential helper to run each deployment script with `inspect` then `apply`, in this order:

| Migration | Deployment script | Required predecessor |
| --- | --- | --- |
| `20261014120000_subscription_request_simple_activation.sql` | `scripts/deploy-subscription-request-simple-activation.py` | `20261014110000_subscription_review_managers_mail.sql` |
| `20261014130000_subscription_request_penny_mail.sql` | `scripts/deploy-subscription-request-penny-mail.py` | `20261014120000_subscription_request_simple_activation.sql` |
| `20261014140000_subscription_departure_password_tasks.sql` | `scripts/deploy-subscription-password-tasks.py` | `20261014130000_subscription_request_penny_mail.sql` |

Each script takes `inspect|apply <reviewed-head> <helper-sha256> <transport-sha256> <migration-sha256> <predecessor-sha256>`. The shared transport is `scripts/deploy-staff-leave-calendar.py`. Use the exact reviewed commit and file bytes; the scripts require a clean MAM-authored source tree, verify the MAM organization/project, fence the predecessor and commit once with independent readback. An ambiguous outcome requires read-only reconciliation with `inspect`, never a blind retry. These migrations do not backfill departures or replay email.

Follow `/Volumes/UG/MAM/opencode/n8n/AGENTS.md` and run its required `python3 scripts/verify.py` before publishing the V2 receiver. Verify its saved and active node graph, MAM credential references, V2 webhook, zero schedules and unchanged V1 scheduler. Then merge the reviewed GitHub PR into `main` and verify the correct MAM Vercel commit and production alias. Retain the fence for at least the old subscription cron's declared `maxDuration=300` seconds after that alias switch, so pre-switch invocations cannot claim newly resumed work. While fenced, the V2 submission claim refuses an unavailable approver; a cron `503` is expected and must not be treated as readiness failure. After that drain, repeat the zero-work guards and restore only the captured Penny pair with a compare-and-set against the exact enabled/null configuration, shared directory-role lock and locked canonical profile/person/work-email rows. Revalidate Penny's active, unique account and work mailbox, then independently read back the restored configuration. Retain the recovery journal until restoration verifies.

Use Ego Lite to check the simplified form and direct Tasks link, then confirm the resumed scheduler health. Synthetic browser/SQL/mail-receipt tests prove the write contracts; they are not actual recipient-Inbox evidence. Do not manufacture a production request, purchase or departure for acceptance.

The unpublished Requests migration supports the exact published `bce09faab4c9d4811837b21111c9ad4c81318953` predecessor. Source-built PostgreSQL 16 and 17 inventories agree on the original 78 added identities and 21 changed definitions, plus 44 exact additions from the published task-notes migration. The compatibility mapping validates every current definition before substituting retained definitions for the initial comparison; existing original fingerprints are retained. The original 19 protected data relations remain protected, with the later annual-day accounting and task-notes relations added when present. Cold ordered replay remains supported.

A separately dated hosted compatibility candidate is bound to the 14 October 2026 read-only MAM project observation: 19,155 complete expanded catalog rows, with all published application transition mappings matching. Removing only the verified task-notes additions reproduces the earlier normalized fingerprint `d8ac05b23d63fc06564883d3bb8e4ca074b536f14bb17ed26d9caa50614e5c85`, admitted only for PostgreSQL 17, non-superuser `postgres`. This is a new current-platform baseline, not a claim that only partition names changed or that historical definitions were recovered. It requires source review and release-envelope acceptance before use; unknown fingerprints remain rejected. Production configuration and delivery acceptance are still pending.
