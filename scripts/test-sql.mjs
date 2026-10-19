import { spawnSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCluster, createDatabase, stopCluster, sql, target, command, postgresEnv } from "./local-test-postgres.mjs";
import { runReportingSpliceSql } from "../tests/run-reporting-splice-sql.mjs";

const powerBiOnly = process.argv[2] === "--powerbi-hr-directory";
const reportingSpliceOnly = process.argv[2] === "--reporting-splice";
const sourceRoot = realpathSync(((powerBiOnly || reportingSpliceOnly) ? process.argv[3] : process.argv[2]) ?? process.cwd());
const socket = startCluster();
let passed = false;
console.log(`Disposable PostgreSQL socket: ${socket}`);
function runPowerBiContract() {
  const inspector = path.join(sourceRoot, "scripts/inspect-powerbi-hr-directory.py");
  for (const args of [[], ["apply"], ["apply", "unapproved-source"], ["inspect", "extra"]]) {
    const rejected = spawnSync("python3", [inspector, ...args], { env: postgresEnv, encoding: "utf8" });
    if (rejected.status !== 2 || !rejected.stderr.includes("Usage:") || rejected.stdout) {
      throw new Error("Power BI inspector accepted an unsupported operation");
    }
  }
  console.log("PASS: Power BI inspector rejects four unsupported invocations before credentials");
  createDatabase(socket, "mam_test_powerbi_contract");
  console.log(command("psql", [...target(socket, "mam_test_powerbi_contract"), "-f", path.join(sourceRoot, "tests/powerbi-hr-directory.sql")]));
  const schema = JSON.parse(command("python3", ["-c", "import json, runpy, sys; m = runpy.run_path(sys.argv[1]); print(json.dumps({'sql': m['SCHEMA_SQL'], 'keys': sorted(m['SCHEMA_KEYS'])}))", inspector]));
  const schemaSql = schema.sql;
  const inspectSql = `select row_to_json(checks) from (${schemaSql}) checks;`;
  const baseline = () => {
    const result = JSON.parse(sql(socket, "mam_test_powerbi_contract", inspectSql));
    if (Object.keys(result).sort().join(",") !== schema.keys.join(",") || schema.keys.length !== 17) {
      throw new Error("Power BI metadata must retain the exact 17-key contract");
    }
    return result;
  };
  if (!Object.values(baseline()).every(value => value === true)) throw new Error("Synthetic Power BI metadata contract failed");
  for (const [change, predicate] of [
    ["grant select on public.internal_org_people to mam_powerbi_hr_reader", "source_tables_are_private"],
    ["grant update on powerbi_hr.employee_directory to mam_powerbi_hr_reader", "view_is_read_only"],
    ["grant select on public.powerbi_contract_other to mam_powerbi_hr_reader", "no_other_business_relation_access"],
    ["grant usage on sequence public.powerbi_contract_sequence to mam_powerbi_hr_reader", "no_sequence_access"],
    ["grant execute on function public.powerbi_contract_definer() to mam_powerbi_hr_reader", "no_security_definer_routines"],
    ["grant anon to mam_powerbi_hr_reader", "no_role_membership"],
    ["alter role mam_powerbi_hr_reader bypassrls", "role_is_limited"],
    ["alter role mam_powerbi_hr_reader set default_transaction_read_only = off", "read_only_default"],
    ["alter role mam_powerbi_hr_reader set statement_timeout = '120s'", "bounded_query_time"],
    ["alter view powerbi_hr.employee_directory set (security_barrier = false)", "security_barrier"],
    ["alter view powerbi_hr.employee_directory rename column full_name to unapproved_column", "projection_is_exact"],
    ["grant select on powerbi_hr.employee_directory to authenticated", "app_roles_not_granted"],
  ]) {
    const changed = JSON.parse(sql(socket, "mam_test_powerbi_contract", `begin; ${change}; ${inspectSql} rollback;`));
    if (changed[predicate] !== false) throw new Error(`Power BI drift was not rejected: ${predicate}`);
    if (!Object.values(baseline()).every(value => value === true)) throw new Error("Power BI drift probe did not roll back");
    console.log(`PASS: Power BI rejects ${predicate} drift`);
  }
  console.log("PASS: Power BI exact metadata contract and 12 rolled-back drift probes");
  createDatabase(socket, "mam_test_powerbi_unrelated");
  const columnProbes = [];
  for (const [relation, column, predicate] of [
    ["public.internal_org_people", "full_name", "source_tables_are_private"],
    ["private.employee_directory_details", "first_name", "source_tables_are_private"],
    ["public.powerbi_contract_other", "value", "no_other_business_relation_access"],
    ["powerbi_hr.employee_directory", "full_name", "view_is_read_only"],
    ["extensions.pg_stat_statements", "query", "shared_statistics_views_are_read_only"],
    ["extensions.pg_stat_statements_info", "dealloc", "shared_statistics_views_are_read_only"],
  ]) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      if (privilege === "SELECT" && ["view_is_read_only", "shared_statistics_views_are_read_only"].includes(predicate)) continue;
      columnProbes.push([
        `${relation} column ${privilege}`,
        `grant ${privilege}(${column}) on ${relation} to mam_powerbi_hr_reader`,
        predicate,
        `has_column_privilege('mam_powerbi_hr_reader', '${relation}', '${column}', '${privilege}')`,
      ]);
    }
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      columnProbes.push([
        `${role} projection column ${privilege}`,
        `grant ${privilege}(full_name) on powerbi_hr.employee_directory to ${role}`,
        "app_roles_not_granted",
        `has_column_privilege('${role}', 'powerbi_hr.employee_directory', 'full_name', '${privilege}')`,
      ]);
    }
  }
  const defaultsProbes = [
    ["current database read-only override", "alter role mam_powerbi_hr_reader in database mam_test_powerbi_contract set default_transaction_read_only = off", "read_only_default"],
    ["current database timeout override", "alter role mam_powerbi_hr_reader in database mam_test_powerbi_contract set statement_timeout = '120s'", "bounded_query_time"],
    ["unrelated database read-only cannot supply default", "alter role mam_powerbi_hr_reader reset default_transaction_read_only; alter role mam_powerbi_hr_reader in database mam_test_powerbi_unrelated set default_transaction_read_only = on", "read_only_default"],
    ["unrelated database timeout cannot supply default", "alter role mam_powerbi_hr_reader reset statement_timeout; alter role mam_powerbi_hr_reader in database mam_test_powerbi_unrelated set statement_timeout = '60s'", "bounded_query_time"],
  ];
  const failures = [];
  for (const [label, change, predicate, evidence] of [...columnProbes, ...defaultsProbes]) {
    const probeSql = `select json_build_object('checks', (select row_to_json(checks) from (${schemaSql}) checks), 'grantPresent', ${evidence ?? "true"})`;
    const probe = JSON.parse(sql(socket, "mam_test_powerbi_contract", `begin; ${change}; ${probeSql}; rollback;`));
    if (!probe.grantPresent) throw new Error(`Power BI probe grant was not present: ${label}`);
    if (!Object.values(baseline()).every(value => value === true)) throw new Error(`Power BI probe did not roll back: ${label}`);
    if (probe.checks[predicate] !== false) {
      failures.push(label);
      console.log(`FAIL: Power BI missed ${label}: ${predicate}`);
    } else console.log(`PASS: Power BI rejects ${label}: ${predicate}`);
  }
  if (failures.length) throw new Error(`Power BI missed ${failures.length} column/default drifts: ${failures.join(", ")}`);
  for (const [label, change] of [
    ["current database safe read-only overrides unsafe global role", "alter role mam_powerbi_hr_reader set default_transaction_read_only = off; alter role mam_powerbi_hr_reader in database mam_test_powerbi_contract set default_transaction_read_only = on"],
    ["current database safe timeout overrides unsafe global role", "alter role mam_powerbi_hr_reader set statement_timeout = '120s'; alter role mam_powerbi_hr_reader in database mam_test_powerbi_contract set statement_timeout = '60s'"],
    ["unrelated database unsafe read-only is ignored", "alter role mam_powerbi_hr_reader in database mam_test_powerbi_unrelated set default_transaction_read_only = off"],
    ["unrelated database unsafe timeout is ignored", "alter role mam_powerbi_hr_reader in database mam_test_powerbi_unrelated set statement_timeout = '120s'"],
    ["global role read-only overrides database setting", "alter database mam_test_powerbi_contract set default_transaction_read_only = off"],
    ["global role timeout overrides database setting", "alter database mam_test_powerbi_contract set statement_timeout = '120s'"],
  ]) {
    const changed = JSON.parse(sql(socket, "mam_test_powerbi_contract", `begin; ${change}; ${inspectSql} rollback;`));
    if (!Object.values(changed).every(value => value === true)) throw new Error(`Power BI safe precedence control failed: ${label}`);
    if (!Object.values(baseline()).every(value => value === true)) throw new Error(`Power BI safe precedence control did not roll back: ${label}`);
    console.log(`PASS: Power BI accepts ${label}`);
  }
  console.log(`PASS: Power BI ${columnProbes.length} column ACL, ${defaultsProbes.length} default rejection probes and six safe precedence controls`);
}
try {
  if (!powerBiOnly) {
  const replay = spawnSync(process.execPath, [fileURLToPath(new URL("./test-migration-replay.mjs", import.meta.url)), socket, "mam_test_replay", "tests/core-review-safety.sql", "tests/unified-role-subscription-employee-delegation.sql", "tests/subscription-requests.sql", "tests/subscription-requests-security.sql", "tests/subscription-request-mail.sql", "tests/annual-continuous-accrual.sql", "tests/password-recovery.sql", "tests/performance-review-admin-effective.sql"], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (replay.status !== 0) throw new Error("Full migration replay failed");
  command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=mam_test_replay', 'mam_test_sr_concurrency']);
  const requestRace = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/subscription-requests-concurrency.mjs'), socket, 'mam_test_sr_concurrency'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (requestRace.status !== 0) throw new Error('Subscription request CAS and authority concurrency failed');
  const requestNotifications = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/subscription-request-notifications-integration.mjs'), socket, 'mam_test_replay'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (requestNotifications.status !== 0) throw new Error('Subscription request persisted notification envelopes failed');
  const requestCatalog = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/subscription-requests-catalog.mjs'), socket, 'all'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (requestCatalog.status !== 0) throw new Error('Subscription request exact catalog and deferred-ledger rollback tests failed');
  const requestForward = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/subscription-requests-catalog.mjs'), socket, 'forward'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (requestForward.status !== 0) throw new Error('Subscription request forward compatibility and atomic release rehearsal failed');
  runReportingSpliceSql(socket, "mam_test_replay", sourceRoot);
  const finalizerUnit = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_archived_account_finalizer_release.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (finalizerUnit.status !== 0) throw new Error('Archived account finalizer release helper tests failed');
  command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests/archived-account-finalizer.sql')]);
  console.log('PASS: archived account finalizer SQL and exact-source release helper contract');
  const versionConflictUnit = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_offboarding_version_conflict_release.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (versionConflictUnit.status !== 0) throw new Error('Offboarding version-conflict release helper tests failed');
  command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests/offboarding-version-conflicts.sql')]);
  console.log('PASS: offboarding version-conflict native action contract and exact-source release helper');
  const afterAnnualUnit = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_after_annual_offboarding_release.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (afterAnnualUnit.status !== 0) throw new Error('After-annual offboarding portable release adapter tests failed');
  console.log('PASS: after-annual offboarding portable MODEL source, query, dispatch and readback controls');
  if (!reportingSpliceOnly) {
  for (const regression of ['subscription-request-simple-activation.sql', 'subscription-request-penny-mail.sql', 'subscription-password-tasks.sql', 'subscription-request-template.sql', 'subscription-start-date.sql']) {
    console.log(command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests', regression)]));
  }
  command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=mam_test_replay', 'mam_test_sra_concurrency']);
  const activationRace = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/subscription-request-activation-concurrency.mjs'), socket, 'mam_test_sra_concurrency'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (activationRace.status !== 0) throw new Error('Subscription activation and withdrawal concurrency failed');
  const passwordRace = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/subscription-password-tasks-concurrency.mjs'), socket, 'mam_test_replay'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (passwordRace.status !== 0) throw new Error('Subscription password task completion concurrency failed');
  console.log(command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests/subscription-review-tasks.sql')]));
  console.log(command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests/subscription-review-mail.sql')]));
  console.log(command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests/task-notes.sql')]));
  const reviewReleaseUnit = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_subscription_review_release.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (reviewReleaseUnit.status !== 0) throw new Error('Subscription review release helper tests failed');
  const tradeReleaseUnit = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_trade_school_release.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (tradeReleaseUnit.status !== 0) throw new Error('Trade-school release helper tests failed');
  for (const regression of ['new-starter-team-manager.sql', 'new-starter-team-manager-creation.sql', 'new-starter-team-manager-resolution.sql', 'new-starter-team-manager-schema.sql', 'new-starter-team-manager-matrix.sql', 'new-starter-team-manager-parent-effects.sql']) {
    command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests', regression)]);
    console.log(`PASS: Team Manager ${regression}`);
  }
  const onboardingReview = spawnSync(process.execPath, [path.join(sourceRoot, "tests/run-onboarding-review-sql.mjs"), socket], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (onboardingReview.status !== 0) throw new Error("Onboarding review PostgreSQL authorization, CAS, concurrency and catalog rollback tests failed");
  command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests/operator-session-proof.sql')]);
  command("createdb", ["-h", socket, "-p", "55439", "-U", "postgres", "--template=mam_test_replay", "mam_test_offboarding_admin"]);
  const offboardingRace = spawnSync(process.execPath, [path.join(sourceRoot, "tests/run-offboarding-admin-concurrency.mjs"), socket, "mam_test_offboarding_admin"], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (offboardingRace.status !== 0) throw new Error("Offboarding administrator PostgreSQL concurrency tests failed");
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/leave-register-read-grant.sql")]);
  for (const regression of ['payroll-closing-contract.sql', 'payroll-closing.sql', 'payroll-carryforward-lifecycle.sql', 'payroll-closing-privacy.sql', 'payroll-closing-mutation-guards.sql', 'payroll-closing-security.sql', 'payroll-closing-legacy-drift.sql', 'payroll-carryforward-import.sql', 'payroll-carryforward-cutoff.sql']) {
    command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests', regression)]);
    console.log(`PASS: payroll closing ${regression}`);
  }
  command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=mam_test_replay', 'mam_test_payroll_closing_race']);
  const closingRace = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/run-payroll-closing-concurrency.mjs'), socket, 'mam_test_payroll_closing_race'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (closingRace.status !== 0) throw new Error('Payroll closing PostgreSQL concurrency tests failed');
  const closingRelease = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/run-payroll-closing-release.mjs'), socket, 'mam_test_payroll_closing_release'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (closingRelease.status !== 0) throw new Error('Payroll closing hash-pinned transaction tests failed');
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/analytics-api-employees.sql")]);
  console.log("PASS: Analytics employees dataset exposes names without private contacts; RPC remains service-role-only");
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/analytics-api-leave-business-hours.sql")]);
  console.log("PASS: Analytics leave_requests dataset reports business_hours from recorded duration and employment classification");
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/notification-delivery-receipts.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/new-starter-day-one.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/onboarding-credentials.sql")]);
  for (const regression of ['password-reset-credential-lock.sql', 'password-reset-pending-credentials.sql', 'password-reset-no-reclaim.sql', 'password-reset-credential-contract.sql']) {
    command('psql', [...target(socket, 'mam_test_replay'), '-f', path.join(sourceRoot, 'tests', regression)]);
  }
  for (const [database, mode] of [['mam_test_reset_credentials', []], ['mam_test_reset_profile_lock', ['--profile-lock']]]) {
    command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=mam_test_replay', database]);
    const resetRace = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/run-password-reset-credential-concurrency.mjs'), socket, database, ...mode], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
    if (resetRace.status !== 0) throw new Error('Password reset credential PostgreSQL concurrency tests failed');
  }
  command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=mam_test_replay', 'mam_test_recovery_concurrency']);
  const recoveryRace = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/run-password-recovery-concurrency.mjs'), socket, 'mam_test_recovery_concurrency'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (recoveryRace.status !== 0) throw new Error('Password recovery account-version concurrency tests failed');
  console.log('PASS: password reset preflight, durable pending fences, ACLs, audit and PostgreSQL concurrency');
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/two-week-check-in.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/check-in-review-outcomes.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/six-month-check-in-review.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/six-month-casual-check-in.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/employee-team-directory.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/reporting-calendar-scope.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/scheduled-offboarding.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/directory-role.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/directory-overseas.sql")]);
  const directoryRace = spawnSync(process.execPath, [path.join(sourceRoot, "tests/run-directory-role-concurrency.mjs"), socket, "mam_test_replay"], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (directoryRace.status !== 0) throw new Error("Directory role PostgreSQL concurrency tests failed");
  const receipts = spawnSync(process.execPath, [path.join(sourceRoot, "tests/run-notification-delivery-sql.mjs"),
    socket, "mam_test_notification_concurrency"], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (receipts.status !== 0) throw new Error("Durable notification PostgreSQL concurrency tests failed");
  createDatabase(socket, "openclaw_leave_test");
  sql(socket, "openclaw_leave_test", "select 1");
  const openclaw = spawnSync(process.execPath, [fileURLToPath(new URL("../tests/run-openclaw-confirm-only-sql.mjs", import.meta.url)), socket], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (openclaw.status !== 0) throw new Error("OpenClaw PostgreSQL transaction/concurrency tests failed");
  createDatabase(socket, "openclaw_leave_test_2300");
  const identity = spawnSync(process.execPath, [fileURLToPath(new URL("../tests/run-openclaw-identity-sql.mjs", import.meta.url)), socket, "openclaw_leave_test_2300"],
    { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (identity.status !== 0) throw new Error("OpenClaw verified identity PostgreSQL tests failed");
  createDatabase(socket, "portal_account_executor_test");
  // Use -f (not stdin) so the fixture's relative \ir paths keep their meaning.
  command("psql", [...target(socket, "portal_account_executor_test"), "-f", path.join(sourceRoot, "tests/portal-account-executor.sql")]);
  const accounts = spawnSync(process.execPath, [path.join(sourceRoot, "tests/run-account-executor-concurrency.mjs"),
    "--host", socket, "--port", "55439", "--user", "postgres", "--database", "portal_account_executor_test"],
  { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (accounts.status !== 0) throw new Error("Account executor PostgreSQL concurrency tests failed");
  createDatabase(socket, "mam_test_employee_calendar");
  command("psql", [...target(socket, "mam_test_employee_calendar"), "-f", path.join(sourceRoot, "tests/employee-team-calendar.sql")]);
  createDatabase(socket, "mam_test_staff_calendar");
  command("psql", [...target(socket, "mam_test_staff_calendar"), "-f", path.join(sourceRoot, "tests/calendar-staff-details.sql")]);
  }
  }
  if (!reportingSpliceOnly) runPowerBiContract();
  passed = true;
} finally {
  stopCluster(socket);
  if (passed) {
    rmSync(socket, { recursive: true });
    console.log("Stopped and removed this run's disposable PostgreSQL cluster");
  } else console.log(`Stopped task-owned PostgreSQL; diagnostic files: ${socket}`);
}
