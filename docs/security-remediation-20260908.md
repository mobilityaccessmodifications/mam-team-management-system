# Security remediation — 8 September 2026

Base: `26cb61d06873612d8df04deeb2d10102cfd40d97`. This change does not alter UI, leave eligibility, reviewer access, or recipient business rules.

## Changes

- Database triggers queue submission, approval, decline and cancellation in the mutation transaction. Conditional approvals queue after the decision note is saved. Ordinary edits do not resend; historical imports do not send submission/approval notices, but subsequent cancellations still notify.
- Browser-authorised RPCs retain existing authorisation checks but can no longer bypass the notification obligation. Only service-role worker functions claim/ack; private queue payloads are not browser-readable.
- Immediate application dispatch drains the same queue as the periodic `/api/cron/leave-notifications` handler. There is no second independent send path.
- Per-request ordering, leased claims and immutable retry payloads prevent concurrent workers claiming the same event. The n8n idempotency key uses the delivery ID, not mutable request fields. Failure remains pending and retries after 21 minutes (longer than the receiver's 20-minute in-flight lock).
- Notes accept normal textarea newlines/tabs while remaining HTML-escaped. The dispatcher strips other non-printing controls from outgoing body rendering only; the database note/snapshot is unchanged. This intentional sanitisation prevents optional body formatting from suppressing required notifications. The receiver rejects raw control characters if a caller bypasses that renderer. Subject/header fields are never sanitised into acceptance.
- All routes carry CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `nosniff`.
- Private append-only grant-change audit records actor, affected Auth/person IDs, operation, transaction ID and time. This adds future history; it cannot reconstruct past grant targets. Passwords never enter this audit.

## Release sequence — requires production authorisation and target checks

Do not deploy only the application: its new queue RPCs require the migration.

1. Verify the configured MAM Supabase project and apply the reviewed migration. No old events are backfilled. Plan a short coordinated release window: old application sends and the new queue must not both dispatch the same events. Keep the new worker disabled until the application switches; reconcile any queued transition events with existing receiver receipts before enabling it. Never blindly resend a backlog.
2. Verify the MAM n8n instance per its project rules; publish the reviewed validator using the existing receiver release script. Do not execute a workflow to test with real recipients.
3. Merge the reviewed GitHub branch to `main` and verify the resulting deployment. Never deploy local application code directly to Vercel.
4. Production target verification confirmed Vercel Hobby. The five-minute worker is therefore scheduled through MAM n8n, not Vercel cron; no plan upgrade. It calls the same bearer-protected endpoint. Configure exactly one periodic scheduler and preserve existing birthday/reminder timing.
5. Verify queue counts and scheduler receipts without printing staff data. A synthetic isolated end-to-end test must prove retries and deduplication before any real sending. Check framing headers on public and authenticated responses.

## Operations

The handler returns aggregate claimed/sent/failed counts only. Missing recipients are kept in the queue with `last_error = 'missing_recipient'`, to be retried after correcting the HR-managed address. Inspect pending/aged/error counts using an authorised database administration route; never expose payloads or addresses in logs. Alert on pending events older than 30 minutes, repeated worker failures, missing scheduler runs, or missing-recipient errors. An empty claim batch alone is not proof the queue is healthy.

Successful events retain their private snapshot and delivery receipt timestamp. Pending events prevent deleting the source; completed history survives a subsequently authorised source deletion without blocking it. Define retention/archive policy before purging this private history. Do not purge unsent events. n8n currently retains deduplication state for 90 days; investigate old ambiguous deliveries before a manual replay rather than assuming unlimited exactly-once guarantees.

## Verification

`npm test`, `npm run lint`, `npm run typecheck`, production build. SQL tests run against a new disposable PostgreSQL 16 database with minimal synthetic schema dependencies, then execute the actual new migration. They verify queue creation, rollback, conditional decisions, historical behaviour, immutable retries, lease tokens, ordering, grants and grant/revoke audit identities. They are not a replacement for running all historical migrations and all portal RPCs in a complete Supabase staging environment.

CI now runs JavaScript tests and the disposable SQL regression job. No real employees, production tokens, external mail or production database writes are needed.

Local results: 22 JavaScript tests passed; the SQL suite passed in a fresh PostgreSQL 16 database. Actual role execution confirmed service_role can claim and authenticated cannot. Lint/typecheck passed; `npm run build -- --webpack` passed (webpack avoids the external dependency symlink restriction in this isolated worktree). Local HTTP checks confirmed framing headers on login and redirect responses. No production migration, n8n update, release, or real email was performed.

Review command: `/Users/nixon/.codex/skills/autoreview/scripts/autoreview --mode local --engine codex --no-web-search` with security scope prompts. Three accepted compatibility findings were fixed: manager submissions without employee email, Accounts CC for conditional-approval cancellation, and silent historical corrections. The last run returned one P2 about stripping body control characters. It was consciously rejected after manual review: failing an otherwise valid durable event because of optional body control bytes recreates notification suppression, while the original database content remains intact. The renderer preserves normal newline/tab characters and the test proves the intended output. The last automated run therefore was **not a zero-findings exit**; there are no remaining accepted findings from it. No extra run was made just to obtain a clean label.

Skills used: takeover-context, Supabase, Next.js, Vercel Cron Jobs, autoreview.
