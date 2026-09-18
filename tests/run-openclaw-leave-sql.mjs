// Local synthetic cluster only. Never accepts a production URL or password.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const socket=process.argv[2];
const database=process.argv[3]??'openclaw_leave_test';
if(!/^openclaw_leave_test(_[0-9]+)?$/.test(database))throw new Error('Synthetic database required');
if(!socket?.startsWith('/private/tmp/mam-openclaw-pg.'))throw new Error('Task-owned local socket required');
const extract=(path,start,end)=>{const source=fs.readFileSync(path,'utf8');const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0)throw new Error('Fixture extraction failed');return source.slice(a,b);};
const sql=fs.readFileSync('tests/openclaw-leave-bootstrap.sql','utf8')+'\n'+
extract('supabase/migrations/20260818130000_configurable_leave_approval_grants.sql','create function public.submit_my_leave_request(', 'comment on function public.submit_my_leave_request')+'\n'+
extract('supabase/migrations/20260904140000_historical_leave_import_support.sql','create or replace function private.enforce_leave_request_employment_policy()', 'drop function public.list_leave_workspace_requests')+'\n'+
'create trigger employment before insert on public.leave_requests for each row execute function private.enforce_leave_request_employment_policy();\n'+
fs.readFileSync('supabase/migrations/20260917223558_openclaw_leave_bridge.sql','utf8')+'\n'+fs.readFileSync('tests/openclaw-leave.sql','utf8');
const result=spawnSync('psql',['-h',socket,'-p','55439','-d',database,'-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
if(result.status!==0)process.exit(result.status??1);
const args=['-h',socket,'-p','55439','-d',database,'-v','ON_ERROR_STOP=1'];
const setup=spawnSync('psql',args,{input:fs.readFileSync('tests/openclaw-leave-concurrency.sql','utf8'),encoding:'utf8',env:{PATH:process.env.PATH}});
if(setup.status!==0){process.stderr.write(setup.stderr??'');process.exit(setup.status??1);}
// Both connections use the frozen PRE-submit snapshot, not a sequential mock.
const confirm=key=>new Promise((resolve,reject)=>{
 const sql=`set role service_role; select public.openclaw_leave_commit(repeat('${key}',64),repeat('f',64),snapshot->>'fingerprint',snapshot->>'draftFingerprint',packet,person,draft,'{}',true) from public.fixture_openclaw_plan;`;
 const child=spawn('psql',[...args,'-Atq','-c',sql],{env:{PATH:process.env.PATH}});
 let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
 child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout.trim())):reject(new Error(stderr)));
});
const [first,second]=await Promise.all([confirm('7'),confirm('8')]);
if(first.code!=='submitted'||JSON.stringify(first)!==JSON.stringify(second))throw new Error('Concurrent retry mismatch');
process.stdout.write('Concurrent PostgreSQL confirmations: same Pending result\n');
const retention=spawnSync('psql',args,{input:fs.readFileSync('tests/openclaw-leave-retention.sql','utf8'),encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(retention.stdout??'');process.stderr.write(retention.stderr??'');process.exit(retention.status??1);
