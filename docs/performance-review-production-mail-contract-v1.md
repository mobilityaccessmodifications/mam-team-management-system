# Production performance notification interface — v1

Engineering contract for Performance Review publication and Careers notifications, with no test email. Manager/Admin review and document projections include structured goals; employee projections exclude them. The current flow uses manual meeting entry and sends the completed assessment and goals attachment from Careers to the authorized manager, with the configured Penny and Steven reviewers copied. Production changes require the project approval and release gates. This contract is not a technical acceptance receipt.

## Owner boundaries

- UI owner: native performance modules, real workspace, page/People shell integration, five Server Actions, related frontend/Action tests. Do not import UAT runtime/bootstrap/SDK/global-fetch/effect fences. Preserve canonical questions and Word geometry; populated goals replace the blank goal rows. Legacy snapshots without goals retain their original Word bytes.
- Database owner: one new versioned production migration, bounded guarded release helper and their SQL/helper tests. Preserve historical migrations, existing records and unrelated catalog objects; retain a healthy purge fingerprint or an existing purge HOLD.
- Mail adapter owner: new server-only dispatcher, dedicated `/api/performance-reviews/mail` route, bounded tests, and only necessary sandbox/mail-variable guards. Do not change existing leave/subscription/check-in mail routes.
- n8n owner: the Performance Review notification and final attachment workflow builders and offline tests under this repository's `deploy/n8n/` and `scripts/`; retire both meeting-import entry points. Publish only through the verified original MAM n8n project REST configuration.
- Parent integrates, verifies targets, handles secrets, applies approved migrations, configures, merges and reads back. No child remote/provider/credential writes.

## Stable application seam

The UI owner adds a best-effort Next `after` callback only after the actual `submit_review` RPC has returned a validated matching committed receipt:

`dispatchPerformanceReviewMailForReview(reviewId: string): Promise<void>` from `@/lib/performance-review-mail`.

A callback/configuration failure must not turn an already committed review into a rejected mutation or invite a repeat final submission. Use the durable scheduler as fallback. Other mutations and employee payloads must not gain mail fields. No UI copy may claim recipient delivery from final-record persistence.

## Durable database seam

`private.performance_review_mail_outbox` has one unique delivery per finalized review, with a UUID delivery ID, review FK, durable claim token, queued/claimed/sending/provider_accepted/needs_review state, attachment SHA and minimal outcome timestamps. No API role has direct table access. Force RLS. Revoke default PUBLIC/anon/authenticated access to service-only RPCs; verify actual hosted service-role defaults explicitly.

Finalization atomically creates exactly one queued row alongside the review/event/operation receipt, without sending. Do not seed historical or UAT reviews or replay old fake claims. A final review and its manager note remain immutable under the existing rules.

Service-only RPC contracts:

1. `claim_performance_review_mail(p_review_id uuid DEFAULT NULL, p_limit integer DEFAULT 10)` returns rows with exactly `delivery_id`, `review_id`, `claim_token`, `payload`. Claim only queued rows under bounded locks. `payload` contains exactly `reviewId`, `reviewCode`, `finalisedAt`, `managerNote`, `document`, `recipient`, `ccRecipients`. `document` is the frozen manager-audience `PerformanceDocument`; the note is separate. No browser input supplies any of this.
2. `begin_performance_review_final_mail(p_delivery_id uuid, p_claim_token uuid, p_attachment_sha256 text, p_recipient text, p_cc_recipients text[])` returns a scalar Boolean. Exactly one claimed-to-sending CAS may return true. Wrong/stale/duplicate claims never authorize another provider send. The current eligible manager address must equal `p_recipient`, and the exact canonical additional recipient set must equal `p_cc_recipients`. Resolve both named reviewer Auth/person pairs from the private configuration and current active authorized directory rows while holding the directory/configuration locks. Exclude the review subject and primary manager, deduplicate and sort; an explicit empty array can be valid after exclusions, while missing or invalid configuration cannot authorize a send. Service-role access to the former manager-only begin RPC is revoked.
3. `finish_performance_review_mail(p_delivery_id uuid, p_claim_token uuid, p_outcome text, p_attachment_sha256 text)` returns a scalar Boolean. Outcomes are `provider_accepted`, `unknown`, `rejected`; unknown/rejected become sticky `needs_review`. Same acknowledged result may reconcile idempotently. Never downgrade an already provider-accepted delivery or release a claimed/sending unknown row for automatic retry.

A durable claim is not a successful send. There is no automatic expiry/reclaim of uncertain attempts. No account/role/credential/reporting changes, trigger bypass, fabricated Auth claims, or salary data.

## Canonical attachment and wire payload

The server validates the database-owned document with the real parser and calls `buildPerformanceReviewDownload`. Require manager audience, a matching review code and finalized record. Use its `.docx` filename/MIME and exact returned bytes; max 2 MiB decoded attachment. Compute SHA-256 over those bytes. The private reviewer note remains in the authorized portal and is excluded from the manager email body and Word attachment.

POST wire keys are exactly:

`version`, `event`, `eventKey`, `deliveryId`, `reviewId`, `reviewCode`, `claimToken`, `employeeName`, `managerName`, `finalisedAt`, `recipient`, `ccRecipients`, `managerNote`, `attachment`.

- `version = 1`, `event = performance-review-finalised`.
- `eventKey = performance-review:<canonical review UUID>:finalised`.
- All UUIDs canonical; review code from the validated snapshot.
- `recipient` is the canonical eligible manager work address returned by the database. The provider begin step revalidates that address and authorization before granting one send. The sender and Reply-To are `careers@mobilityaccess.com.au`. `ccRecipients` is a required dense canonical sorted unique array of zero to two validated named-reviewer work addresses, excluding the manager and review subject; BCC is empty. Both named reviewer pairs must be configured and eligible even when exclusions produce an empty CC array. The email asks recipients to review the completed form, including goals, and, if there are no issues, move to the next step with an internal discussion.
- `attachment` keys exactly `fileName`, `mimeType`, `contentBase64`, `sha256`. MIME is `application/vnd.openxmlformats-officedocument.wordprocessingml.document`; filename is the canonical manager `.docx`. Validate canonical base64, decoded bound and SHA before provider authorization.
- Do not persist/log this payload, private notes, answers, attachment bytes or credentials in ordinary logs/n8n execution history.

Webhook response keys: `ok`, `status`, `deliveryId`, `eventKey`, `actualRecipients`, `attachmentSha256`. Status is `provider_accepted` or `held`; `provider_accepted` means sender-side acceptance, never inbox delivery. Require exact delivery/event/SHA matching and `actualRecipients` equal to `[recipient, ...ccRecipients]`. Missing/malformed/timeout/redirect results are unknown/held, never automatic resend.

## HTTPS, secret and receipt route

Consumed server-only configuration names:

- `PERFORMANCE_REVIEW_EMAIL_MODE`: `disabled` by default, explicitly `live` for the authorized production activation.
- `MAM_N8N_PERFORMANCE_WEBHOOK_ORIGIN`: exact verified HTTPS MAM n8n origin, no path/userinfo/query/fragment.
- `MAM_N8N_PERFORMANCE_WEBHOOK_URL`: same exact origin, fixed `/webhook/mam-people-hub-performance-review-mail-v1`, no redirect/query/fragment.
- `MAM_N8N_PERFORMANCE_WEBHOOK_SECRET`: dedicated source-bound secret; only parent provisions/synchronizes through approved secret stores. Do not rotate/reuse unrelated provider credentials.

Use `X-MAM-Performance-Secret` on caller and callback. No credentials in argv, chat, source, QA, public variables or image layers. HTTPS exact-origin requests, redirects and automatic retries disabled; bound both response headers and body processing.

`GET /api/performance-reviews/mail`: existing `CRON_SECRET` authorization; live mode drains only this new queued outbox. With exact `?readiness=1`, it performs no claims or sends and returns only bounded configuration/connectivity predicates.

`POST` to the same route uses the performance shared secret and a closed body:

- `{phase: readiness}`: no RPC or send, only an authenticated readiness acknowledgement.
- `{phase: begin, deliveryId, claimToken, attachmentSha256, recipient, ccRecipients}`: invoke the strict Boolean begin RPC; expose only the decision.
- `{phase: finish, deliveryId, claimToken, attachmentSha256, outcome}`: invoke the strict Boolean finish RPC.

Reject extra fields, unsafe types, invalid identifiers, unbounded input, wrong origin/secret and malformed results. Keep the existing 1 KiB callback bound and actual native admin client and canonical database authorization. The route must not accept arbitrary URLs, recipients, document content or an impersonated staff actor.

## New n8n workflow

Use fixed MAM People Hub origin and the new bounded webhook paths. A separate readiness trigger under the same owned workflow/credential may verify native Header Auth, the no-RPC callback readiness and an approved sender-identity GET. It must have no path to Outlook send. No real business webhook or email is used as a probe.

The POST business graph validates the complete payload and attachment, calls the begin callback immediately before Outlook send, and sends only when the actual Boolean permit is true. Node retries off. Then acknowledge provider acceptance via finish and return the exact bound receipt. On rejected/unknown outcome retain the durable hold; never manufacture a message ID, retry a send, or clear a claim.

A dedicated five-minute scheduler calls only this new protected Hub dispatcher route, using the existing verified MAM scheduler credential where compatible. No edits to existing schedulers/workflows, historical catch-up, manual send caps or the fake bridge's expired test windows. Disable success/error/progress/manual execution persistence for credential/HR payloads. Parent verifies inactive graph and version, reviews it, then activates only the approved owned workflow; actual no-send readiness and exact readback are distinct from recipient delivery.

## Acceptance boundaries

Use synthetic isolated records/capture for the new code, Word bytes, failure/duplicate/unknown guards and role/privacy tests. No actual test email or real-staff mutation. The 21 October 2026 production rollout applied `20261021024049` on the exact MAM PostgreSQL 17 project, with exact-source migration history, unchanged predecessor history and a healthy purge fingerprint. Read-back confirmed Careers notification and manager attachment workflow versions, with both meeting-import entry points disabled and the meeting workflow inactive. Delivery was paused during the coordinated switch; the reviewed GitHub merge supplies the production deployment that restores live delivery. No test email was sent. Future database changes require a fresh target check and guarded, version-specific established release path; never `db push` unrelated local history or blindly refresh a purge fingerprint. Independently review the integrated production candidate and exact release helper, then use the normal GitHub-merge-to-Vercel flow. HR business acceptance does not replace these technical results.
