# Disposable real Auth Admin integration

Run from the candidate worktree, with its installed Node dependencies:

```sh
node tests/run-confirmed-test-purge-auth.mjs
```

The runner is executable and has no arguments accepting a remote project URL or credential. It hard-codes the task-approved Docker endpoint `unix:///Users/nixon/.colima/mam-cleanup-e2e/docker.sock` and isolated Docker configuration `/Users/nixon/.hermes/profiles/mam/cache/scratch/docker-mam-cleanup`; every Docker invocation explicitly supplies both with `env`. It requires Docker server 29.5.2. It neither selects a global Docker context nor changes/stops Colima. All containers, the private network and the named database volume carry the task label `mam.confirmed-test-purge-auth` and unique per-run names. Database ports are not published; Auth and PostgREST publish random ports only on 127.0.0.1. The local forwarding/fault proxy also binds only 127.0.0.1. Cleanup is in `finally`, with readback verifying containers, network and database volumes are absent. Downloaded public images remain cached; the VM is left running for its owner.

All passwords, signing material and legacy API JWTs are generated locally in memory per run. No `.env`, production configuration, vault, registry credentials or existing database is read. Provider payloads, tokens and passwords are not printed. The only diagnostic extracted from database logs is a known rejection boolean and UPDATE column names, never raw statements or logs.

## Immutable image references actually pulled and run

| Component | Reference / observed image ID |
| --- | --- |
| PostgreSQL | `postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929` |
| Supabase Auth | `supabase/gotrue:v2.189.0@sha256:385184459f57569c54c25209f51f3b2be99ddd7c4ce9e3555b5d3eea8447b7cf` |
| PostgREST | `postgrest/postgrest:v14.12@sha256:54000f24847d01a2c2302e0041cf0618b875c57fb48507d743cfa9aaa50bf43c` |

Each observed image ID was the `sha256` value above on the dedicated daemon. The runner prints both the reference and actual ID on every run.

## Provider and application boundaries

GoTrue starts first under a non-superuser `supabase_auth_admin` role, owns the `auth` schema, and applies its real shipped migrations. The existing SQL-only platform prerequisite is read with only its fake Auth schema/table/functions removed. GoTrue supplies the actual `auth.users`, identities, sessions, `auth.uid()`, `auth.jwt()` and `auth.role()` definitions. Remaining role, Storage table-shape, extensions and publication prerequisites stay synthetic. The runner then replays every application migration unchanged (164 in the purge-only release integration), including its restrictive triggers, and executes the effective RLS/ACL/schema contract.

The contract's UNIX-only **listening** assertion is replaced with a Docker inspection asserting the database has no published host port; the SQL connection itself is still a UNIX socket via `docker exec psql`. Internal Docker TCP is necessary for the actual GoTrue and PostgREST services. No application assertion, policy, function, migration or trigger is weakened or replaced.

The real TypeScript `runConfirmedTestIdentityPurge` export is loaded through esbuild. Only the packaging marker `server-only` is removed. Real supabase-js clients talk HTTP to actual GoTrue and PostgREST; the synthetic actor signs in through GoTrue and gets actual database System Admin authorization. Business RPCs execute as its authenticated role. Analytics RPCs use the existing service-role-only ACL. SQL is used only for synthetic application fixture insertion, readback and schema assertions; Auth accounts are created, banned, unbanned and deleted solely through supported Auth Admin APIs.

## Assertions

- Linked employee profile is disabled; real Auth password login reports `user_banned` after a supported ban. A real prior Auth session exists, so session cleanup is not a vacuous check.
- The orchestrator calls actual `deleteUser(id, false)` exactly once after its durable claim. Readback requires null user plus exact `user_not_found` / HTTP 404. User, profile, person, provider identities and prior sessions are absent.
- Cancelled portal leave and completed synthetic check-in history disappear; original directory audit is retained in the receipt. Actual dashboard RPCs exclude the purged ID/name. Another synthetic employee's complete reminder snapshot remains unchanged.
- Inactive directory-only shape completes with a null Admin client and no Auth Admin HTTP calls.
- Two proxy faults occur **after GoTrue actually returns successful deletion**: malformed/truncated success JSON and a dropped response. An unavailable readback produces `reconciliation_required` with a durable `auth_delete_started` receipt. Clearing the transport fault and reconciling completes without a second provider DELETE.
- With no Storage HTTP service, an actual other Auth user's editable metadata referencing the target UUID blocks preview. Target Auth and business identity stay intact. This proves the Auth metadata dependency blocker, not Storage behavior.
- Unbanning via the real provider after review must make direct `prepare` RPC fail before business destruction; profile/person survive and no receipt exists.
- Following actual business prepare, real provider `updateUserById` containment reban must succeed before hard deletion. This catches provider `updated_at` side effects absent from SQL-only tests.
- A canonical synthetic person shares the exact target human name (including real Auth metadata). An unrelated account's email contains the target email as a substring. Exact target purge must leave both intact and the canonical account still provider-updateable.
- Full actor/canonical/other person/profile snapshots and their Auth identity/metadata invariants survive. Final real Auth user and completed-receipt counts and the captured schema/trigger hash are checked.

## Execution evidence / current gate

The purge-only release integration passed the actual pinned GoTrue/PostgREST integration, exit 0. Execution output is recorded in `/Users/nixon/.hermes/profiles/mam/cache/scratch/purge-only-auth-integration.log`: all ten behavioral checks completed after unchanged replay of 164 application migrations and the effective schema/RLS/ACL contract. Supported containment `updateUserById` succeeded after business prepare, followed by supported hard deletion. Final exact actor/canonical/other profile/person snapshots, Auth identity/metadata invariants, five remaining Auth users, six completed receipts and unchanged schema/restrictive-trigger fingerprint all passed. Cleanup readback verified no task containers, networks or volumes remained; the dedicated VM stayed running.

The prior failure evidence remains in `/Users/nixon/.hermes/profiles/mam/cache/scratch/purge-auth-integration-stable-candidate.log`: GoTrue updated only `banned_until,updated_at`, but its populated stored generated `confirmed_at` was not yet computed in BEFORE-trigger NEW. The corrected guard compares every live non-generated user column from `pg_catalog.pg_attribute`, excluding only the two explicitly permitted writable fields. Generated source fields and all other writable fields remain protected; any additional provider mutation fails closed. No provider harness, application trigger or migration was replaced for the passing run.

TDD reproduced the rejection in `tests/confirmed-test-purge-security.sql` with a populated stored generated confirmation field before the migration fix, then passed after it. The focused disposable SQL suite passed purge, security, permissions, core-review safety, analytics, notification receipts, scheduled offboarding and both concurrency checks. All 22 purge Node tests passed; their separately labelled mocked orchestration boundary is not substituted for the real-provider result.

The reduced Storage correction was rerun through this same dedicated real-provider
runner with exit 0. `purge-storage-correction-auth.log` in the MAM scratch directory
records unchanged replay of all 164 current application migration files, all ten
behavioral checks and successful exact task-resource cleanup. Its separate
SELECT-only provider-ownership fixture also passed; neither result asserts
concurrent/future metadata protection for the three expressly excluded tables.

## Explicitly unverified

There is **no Storage API server** in this integration. Storage table shapes are migration prerequisites only: uploads, storage ownership rejection, actual object deletion, bucket behavior and Storage HTTP are not tested. No email, SMS, external OAuth, hosted gateway, production setting, real staff account or remote migration ledger is exercised. These pins demonstrate the named self-hosted versions, not the hosted project's exact provider version/configuration. Existing JWTs are not claimed globally revoked for stateless third-party consumers merely because Auth users/sessions are absent.

The separately authorized reduced Storage boundary exempts exactly
`storage.migrations`, `storage.buckets_vectors` and `storage.vector_indexes` from
new retirement triggers and uses only read-only `ACCESS SHARE NOWAIT` locks there.
Their observed UUID/JSON/text references still block cleanup and their schema
remains fingerprinted, but concurrent or future provider writes are not prevented.
`node tests/run-confirmed-test-purge-provider-storage.mjs --concurrency` separately
reproduces those provider-owned tables under a non-superuser execution role with
`SELECT` only. It exercises actual authenticated preview/prepare/claim/completion,
unknown privilege failures with atomic rollback, unchanged provider guards,
reference blockers/readback and schema drift. This synthetic ownership fixture
does not convert the real Auth integration into a Storage HTTP test or a universal
provider-metadata guarantee.

## Official sources consulted

- [Supabase Docker composition](https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml): Auth/PostgREST image versions and environment configuration.
- [Auth README](https://github.com/supabase/auth/blob/master/README.md): automatic provider migrations, database configuration and self-hosted schema boundary.
- [Pinned Auth Admin implementation](https://github.com/supabase/auth/blob/v2.189.0/internal/api/admin.go): hard-delete request parameter, not-found semantics and provider-owned transaction.
- [Pinned user model](https://github.com/supabase/auth/blob/v2.189.0/internal/models/user.go): `Ban` uses provider `UpdateOnly`.
- [Supabase PostgreSQL Auth bootstrap](https://github.com/supabase/postgres/blob/develop/migrations/db/init-scripts/00000000000001-auth-schema.sql): Auth role and schema ownership conventions.
