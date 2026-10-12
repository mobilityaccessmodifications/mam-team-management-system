import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, sql, command, target } from "./local-test-postgres.mjs";
import { runTeamManagerMigrationGuards } from "../tests/run-team-manager-migration-guards.mjs";

const [socket, database = "mam_test_replay", ...regressions] = process.argv.slice(2);
const annualLegacy = regressions.includes("--annual-legacy-fixture");
createDatabase(socket, database);
sql(socket, database, readFileSync(new URL("../tests/migrations/0001-supabase-platform.sql", import.meta.url), "utf8"));
const files = readdirSync("supabase/migrations").filter((file) => file.endsWith(".sql")).sort();
for (const file of files) {
  console.log(`Replay ${file}`);
  if (file === '20261008140000_employee_team_manager_defaults.sql') {
    runTeamManagerMigrationGuards(socket, database, readFileSync(path.join('supabase/migrations', file), 'utf8'));
  }
  if (file === '20261012110000_trade_school_leave.sql') {
    const prefix = `mam_test_trade_${database.replace(/^mam_test_/, '')}`;
    const predecessor = `${prefix}_pred`;
    command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', `--template=${database}`, predecessor]);
    console.log(command('python3', [path.resolve('tests/run-trade-school-release.py'), socket, predecessor, `${prefix}_release`]));
  }
  if (annualLegacy && file === "20261006106000_annual_leave_all_submitter_gate.sql") {
    command('createdb', ['-h', target(socket, database)[2], '-p', '55439', '-U', 'postgres', `--template=${database}`, `${database}_predecessor`]);
    sql(socket, database, readFileSync(new URL("../tests/annual-leave-legacy-setup.sql", import.meta.url), "utf8"));
  }
  if (file === "20261003090000_payroll_operator_session_proof.sql") {
    sql(socket, database, readFileSync(new URL("../tests/migrations/operator-session-platform.sql", import.meta.url), "utf8"));
    sql(socket, database, "update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;");
  }
  if (file === "20261006104000_unified_portal_roles.sql") {
    console.log("CI platform baseline: approved Storage structure only; exact migration guards unchanged");
    sql(socket, database, readFileSync(new URL("../tests/migrations/canonical-roles-storage-platform.sql", import.meta.url), "utf8"));
    sql(socket, database, readFileSync(new URL("../tests/migrations/canonical-roles-hosted-member-predecessor.sql", import.meta.url), "utf8"));
    sql(socket, database, "update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;");
    command("psql", [...target(socket, database),
      "-f", path.resolve("tests/migrations/canonical-roles-release-plan.sql"),
      "-f", path.resolve("supabase/migrations", file),
      "-f", path.resolve("tests/migrations/canonical-roles-release-readback.sql")]);
    continue;
  }
  sql(socket, database, readFileSync(path.join("supabase/migrations", file), "utf8"));
}
console.log(`PASS: executed all ${files.length} ordered migrations without changing their bytes`);
sql(socket, database, readFileSync(new URL("../tests/migrations/effective-contract.sql", import.meta.url), "utf8"));
console.log("PASS: effective schema, RLS, role/function ACLs and denied operations");
for (const regression of regressions.filter((entry) => entry !== "--annual-legacy-fixture")) {
  command("psql", [...target(socket, database), "-f", path.resolve(regression)]);
  console.log(`PASS: full-schema regression ${regression}`);
}
