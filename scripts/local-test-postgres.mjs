// Disposable PostgreSQL only: no URLs, .env files, inherited PG settings or TCP.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const postgresEnv = {
  PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", LC_ALL: "C",
  PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGCONNECT_TIMEOUT: "5",
  PGPASSWORD: "synthetic-local-unused",
  PYTHONDONTWRITEBYTECODE: "1",
};
export function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { env: postgresEnv, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    if (binary === "psql") {
      throw new Error(`psql failed: exit=${result.status} signal=${result.signal ?? "none"} spawn=${result.error?.message ?? "none"}\nstderr:\n${result.stderr ?? ""}`);
    }
    throw new Error(`${binary} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout;
}

export function target(socket, database) {
  if (!/^(?:\/private)?\/tmp\/mam-openclaw-pg\.[A-Za-z0-9]+$/.test(socket ?? "")
    && (!/^mam-openclaw-pg\.[A-Za-z0-9]+$/.test(path.basename(socket ?? ""))
      || path.dirname(socket ?? "") !== realpathSync(os.tmpdir()))) {
    throw new Error("A task-owned local PostgreSQL socket is required");
  }
  if (!/^(?:mam_test_[a-z0-9_]+|openclaw_leave_test(?:_[0-9]+)?|portal_account_executor_test)$/.test(database ?? "")) {
    throw new Error("A synthetic test database name is required");
  }
  const marker = JSON.parse(readFileSync(path.join(socket, "mam-test-cluster.json"), "utf8"));
  if (marker.socket !== realpathSync(socket) || marker.port !== 55439 || marker.owner !== "mam-local-tests-v1") {
    throw new Error("Invalid local PostgreSQL ownership marker");
  }
  return ["-X", "-h", socket, "-p", "55439", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"];
}

export function sql(socket, database, query) {
  const args = target(socket, database);
  const directory = mkdtempSync(path.join(socket, "mam-query-"));
  const file = path.join(directory, "query.sql");
  try {
    writeFileSync(file, query, { mode: 0o600 });
    return command("psql", [...args, "-Atq", "-f", file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function startCluster() {
  const socket = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "mam-openclaw-pg.")));
  const data = path.join(socket, "data");
  command("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  writeFileSync(path.join(socket, "mam-test-cluster.json"), JSON.stringify({ owner: "mam-local-tests-v1", socket, port: 55439 }));
  command("pg_ctl", ["-D", data, "-l", path.join(socket, "postgres.log"), "-o", `-k ${socket} -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700`, "-w", "start"]);
  return socket;
}

export function createDatabase(socket, database) {
  const args = target(socket, database);
  command("createdb", ["-h", args[2], "-p", "55439", "-U", "postgres", "--template=template0", database]);
}

export function stopCluster(socket) {
  target(socket, "mam_test_stop");
  command("pg_ctl", ["-D", path.join(socket, "data"), "-m", "fast", "-w", "stop"]);
  // Keep the small, task-owned log/data directory for diagnosis; cleanup is explicit.
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, socket, database] = process.argv.slice(2);
  if (action === "start") console.log(startCluster());
  else if (action === "stop") stopCluster(socket);
  else if (action === "createdb") createDatabase(socket, database);
  else throw new Error("Usage: local-test-postgres.mjs start | stop SOCKET | createdb SOCKET mam_test_NAME");
}
