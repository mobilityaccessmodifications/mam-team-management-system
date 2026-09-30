import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");

test("leave_requests API returns the computed business_hours field beside raw hours", async () => {
  const source = ts.transpileModule(
    readFileSync("src/app/api/analytics/v1/route.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const expected = {
    data: {
      data: [{
        request_id: "synthetic-request-id",
        hours: null,
        business_hours: 15.2,
      }],
      pagination: { total: 1, limit: 500, offset: 0 },
    },
    error: null,
  };
  const createAdminClient = () => ({
    rpc: async (name) => name === "validate_analytics_api_key"
      ? { data: true, error: null }
      : expected,
  });

  const moduleUnderTest = { exports: {} };
  new Function("require", "module", "exports", source)(
    (id) => id === "@/lib/supabase/admin" ? { createAdminClient } : require(id),
    moduleUnderTest,
    moduleUnderTest.exports,
  );

  const response = await moduleUnderTest.exports.GET(new Request("https://example.test/api/analytics/v1?dataset=leave_requests", {
    headers: { Authorization: "Bearer synthetic-analytics-key-for-test-only" },
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.dataset, "leave_requests");
  assert.equal(body.data[0].hours, null);
  assert.equal(body.data[0].business_hours, 15.2);
});
