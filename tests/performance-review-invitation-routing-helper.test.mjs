import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
for(const scenario of ['inspect','apply','wrong-project','wrong-org','bad-pin','dirty-source','wrong-origin','wrong-author','bad-predecessor','duplicate-ledger','wrong-major','source-race','unknown-before','unknown-after','malformed-attestation','readback-error','drift-ledger','drift-catalog'])test(`invitation routing release CLI ${scenario}`,()=>{
 const result=spawnSync('python3',['-B','tests/performance-review-invitation-routing-helper-cli.py',scenario],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.classification,'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');assert.equal(receipt.scenario,scenario);
});
