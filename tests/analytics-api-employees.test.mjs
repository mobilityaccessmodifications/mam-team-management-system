import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");

test("employees API response passes through first_name and last_name from the RPC projection", async () => {
  const source = ts.transpileModule(
    readFileSync("src/app/api/analytics/v1/route.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const expected = {
    data: {
      data: [{ employee_id: "synthetic-id", first_name: "Taylor", last_name: "Synthetic" }],
      pagination: { total: 1, limit: 500, offset: 0 },
    },
    error: null,
  };
  const moduleUnderTest = { exports: {} };
  const createAdminClient = () => ({
    rpc: async (name) => name === "validate_analytics_api_key"
      ? { data: true, error: null }
      : expected,
  });

  new Function("require", "module", "exports", source)(
    (id) => id === "@/lib/supabase/admin" ? { createAdminClient } : require(id),
    moduleUnderTest,
    moduleUnderTest.exports,
  );

  const response = await moduleUnderTest.exports.GET(new Request("https://example.test/api/analytics/v1?dataset=employees", {
    headers: { Authorization: "Bearer synthetic-analytics-key-for-test-only" },
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.dataset, "employees");
  assert.deepEqual(body.data, expected.data.data);
  assert.equal(body.data[0].first_name, "Taylor");
  assert.equal(body.data[0].last_name, "Synthetic");
});
