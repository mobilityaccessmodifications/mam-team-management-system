import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,realpathSync} from 'node:fs';
import ts from 'typescript';
import os from 'node:os';
const suites=['tests/performance-review-production-sql.native.mjs','tests/performance-review-production-envelope.native.mjs','tests/performance-review-completion.native.mjs','tests/performance-review-completion-envelope.native.mjs','tests/performance-review-completion-races.native.mjs','tests/performance-review-completion-release.native.mjs','tests/performance-review-notifications.native.mjs','tests/performance-review-preview.native.mjs','tests/performance-review-delegation.native.mjs','tests/performance-review-admin.native.mjs','tests/performance-review-careers-cc.native.mjs','tests/performance-review-meeting.native.mjs','tests/performance-review-invitation-status.native.mjs','tests/performance-review-invitation-routing.native.mjs','tests/performance-review-self-submitted-manager.native.mjs','tests/performance-review-manager-mail.native.mjs','tests/performance-review-goals-final.native.mjs'];
function run({major=17,status=0}={}) {
 const calls=[],source=readFileSync('scripts/test-performance-review-production.mjs','utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const require=id=>({'node:assert/strict':assert,'node:os':os,'node:fs':{realpathSync},'node:child_process':{spawnSync(binary,args,options){calls.push({binary,args,options});return args[0]==='--version'?{status:0,stdout:'synthetic (PostgreSQL) '+major+'.11',stderr:''}:{status,stderr:''};}}})[id]??(()=>{throw Error('Unexpected native caller import '+id);})();
 const invoke=()=>new Function('require','exports','process',compiled)(require,{}, {env:{PATH:'/synthetic/bin',MAM_PERFORMANCE_TEST_EVIDENCE:'/synthetic/evidence'},execPath:'/synthetic/node'});
 return {calls,invoke};
}
test('standard performance native caller dispatches every new completion regression without full replay',()=>{
 const h=run();h.invoke();const native=h.calls.filter(c=>c.binary==='/synthetic/node');
 assert.equal(native.length,1);assert.deepEqual(native[0].args,['--test',...suites]);
 assert.equal(native[0].options.env.TMPDIR,realpathSync(os.tmpdir()));
 assert.deepEqual(Object.keys(native[0].options.env).sort(),['LANG','LC_ALL','MAM_PERFORMANCE_TEST_EVIDENCE','PATH','TMPDIR']);
});
test('standard performance native caller retains wrong-major and child-failure holds',()=>{
 const major=run({major:16});assert.throws(major.invoke,/requires PostgreSQL 17/);assert.equal(major.calls.filter(c=>c.binary==='/synthetic/node').length,0);
 const child=run({status:1});assert.throws(child.invoke,/Native performance feature\/release gate failed/);
});
