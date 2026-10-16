import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadUatSafety } from "./helpers/uat-safety-loader.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

test("employees API response passes through all approved HR projection fields from the RPC", async () => {
  const source = ts.transpileModule(
    readFileSync("src/app/api/analytics/v1/route.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const expected = {
    data: {
      data: [{
        employee_id: "synthetic-id",
        first_name: "Taylor",
        last_name: "Synthetic",
        team: "Major",
        scheduled_employment_end_date: "2027-12-31",
        employment_type: "casual",
        contract_type: "fixed_term",
        working_weekdays: [1, 3, 5],
        working_day_times: [{ weekday: 1, start_time: "09:00", end_time: "17:00" }],
      }],
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
    (id) => id === "@/lib/uat-safety" ? loadUatSafety() : id === "@/lib/supabase/admin" ? { createAdminClient } : require(id),
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
  assert.equal(body.data[0].team, "Major");
  assert.equal(body.data[0].scheduled_employment_end_date, "2027-12-31");
  assert.equal(body.data[0].employment_type, "casual");
  assert.equal(body.data[0].contract_type, "fixed_term");
  assert.deepEqual(body.data[0].working_weekdays, [1, 3, 5]);
  assert.deepEqual(body.data[0].working_day_times, [{ weekday: 1, start_time: "09:00", end_time: "17:00" }]);
});
