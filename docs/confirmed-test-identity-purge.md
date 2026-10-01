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
exact account. Audit/event rows move intact into the private receipt; business
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
shared payroll imports, reviews, provider receipts, attempted/claimed/sent queues,
or unreviewed indirect UUID/JSON/text references block with the actual table or
state. Copying a work-schedule event elsewhere does not authorize deleting its
immutable original. Such blockers do not establish that either live confirmed
test target has those dependencies.

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
   private receipt/schema tables are excluded from the census and final absence
   checks; a same-named table in another supported schema is not excluded.
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
