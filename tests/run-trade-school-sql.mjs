import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { command, createDatabase, postgresEnv, sql, target } from "../scripts/local-test-postgres.mjs";

const [socket, database = "mam_test_trade_leave", predecessor] = process.argv.slice(2);
const root = realpathSync(new URL("..", import.meta.url));
if (predecessor) {
  target(socket, predecessor);
  command("createdb", ["-h", socket, "-p", "55439", "-U", "postgres", `--template=${predecessor}`, database]);
  sql(socket, database, readFileSync(path.join(root, "supabase/migrations/20261012110000_trade_school_leave.sql"), "utf8"));
} else {
  createDatabase(socket, database);
  const replay = spawnSync(process.execPath, [path.join(root, "scripts/test-migration-replay.mjs"), socket, `${database}_replay`], { cwd: root, env: postgresEnv, stdio: "inherit" });
  if (replay.status !== 0) throw new Error("Trade-school full migration replay failed");
  command("dropdb", ["-h", socket, "-p", "55439", "-U", "postgres", database]);
  command("createdb", ["-h", socket, "-p", "55439", "-U", "postgres", `--template=${database}_replay`, database]);
}
console.log(command("psql", [...target(socket, database), "-f", path.join(root, "tests/trade-school-leave.sql")]));
console.log("PASS: trade-school PostgreSQL regression complete");
