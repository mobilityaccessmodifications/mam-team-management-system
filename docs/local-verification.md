# Local and CI verification

`npm run check` runs lint, TypeScript, Node tests and the production build.
It does not contact a database or send notifications. A build may download the
configured Google fonts. SQL and browser integration gates are explicit:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:sql
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/ms-playwright npx playwright install chromium --only-shell
npm run test:browser
npm run test:bundle
```

On Linux, use `npx playwright install --with-deps chromium --only-shell` with the
same browser-cache variable. PostgreSQL's `initdb`, `pg_ctl`, `createdb`, and
`psql` must be on PATH. Homebrew's PostgreSQL 16 binaries work locally. CI runs
the complete replay/OpenClaw job in both PostgreSQL 16 and 17 containers as the
unprivileged `postgres` OS user; the older focused SQL fixture job remains separate.

Performance review release-envelope tests are an explicit PostgreSQL 17 gate:

```sh
npm run test:sql:performance
```

Supply PostgreSQL 17 `initdb`, `pg_ctl`, `postgres`, `createdb`, `psql` and
`pg_dump`, plus Python and Git, on PATH. The gate fails if they are absent or
the selected major is not 17. It creates fresh marked socket-only clusters
under `os.tmpdir()` with a C locale, creates its own private evidence parent,
and verifies stop status, pid and socket absence. A short private TMPDIR may
be supplied; no Homebrew or user-profile path is required. Optional
`MAM_PERFORMANCE_TEST_EVIDENCE` selects a new task-owned evidence directory.
CI runs this gate explicitly in the 17 replay matrix entry. The full ordered
replay still runs every migration under both 16 and 17; the new feature core
admits only its exact version-selected metadata variants. The production
release helper still requires exactly 17. Standard `npm test` contains only
portable helper/Git fixtures and does not register these native suites.

## Disposable PostgreSQL

`test:sql` creates a unique `/tmp/mam-openclaw-pg.*` directory, initializes a new
cluster, disables TCP (`listen_addresses=''`), and connects over its private
UNIX socket. It ignores external connection variables, password/service files
and `.psqlrc`. It never reads `.env` or accepts a database URL. A task ownership
marker and a synthetic database-name allowlist protect the helpers. It stops
the cluster on completion, deletes its own successful scratch run, and retains
failed runs for diagnosis. It never deletes a pre-existing database.

For several local workers, start one cluster and give each worker a new name:

```sh
node scripts/local-test-postgres.mjs start
# Use the exact printed socket path in these commands:
node scripts/test-migration-replay.mjs SOCKET mam_test_worker1
node scripts/local-test-postgres.mjs createdb SOCKET mam_test_worker2
node scripts/local-test-postgres.mjs stop SOCKET
```

The user is `postgres`, the port is `55439`, and the socket directory isolates
concurrent clusters even though their port numbers match. A standalone replay
runner uses migrations in the current directory and platform prerequisites next
to the runner, allowing an integration worktree to replay its own new migrations.
Use `psql -X -h SOCKET -p 55439 -U postgres -d mam_test_worker1
-v ON_ERROR_STOP=1 -f tests/your-regression.sql` for further synthetic checks.
Use `PGPASSFILE=/dev/null PGSERVICEFILE=/dev/null` for manual commands as well.

## What the SQL gates establish

`tests/migrations/0001-supabase-platform.sql` is an explicit versioned test
prerequisite for roles and the small Auth/Storage/Realtime platform surface used
by this repository. It creates **no application tables or replacement business
functions**. The runner then executes every SQL file in `supabase/migrations`
in filename order with `ON_ERROR_STOP`; it never skips a failed migration or
rewrites applied history. Final tests inspect actual RLS, schema and RPC grants
and exercise denied operations as `anon`, `authenticated` and `service_role`.
The standard SQL gate then requires `tests/core-review-safety.sql` against this
same full schema; a missing file fails the gate. The standalone replay command
accepts post-replay SQL paths after the database name when testing other branches.
`node scripts/test-sql.mjs /absolute/integration/worktree` runs all required SQL
gates against that worktree's files without changing its checkout.

The baseline of 133 migrations replays without an application-history shim.
This is a full application migration replay over an explicit platform bootstrap,
not a full Supabase installation. GoTrue, PostgREST, Storage HTTP and Realtime
server behavior still require their own tests. The old focused fixture schemas
are not full replay. OpenClaw's historical upgrade/rollback/concurrent-confirm
suite runs separately against its existing synthetic fixture, using real parallel
PostgreSQL connections, because it asserts behavior across protocol upgrades.
The account-executor fixture then runs in its own fresh database; two-connection
tests exercise exclusive execution, receipt replay and cleanup-versus-link races.
The verified-phone fixture also has its own fresh database, covering enrollment,
ACLs, identity-version replay and a real revocation-versus-confirmation lock race.
Final replay checks require the private phone tables, RLS and management-only
enrollment grants in the effective schema.

A successful clean replay does **not** reconcile the production migration ledger.
The review's local-only/remote-only versions need a separately reviewed mapping
of effective definitions and provenance. Never replay local-only history into
production based on this gate, and never manufacture ledger entries here.

## Browser and bundle gates

The Chromium suite imports real components with synthetic action boundaries and
blocks external requests. It creates no application route and needs no Auth keys.
It reuses `tests/resources-browser.mjs` for five scenarios (summary/nested focus,
picker Enter, inactive members, dirty-review preservation and repeated credential
expiry). Calendar tests cover authorised duration on phone and desktop widths,
part days, multi-day requests and archived display names. These are component
behavior gates, not full employee-to-manager/email/Auth end-to-end tests.

`node scripts/test-browser.mjs /absolute/integration/worktree` can read another
task-approved source worktree for integration checks without writing to it. The
current worktree retains its own dependencies and browser cache. Extra arguments
after the source path go to Playwright, for example `--grep calendar`.

`test:bundle` reads the default production build's home client-reference manifest
and runtime manifest. It sums unique synchronous home chunks, root runtime and
polyfills, reporting raw and per-file gzip bytes; unopened async panels are not
counted. It fails closed if Next changes the manifest format or a chunk is missing.
It excludes CSS, fonts, other layout boundaries and subsequent panel loads.
The 1,350,000-byte raw / 400,000-byte gzip guard in `tests/bundle-budget.json`
allows bounded headroom above the integrated lazy-panel build measured on
2026-09-22: 1,164,987 raw bytes / 341,726 gzip bytes using Next 16.3.5 Turbopack.
The e88b366 baseline measured with that same bundler and scope was 1,943,456 raw
bytes / 545,452 gzip bytes. These are bundle measurements, not Core Web Vitals
or a network/device performance claim. Record actual production-bundler results
when changing the budget; do not substitute the review's older Webpack numbers.
