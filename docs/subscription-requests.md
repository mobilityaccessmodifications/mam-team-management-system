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
- These initial pins have synthetic native-platform provenance, not hosted Supabase provenance. Hosted compatibility remains unbound and requires a separate approved, independently reviewed release preparation. Unknown platform metadata fails closed; do not refresh a pin from the observed target merely to permit deployment.
- The published purge collector is unchanged. Existing account, identity, delegation, register, vault and audit data remain unchanged. Deferred constraints drain before and after the one-row predecessor-hash CAS refresh. Fresh exact-catalog checks and a retained-candidate ledger comparison run before COMMIT.
- Same-baseline actual COMMIT controls, benign queued effects and 35 synthetic fault/benign cases test initial poisoning, prefixed objects, routine security, ACL/RLS, trigger predicates/column lists, protected data, deferred effects and ledger drift. Generated queries, complete input hashes and rollback digests remain in the task-owned test evidence.

### Verification commands

`node --test tests/subscription-request*.test.mjs`

`npm run test:sql` (includes full cold replay, request contracts, 35 catalog cases and observable PostgreSQL races)

`node tests/subscription-requests-browser.mjs` (real production component → actual Server Action → owned disposable SQL; synthetic authentication boundary, not a real JWT login)

`npm run check`

All fixtures use synthetic identities. The source baseline above preserves the current confirmation and does not fabricate the missing historical interview.
