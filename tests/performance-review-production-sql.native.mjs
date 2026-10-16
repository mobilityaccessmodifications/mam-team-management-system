import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ownedCluster,rows} from './performance-review-production-harness.mjs';
let c;
function flow(extra){
 const core=readFileSync('tests/performance-review-production-core.sql','utf8');
 const end=core.indexOf("select pg_temp.assert_true(current_setting('test.final')");
 assert.ok(end>0);
 c.sql('mam_test_pr_core',core.slice(0,end)+'reset role;\n'+extra+'\nrollback;');
}
before(()=>{
 const result=spawnSync('postgres',['--version'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const major=Number(/\(PostgreSQL\) (\d+)\./.exec(result.stdout)?.[1]);assert.ok([16,17].includes(major));
 c=ownedCluster(major);
});
after(()=>c?.stop());
test('versioned production schema exposes the real performance workspace',()=>{
 c.setup('mam_test_pr_core');
 assert.match(c.sql('mam_test_pr_core',"select to_regprocedure('public.performance_review_workspace()') is not null;"),/^t$/m);
});
test('feature metadata exactly matches its native major with only the four reviewed ACL variants',()=>{
 const source=readFileSync('supabase/migrations/20261016150000_performance_reviews_and_mail.sql','utf8');
 const variants=JSON.parse(source.split('$performance_expected$')[1]);assert.deepEqual(Object.keys(variants).sort(),['16','17']);
 const major=Number(c.sql('mam_test_pr_core',"select current_setting('server_version_num')::integer/10000;").trim());
 const metadata=source.split('$performance_metadata$')[1].trim().replace(/;$/,'');
 const actual=rows(c.sql('mam_test_pr_core',"set search_path='';"+metadata))[0];assert.deepEqual(actual,variants[String(major)]);
 const sibling=structuredClone(actual);
 for(const relation of Object.values(sibling.relations))relation.acl=major===16?'{postgres=arwdDxtm/postgres}':'{postgres=arwdDxt/postgres}';
 assert.deepEqual(sibling,variants[major===16?'17':'16']);
});
test('finalisation atomically queues one private mail delivery alongside the unchanged core contract',()=>{
 const core=readFileSync('tests/performance-review-production-core.sql','utf8');
 const boundary=core.lastIndexOf('rollback;');
 const extra="select pg_temp.assert_true(to_regclass('private.performance_review_mail_outbox') is not null,'final notification outbox exists');\nselect pg_temp.assert_true((select count(*)=1 and bool_and(state='queued' and claim_token is null and attachment_sha256 is null) from private.performance_review_mail_outbox where review_id=current_setting('test.review_id')::uuid),'exactly one queued row after final and operation replay');\n";
 c.sql('mam_test_pr_core',core.slice(0,boundary)+extra+core.slice(boundary));
});
test('only service can durably claim queued final payloads once',()=>flow(readFileSync('tests/performance-review-production-claim.sql','utf8')));
test('begin grants one exact scalar Boolean permit without resend',()=>flow(readFileSync('tests/performance-review-production-claim.sql','utf8')+readFileSync('tests/performance-review-production-begin.sql','utf8')));
test('finish retains sticky unknown and monotonic accepted state with no resend',()=>flow(['claim','begin','finish'].map(x=>readFileSync(`tests/performance-review-production-${x}.sql`,'utf8')).join('\n')));
test('production migration refuses a mismatched captured purge predecessor atomically',()=>{
 c.setup('mam_test_pr_drift',false);
 c.sql('mam_test_pr_drift',"update private.confirmed_test_purge_schema set schema_hash=repeat('0',64);");
 const result=c.run('mam_test_pr_drift',readFileSync('supabase/migrations/20261016150000_performance_reviews_and_mail.sql','utf8'));
 assert.equal(result.status,3);assert.match(result.stderr,/55000/);
 assert.match(c.sql('mam_test_pr_drift',"select to_regclass('private.performance_reviews') is null;"),/^t$/m);
});
test('only the reviewed additive catalog delta advances the purge fingerprint',()=>{
 assert.match(c.sql('mam_test_pr_core',"select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);"),/^t$/m);
});
