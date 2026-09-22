import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const module = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(readFileSync("src/lib/asset-bulk.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(require, module, module.exports);
const { runAssetBulkEdit } = module.exports;
const assets = [1, 2, 3].map(i => ({ id: `device-${i}`, assetCode: `MAM-IT-00000${i}`, version: i, assignedTo: { personId: "old" } }));
test("bulk asset assignment preserves versions, is sequential and reports individual failures", async () => {
  let running = 0; const calls = []; const progress = [];
  const outcome = await runAssetBulkEdit(assets, { action: "assign", assignedPersonId: "new" }, {
    async assign(input) {
      assert.equal(running++, 0); calls.push(input); await Promise.resolve(); running--;
      if (input.assetId === "device-2") throw new Error("Changed by another administrator.");
      return { ...assets.find(a => a.id === input.assetId), version: input.version + 1, assignedTo: { personId: input.assignedPersonId } };
    }, async return() { assert.fail("wrong operation"); },
  }, count => progress.push(count));
  assert.deepEqual(calls.map(c => c.version), [1, 2, 3]);
  assert.deepEqual(outcome.updated.map(a => a.id), ["device-1", "device-3"]);
  assert.deepEqual(outcome.failed, [{ id: "device-2", assetCode: "MAM-IT-000002", message: "Changed by another administrator." }]);
  assert.deepEqual(progress, [1, 2, 3]);
});
test("same-owner assignments still verify the server version and returns keep the chosen date", async () => {
  const verified = [];
  const outcome = await runAssetBulkEdit(assets, { action: "assign", assignedPersonId: "old" }, { async assign(input) { verified.push(input); if (input.assetId === "device-2") throw new Error("Stale version"); return assets.find(a => a.id === input.assetId); }, async return() { assert.fail("wrong operation"); } });
  assert.equal(verified.length, 3);
  assert.equal(outcome.updated.length, 2);
  assert.equal(outcome.failed[0].id, "device-2");
  const calls = [];
  await runAssetBulkEdit(assets, { action: "return", returnedOn: "2026-09-22" }, { async assign() { assert.fail("wrong operation"); }, async return(input) { calls.push(input); return { ...assets[0], id: input.assetId }; } });
  assert.deepEqual(calls, assets.map(a => ({ assetId: a.id, version: a.version, returnedOn: "2026-09-22" })));
});
test("invalid duplicate or oversized selection cannot dispatch asset mutations", async () => {
  const actions = { async assign() { assert.fail("invalid selection mutated"); }, async return() { assert.fail("invalid selection mutated"); } };
  for (const list of [[], [assets[0], assets[0]], Array.from({ length: 101 }, (_, i) => ({...assets[0], id: String(i)}))]) {
    await assert.rejects(runAssetBulkEdit(list, {action: "assign", assignedPersonId: "new"}, actions), /Select between/);
  }
});
