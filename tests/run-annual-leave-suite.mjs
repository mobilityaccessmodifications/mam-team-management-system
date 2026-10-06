import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {startCluster,stopCluster,command,target,postgresEnv} from '../scripts/local-test-postgres.mjs';

const owned=!process.argv[2];
const socket=process.argv[2]??startCluster();
const prefix=`mam_test_annual_${process.pid}`;
const passed=new Set();
function run(binary,args){
  const result=spawnSync(binary,args,{env:postgresEnv,encoding:'utf8',maxBuffer:8*1024*1024});
  process.stdout.write(result.stdout??'');
  if(result.error||result.status!==0){process.stderr.write(result.stderr??'');throw result.error??new Error(`${binary} exit ${result.status}`);}
  for(const match of result.stdout.matchAll(/^PASS (T\d{2})\b/gm))passed.add(match[1]);
}
try{
  run(process.execPath,['scripts/test-migration-replay.mjs',socket,prefix,'--annual-legacy-fixture']);
  run('psql',[...target(socket,prefix),'-v','annual_gate_current=1','-f','tests/banked-leave-request.sql']);
  for(const regression of ['core-review-safety.sql','payroll-carryforward-cutoff.sql']){
    run('psql',[...target(socket,prefix),'-f',`tests/${regression}`]);
  }
  for(const mode of ['bridge','bulk','concurrency']){
    const db=`${prefix}_${mode}`;
    command('createdb',['-h',socket,'-p','55439','-U','postgres',`--template=${prefix}`,db]);
    run(process.execPath,[`tests/run-annual-leave-${mode}.mjs`,socket,db]);
  }
  run('python3',['tests/run-annual-leave-release.py',socket,`${prefix}_predecessor`]);
  const expected=Array.from({length:20},(_,index)=>`T${String(index+1).padStart(2,'0')}`);
  assert.deepEqual([...passed].sort(),expected,'Every requested annual-leave group must pass in this final-source run');
  console.log(JSON.stringify({annualLeaveGroups:passed.size,expectedGroups:20,groups:expected,status:'PASS'}));
}finally{
  if(owned)stopCluster(socket);
}
