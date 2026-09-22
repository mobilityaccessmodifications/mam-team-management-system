# Notification privacy and receiver release

Submission emails are independent reviewer and applicant copies for every leave
category, not just legacy sick-balance snapshots. Reviewers include HR, exclude
the applicant's recorded addresses, and receive no applicant address in their
To/CC headers. The applicant receives their own confirmation without reviewer CC.
Approval/decline routing is unchanged. Whenever Accounts receives a decision
email, manager notes are omitted for both companies. No email contains balances.

Each copy retains its own stable key. Receiver receipts retain the original
normalized To and CC plus minimal provider acknowledgement metadata. Duplicate
success returns that original evidence only when both recipient sets still
match. A changed To or CC returns `receipt-recipient-mismatch`, `ok: false` and
`reconciliationRequired: true`, with the original evidence; it never sends to
the replacement address or acknowledges it as delivered. The duplicate-response
and rejection-response nodes must be published with the validator and
confirmation nodes so these fields survive the final response.

Legacy receipts containing only state/time return
`receipt-evidence-unavailable` without inventing recipients. A shared legacy
key blocks both new submission copies and requires reconciliation even when
its original recipients are known (`legacy-receipt-reconciliation`). A
current copy's own confirmed receipt takes precedence over the shared key.
Legacy sick split keys are unchanged. Processing receipts block concurrent
replays; after 20 minutes their result is `receipt-delivery-unknown`, not a
license to send again. A late success may still confirm its matching original
reservation. Provider rejection never produces a success receipt for either
company. Sender nodes that expose no message/request ID record null; a node
acknowledgement is not proof of inbox delivery.

All leave, birthday/priority, payroll-reminder and comparison-alert branches
use the same capacity and retention policy. At 5,000 stored keys, new keys fail
closed with the sanitized error `MAM notification receipt capacity reached;
reconciliation required.` Existing duplicates and confirmations still work;
even an existing 5,001-key cache is preserved instead of truncated. Unexpired
receipts keep all evidence. After 90 days, unrelated sent receipts may lose
To/CC/provider metadata but retain a minimal sent tombstone. The current key,
its legacy key and every processing reservation remain protected. Expiry does
not permit a second send, and tombstones count toward the limit.

Capacity therefore requires operator reconciliation or a reviewed move to
durable deduplication storage; simply waiting for the TTL does not free slots.
Do not delete receipts, acknowledge current addresses from old evidence, or
manually drain/re-send a backlog. Verify original provider evidence and outbox
state under separate authorization before resolving unknown deliveries. The
new evaluator tests exercise shared-state interleavings, not n8n's storage
durability or multi-worker locking. Static workflow data is not a transactional
cross-worker lock: verify execution serialization and persistence at release,
or use an atomic durable reservation store before claiming that guarantee.

The receiver deliberately rejects new unsplit submissions. Deploy its reviewed
code before merging the split-aware dispatcher: old application instances keep
those events queued for retry rather than exposing applicant addresses. Deploy
with `python3 scripts/deploy-notification-review.py inspect`, then `apply` with
the reviewed bundle hash printed by its `hash` mode. Verify MAM n8n first. The
helper preserves credentials, connections, Outlook settings and static receipts.
Merge through GitHub and verify the exact resulting Vercel production SHA.

Full receiver execution retention remains disabled because it contains HR data.
The leave receiver now uses the existing sanitized internal error alert workflow,
like the check-in receiver and dispatchers. Durable database error state and the
independent GitHub recovery workflow remain available; raw mail logging is not
required for operational visibility. Do not change the sender OAuth identity
based on a stale runbook label alone.

The R02/R03 changes are repository templates and local synthetic tests only;
their live deployment has not been verified. The release helper now includes
all four code nodes and checks the reviewed e88b366 baseline hashes, the
historical rejection-node hash, or the desired code, preserving connections,
sender configuration and static data.
Any different live version requires fresh inspection. At release, verify the
rejection response preserves the reconciliation result, the capacity error
reaches the existing sanitized error workflow, and no raw HR execution data is
retained. Run the offline regression suite with:

```sh
node --test tests/notification-receipts.test.mjs tests/leave-priority-email.test.mjs tests/payroll-comparison-email.test.mjs tests/openclaw-leave-email.test.mjs tests/security-outbox.test.mjs tests/notification-review-deploy.test.mjs
```

The September review's payroll-unsupported claim did not match the live receiver:
its validator hash matched the checked-in payroll-capable code. Check-in catch-up
was already deployed in migration `20260921191000`; past-due history is
intentionally not automatically mailed. Birthday reminders remain manager-only
without HR CC; the caller now reflects that policy as well. An old local checkout
is not production drift and must not be reset or fast-forwarded over other work.
