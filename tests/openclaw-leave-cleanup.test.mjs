import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
const require = createRequire(import.meta.url);
const ts = require("typescript");
function fixture(responses, secret = "synthetic-cron-key") {
  let calls = 0;
  let clients = 0;
  const mod = { exports: {} };
  const imports = {
    "node:crypto": crypto,
    "@/lib/supabase/admin": { createAdminClient: () => {
      clients++;
      return { rpc(name) {
        assert.equal(name, "prune_openclaw_leave_state");
        return { async abortSignal() { return responses[Math.min(calls++, responses.length - 1)]; } };
      } };
    } },
  };
  const source = readFileSync("src/app/api/cron/openclaw-leave-cleanup/route.ts", "utf8");
  new Function("require", "module", "exports", "process", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(id => {
    assert.ok(id in imports); return imports[id];
  }, mod, mod.exports, { env: { CRON_SECRET: secret, MAM_OPENCLAW_LEAVE_ENABLED: "false" } });
  return { get: mod.exports.GET, calls: () => calls, clients: () => clients };
}
const request = (authorization) => new Request("https://example.invalid/api/cron/openclaw-leave-cleanup", {
  headers: authorization ? { authorization } : {},
});
test("protocol cleanup requires the cron secret before touching the database", async () => {
  const f = fixture([]);
  for (const token of [undefined, "Bearer wrong", "Bearer synthetic-cron-keyX"]) {
    assert.equal((await f.get(request(token))).status, 401);
  }
  assert.equal(f.clients(), 0);
  assert.equal((await fixture([], "").get(request("Bearer "))).status, 401);
});
test("cleanup drains bounded batches even with leave submission disabled and exposes no payload", async () => {
  const f = fixture([{ data: { remaining: true } }, { data: { remaining: false } }]);
  const result = await f.get(request("Bearer synthetic-cron-key"));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { code: "complete" });
  assert.match(result.headers.get("cache-control"), /no-store/);
  assert.equal(f.calls(), 2);
});
test("cleanup failures and backlog are visible without leaking database errors", async () => {
  for (const response of [{ error: { message: "private database detail" } }, { data: {} }]) {
    const result = await fixture([response]).get(request("Bearer synthetic-cron-key"));
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { code: "cleanup_failed" });
  }
  const f = fixture([{ data: { remaining: true } }]);
  const result = await f.get(request("Bearer synthetic-cron-key"));
  assert.equal(f.calls(), 100);
  assert.deepEqual(await result.json(), { code: "cleanup_incomplete" });
});
test("daily cleanup is scheduled and its exact route reaches its own authentication gate", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.ok(config.crons.some(job => job.path === "/api/cron/openclaw-leave-cleanup" && job.schedule === "47 16 * * *"));
  const proxy = readFileSync("src/proxy.ts", "utf8");
  assert.ok(proxy.indexOf('pathname === "/api/cron/openclaw-leave-cleanup"') < proxy.indexOf("if (!isSupabaseConfigured())"));
});
