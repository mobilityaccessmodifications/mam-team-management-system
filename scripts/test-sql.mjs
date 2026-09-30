import { spawnSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCluster, createDatabase, stopCluster, sql, target, command, postgresEnv } from "./local-test-postgres.mjs";

const sourceRoot = realpathSync(process.argv[2] ?? process.cwd());
const socket = startCluster();
let passed = false;
console.log(`Disposable PostgreSQL socket: ${socket}`);
try {
  const replay = spawnSync(process.execPath, [fileURLToPath(new URL("./test-migration-replay.mjs", import.meta.url)), socket, "mam_test_replay", "tests/core-review-safety.sql"], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (replay.status !== 0) throw new Error("Full migration replay failed");
  command("createdb", ["-h", socket, "-p", "55439", "-U", "postgres", "--template=mam_test_replay", "mam_test_offboarding_admin"]);
  const offboardingRace = spawnSync(process.execPath, [path.join(sourceRoot, "tests/run-offboarding-admin-concurrency.mjs"), socket, "mam_test_offboarding_admin"], { cwd: sourceRoot, env: postgresEnv, stdio: "inherit" });
  if (offboardingRace.status !== 0) throw new Error("Offboarding administrator PostgreSQL concurrency tests failed");
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/leave-register-read-grant.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/analytics-api-employees.sql")]);
  console.log("PASS: Analytics employees dataset exposes names without private contacts; RPC remains service-role-only");
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/notification-delivery-receipts.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/new-starter-day-one.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/onboarding-credentials.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/two-week-check-in.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/check-in-review-outcomes.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/six-month-check-in-review.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/six-month-casual-check-in.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/employee-team-directory.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/reporting-calendar-scope.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/scheduled-offboarding.sql")]);
  command("psql", [...target(socket, "mam_test_replay"), "-f", path.join(sourceRoot, "tests/directory-role.sql")]);
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
  passed = true;
} finally {
  stopCluster(socket);
  if (passed) {
    rmSync(socket, { recursive: true });
    console.log("Stopped and removed this run's disposable PostgreSQL cluster");
  } else console.log(`Stopped task-owned PostgreSQL; diagnostic files: ${socket}`);
}
