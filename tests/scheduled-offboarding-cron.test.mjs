import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function loadRoute({ candidates = [], runError = null, banError = null } = {}) {
  const calls = [];
  const admin = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "list_scheduled_employee_offboarding") return { data: candidates, error: null };
      if (name === "run_scheduled_employee_offboarding") return { data: !runError, error: runError };
      if (name === "confirm_scheduled_offboarding_auth_ban") return { data: null, error: null };
      throw Error(`Unexpected RPC ${name}`);
    },
    auth: { admin: {
      async updateUserById(id, payload) {
        calls.push(["ban", id, payload]);
        return { data: { user: { id } }, error: banError };
      },
      async getUserById(id) {
        calls.push(["inspect_ban", id]);
        return { data: { user: { id, banned_until: "2099-01-01T00:00:00Z" } }, error: null };
      },
    } },
  };
  const source = ts.transpileModule(readFileSync("src/app/api/cron/scheduled-offboarding/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const moduleUnderTest = { exports: {} };
  new Function("require", "module", "exports", source)((id) => id === "@/lib/supabase/admin" ? { createAdminClient: () => admin } : require(id), moduleUnderTest, moduleUnderTest.exports);
  return { GET: moduleUnderTest.exports.GET, calls };
}
const request = (secret) => new Request("https://example.test/api/cron/scheduled-offboarding", { headers: { authorization: `Bearer ${secret}` } });
const person = "92000000-0000-4000-8000-000000000002";
const user = "92000000-0000-4000-8000-000000000003";

test("cron rejects requests without the secret before querying", async () => {
  process.env.CRON_SECRET = "synthetic-cron-secret";
  const { GET, calls } = loadRoute();
  assert.equal((await GET(request("incorrect"))).status, 401);
  assert.equal(calls.length, 0);
});

test("cron archives then bans Auth and confirms exactly the linked account", async () => {
  process.env.CRON_SECRET = "synthetic-cron-secret";
  const { GET, calls } = loadRoute({ candidates: [{ person_id: person, auth_user_id: user, is_active: true }] });
  const response = await GET(request(process.env.CRON_SECRET));
  assert.equal(response.status, 200, JSON.stringify({ body: await response.json(), calls }));
  assert.deepEqual(calls.map((entry) => entry[0]), ["list_scheduled_employee_offboarding", "run_scheduled_employee_offboarding", "ban", "inspect_ban", "confirm_scheduled_offboarding_auth_ban"]);
  assert.equal(calls[2][1], user);
  assert.equal(calls[2][2].ban_duration, "876000h");
});

test("cron does not ban Auth if transactional archive fails", async () => {
  process.env.CRON_SECRET = "synthetic-cron-secret";
  const { GET, calls } = loadRoute({ candidates: [{ person_id: person, auth_user_id: user, is_active: true }], runError: { message: "hardware not returned" } });
  assert.equal((await GET(request(process.env.CRON_SECRET))).status, 500);
  assert.equal(calls.some((entry) => entry[0] === "ban"), false);
});

test("failed Auth ban remains unconfirmed for retry", async () => {
  process.env.CRON_SECRET = "synthetic-cron-secret";
  const { GET, calls } = loadRoute({ candidates: [{ person_id: person, auth_user_id: user, is_active: false }], banError: { message: "unavailable" } });
  assert.equal((await GET(request(process.env.CRON_SECRET))).status, 500);
  assert.equal(calls.some((entry) => entry[0] === "confirm_scheduled_offboarding_auth_ban"), false);
});
