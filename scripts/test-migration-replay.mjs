import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, sql, command, target } from "./local-test-postgres.mjs";

const [socket, database = "mam_test_replay", ...regressions] = process.argv.slice(2);
createDatabase(socket, database);
sql(socket, database, readFileSync(new URL("../tests/migrations/0001-supabase-platform.sql", import.meta.url), "utf8"));
const files = readdirSync("supabase/migrations").filter((file) => file.endsWith(".sql")).sort();
for (const file of files) {
  console.log(`Replay ${file}`);
  if (file === "20261003090000_payroll_operator_session_proof.sql") {
    sql(socket, database, readFileSync(new URL("../tests/migrations/operator-session-platform.sql", import.meta.url), "utf8"));
    sql(socket, database, "update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;");
  }
  sql(socket, database, readFileSync(path.join("supabase/migrations", file), "utf8"));
}
console.log(`PASS: executed all ${files.length} ordered migrations without changing their bytes`);
sql(socket, database, readFileSync(new URL("../tests/migrations/effective-contract.sql", import.meta.url), "utf8"));
console.log("PASS: effective schema, RLS, role/function ACLs and denied operations");
for (const regression of regressions) {
  command("psql", [...target(socket, database), "-f", path.resolve(regression)]);
  console.log(`PASS: full-schema regression ${regression}`);
}
