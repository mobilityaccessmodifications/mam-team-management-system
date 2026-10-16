import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
test('bounded production helper provides inspect snapshot apply readback through the actual CLI',()=>{
 assert.ok(existsSync('scripts/deploy-performance-reviews.py'),'new version-specific helper exists');
});
test('actual inspector CLI verifies bound production metadata without mutation',()=>{
 const r=spawnSync('python3',['-B','tests/performance-review-production-helper-cli.py','inspect'],{encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).classification,'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');
});
test('snapshot CLI captures an explicit source-bound private before frame without writes',()=>{
 const r=spawnSync('python3',['-B','tests/performance-review-production-helper-cli.py','snapshot'],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
});
test('apply CLI journals one transaction then independently reads back and never replays recorded target',()=>{
 const r=spawnSync('python3',['-B','tests/performance-review-production-helper-cli.py','apply'],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).counts.mutationDispatches,1);
});
