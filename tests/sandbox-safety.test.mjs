import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", code)(require, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const localEnvironment = {
  MAM_SANDBOX_E2E: "true",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
  SUPABASE_SECRET_KEY: "sb_secret_synthetic",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

test("sandbox mode accepts only a complete loopback application configuration", () => {
  const { assertSandboxEnvironment } = load("src/lib/sandbox-safety.ts");

  assert.doesNotThrow(() => assertSandboxEnvironment(localEnvironment));
  assert.throws(
    () => assertSandboxEnvironment({
      ...localEnvironment,
      NEXT_PUBLIC_SUPABASE_URL: "https://xtwlrjqbusadghavchqm.supabase.co",
    }),
    /loopback/i,
  );
  assert.throws(
    () => assertSandboxEnvironment({ ...localEnvironment, SUPABASE_SECRET_KEY: "" }),
    /SUPABASE_SECRET_KEY/,
  );
});

test("sandbox mode rejects outbound integration variables without leaking their values", () => {
  const { assertSandboxEnvironment } = load("src/lib/sandbox-safety.ts");
  const sensitiveValue = "must-never-appear-in-an-error";

  assert.throws(
    () => assertSandboxEnvironment({
      ...localEnvironment,
      MAM_N8N_LEAVE_WEBHOOK_SECRET: sensitiveValue,
    }),
    (error) => {
      assert.match(error.message, /MAM_N8N_LEAVE_WEBHOOK_SECRET/);
      assert.doesNotMatch(error.message, new RegExp(sensitiveValue));
      return true;
    },
  );
});

test("sandbox fetch guard blocks remote requests before the network and permits loopback", async () => {
  const { createSandboxFetch } = load("src/lib/sandbox-safety.ts");
  const requests = [];
  const fetchImplementation = async (input) => {
    requests.push(String(input));
    return new Response(null, { status: 204 });
  };
  const guardedFetch = createSandboxFetch(fetchImplementation, localEnvironment);

  await assert.rejects(
    guardedFetch("https://example.test/webhook"),
    /blocked outbound request/i,
  );
  assert.deepEqual(requests, []);

  assert.equal((await guardedFetch("http://127.0.0.1:54321/rest/v1/profiles")).status, 204);
  assert.deepEqual(requests, ["http://127.0.0.1:54321/rest/v1/profiles"]);
});

test("sandbox guard is inert unless explicitly enabled", async () => {
  const { assertSandboxEnvironment, createSandboxFetch } = load("src/lib/sandbox-safety.ts");
  const environment = { MAM_SANDBOX_E2E: "false" };
  let calls = 0;

  assert.doesNotThrow(() => assertSandboxEnvironment(environment));
  const response = await createSandboxFetch(async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }, environment)("https://example.test");

  assert.equal(response.status, 204);
  assert.equal(calls, 1);
});

test("Next.js startup installs the sandbox environment and fetch guards", () => {
  const nextConfig = fs.readFileSync("next.config.ts", "utf8");
  const instrumentation = fs.readFileSync("src/instrumentation.ts", "utf8");
  assert.match(nextConfig, /assertSandboxEnvironment\(\)/);
  assert.match(instrumentation, /assertSandboxEnvironment\(\)/);
  assert.match(instrumentation, /installSandboxFetchGuard\(\)/);
});
