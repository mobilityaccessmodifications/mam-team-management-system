import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync,readFileSync,writeFileSync,existsSync,mkdtempSync,mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {download} from './performance-review-completion-word-fixture.mjs';
import {loadMailHarness,fixture,ack} from './helpers/performance-review-mail-harness.mjs';
import {startCluster,stopCluster,createDatabase,sql,postgresEnv} from '../scripts/local-test-postgres.mjs';

test('byte-exact ordered replay preserves all 196 migrations and admits only completion delta',async()=>{
 const out=process.env.MAM_PERFORMANCE_TEST_EVIDENCE??mkdtempSync(path.join(os.tmpdir(),'completion-replay-'));
 mkdirSync(out,{recursive:true,mode:0o700});
 const socket=startCluster();let cleanup;
 writeFileSync(path.join(out,'replay-cluster.json'),readFileSync(path.join(socket,'mam-test-cluster.json')));
 try {
  const database='mam_test_completion_replay';createDatabase(socket,database);
  sql(socket,database,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
  const files=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&f.slice(0,14)<='20261017103000').sort();assert.equal(files.length,197);
  const pins={};
  for(const file of files) {
   const source=readFileSync(path.join('supabase/migrations',file));pins[file]=createHash('sha256').update(source).digest('hex');
   if(file==='20261003090000_payroll_operator_session_proof.sql') {
    sql(socket,database,readFileSync('tests/migrations/operator-session-platform.sql','utf8'));
    sql(socket,database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
   }
   if(file==='20261006104000_unified_portal_roles.sql') {
    for(const fixture of ['canonical-roles-storage-platform.sql','canonical-roles-hosted-member-predecessor.sql'])sql(socket,database,readFileSync('tests/migrations/'+fixture,'utf8'));
    sql(socket,database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
    sql(socket,database,readFileSync('tests/migrations/canonical-roles-release-plan.sql','utf8')+'\n'+source.toString()+'\n'+readFileSync('tests/migrations/canonical-roles-release-readback.sql','utf8'));
   }else sql(socket,database,source.toString());
   console.log('Replayed byte-exact '+file);
  }
  writeFileSync(path.join(out,'ordered-replay-source-pins.json'),JSON.stringify(pins,null,2)+'\n');
  for(const [file,pin]of Object.entries(pins))assert.equal(createHash('sha256').update(readFileSync(path.join('supabase/migrations',file))).digest('hex'),pin);
  const source=readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8');
  const metadata=source.split('$performance_metadata$')[1].trim().replace(/;$/,'');
  const expected=JSON.parse(source.split('$performance_expected$')[1])[String(Number(sql(socket,database,"select current_setting('server_version_num')::integer/10000;").trim()))];
  const actual=JSON.parse(sql(socket,database,"set search_path='';"+metadata).trim());assert.deepEqual(actual,expected);
  assert.equal(sql(socket,database,'select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);').trim(),'t');
  writeFileSync(path.join(out,'effective-feature-metadata.json'),JSON.stringify(actual,null,2)+'\n');
  const business=readFileSync('tests/performance-review-completion-effective.sql','utf8');
  const r=spawnSync('psql',['-X','-h',socket,'-p','55439','-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'],{env:postgresEnv,input:business,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});
  writeFileSync(path.join(out,'effective-business.sql'),business);writeFileSync(path.join(out,'effective-business.stdout.log'),r.stdout??'');writeFileSync(path.join(out,'effective-business.stderr.log'),r.stderr??'');writeFileSync(path.join(out,'effective-business.receipt.json'),JSON.stringify({exit:r.status,signal:r.signal}));assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout.split('\n').find(line=>line.startsWith('{"outboxes"')||line.startsWith('{"documents"')||line.startsWith('{"classification"')));assert.equal(result.outboxes,2);assert.equal(result.documents.length,2);
  const boundaries=[];
  for(const document of result.documents) {
   const bytes=download(document).bytes;assert.ok(bytes.length<=2097152);const row=fixture();row.payload.document=document;row.payload.reviewCode=document.code;
   let wire,claimed=false;const h=loadMailHarness({rpc:name=>{if(name!=='claim_performance_review_mail')return {data:true,error:null,status:200};const data=claimed?[]:[row];claimed=true;return {data,error:null,status:200};},fetch:async(_url,init)=>{wire=JSON.parse(init.body);return ack(wire);}});
   await h.mail.dispatchPerformanceReviewMailOutbox();assert.ok(wire,'Actual worker emits the native saved document through an inert port');
   const saved=readFileSync('deploy/n8n/performance-review-mail-v1/validate-payload.js','utf8');const checked=new Function('$input','$json','require',saved)({all:()=>[{json:{body:wire}}]},{body:wire},()=>({createHash}));
   const valid=checked[0].json.valid;assert.equal(typeof valid,'boolean');
   if(document.employee.name.length<=200)assert.equal(valid,true);
   boundaries.push({company:document.employee.company,codepoints:Array.from(document.employee.name).length,utf16Units:document.employee.name.length,canonicalBytes:bytes.length,serverEmitted:true,savedN8nAccepted:valid,sourceSha256:{mail:createHash('sha256').update(readFileSync('src/lib/performance-review-mail.ts')).digest('hex'),savedValidator:createHash('sha256').update(saved).digest('hex')}});
  }
  writeFileSync(path.join(out,'schema-derived-mail-boundary.json'),JSON.stringify({classification:'NATIVE_SAVED_DOCUMENT_TO_REAL_WORKER_INERT_WIRE_NOT_PROVIDER_ACCEPTANCE',boundaries,requiresMailOwnerNameWidthSync:boundaries.some(b=>!b.savedN8nAccepted)},null,2)+'\n');
 } finally {
  const pid=existsSync(path.join(socket,'data/postmaster.pid'))?readFileSync(path.join(socket,'data/postmaster.pid'),'utf8').split('\n')[0]:null;
  stopCluster(socket);
  const status=spawnSync('pg_ctl',['-D',path.join(socket,'data'),'status'],{env:postgresEnv,encoding:'utf8'});
  cleanup={socket,pid,statusExit:status.status,stopped:status.status===3,pidAbsent:!existsSync(path.join(socket,'data/postmaster.pid')),socketAbsent:!existsSync(path.join(socket,'.s.PGSQL.55439'))};
  writeFileSync(path.join(out,'replay-cleanup.json'),JSON.stringify(cleanup,null,2)+'\n');writeFileSync(path.join(out,'replay-postgres.log'),readFileSync(path.join(socket,'postgres.log')));
  assert.ok(cleanup.stopped&&cleanup.pidAbsent&&cleanup.socketAbsent);
 }
});
