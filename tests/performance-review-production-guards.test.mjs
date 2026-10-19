import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
const scenarios=['recorded-major','snapshot-corrupt','snapshot-bound','spent-journal','source-race','unknown-interrupt','late-local','duplicate-local','malformed-local','unknown-before','unknown-after','malformed-attestation','readback-error','drift-major','drift-securityHash','drift-dataHash','drift-catalogHash','drift-ledger','drift-feature','deny-major','deny-boolean-major','deny-boolean-ndims','deny-duplicate-version','deny-alias','deny-dimensions','deny-null-elements','deny-raw-source','deny-anchor','deny-predecessor','deny-catalog'];
for(const scenario of scenarios)test(`actual helper CLI fail-closed ${scenario}`,()=>{
 const result=spawnSync('python3',['-B','tests/performance-review-production-helper-cli.py',scenario],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr||result.stdout);
 const model=JSON.parse(result.stdout);assert.equal(model.scenario,scenario);assert.equal(model.classification,'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');
});
