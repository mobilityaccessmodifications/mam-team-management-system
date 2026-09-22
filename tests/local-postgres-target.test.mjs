import test from "node:test";
import assert from "node:assert/strict";
import { target, postgresEnv } from "../scripts/local-test-postgres.mjs";

test("SQL harness rejects remote URLs, ambient sockets and non-synthetic databases before connecting", () => {
  for (const socket of ["postgres://localhost/test", "postgres://remote.invalid/prod", "localhost", "/tmp", "/var/run/postgresql"]) {
    assert.throws(() => target(socket, "mam_test_example"), /task-owned local/);
  }
  for (const database of ["postgres", "production", "mam_test_bad;drop database postgres", "service=production"]) {
    assert.throws(() => target("/tmp/mam-openclaw-pg.synthetic", database), /synthetic test database/);
  }
  assert.equal(postgresEnv.PGPASSFILE, "/dev/null");
  assert.equal(postgresEnv.PGSERVICEFILE, "/dev/null");
  assert.equal(postgresEnv.PGHOST, undefined);
  assert.equal(postgresEnv.PASSWORD, undefined);
});
