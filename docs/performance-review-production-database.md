# Performance review production database candidate

## Boundary

Version `20261016150000_performance_reviews_and_mail` is an additive PostgreSQL 16/17 feature candidate for organization `fwlmbmospuwoaosffvmw`, project `xtwlrjqbusadghavchqm`. Its production release helper remains strictly PostgreSQL 17 at every preflight, locked transaction, recorded and readback branch. The predecessor is exactly `20261014233948_subscription_request_start_date`. The existing 195 migration files, performance business logic and mail RPC contracts are unchanged by this repair.

This owner has not queried or modified production. Synthetic Management API responses are labelled MODEL; native PostgreSQL results use a synthetic historical ledger, not copied hosted statement arrays. No test mail is authorized or sent. Independent review, clean committed source, live inspector/transport acceptance and production apply/readback remain parent-owned gates.

## Exact invocation

Run from a clean reviewed MAM repository checkout, not the dirty owner/evidence worktree. The helper requires canonical MAM remote/commit author, exact full reviewed HEAD, and committed bytes equal to disk and loaded Python code. Keep private frames and journals outside that checkout. Parent creates one new owner-only directory (mode `0700`); the helper exclusively creates private files (mode `0600`). Never copy credentials or employee data into this repository.

All commands below run through the existing MAM credential wrapper:

```sh
"$HOME/Documents/Codex/bin/codex-project-credential" exec supabase -- python3 -B scripts/deploy-performance-reviews.py inspect "$REVIEWED_HEAD" "$HELPER_SHA256" "$TRANSPORT_SHA256" "$MIGRATION_SHA256" "$PREDECESSOR_SHA256"
"$HOME/Documents/Codex/bin/codex-project-credential" exec supabase -- python3 -B scripts/deploy-performance-reviews.py snapshot "$REVIEWED_HEAD" "$HELPER_SHA256" "$TRANSPORT_SHA256" "$MIGRATION_SHA256" "$PREDECESSOR_SHA256" "$PRIVATE_BEFORE_PATH"
"$HOME/Documents/Codex/bin/codex-project-credential" exec supabase -- python3 -B scripts/deploy-performance-reviews.py apply "$REVIEWED_HEAD" "$HELPER_SHA256" "$TRANSPORT_SHA256" "$MIGRATION_SHA256" "$PREDECESSOR_SHA256" "$PRIVATE_BEFORE_PATH" "$BEFORE_SHA256"
"$HOME/Documents/Codex/bin/codex-project-credential" exec supabase -- python3 -B scripts/deploy-performance-reviews.py readback "$REVIEWED_HEAD" "$HELPER_SHA256" "$TRANSPORT_SHA256" "$MIGRATION_SHA256" "$PREDECESSOR_SHA256" "$PRIVATE_BEFORE_PATH" "$BEFORE_SHA256"
```

`TRANSPORT_SHA256` pins `scripts/deploy-staff-leave-calendar.py`. The other pins cover this helper, the single new migration and the exact predecessor. Derive them from the reviewed artifact; no default/HEAD substitution is admitted. `BEFORE_SHA256` is the exact hash returned by snapshot. A snapshot is never overwritten. A new reviewed source revision requires new review and a separately bound frame, not an edit to the old frame.

## Finite parent sequence

1. Integrate the owned sources into the production candidate without overwriting protected files. Complete the required current candidate gates and obtain a fresh independent review of the helper, reviewed migration and its exact source/evidence manifest. Commit/publish only through the existing parent-controlled MAM path.
2. Verify the precise MAM project/organization and run the actual `inspect` CLI above through the approved credential wrapper. Inspector acceptance here has only been tested with inert external ports. Verify the established Management API multi-statement response contract before its mutation use; a final SELECT in native psql is not proof of a hosted COMMIT response.
3. Capture one private `snapshot` with the same five pins. Compare the current live target with the retained source-bound observations: PostgreSQL major 17, exact predecessor, complete historical ledger and matching captured purge catalog. Historical local-only/remote-only aliases are reported, never repaired. An unexpected later migration requires reconciliation, not `db push`.
4. With technical gates satisfied and the existing production authority, issue **one** `apply` with that exact snapshot hash. It performs current preflight plus locked equality, applies the reviewed migration body and writes its exact version/name/raw source ledger row in one transaction. It drains deferred effects, checks complete existing security/data and feature metadata, verifies the resulting fingerprint, and makes a separate read-only query before reporting success.
5. Run explicit `readback` with the same frame/pins. Then continue the parent-owned advisors, integrated application/notification review, target-checked configuration and reviewed GitHub-to-Vercel release. This helper neither sends mail nor activates n8n or application configuration.

## One-shot journal and reconciliation

The snapshot directory contains fixed version-specific files:

- `20261016150000.entered.json`: exclusive, fsynced before dispatch; exact snapshot/query SHA binding. Immutable and never reset.
- `20261016150000.attested.json`: written only after a strictly shaped transaction response, with its resulting catalog SHA. Not independent readback.
- `20261016150000.verified.json`: written only after separate metadata readback verifies exact target source, history, schema/ACL/RLS and preserved data/security.

Timeouts, malformed attestation, interrupts, readback errors or mismatches leave the entered journal spent and return HOLD. No implicit retry, overwrite, reset, historical repair or new-directory retry is permitted. Use only `inspect` and `readback` to reconcile. Even a successful subsequent readback does not create a verified dispatch receipt or re-enable an uncertain apply. A second apply after a fully verified successful operation is read-only and still verifies exact PostgreSQL 17 and the bound before/after preservation. A recorded target with different source, array dimensions, definitions, grants or privacy metadata is never accepted.

## Native and inert checks

Focused helper gates:

```sh
node --test tests/performance-review-production-release-helper.test.mjs tests/performance-review-production-guards.test.mjs
npm run test:sql:performance
```

The pure helper tests create their own portable temporary Git source, canonical local author and exact MAM origin; only the Management API is inert. They need Python and Git, but no PostgreSQL, private QA directory or operator capture. The explicit native gate requires PostgreSQL 17 tools, Python and Git on PATH and uses `os.tmpdir()` with `LANG=LC_ALL=C`. Supply a short, private TMPDIR where required. Missing tools or a different major fail the gate; they never silently skip it. Each fixture creates its own evidence parent before mkdtemp. `MAM_PERFORMANCE_TEST_EVIDENCE` optionally selects a new task-owned evidence parent; otherwise evidence is created under the portable temporary directory. Clusters have fresh ownership markers, no TCP and private Unix sockets; tests stop only their own clusters and retain status-3/pid/socket cleanup receipts. They never start retained earlier clusters.

The complete ordered migration replay remains enabled for PostgreSQL 16 and 17. `node --test tests/performance-review-production-sql.native.mjs` additionally exercises the feature's synthetic native contract under either supplied major. Only four exact new-table owner ACL values differ between the source-pinned 16/17 metadata variants; no global privilege normalization is permitted. The production helper selects only the 17 variant. The same source-derived collector protects complete trigger definitions, names, WHEN, UPDATE OF and remaining trigger metadata at both core assertions, final envelope and independent readback. Native FK names are portable only when their exact PostgreSQL-generated prefix and current trigger OID match; unknown names remain unnormalized and fail closed. Every other definition byte is retained.

The builder test substitutes only its in-memory historical-ledger digest for a small synthetic native history (NULL, empty, lower-bound and NULL-element arrays); the production historical constant and reviewed migration/predecessor bytes remain unchanged by the fixture. This proves generated-transaction behavior, not authentic hosted-ledger admission or native Supabase Auth/PostgREST acceptance. Retained core SQL tests are inherited only with their raw SQL/receipts and source bindings. New native wrapper tests cover a real commit, independent readback, late/deferred security and history faults, stale data and NOWAIT concurrency. The failed fixture acquisition/readback attempts remain recorded separately from their focused corrected passes.

## External ports

Only the held, hash-verified existing transport is loaded. It performs a metadata GET on the fixed MAM Supabase project and database-query POSTs on that same fixed Management API project route. Inspect/snapshot/readback SQL uses bounded READ ONLY transactions. Apply has one mutation dispatch, bounded statement/lock timeouts, a nonblocking directory-role advisory lock, a bounded deterministic protected-table lock set and an exclusive migration-ledger lock. Parent remains the sole real transport/secret/Git/provider writer.
