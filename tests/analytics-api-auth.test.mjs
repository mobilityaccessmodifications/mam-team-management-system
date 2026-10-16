import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadUatSafety } from "./helpers/uat-safety-loader.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadRoute(validateResult) {
  const source = ts.transpileModule(
    readFileSync("src/app/api/analytics/v1/route.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const moduleUnderTest = { exports: {} };
  const createAdminClient = () => ({
    rpc: async (name) => name === "validate_analytics_api_key"
      ? validateResult
      : { data: { rows: [] }, error: null },
  });
  new Function("require", "module", "exports", source)(
    (id) => id === "@/lib/uat-safety" ? loadUatSafety() : id === "@/lib/supabase/admin" ? { createAdminClient } : require(id),
    moduleUnderTest,
    moduleUnderTest.exports,
  );
  return moduleUnderTest.exports;
}

async function request(GET, key) {
  return GET(new Request("https://example.test/api/analytics/v1", {
    headers: { Authorization: `Bearer ${key}` },
  }));
}

test("empty managed-key state retains the deployment analytics key", async (t) => {
  const previous = process.env.MAM_ANALYTICS_API_KEY;
  const key = "synthetic-deployment-analytics-key-00000001";
  process.env.MAM_ANALYTICS_API_KEY = key;
  t.after(() => {
    if (previous === undefined) delete process.env.MAM_ANALYTICS_API_KEY;
    else process.env.MAM_ANALYTICS_API_KEY = previous;
  });

  const { GET } = loadRoute({ data: null, error: null });
  assert.equal((await request(GET, key)).status, 200);
  assert.equal((await request(GET, `${key}-wrong`)).status, 401);
});

test("managed-key rejection and unexpected validator responses fail closed", async (t) => {
  const previous = process.env.MAM_ANALYTICS_API_KEY;
  const key = "synthetic-deployment-analytics-key-00000002";
  process.env.MAM_ANALYTICS_API_KEY = key;
  t.after(() => {
    if (previous === undefined) delete process.env.MAM_ANALYTICS_API_KEY;
    else process.env.MAM_ANALYTICS_API_KEY = previous;
  });

  assert.equal((await request(loadRoute({ data: false, error: null }).GET, key)).status, 401);
  assert.equal((await request(loadRoute({ data: "unexpected", error: null }).GET, key)).status, 401);
  assert.equal((await request(loadRoute({ data: null, error: { code: "PGRST500" } }).GET, key)).status, 401);
  assert.equal((await request(loadRoute({ data: null, error: { code: "PGRST202" } }).GET, key)).status, 200);
});
