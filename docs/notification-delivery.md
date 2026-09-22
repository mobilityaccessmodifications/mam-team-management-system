# Notification privacy and durable delivery

Submission emails are independent reviewer and applicant copies for every leave
category. Reviewers include HR, exclude the applicant's recorded addresses, and
receive no applicant address in To/CC. The applicant receives their own copy
without reviewer CC. Approval/decline routing is unchanged. Decision copies sent
to Accounts omit manager notes for both companies. No email contains balances.
Birthday reminders remain manager-only without HR CC.

## Send boundary

All leave, birthday, payroll-reminder and comparison-alert branches of the MAM
leave email receiver use one durable reservation contract. n8n validates the
message and final recipients, then calls the fixed portal receipt endpoint using
its existing webhook HeaderAuth credential. Native HTTP Request nodes never
follow redirects or retry a reservation. Supabase keys remain server-side.

`POST /api/internal/integrations/notifications/receipts` accepts only bounded,
authenticated reserve/confirm requests. Its three service-only database RPCs
expose no browser/admin replay capability. Private RLS tables have no direct
application-role grants. The receiver receives a token only when a new event key
is inserted atomically. Concurrent requests, retries and a lost reserve response
never receive that token again. No database transaction spans an Outlook send.

Only a fresh grant reaches a sender. A successful sender result is reduced to
provider acceptance, message/request IDs when available, and status code when
available. n8n durably confirms the bound token and original To/CC before returning
success. Provider rejection, network uncertainty or a lost confirmation leaves a
processing reservation that blocks automatic re-sending. After 20 minutes it is
reported as `receipt-delivery-unknown`; time alone never permits a takeover.
An exact late confirmation with the original token is allowed.

Matching duplicates return the original proven recipient sets and provider
acknowledgement. Changed To/CC returns `receipt-recipient-mismatch` and requires
reconciliation, not a send to a replacement address. Missing historical evidence
returns `receipt-evidence-unavailable`. A shared legacy submission key blocks
both new split copies (`legacy-receipt-reconciliation`); a copy's own confirmed
receipt takes precedence. Provider acceptance is not proof of inbox delivery.

The database retains permanent no-resend keys, without the old 5,000-key static
cache limit. A bounded retention operation minimizes recipient/provider evidence
on unrelated sent receipts older than 90 days while preserving tombstones. The
current key and its legacy key are protected during reserve; processing records
are not deleted. Maintenance never creates permission to send again.

## Reviewed release and recovery

Application releases go through reviewed GitHub PRs into `main`, then the exact
Vercel deployment must be verified. The forward database migration is additive
and creates a disabled receipt store. The old receiver remains authoritative
until the explicit paused cutover; an application deploy alone is not completion.

1. Verify the exact MAM Supabase, GitHub, Vercel and n8n targets. Run all local and
   CI gates, including real concurrent PostgreSQL sessions and synthetic Next.js
   HTTP tests. Review the entire API/SQL/n8n/deployment bundle together.
2. Apply the hash-pinned additive migration through the approved credential
   helper/Management API. Merge the reviewed API release and verify production.
   An authenticated GET exposes only `{version: 1, ready: false}` at this stage.
3. Pause only receiver `D6UG5ACZGILCpsOk`. Drain its pinned 30-second execution
   timeout and verify zero nonterminal executions. Take two stable reads and
   create a private task-temporary snapshot containing every legacy key/state/time.
4. Import the complete frozen snapshot in one transaction, preserving known sent
   and unknown states without inventing recipients or provider evidence. Record
   the exact snapshot SHA-256, count and import time. Keep `ready=false`.
5. Apply the hash-pinned n8n nodes/connections while inactive. Preserve Outlook
   credentials, recipients, static data, timeout and sanitized error workflow.
   Verify the saved topology and the existing credential's GET-only API access.
6. Verify the unchanged frozen snapshot and reviewed inactive topology, enable
   the store with the matching import proof, then activate only this receiver.
   Read back its active version and API/database readiness. Do not replay history
   or send a real test email as part of deployment.

If a write times out, inspect exact state before any retry. If a cutover check
fails, keep the affected receiver inactive and fix forward. Do not restore the
unsafe static-cache sender after durable reservations have begun. Keep recovery
snapshots private until the cutover is verified; never commit receipt exports.

Do not delete/reset receipts or manually replay unknown deliveries. Resolving
them needs separately authorized provider/outbox reconciliation. Full n8n
execution retention stays disabled because messages contain HR information;
the existing sanitized error workflow and database error state provide alerts.
Do not change OAuth identity based on an old runbook label.

## Verification and limitations

`npm test` exercises the exact deployed n8n templates and their topology, the
bounded API, and deployment guards. `node tests/run-notification-receipt-http.mjs`
uses a real local Next.js/Supabase-client path with synthetic HTTP RPC fixtures
and no mail sender. `npm run test:sql` replays all migrations and exercises real
PostgreSQL permissions, transactions, concurrency, legacy collisions and
no-resend tombstones; CI repeats it on PostgreSQL 16 and 17.

Offline tests do not establish production provider acceptance. Production release
evidence belongs in the release PR, including exact deployment/workflow versions,
import counts, readiness and checks not performed. WhatsApp remains separately
paused until independently verified phone enrollment and reopening approval.
