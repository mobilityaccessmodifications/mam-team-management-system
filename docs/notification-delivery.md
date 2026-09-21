# Notification privacy and receiver release

Submission emails are independent reviewer and applicant copies for every leave
category, not just legacy sick-balance snapshots. Reviewers include HR, exclude
the applicant's recorded addresses, and receive no applicant address in their
To/CC headers. The applicant receives their own confirmation without reviewer CC.
Approval/decline routing is unchanged. Whenever Accounts receives a decision
email, manager notes are omitted for both companies. No email contains balances.

Each copy retains its own stable key. Previously delivered legacy shared receipts
suppress both copies after an interrupted database acknowledgement; in-flight
legacy sends wait out the existing reservation. Legacy sick split keys are
unchanged. Never delete receiver receipts or manually drain a historic backlog.
Provider rejection prevents success for both companies. Fresh receipts identify
the actual To recipient rather than a different confirmation-only recipient.

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

The September review's payroll-unsupported claim did not match the live receiver:
its validator hash matched the checked-in payroll-capable code. Check-in catch-up
was already deployed in migration `20260921191000`; past-due history is
intentionally not automatically mailed. Birthday reminders remain manager-only
without HR CC; the caller now reflects that policy as well. An old local checkout
is not production drift and must not be reset or fast-forwarded over other work.
