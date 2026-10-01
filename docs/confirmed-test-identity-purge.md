# Confirmed-test identity purge candidate

This is a separate, System Admin-only destruction policy, not employee offboarding,
normal Directory delete, or duplicate-person merging. It requires independent
confirmation that the exact full identity is exclusively fake/test data. A shared
first name, disabled login, inactive directory row, or short-name duplicate is not
that confirmation. Real employee retention remains unchanged.

## Retention and supported records

Each exact person receives a separate private receipt in
`private.confirmed_test_identity_purges`. The receipt retains the original person,
Auth and actor identifiers, company, original value-minimised audit/event rows,
reviewed per-table counts and SHA256 digests, retired identifiers, and durable
phase timestamps. Original event actor IDs and chronology are retained without
live person/Auth FKs. Receipts are not an employee category and have no reporting,
Directory, account, or employee-preview projection. Direct table access is revoked
from anonymous, authenticated and service roles. Retain this necessary cleanup
provenance indefinitely until a separately approved audit-retention policy exists;
there is no expiry job or silent receipt deletion.

Exclusive business data is destroyed, not copied into another employee record.
The reviewed allowlist covers person/profile/details, check-in enrolment and
unattempted reminder histories, unsent day-one/onboarding queues, balances without
shared import provenance, cancelled portal leave with its exclusive events,
reviewer assignments and never-attempted outbox, and account events targeting that
exact account. The forward finalized leave-history exception below is separate
from those original queue restrictions. Audit/event rows move intact into the private receipt; business
payloads are represented only by counts/digests. Retired references are typed stable UUIDs: person, Auth and owned row IDs.
Canonical stable UUID references in fields, nested JSON, keys and embedded paths
are checked; arbitrary names, login/contact strings and other prose are not
permanent identity keys.
Legitimate names and email addresses may be reused under new stable IDs.

Two supported target shapes:

- Linked employee: profile is already disabled, role is Employee, no shared Auth
  link/admin/reporting children, and the exact Auth identity is already banned.
  Business removal commits before the separately durable Auth-delete attempt.
- Directory-only employee: exact Auth link/login/account version are explicitly
  null and the person is already inactive. The business transaction commits a
  complete receipt immediately; no Auth Admin client or Auth request is needed.

Neither path invents an employment end date or archive reason. Source protection
triggers remain enabled. Work-schedule requests/events, real actor/reviewer/uploader
references, roster-import links, grants, assets, subscriptions, evidence/Storage,
shared payroll imports, reviews, unsupported provider receipts or attempted/claimed/sent queues,
or unreviewed indirect UUID/JSON/text references block with the actual table or
state. Copying a work-schedule event elsewhere does not authorize deleting its
immutable original. Such blockers do not establish that either live confirmed
test target has those dependencies.

## Forward finalized leave-history correction

`20261001140000_confirmed_test_purge_delivered_leave_history.sql` leaves the applied
`20261001130000` migration unchanged. It pins exact predecessor bodies, rejects
pre-existing drift, and verifies the normalized predecessor plus exact new
function definitions/owner/ACLs before advancing the reviewed fingerprint.
Comparison and candidate-hash capture share one database snapshot; later drift
is not silently incorporated into that fingerprint.

For exclusively owned cancelled portal leaves, a delivered outbox row additionally
requires positive attempts, non-null delivery time, no claim fields or error,
and a coherent frozen request/event/recipient snapshot. Each `employeeEmails`
array item must be one valid address, never a comma-separated recipient set;
aggregate `employeeEmail` equality does not substitute for that item check. Its private provenance
retains original IDs, event, attempt count, creation/delivery times and hashed
recipient attribution, not notification content. Active claims, attempted but
uncertain/failed delivery and incomplete or mismatched snapshots still block.

Exact owned `sent` notification receipts remain **in place** as permanent no-resend
keys. Ownership requires a canonical complete leave event key matching an owned
request, outbox event and the dispatcher's outbox/audience SHA256 suffix; UUID
substring detection is only a conservative blocker, never ownership authority.
Sent time, delivery token and provider evidence must exist. The stored canonical
To/CC envelope must exactly equal the envelope derived from that same frozen
snapshot by the current dispatcher and reviewed n8n validator. Split submissions
use the `:reviewers` and `:employee` keys: reviewers are managers plus HR minus
employees, the employee copy goes to employees, and both copies have empty CC.
Cancellation goes to managers, with HR and (unless `wasApproved` is literal JSON
`false`) Accounts in CC, excluding To recipients. Approved/declined/conditional
notices use the validator's employee/CC rules. Expected sets follow the producer's
case-folding, deduplication and sorting; no stored payload or receipt is rewritten.
Unknown unsplit submission envelopes and mismatched recipients/CC block rather
than receiving a history exception. The private purge
audit binds each key to its original timestamp-normalized row digest and hashes
recipient/CC/provider attribution. Only that exact sent row, or its one-way
90-day minimized tombstone, is exempted from operational-absence checks.
Processing, legacy-unknown, pre-minimized, shared and unbound keys remain blockers.
The original minimizer may clear address/token/provider values after 90 days but
cannot delete a key, change original creation/sent times, re-enrich a tombstone or
produce a new send grant. These audit-preserved stable-ID references are not
operational employee records and are not exposed by Analytics; they are expressly
**not** proof that all private references to the retired identity disappeared.

Submission receipts must have the exact target actor and a result bound to its
owned cancelled portal leave with the reviewed four-key result shape and literal
wire status `Pending`. `submit_leave_request_once` stores the DTO returned by
`submit_my_leave_request` or `submit_selected_employee_leave_request` unchanged;
both return `Pending` although the underlying newly created leave row stores
`submitted`. The receipt remains the original submission response after leave
cancellation. Lowercase `submitted`, case/whitespace variants, unknown values,
missing status and non-string values are not supported receipt history.
Necessary actor/key/hash, creation and literal result-state provenance is
archived without duplicating reviewer labels or normalizing status. Status claims must be exact person/Auth-linked, finalized disabled at the
current account version, with succeeded provider execution, executor token and
provider start/finish evidence. Their original actor/state row is retained.
Both FK-bearing rowsets are explicitly deleted with reviewed count checks before
person/Auth deletion; their cascades are not relied upon to erase unknown rows.
All other census, schema, source-trigger, privilege and provider boundaries stay
unchanged. Earlier completed cleanup receipts and guards are not rewritten.

Local synthetic verification:

```sh
node tests/run-confirmed-test-purge.mjs tests/confirmed-test-purge-submission-wire-status.sql tests/confirmed-test-purge-delivered-history.sql tests/confirmed-test-purge-delivered-blockers.sql tests/confirmed-test-purge-delivered-envelope.sql tests/confirmed-test-purge-delivered-address-items.sql tests/confirmed-test-purge-delivered-retention.sql tests/confirmed-test-purge-delivered-manager-only.sql tests/confirmed-test-purge-delivered-timezone.sql --migration-guards --delivered-concurrency --delivered-producer
node tests/run-confirmed-test-purge-provider-storage.mjs --concurrency
node tests/run-confirmed-test-purge-auth.mjs
```

The full-schema wire-status regression exercises both real submission paths and
receipt replay, distinguishing stored `submitted` leave from the `Pending` DTO.
The producer-positive fixture runs the actual TypeScript dispatcher and reviewed
n8n graph offline against full-schema frozen payloads, compares all six exact
To/CC/key envelopes to the SQL receipts, then runs actual preview/prepare and
checks unchanged no-resend rows. Its notification I/O is synthetic, not delivery.
Separate fail-closed probes cover unknown/malformed receipt status, shared result
IDs/actors, stale hashes, incoherent To/CC and malformed array items even when the
aggregate employeeEmail still matches.

The disposable real GoTrue/PostgREST fixture also models two cancelled leaves,
four delivered outbox rows, six sent no-resend receipts with those exact producer
envelopes, two literal `Pending` submission receipts and one finalized status
claim. It checks supported hard deletion/readback, unchanged retained receipts,
necessary provenance and actual dashboard absence.
This is local candidate evidence, not independent review or production feasibility.

## Transaction and reconciliation contract

1. Preview rechecks the actual active System Admin session and exact company,
   person, full name, account/login and versions. It returns counts/digests, not
   private rows. Null account fields are required for directory-only targets.
2. Apply requires that exact preview hash plus both literal `true` confirmations:
   `confirmTestOnly` and `destroyExclusiveHistory`. It serializes purge operations,
   checks administrator authority before any global/table locks, acquires
   advisory/table locks without waiting, locks each reviewed owned row with
   `FOR UPDATE NOWAIT` before destruction (including ordinary writers that first
   take a row lock), and repeats administrator and
   the census/version/hash checks, archives provenance, explicitly deletes each
   reviewed rowset in dependency order, checks exact deletion counts, and asserts
   operational reference absence before committing. It does not invoke a generic
   cascade or disable/rewrite existing triggers.
3. A schema fingerprint covers application tables/columns, FKs (including external
   schema FKs to these tables or Auth), trigger definitions/enabled states,
   functions, reporting views, ownership/ACLs and RLS policies. Schema/projection drift requires a separately
   reviewed forward migration; do not reset its fingerprint to silence a blocker.
   Installation also rejects unreviewed external-schema FK dependencies.
4. Retired-reference guards prevent stale workers, re-imports and new actor/JSON
   references from recreating removed stable IDs in application tables, supported
   Storage tables and Auth users. Exactly `storage.migrations`,
   `storage.buckets_vectors` and `storage.vector_indexes` are excluded from new
   retirement triggers and receive only `ACCESS SHARE NOWAIT` table locks. The
   remaining tables retain `SHARE ROW EXCLUSIVE NOWAIT` locks and all existing
   source/provider triggers stay enabled. Existing unresolved Auth targets permit only a non-shortening
   future ban and its monotonic update timestamp. Every other live non-generated
   Auth user column is compared using the catalog; stored generated values are
   computed after BEFORE triggers, while their writable source fields remain
   protected. Unbanning, shorter bans, decreasing timestamps, identity recreation
   and new references in guarded tables remain prohibited. Only the two qualified
   private receipt/schema tables are excluded wholesale from the census and final
   absence checks; a same-named table in another supported schema is not excluded.
   The forward correction retains only the individually bound notification-audit
   rows described above, not their entire table or other provider receipts.
5. For linked targets only, a compare-and-set moves `business_purged` to
   `auth_delete_started`, rechecking the actual Auth ban under a row lock,
   before one server-only
   `admin.auth.admin.deleteUser(exactId, false)` call. A lost claim response never
   authorizes a call. No SQL Auth delete and no failed-new-account rollback are used.
6. Auth `user_not_found` readback and database Auth absence plus operational census
   are both required before `complete`. Provider errors/timeouts retain the durable
   phase; they never imply rollback or permission to retry deletion. `reconcile`
   reads/finalises only. If the account still exists after a started attempt, stop
   for bounded provider/operator investigation; this candidate intentionally has
   no automatic takeover/reset/retry endpoint. A prepare timeout is recovered by
   exact-person receipt readback, not by blindly repeating business destruction.
   The orchestrator has one 15-second deadline across session, RPC and Auth calls.
   Expired/lost claim responses never start Auth deletion; expired Auth deletion
   calls require reconciliation and are never retried. Underlying provider calls
   can settle after the deadline; a timeout is not proof of rollback.

Completed business purge removes test leave/check-in/person rows from their
source reporting datasets. Disabling a login alone does not do that. Verify live
source datasets and any independent dashboard caches after an authorized release;
no live dashboard verification is claimed here.

## Authorized reduced provider boundary

The user explicitly accepts practical confirmed-test deletion using the available
approved tools rather than universal provider-metadata protection. The exact
three provider-owned Storage tables above allow the migration execution role
`SELECT` but not `UPDATE`, `DELETE`, `TRUNCATE` or `TRIGGER`. This candidate neither
grants those privileges nor changes provider ownership or switches execution
roles. Missing privileges on any other table still fail the migration atomically;
there is no privilege-based catch-and-skip behavior.

All three tables remain in the broad UUID/JSON/text/key/path reference census,
post-business-deletion checks, completion checks and full schema/ACL/trigger
fingerprint. Any observed reference still blocks preview/prepare/completion; the
operator must read back exact reference absence before reporting cleanup complete.
Read-only locks do **not** serialize concurrent provider metadata writes. A provider
writer can commit a reference after a scan, including during the cleanup operation,
and can insert a new retired-ID reference afterward. No concurrent or future-write
guarantee is claimed for these three tables. Schema fingerprints detect schema
drift, not those later row writes. Existing-reference checks are point-in-time
evidence, not a universal retirement prohibition.

## Supported operator entry point

`POST /api/admin/confirmed-test-purge` invokes the independently authenticated
Server Action. Use the current actual System Admin browser session, not selected
employee preview state. The endpoint requires same-origin JSON and a bounded
request: Content-Length is prechecked, streaming bytes stop at 8192 with
cancellation, and body reads have a five-second deadline. There is no added UI, credential prompt, or production apply script.

Example payload (synthetic only; substitute independently reviewed exact identity
values in the approved environment, never choose by fuzzy name):

```json
{
  "mode": "preview",
  "personId": "94000000-0000-4000-8000-000000000002",
  "authUserId": "94000000-0000-4000-8000-000000000003",
  "companyKey": "mam",
  "fullName": "Confirmed Fake Synthetic",
  "loginName": "fake@example.test",
  "personVersion": 1,
  "accountVersion": 1
}
```

Send the JSON with the authenticated same-origin browser's `fetch`, using
`Content-Type: application/json`, `credentials: same-origin`, and
`cache: no-store`. Review every returned manifest count/digest before applying.
For apply, keep those exact fields, change `mode` to `apply`, add the returned
`manifestHash` (the preview response field is `manifest_hash`), and set both
confirmation fields above to `true`. For directory-only targets set
`authUserId`, `loginName`, and `accountVersion` to null. For reconciliation send
only `mode: reconcile`, exact `personId` and exact/null `authUserId`.

A 409 `reconciliation_required` response is partial/unresolved, not deletion
completion. Refresh the per-person receipt through reconcile. Keep each target's
preview/hash/receipt distinct. Successful retries only read an existing completed
receipt; they cannot authorize another Auth-delete attempt.

## Local verification and release gates

```sh
node --test tests/confirmed-test-purge*.test.mjs
node tests/run-confirmed-test-purge.mjs tests/confirmed-test-purge.sql \
  tests/confirmed-test-purge-security.sql tests/confirmed-test-purge-permissions.sql \
  tests/core-review-safety.sql tests/analytics-api-employees.sql \
  tests/notification-delivery-receipts.sql tests/scheduled-offboarding.sql --concurrency
node tests/run-confirmed-test-purge-provider-storage.mjs --concurrency
npm run lint
npm run typecheck
npm test
```

The disposable Unix-socket-only PostgreSQL runner uses synthetic fixtures and
replays all migrations unchanged, emulating permissive default grants before
the purge migration. Both receipt tables FORCE RLS, and every new function has
explicit role-specific EXECUTE revocations. It supplies a small Auth/Storage
platform contract, not GoTrue. Tests exercise linked exclusive records (2 cancelled
leave requests, 11 check-ins and 7 original directory audits), an inactive unlinked
person with 5 check-ins, unchanged real shared-first-name/short-name identities,
actual analytics dataset absence, claims/provider/indirect/shared/immutable
blockers, schema/ACL drift, an interleaved Auth metadata writer, unauthorized
lock rejection, reverse-order ordinary writers, direct-RPC ban enforcement,
expired claim bans, supported rebanning and legitimate name/email reuse.

The separate provider-ownership fixture bootstraps under `fixture_bootstrap`,
replays unchanged predecessors, then runs this entire transactional migration
and actual authenticated purge RPCs with a non-superuser `postgres` execution role
that has only `SELECT` on the exact three provider-owned synthetic tables and no
provider-role membership. It checks every eligible guard, unchanged provider
ownership/ACL/existing triggers, unknown-table atomic rollback, excluded-table
reference blockers and zero-reference readback, exact lock modes, qualified
receipt exclusions, schema drift and reverse-order `SELECT FOR UPDATE` writers.
Its SQL-only Auth removal is a disposable fixture action, not the production Auth
Admin path. Storage HTTP and universal provider-write prevention remain untested
and are not promised.

Node orchestration tests explicitly mock the Auth Admin boundary. They prove exact
hard-delete invocation, durable grant ordering, no blind retries, uncertain receipt
and provider responses, privilege rejection, directory-only no-Auth behavior and
readback semantics. They do **not** prove GoTrue end-to-end deletion. Before release:
review the exact migration hash and retention policy; verify deployed schema/FKs/
triggers and active System Admin actor; perform a disposable GoTrue integration
including real SDK hard-delete/Storage/managed-Auth dependencies and unknown-result
reconciliation; run all normal release/security/browser gates; obtain separately
required target-specific migration/application/production mutation approval.
## Purge-only release integration

The user states they reviewed the supplied candidate and explicitly authorized
release and confirmed-test cleanup. This is a human review assertion, not an
automated or independent security-review pass; the independent provider review
was blocked. Release integration excludes employee consolidation entirely.
The initial operator scope is the two separately confirmed test identities;
real employee consolidation remains deferred.

The purge-only branch starts from `origin/main` at
`dcd6281800df9bdd70c498f01b5a9a76a12036cd`. The original application and migration
bytes matched the supplied purge candidate; the reduced Storage correction changes
only the unapplied purge migration and its tests/documentation. The shared disposable Auth platform fixture now
includes the real `banned_until` column; the purge runner uses that prerequisite
instead of adding it a second time. This is a test-only platform correction,
not a production schema change.

Integrated local gates passed: lint, type-check, 859 Node tests, production
build, the standard SQL gate, unchanged replay of 164 migrations, seven focused
full-schema SQL suites and two concurrency checks, 36 browser component tests,
and the production bundle budget. The dedicated real Auth integration passed
all ten behavioral checks on this purge-only tree; see the integration document
for its limitations. No production change or merge is performed by this release
preparation. Live migration, operator manifests, target-specific destruction
and deployment verification remain separately controlled release operations.

The reduced Storage correction also passed the 164-migration SELECT-only
provider-ownership fixture, all seven focused SQL suites with the strengthened
reverse-order row-lock regression, 22 purge Node tests, `npm run check` (859 Node
tests and production build), the standard SQL gate, 36 browser component tests
and the bundle budget (1,178,595 raw / 345,399 gzip bytes). The actual dedicated
GoTrue/PostgREST integration passed all ten checks again and verified resource
cleanup. Logs are in the MAM scratch directory as
`purge-storage-correction-{provider-sql,focused-sql,node,check,standard-sql-rerun,browser,auth}.log`.
The standard SQL gate used a scratch-only infrastructure path adapter for its
temporary cluster and matching path validators; application migrations and
behavior assertions were unchanged. The corrected source remains local and
uncommitted pending independent parent review; no production mutation, privilege
change, merge or push is performed by this correction.
