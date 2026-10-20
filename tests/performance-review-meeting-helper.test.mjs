import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const helper='scripts/deploy-performance-review-meeting.py';
const migration='supabase/migrations/20261020212355_performance_review_meeting_invitation.sql';
const predecessor='supabase/migrations/20261020003343_performance_review_careers_cc.sql';
const transport='scripts/deploy-staff-leave-calendar.py';
const hash=s=>createHash('sha256').update(s).digest('hex');
const cleanEnv={PATH:process.env.PATH,TMPDIR:os.tmpdir(),LANG:'C',LC_ALL:'C',PYTHONDONTWRITEBYTECODE:'1'};
function python(code,input){const r=spawnSync('python3',['-B','-c',code],{env:cleanEnv,encoding:'utf8',input:JSON.stringify(input)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
const prior=python("import runpy,json; m=runpy.run_path('scripts/deploy-performance-review-meeting.py');print(json.dumps(m['predecessor_bodies'](m['MIGRATION'].read_text())))");
const expected=python("import runpy,json; m=runpy.run_path('scripts/deploy-performance-review-meeting.py');print(json.dumps(m['expected_bodies'](m['MIGRATION'].read_text())))");
function fixture({hold=false,mode='success',target=null,changeAfter=false}={}){
 const dir=mkdtempSync(path.join(realpathSync(os.tmpdir()),'mam-meeting-helper-'));const root=path.join(dir,'source'),operator=path.join(dir,'operator');mkdirSync(root);mkdirSync(operator,{mode:0o700});
 const stateFile=path.join(operator,'state.json');
 const digest='a'.repeat(64),catalog='b'.repeat(64),newCatalog='c'.repeat(64);
 const before={major:17,actor:'postgres',session:'postgres',readOnly:'on',catalogHash:catalog,storedHash:hold?digest:catalog,purgeRows:1,dataHash:digest,preservedHash:digest,oldMetadata:{},predecessorExact:true,targetPresent:false,targetExact:false,ledger:[{version:'20261020003343',name:'performance_review_careers_cc',rowSha256:digest,sourceArraySha256:digest}],requestTable:false,bodies:prior,ready:false};
 const after={...before,catalogHash:newCatalog,storedHash:hold?digest:newCatalog,targetPresent:true,targetExact:true,requestTable:true,ready:true,bodies:expected,ledger:[...before.ledger,{version:'20261020212355',name:'performance_review_meeting_invitation',rowSha256:catalog,sourceArraySha256:catalog}]};
 if(changeAfter)after.dataHash='f'.repeat(64);
 writeFileSync(stateFile,JSON.stringify({before,after,mode,dispatches:0,target:target??{id:'xtwlrjqbusadghavchqm',organization_id:'fwlmbmospuwoaosffvmw'}}));
 for(const name of [helper,migration,predecessor]){const dest=path.join(root,name);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(name));}
 writeFileSync(path.join(root,transport),`import json\nfrom pathlib import Path\nSTATE=Path(${JSON.stringify(stateFile)})\ndef api(path):\n return json.loads(STATE.read_text())['target']\ndef query(sql):\n state=json.loads(STATE.read_text())\n if sql.startswith('begin read only;'):\n  return [{'state':state['after'] if state['dispatches'] and state['mode']!='rollback' else state['before']}]\n state['dispatches']+=1\n STATE.write_text(json.dumps(state))\n if state['mode'] in ('unknown','rollback'):raise RuntimeError('Synthetic lost response')\n return [{'resultingCatalogSha256':state['after']['catalogHash']}]\n`);
 const git=args=>{const r=spawnSync('git',args,{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(['init','-q']);git(['config','user.name','mobilityaccessmodifications']);git(['config','user.email','310802599+mobilityaccessmodifications@users.noreply.github.com']);git(['remote','add','origin','https://github.com/mobilityaccessmodifications/mam-team-management-system.git']);git(['add',helper,migration,predecessor,transport]);git(['commit','-qm','Synthetic meeting release helper fixture']);
 const head=git(['rev-parse','HEAD']);const pins=[helper,transport,migration,predecessor].map(name=>hash(readFileSync(path.join(root,name))));
 const snapshot=path.join(operator,'before.json');
 const run=(operation,...extra)=>spawnSync('python3',['-B',path.join(root,helper),operation,head,...pins,...extra],{cwd:root,env:{...cleanEnv,CODEX_COMPANY_PROFILE:'mam',SUPABASE_ACCESS_TOKEN:'synthetic-not-a-real-credential'},encoding:'utf8'});
 return{dir,root,operator,stateFile,before,after,snapshot,run,git,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
function snapshot(f){const result=f.run('snapshot',f.snapshot);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.existingPurgeHold,f.before.storedHash!==f.before.catalogHash);return receipt.snapshotSha256;}
test('meeting helper unsupported invocations stop before credentials or network',()=>{
 for(const args of [[],['apply'],['arbitrary','f'.repeat(40)],['inspect','unreviewed']]){const r=spawnSync('python3',['-B',helper,...args],{env:cleanEnv,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/Usage:/);assert.equal(r.stdout,'');}
});
for(const hold of [false,true])test(`meeting helper exact snapshot/apply/readback preserves ${hold?'existing HOLD':'healthy purge baseline'}`,()=>{
 const f=fixture({hold});try{const pin=snapshot(f),apply=f.run('apply',f.snapshot,pin);assert.equal(apply.status,0,apply.stderr);assert.equal(JSON.parse(apply.stdout).writeCount,1);const repeated=f.run('apply',f.snapshot,pin);assert.equal(repeated.status,0,repeated.stderr);assert.equal(JSON.parse(repeated.stdout).readOnly,true);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,1);const read=f.run('readback',f.snapshot,pin);assert.equal(read.status,0,read.stderr);assert.equal(JSON.parse(read.stdout).readbackVerified,true);}finally{f.cleanup();}
});
test('meeting helper wrong provider organization stops all SQL queries',()=>{
 const f=fixture({target:{id:'xtwlrjqbusadghavchqm',organization_id:'wrong-company'}});try{const r=f.run('inspect');assert.notEqual(r.status,0);assert.match(r.stderr,/Wrong MAM organization\/project/);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,0);}finally{f.cleanup();}
});
test('meeting helper unknown mutation response spends journal and never retries',()=>{
 const f=fixture({mode:'unknown'});try{const pin=snapshot(f);const first=f.run('apply',f.snapshot,pin);assert.notEqual(first.status,0);assert.match(first.stderr,/dispatch unverified; HOLD/);const second=f.run('apply',f.snapshot,pin);assert.notEqual(second.status,0);assert.match(second.stderr,/spent; HOLD; readback only, never retry/);const read=f.run('readback',f.snapshot,pin);assert.equal(read.status,0,read.stderr);assert.equal(JSON.parse(read.stdout).readbackVerified,true);const recovered=f.run('apply',f.snapshot,pin);assert.equal(recovered.status,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).readOnly,true);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,1);}finally{f.cleanup();}
});
test('meeting helper post-commit row drift remains HOLD and never redispatches',()=>{
 const f=fixture({changeAfter:true});try{const pin=snapshot(f),first=f.run('apply',f.snapshot,pin);assert.notEqual(first.status,0);assert.match(first.stderr,/readback unverified; HOLD/);const second=f.run('apply',f.snapshot,pin);assert.notEqual(second.status,0);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,1);}finally{f.cleanup();}
});
test('meeting helper rejects source drift before provider access',()=>{
 const f=fixture();try{writeFileSync(path.join(f.root,migration),readFileSync(path.join(f.root,migration),'utf8')+'\n');const r=f.run('inspect');assert.notEqual(r.status,0);assert.match(r.stderr,/Reviewed release hash differs/);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,0);}finally{f.cleanup();}
});
test('meeting helper refuses target source alias and historical ledger drift',()=>{
 for(const kind of ['alias','history']){const f=fixture();try{const pin=snapshot(f),data=JSON.parse(readFileSync(f.stateFile));if(kind==='alias'){data.before.targetPresent=true;data.before.targetExact=false;}else data.before.ledger[0].rowSha256='f'.repeat(64);writeFileSync(f.stateFile,JSON.stringify(data));const r=f.run('apply',f.snapshot,pin);assert.notEqual(r.status,0);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,0);}finally{f.cleanup();}}
});

test('meeting helper unknown rolled-back outcome stays read-only and never retries',()=>{
 const f=fixture({mode:'rollback'});try{const pin=snapshot(f),first=f.run('apply',f.snapshot,pin);assert.notEqual(first.status,0);const read=f.run('readback',f.snapshot,pin);assert.notEqual(read.status,0);assert.match(read.stderr,/Unrecorded or changed release; HOLD/);const retry=f.run('apply',f.snapshot,pin);assert.notEqual(retry.status,0);assert.equal(JSON.parse(readFileSync(f.stateFile)).dispatches,1);}finally{f.cleanup();}
});
