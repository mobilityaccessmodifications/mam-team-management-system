import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(file, imports) {
  const mod = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(id => { assert.ok(id in imports, id); return imports[id]; }, mod, mod.exports);
  return mod.exports;
}
test("real contract and Supabase adapter carry the resolved actor for needs_input with no draft", async () => {
  const personId = "10000000-0000-4000-8000-000000000001";
  const userId = "20000000-0000-4000-8000-000000000001";
  const calls = [];
  const client = { rpc(name, args) {
    calls.push({ name, args });
    return { async abortSignal() {
      if (name === "openclaw_leave_snapshot") return { data: {
        complete: true, fingerprint: "a".repeat(64), draftFingerprint: "b".repeat(64), draft: null, receipt: null,
        rows: [{ personId, userId, company: "mam", active: true, nodeKind: "person", accountActive: true,
          phone: "0400000001", country: "Australia", employmentType: "full_time" }],
      } };
      assert.equal(name, "openclaw_leave_commit");
      assert.equal(args.p_person_id, personId);
      assert.equal(args.p_draft, null);
      assert.equal(args.p_submit, false);
      assert.deepEqual(args.p_result, { code: "needs_input", missing: ["leaveType", "startDate", "endDate"] });
      return { data: args.p_result };
    } };
  } };
  const phone = load("src/lib/openclaw-allowlist.ts", { "server-only": {}, "node:crypto": crypto, "libphonenumber-js/max": require("libphonenumber-js/max") });
  const contract = load("src/lib/openclaw-leave-contract.ts", { "server-only": {}, "node:crypto": crypto, "./openclaw-allowlist": phone });
  const store = load("src/lib/openclaw-leave-store.ts", { "server-only": {}, "./supabase/admin": { createAdminClient: () => client } }).createLeaveBridgeStore();
  const config = { key: "synthetic-test-key-".padEnd(48, "x"), account: "test" };
  const packet = { version: 1, account: "test", channel: "whatsapp", sender: "+61400000001", session: "self", eventId: "needs-input", operation: "prepare", payload: {} };
  const raw = JSON.stringify(packet), timestamp = String(Date.now());
  const signature = crypto.createHmac("sha256", config.key).update(`POST\n${contract.LEAVE_BRIDGE_PATH}\n${timestamp}\n${raw}`).digest("hex");
  const response = await contract.handleLeaveBridge(raw, timestamp, signature, config, store);
  assert.equal(response.status, 200);
  assert.equal(response.body.code, "needs_input");
  assert.equal(calls.length, 2);
});
