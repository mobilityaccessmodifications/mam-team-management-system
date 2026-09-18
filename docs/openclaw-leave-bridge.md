# WhatsApp self-leave bridge — local implementation draft, NOT enabled

Status: contract, HMAC HTTP route, optimistic-CAS store and additive migration
draft exist locally. There is **no production migration, secret provisioning or
VPS installation**. Full-stack database and native adapter verification is still
required. Do not point MCP at this path and describe it as working.
Do not reuse the read-only allowlist secret. No real leave or notification was
created. Existing portal submission and its database permissions are unchanged.

## Existing workflow audit

- `src/app/leave/actions.ts: submitLeaveRequest` validates fields, requires a
  Supabase `auth.getUser()` session, calls `submit_my_leave_request`, then dispatches
  notifications. It cannot authenticate a WhatsApp sender and is NOT a bot API.
- `submit_my_leave_request` derives its actor from `auth.uid()`, requires an active
  linked portal employee, validates category/dates/times, resolves reviewers and
  starts Pending. Its current foundation is migration
  `20260818130000_configurable_leave_approval_grants.sql`, with later policy,
  stable-person, reviewer-routing, evidence and outbox triggers.
- `submit_selected_employee_leave_request` is a different privileged workflow.
  Do not call it with a service key or manufacture an administrator login to
  impersonate WhatsApp users. Never mint a user JWT or set request JWT claims
  from model parameters to bypass the existing self-only RPC.
- The service-only WhatsApp allowlist returns a set of allowed numbers, not an
  authenticated caller, employee identity, confirmation proof or submission grant.
  Its five-minute cache must not authorize a write.
- Employment policy limits Casual/ABN/unclassified employees to Unpaid leave.
  Full-time full-day display is 7.6 hours; authoritative duration, current
  reviewers, employment constraints and notification routing remain database-owned.
  Current portal notes are optional; do not demand medical diagnoses in chat.

## Trust boundary and proposed API

`POST /api/internal/integrations/openclaw/leave` is implemented locally, disabled
unless `MAM_OPENCLAW_LEAVE_ENABLED=true`, account and a distinct secret are set.
The migration also creates a private database release gate, **false by default**;
the route flag alone cannot enable database writes.

Only a trusted **native OpenClaw adapter** may sign requests. Ordinary MCP tool
arguments, prompts, quoted messages, session names and `confirmed: true` are not
identity/consent evidence. The adapter must obtain account, canonical sender and
session from host-derived requester context, fail closed when missing, reject
groups/from-self/system events, and check that the session belongs to that sender.
Use the same configured WhatsApp account at both ends. No account switching.

Configure a distinct random 32-byte base64url
`MAM_OPENCLAW_LEAVE_BRIDGE_SECRET` only in the adapter's protected process and
People backend. Never expose it, the signing function, or Supabase credentials
to model tools, tool arguments, agent files, transcripts or general MCP clients.
Changing an env variable is insufficient to enable this unconnected contract.

Headers planned: `X-MAM-Timestamp` (13-digit epoch milliseconds),
`X-MAM-Signature` (lowercase hex HMAC-SHA256). Signed bytes:

```text
POST\n/api/internal/integrations/openclaw/leave\n<Timestamp>\n<exact UTF-8 JSON body>
```

Signature validity is ±60 seconds. Cap streamed body at 16 KiB **before buffering**
in any future route; accept JSON only, no query parameters, cookies or CORS;
HTTPS fixed origin, no redirects. All responses must be `private, no-store`.
Apply per-sender/account rate limits before database work. Key rotation is a
separate provisioning operation; do not ship literal keys or copy production data.

Envelope keys (all required; unknown keys rejected):

```json
{
  "version": 1,
  "account": "mam-test",
  "channel": "whatsapp",
  "sender": "+61400000001",
  "session": "host-derived-session",
  "eventId": "host-derived-event-id",
  "operation": "prepare",
  "payload": {
    "leaveType": "Annual leave",
    "startDate": "2026-10-12",
    "endDate": "2026-10-12"
  }
}
```

This example is synthetic. Identity and event ID are inserted by the adapter,
**not arguments in the model-visible tool schema**. Only the `prepare` payload
is model-visible: `leaveType`, `startDate`, `endDate`, optional paired
`startTime`/`endTime`, optional `employeeNote`. Missing required fields return
`needs_input` with field names; ask the employee and prepare again with a new
host tool-call event ID. Do not invent dates, note text, times or consent.
Times use 15-minute intervals, 06:00–18:00; the contract bounds ranges to 366
days and years 2000–2100. Timezone is Australia/Melbourne. No attachment intake.
Account/session/event identifiers are bounded to 128 ASCII letters, digits,
colon, underscore or hyphen. If a provider/host ID contains other characters,
the adapter must deterministically SHA-256 the complete trusted ID (including
its namespace), not truncate it or substitute an LLM-selected session label.

## Display and confirmation (not model-callable tools)

### Native host binding evidence and required behavior

The linked `连接并安装 OpenClaw` task reports inspection of the actual installed
OpenClaw **2026.9.4** type definitions on the approved VPS (18 September 2026):

- Tool factory context provides `requesterSenderId`, `messageChannel`,
  `agentAccountId`, `sessionKey`, `deliveryContext` and optional `delivery.send`.
  `deliveryContext` has channel/accountId/to/threadId. `delivery.send` returns
  `Promise<void>`: completion alone is **not** an outbound message-ID receipt.
- `message_sent` supplies `to`, `content`, `success`, `messageId`; its hook context
  supplies channelId/accountId/sessionKey. Correlate a successful event to the
  exact pending summary, intended DM recipient, account and session before `shown`.
- `before_dispatch` supplies channel/content/senderId/replyToId/replyToIdFull/
  replyToIsQuote/isGroup and supports `{handled,text}`. Intercept only the exact
  UUID challenge reply from the same trusted sender, same account/session, a DM,
  and the exact recorded quote ID. Consume confirmation as a trusted hook event,
  not an instruction passed to the language model.

This is delegated type-inspection evidence, **not** an end-to-end verification
of plugin behavior. The OpenClaw task owns the native binding implementation and
its tests. Backend quote binding remains mandatory: no fallback to an unquoted
`CONFIRM`, generic yes, model `confirmed=true`, or a guessed outbound ID. Normalize
provider IDs identically on send/receive, without dropping account namespaces.
If message receipt correlation is absent/ambiguous, send fails, context is missing,
or a plugin restart loses pending state, fail closed and require a new preparation.
Install no bare MCP write tool as a substitute. Hook ordering and duplicate events
must be covered by that task's synthetic tests before either release gate opens.

1. `prepare` resolves one active MAM employee from a complete live directory,
   rejects missing/shared/invalid phones and missing/inactive linked accounts,
   validates fields and records an immutable ten-minute draft. The result has
   `draftId`, exact `summary`, its SHA-256 `digest`, and `expiresAt`. No leave yet.
2. The trusted adapter sends that exact summary directly to the verified sender,
   without an LLM rewrite. On successful provider send it signs `shown` with
   payload `{draftId,digest,outboundMessageId}`. If send fails, do not mark shown.
   The token-bearing summary must never be sent to a different session/person.
3. A trusted incoming-message hook must see a **later actual user message**,
   same sender/account/session, replying to that outbound message and containing
   exactly `CONFIRM <draft challenge>`. It signs `confirm` with payload
   `{draftId,digest,replyToMessageId,text}` using the provider's inbound event ID.
   Generic “yes”, quoted/forwarded text, an earlier event, model tool output, a
   self-sent message or missing reply metadata is NOT confirmation. Do not allow
   the LLM to construct or invoke `shown`/`confirm` or ask the signer to sign them.
4. The backend re-resolves identity and employment policy, checks exact draft
   binding, summary digest, shown receipt, expiry and confirmation text. Changed
   ownership/classification requires a new draft, even for a manager/admin.
   A successful result is only `{code:"submitted",requestId,status:"Pending"}`.
   Approval/rejection/cancellation/edit endpoints and employee selectors do not exist.

The HMAC authenticates the adapter, not WhatsApp itself. The backend cannot
independently prove that a compromised signer really displayed the summary or
received consent. Before activation, audit the installed adapter's host context,
incoming-message provenance, event ordering, account isolation and confirmation
hook with synthetic messages. A generic stdio MCP server alone is insufficient.

## Database adapter implementation and remaining release blockers

`src/lib/openclaw-leave-store.ts` computes a plan from one snapshot RPC; one commit
RPC rechecks source and draft fingerprints under locks, then writes all state.
`supabase/migrations/20260917223558_openclaw_leave_bridge.sql` is local-only.
Snapshot normalization is done in trusted People server code; the database receives
its resolved person ID only over the service-only boundary, not from HTTP/model
payloads. This is a trusted server plan, not independent SQL phone normalization.

The two public RPC facades are `SECURITY DEFINER` with a fixed empty
`search_path` and schema-qualified private calls. Only `service_role` receives
EXECUTE on these facades; it receives no direct EXECUTE on the private bridge
functions and no table grants. The migration does not add private-schema USAGE
or revoke unrelated existing schema privileges. This follows PostgreSQL's
[security-definer guidance](https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).

Local ACL verification on 2026-09-18: the original invoker version was callable
because its final GRANT statements restored private-facade EXECUTE to
`service_role`; there was no reproduced permission-chain outage. The tightened
regression rejects that original privilege shape. The revised migration passed
catalog and actual `SET ROLE` checks for `anon`, `authenticated`, and
`service_role`: browser RPC calls, direct private calls and table access are
denied; public service-role calls work without private-schema USAGE; default-off
release gating, prepare/show/confirm and exact retry all pass in a disposable
synthetic database. The 12 focused contract/route tests also pass. This is local
verification, not an external review or production migration.

The private submit helper is derived from the deployed portal function using
guarded substitutions, leaving the portal function unchanged. It rejects leftover
`auth.` references in the helper itself. **This is not proof that every called
function or trigger is session-independent.** The known submission-details trigger
sets submitted_by from auth.uid(); bridge commit corrects that column in the same
transaction. Real employment trigger and complete portal submission body are used
in the SQL fixture; reviewer and outbox fixtures are simplified. The complete
deployed trigger stack, notification payload, manager-group rules, lock ordering,
deadlock retries and concurrent portal/bridge mutations still need validation.

Run local SQL fixture with `node tests/run-openclaw-leave-sql.mjs <task-local-socket>`
on port 55439, fresh database `openclaw_leave_test`, existing synthetic roles.
It tests migration compilation, role denial, CAS rejection, confirmation rejection,
one Pending request, reviewer/event/outbox rows, and retry idempotency. It is not
a full production-schema test. Full native host-binding verification remains
incomplete; keep both release gates disabled.

The following guarantees remain the acceptance checklist; the in-memory tests
and partial SQL fixture alone do **not** prove full-schema crash recovery/isolation:

- Execute identity revalidation, immutable draft/receipt locking, submit-self,
  reviewer assignment, audit, Pending insert and notification outbox in one
  serializable transaction. A request must not create a leave without its replay
  receipt, or a successful receipt without its leave. Roll back together.
- Keep draft/receipt tables private with RLS and no browser role grants. Expose
  only narrow service-only public SECURITY INVOKER wrappers around audited
  private routines with an empty search path. Revoke PUBLIC/anon/authenticated
  execution. Supabase service-role stays solely in the People server.
- Never implement `transaction()` as several independent PostgREST calls.
  If normalizing directory phones in Node, use a DB-issued snapshot fingerprint:
  include all active MAM phone/country/identity/account-state rows in deterministic
  order, validate completion, normalize with the shared numbering library, then
  have the final RPC lock source rows/tables against inserts/changes, re-derive
  and compare that fingerprint before trusting the resolved identity. Reject a
  stale snapshot and start over. Document/test lock ordering with existing
  hierarchy and leave-grant advisory locks. No `limit 1` ambiguity workaround.
- A narrow private submit-self helper may be extracted from the current portal
  implementation only with regression tests preserving existing caller checks.
  Do not use raw table inserts that omit policy/reviewer/evidence/outbox triggers,
  globally mutate JWT claims, or accept caller-selected user/person IDs in the
  public bridge. The internal `Employee` object here is server-resolved only.
- Uniqueness: receipt key is SHA-256 of account/sender/provider event ID; body
  fingerprint binds operation, session and payload. Exact retries return the
  saved result; changed payload conflicts. A receipt also binds immutable person
  and user IDs to prevent a reassigned phone reading an earlier owner's result.
  Re-signing transport time for a retry must not change the original event ID or
  body. One draft may produce only one leave even with new confirmation events.
- Enforce overlap/deduplication for fresh drafts in the same transaction, per
  employee and non-cancelled/non-declined leave; no caller-controlled idempotency
  key can disable this check. Record bounded minimal audit provenance. Establish
  retention/cleanup for drafts, confirmation IDs and receipts before rollout.
- Notifications use the existing transactional outbox and normal dispatcher;
  never accept recipients from the adapter and never send mail inside this
  transaction. No balance in chat/email response. No direct email test sends.
- Safe failures only: 400 invalid input, 401 bad signature, 409 identity/state/
  confirmation conflict or expiry, 503 unavailable. Do not expose SQL messages,
  matched names, phone lists, reviewer identities, notes or raw request logs.

Required pre-release tests: actual PostgreSQL role denial, transaction rollback,
parallel duplicate confirmations, source edits/inserts during submit, changed
employment/manager, outbox once-only, timeout-after-commit retry, revoked accounts,
number reassignment, no reviewer, invalid employment leave type, overlap and
gateway restart/replay. These are **not completed by the in-memory contract tests**.

## Local verification

`node --test tests/openclaw-leave-contract.test.mjs` uses only synthetic people,
phones, times and a synthetic serializable store. No network, credentials,
database connection, outbound message or email occurs. Existing portal workflows
remain unchanged. External review of this new internal leave diff requires its
own specific approval; previous phone-normalization review is not a review of it.

Initial contract-only verification on 18 September 2026: 11 focused contract tests
and 240 Node tests passed. Later route/store/SQL changes require fresh checks.
The initial stage had no external review. The user subsequently authorized
external read-only review of this leave diff on 2026-09-18; see the follow-up
below. No production operation has been performed for this leave diff.

Route/store draft verification: all 241 Node tests, lint, typecheck and production
build passed. The migration/partial SQL fixture passed in two isolated databases,
including the final default-off release gate version. The local PostgreSQL server
was stopped after testing. No full-schema/concurrency/native-plugin verification
is implied. All changes remain uncommitted on `codex/openclaw-leave-contract`.

After source inclusion of the native plugin: `node --check` passed for its
runtime entry; four new offline smoke tests and all 245 Node tests passed.
`npm run lint`, `npm run typecheck`, and `git diff --check` also passed. No
dependency installation, native VPS revalidation, gateway install/enable,
production migration or external review was performed in this source-inclusion
step. The imported runtime, package and manifest hashes match the temporary
source; only its operator README was expanded.

## Deployment sequence (NOT executed; requires approval)

Native plugin source is now included at
[`integrations/openclaw-leave/`](../integrations/openclaw-leave/README.md):
`index.js`, `package.json`, `openclaw.plugin.json`, and operator README. The
runtime source matches the coordinating task's temporary tested copy; no
temporary harness, credentials, dependencies or generated build output were
copied. The coordinating task reported native OpenClaw 2026.9.4 build/validation
success. The repository's `tests/openclaw-leave-plugin.test.mjs` is an offline
registration/identity/signature/confirmation smoke test with fake SDK/fetch;
it is not native SDK or real-channel E2E evidence. Installation behavior has
not been verified; follow the README's stop gate, not an install-then-disable
recipe. No plugin is installed or enabled by these source additions.

1. Finish full-schema tests, portal/bridge concurrency tests, cleanup operational verification and native
   plugin host bindings. Independently review the exact internal diff after explicit
   external-code-review authorization; do not reuse the phone-normalization review.
2. Verify MAM Supabase target, apply only the reviewed migration with its recorded
   hash/version; leave database gate false. Check service-only ACL and all triggers.
3. Provision a new `MAM_OPENCLAW_LEAVE_BRIDGE_SECRET` in People production and the
   trusted VPS adapter only; configure exact `MAM_OPENCLAW_LEAVE_ACCOUNT`.
   Keep `MAM_OPENCLAW_LEAVE_ENABLED=false` until gateway verification passes.
4. Authorized GitHub PR/merge triggers Vercel; never direct-deploy local code.
5. Install the independently tested native plugin and trusted inbound hook on the
   approved VPS, verify sender/account/quote provenance with synthetic tests.
6. Only after explicit release authorization and complete checks, enable the
   private database gate and route flag. Never expose a DB key to VPS. Do not create
   real leave or send employee test messages as a smoke test without authorization.

## Authorized review follow-up (2026-09-18)

The first external Codex run returned five findings; the patch was not approved.
Local evidence is `/private/tmp/mam-openclaw-leave-review.5Fh5I5/review.json`.
The concrete issues were accepted, with two qualifications: exact-event retries
already read their receipt before draft CAS (the defect was concurrent **fresh**
events), and receipts do not store whole packets (prepared summaries nevertheless
contain sensitive notes). Corrections awaiting the next independent review:

- After locked identity/immutable-field/quote checks, a completed confirmation
  returns its persisted result even to a second fresh event with a stale snapshot.
  Two actual parallel PostgreSQL connections now verify identical Pending IDs.
- `changes_requested` joins submitted/approved in the active-overlap guard.
- A fulfilled send promise reports delivery requested, not receipt verified.
  Receipt hooks match session as well as account/sender/exact summary. A failed
  `shown` call can retry only the same provider message ID, including from an
  exact quoted confirmation, and never submits while that receipt is unconfirmed.
- New protocol-cache maintenance keeps a one-hour replay/rate window and deletes
  older drafts/receipts in batches, without touching requests/events/outbox. The
  daily `/api/cron/openclaw-leave-cleanup` requires CRON_SECRET, works even when
  submission is disabled, and reports errors/backlogs as 503. The checked-in
  schedule is not yet deployed. Normal cleanup latency is up to 25 hours, not a
  promise of deletion at 60 minutes; failed/backlogged jobs must be monitored and
  rerun. Retention of the actual HR ledger is unchanged and remains a separate
  business decision. Release must verify the scheduled cleanup successfully runs.

`tests/openclaw-leave-retention.sql` proves expired cache removal, live-window
receipt preservation and unchanged HR records; the SQL runner also checks
changes-requested overlap. Synthetic fixture databases only have been cleaned.
No live employee data was accessed or deleted. Runtime source now differs from
the initially imported plugin, so official native build/validate must be rerun
for the corrected artifact before installation; prior evidence is insufficient.

The second review's final report identified two further corrections and one
false-positive: a completed confirmation now returns its prior result after the
draft TTL (while retained), but never creates a new request after expiry; the
native tool is unavailable without trusted direct delivery and never falls back
to model-driven summary sending. The `needs_input` actor concern was rejected:
the common `saveReceipt` path already supplies the resolved employee. A new test
runs the actual contract plus Supabase adapter and asserts its commit actor and
null draft; a real SQL fixture confirms that plan returns `needs_input` without
creating leave. Both client and DB tests now cover completed-result TTL replay.
Pending final external rerun; do not infer approval from these local tests.

Third review follow-up: fixed the inclusive 366-calendar-day boundary and
removed inbound confirmation trimming, with leap-year and whitespace tests.
The corrected plugin has now been directly checked with native Node 24.19.0 /
OpenClaw 2026.9.4 in a fresh isolated MAM VPS temp directory. Build and validation
passed; the exact runtime/package/manifest hashes are recorded in its README.
Generated metadata matches the repository artifact. No plugin was installed or
enabled, and no real channel, employee data or credentials entered validation.
This supersedes the earlier “native validation pending” note for this artifact,
but does not establish actual WhatsApp hook delivery or production-schema safety.

### Review closeout and final finding adjudication

Four authorized read-only Codex runs used:
`autoreview --mode local --engine codex --no-web-search --stream-engine-output
--prompt-file /private/tmp/mam-openclaw-leave-review.5Fh5I5/scope.md`, with
separate `review[-2/-3/-4].json` and `.txt` outputs in that directory. Accepted
code findings were corrected and rerun as described above. All 253 Node tests,
lint and typecheck passed; local PostgreSQL fixtures compile and execute the
actual derived helper and verify concurrency/ACL/retention. Native SDK validation
of the exact corrected plugin also passed.

The last helper exited **1**, not clean: its sole finding claimed the rewrite
leaves `or or`. This is a verified false-positive, not an unresolved code defect.
The removed literal starts with `or coalesce(...)`, so the leading operator is
removed with that clause. A direct query of `pg_proc.prosrc` in the isolated
`openclaw_leave_test_8` database returned:

```sql
if v_actor_user_id is null

    or not private.is_active_portal_account(v_actor_user_id) then
```

`prosrc !~ 'or[[:space:]]+or'` returned true. The fixture had already executed
this exact helper to create two synthetic requests (including the concurrent
confirmation scenario). The local cluster was stopped after verification.
The raw reviewer report is retained unmodified. No fifth run was started merely
to obtain a cleaner label; report this as reviewed with the final finding
rejected on evidence, **not** an automated-clean/pass result.

No commit, push, merge, production migration, cron activation or plugin
installation/enablement was performed. All earlier production-trigger,
portal/bridge concurrency and real-channel activation gates remain applicable;
this review closeout does not authorize or prove release readiness.
