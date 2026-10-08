import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {sql,target,command,postgresEnv} from '../scripts/local-test-postgres.mjs';

const [socket,database]=process.argv.slice(2);
assert.match(database??'',/^mam_test_annual_/);
const employee='b1000000-0000-4000-8000-000000000002';
const seed=readFileSync('tests/annual-leave-all-submitters.sql','utf8').split('DO $$ BEGIN\n  BEGIN')[0]
  .replace('\\ir sql-test-auth.sql',`\\ir '${path.resolve('tests/sql-test-auth.sql').replaceAll("'","''")}'`);
const file=path.join(socket,`${database}-bulk-seed.sql`);
writeFileSync(file,seed+`update private.employee_annual_leave_balances set hours=10 where person_id::text like 'b1000000-%';
update private.leave_accrual_policies set enabled=false,requires_review=false where person_id::text like 'b1000000-%'; commit;`,{mode:0o600});
command('psql',[...target(socket,database),'-f',file]);
const day=sql(socket,database,"select ((current_date+28)-(extract(isodow from current_date+28)::integer-1))::text;").trim();
const count=()=>Number(sql(socket,database,`select count(*) from public.leave_requests where employee_person_id='${employee}';`).trim());
function copy(rows,role='postgres'){
  const body=`set role ${role}; copy public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,leave_type,request_type_label,start_date,end_date,business_days,hours) from stdin with(format csv);\n`+
    rows.map((hours,i)=>`${employee},historical_import,${String(i+1).repeat(64)},approved,${new Date().toISOString()},annual,Annual leave,${day},${day},1,${hours}`).join('\n')+'\n\\.\n';
  return spawnSync('psql',[...target(socket,database),'-v','VERBOSITY=verbose','-Atq'],{env:postgresEnv,encoding:'utf8',input:body});
}
const failed=copy([8,8]);
assert.notEqual(failed.status,0,'T07: COPY overspent one employee in a single batch');
assert.match(failed.stderr,/22023:/);
assert.match(failed.stderr,/Not enough balance|Future accrual could not be confirmed/);
assert.equal(count(),0,'T07: failed COPY committed a prefix');
const funded=copy([8]);
assert.equal(funded.status,0,funded.stderr);
assert.equal(count(),1);
const service=copy([8],'service_role');
assert.notEqual(service.status,0,'T07: service COPY bypassed annual balance');
assert.match(service.stderr,/(22023|42501|0A000):/);
assert.equal(count(),1);
const browser=copy([1],'authenticated');
assert.notEqual(browser.status,0,'T07: browser COPY acquired table-write authority');
assert.match(browser.stderr,/(42501|0A000):/);
assert.equal(count(),1);
console.log('PASS T07 real COPY per-row gate atomic failed batch and unchanged browser/service permissions');
