import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const mode of ['deny-major','recorded-major','deny-raw-source','deny-dimensions','deny-anchor','deny-predecessor','deny-catalog','source-race','closure-assume','closure-actions','spent-journal','unknown-before','unknown-after','unknown-interrupt','malformed-attestation','readback-error','drift-dataHash','drift-feature','late-local','duplicate-local']) test('source-bound completion helper retains HOLD for '+mode,()=>{
 const r=spawnSync('python3',['-B','tests/performance-review-completion-helper-cli.py',mode],{encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stderr);
 const receipt=JSON.parse(r.stdout);assert.equal(receipt.classification,'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');assert.ok(receipt.counts.mutationDispatches<=1);
});

test('readback rejects a corrupted one-shot intent even after a matching committed target',()=>{
 const result=spawnSync('python3',['-B','tests/performance-review-completion-helper-cli.py','readback-journal'],{encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);
});

test('completion release has a dedicated source-bound helper with inert real-Git CLI acceptance',()=>{
 assert.ok(existsSync('scripts/deploy-performance-review-completion.py'),'A dedicated new-version helper must exist');
 for(const mode of ['inspect','snapshot','apply']) {
  const result=spawnSync('python3',['-B','tests/performance-review-completion-helper-cli.py',mode],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).classification,'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');
 }
});
