import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function runDeployment(operation, { recorded = false, wrongHash = false } = {}) {
  // Exercise the actual deployment entrypoint. All provider calls are replaced;
  // no real credentials, network requests or database writes are possible here.
  const bootstrap = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    const sql = readFileSync("supabase/migrations/20260920120000_openclaw_quoted_confirm.sql", "utf8");
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    let recorded = ${recorded};
    let writes = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer synthetic-test-token");
      assert.ok(["https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm", "https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm/database/query"].includes(url));
      if (options.method === "GET") return Response.json({ id: "xtwlrjqbusadghavchqm", organization_id: "fwlmbmospuwoaosffvmw" });
      const { query } = JSON.parse(options.body);
      if (query.startsWith("select version,statements")) return Response.json(recorded ? [{ version: "20260920120000", statements: [sql] }] : []);
      if (query.startsWith("select ")) return Response.json([{ prerequisites: true, legacy_bodies: !recorded, quoted_confirm_bodies: recorded, service_only_permissions: true }]);
      assert.equal(${JSON.stringify(operation)}, "apply");
      assert.equal(${wrongHash}, false);
      assert.equal(recorded, false);
      assert.ok(query.startsWith("begin;\\nset local lock_timeout='5s';\\nset local statement_timeout='60s';\\ndo $mam$ begin"));
      const record = "insert into supabase_migrations.schema_migrations(version,name,statements) values('20260920120000','openclaw_quoted_confirm',ARRAY[" + literal(sql) + "]);";
      const expectedTail = sql.slice("begin;".length).replace("\\ncommit;", () => "\\n" + record + "\\nnotify pgrst,'reload schema';\\ncommit;");
      assert.ok(query.endsWith(expectedTail), "Migration body and exact history must survive dollar-token replacement");
      writes += 1;
      recorded = true;
      return Response.json([]);
    };
    process.argv = [process.execPath, "scripts/deploy-openclaw-quoted-confirm.mjs", ${JSON.stringify(operation)}, ${wrongHash} ? "wrong-hash" : createHash("sha256").update(sql).digest("hex")];
    await import("./scripts/deploy-openclaw-quoted-confirm.mjs");
    console.log(JSON.stringify({ writes }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap], {
    cwd: root,
    encoding: "utf8",
    env: { CODEX_COMPANY_PROFILE: "mam", SUPABASE_ACCESS_TOKEN: "synthetic-test-token" },
  });
}

test("quoted-Confirm deployment preserves exact SQL and migration history", () => {
  const result = runDeployment("apply");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).writes, 1);
});

test("quoted-Confirm deployment inspection never writes", () => {
  const result = runDeployment("inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).writes, 0);
});

test("quoted-Confirm deployment replay never reapplies recorded SQL", () => {
  const result = runDeployment("apply", { recorded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).writes, 0);
});

test("quoted-Confirm deployment rejects an unreviewed hash before writes", () => {
  const result = runDeployment("apply", { wrongHash: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewed migration hash mismatch/);
});
