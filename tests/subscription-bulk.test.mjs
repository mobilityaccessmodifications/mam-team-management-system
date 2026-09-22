import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const loaded = { exports: {} };
new Function("module", "exports", ts.transpileModule(readFileSync("src/lib/subscription-bulk.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(loaded, loaded.exports);
const { subscriptionPatchValues, runSubscriptionBulkEdit } = loaded.exports;

test("bulk patch accepts only explicit chosen fields and rejects hidden edits", () => {
  assert.deepEqual(subscriptionPatchValues({ company: "both" }), { company_scope: "both" });
  assert.deepEqual(subscriptionPatchValues({ status: "paused" }), { subscription_status: "paused" });
  for (const bad of [null, [], {}, { company: null }, { company: "else" }, { status: "deleted" }, { responsiblePersonId: "bad" }, { company: "mam", memberPersonIds: [] }, { amountCents: 0 }]) {
    assert.throws(() => subscriptionPatchValues(bad));
  }
});
test("bulk patch runs sequentially and retains item-specific failures without claiming success", async () => {
  const targets = ["a", "b", "c"].map((id) => ({ id, version: 2, serviceName: `Service ${id}` }));
  const calls = []; const progress = []; let active = 0;
  const result = await runSubscriptionBulkEdit(targets, { status: "paused" }, async (target, patch) => {
    active += 1; assert.equal(active, 1);
    calls.push({ id: target.id, version: target.version, patch });
    await Promise.resolve(); active -= 1;
    if (target.id === "b") throw new Error("This subscription has changed.");
  }, (count) => progress.push(count));
  assert.deepEqual(result.updatedIds, ["a", "c"]);
  assert.deepEqual(result.failures, [{ id: "b", serviceName: "Service b", message: "This subscription has changed." }]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(calls.map((call) => call.id), ["a", "b", "c"]);
  assert.ok(calls.every((call) => call.version === 2 && call.patch.status === "paused"));
});
test("invalid or duplicate batches do not start any write", async () => {
  for (const targets of [[], [{ id: "a" }, { id: "a" }], Array.from({ length: 251 }, (_, index) => ({ id: String(index) }))]) {
    await assert.rejects(runSubscriptionBulkEdit(targets, { company: "mam" }, () => assert.fail("Must not write")));
  }
});
test("bulk server action authenticates, checks management and uses the narrow versioned RPC", () => {
  const source = readFileSync("src/app/subscriptions/bulk-actions.ts", "utf8");
  assert.match(source, /auth.getUser\(\)/);
  assert.match(source, /rpc\("can_manage_subscriptions"\)/);
  assert.match(source, /rpc\("patch_subscription_v1"/);
  assert.match(source, /p_expected_version: input.version/);
  assert.doesNotMatch(source, /update_subscription_v4|service.role|member_person_ids/);
});
