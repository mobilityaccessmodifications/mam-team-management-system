import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {env,evidence,rows} from './performance-review-production-harness.mjs';

let ordinal=0;
export function psqlSession(c,database,label){
 assert.match(database,/^mam_test_pr_[a-z0-9_]+$/);
 const marker=JSON.parse(readFileSync(path.join(c.socket,'owner.json'),'utf8'));
 assert.equal(marker.tcp,false);assert.equal(marker.socket,c.socket);assert.equal(marker.port,c.port);
 const stem=path.join(evidence,`master-session-${++ordinal}-${label}`);
 const p=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'],{env:{...env,PGAPPNAME:label},detached:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',closed=false;
 const pending=[];
 p.stdout.on('data',b=>{stdout+=b.toString();for(const x of pending)if(stdout.includes(x.text))x.resolve();});
 p.stderr.on('data',b=>{stderr+=b.toString();});
 const done=new Promise((resolve,reject)=>{
  p.on('error',reject);p.on('close',(code,signal)=>{closed=true;writeFileSync(stem+'.stdout.log',stdout);writeFileSync(stem+'.stderr.log',stderr);writeFileSync(stem+'.receipt.json',JSON.stringify({pid:p.pid,processGroup:p.pid,database,label,exit:code,signal,closed,classification:'OWNED_SOCKET_ONLY_SYNTHETIC_PSQL'},null,2));resolve({code,signal,stdout,stderr});});
 });
 writeFileSync(stem+'.intent.json',JSON.stringify({pid:p.pid,processGroup:p.pid,database,label,socket:c.socket,port:c.port},null,2));
 writeFileSync(stem+'.sql','');
 function write(sql){appendFileSync(stem+'.sql',sql);p.stdin.write(sql+'\n');}
 return {pid:p.pid,done,write,end(sql=''){if(sql)write(sql);p.stdin.end();},async ready(text){
  if(stdout.includes(text))return;
  let timer;try{await Promise.race([new Promise(resolve=>pending.push({text,resolve})),done.then(r=>{throw Error('psql exited before barrier:'+r.code);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('psql barrier timeout')),5000);})]);}finally{clearTimeout(timer);}
 },async cleanup(){if(!closed){p.kill('SIGKILL');await done;}assert.equal(closed,true);}};
}

export async function waitForOwnedLocks(c,database,labels){
 const deadline=Date.now()+5000;let observed=0;
 while(Date.now()<deadline){
  const literal=labels.map(x=>"'"+x.replaceAll("'","''")+"'").join(',');
  const output=c.sql(database,`select jsonb_build_object('waiters',count(*)) from pg_stat_activity where application_name in (${literal}) and wait_event_type='Lock';`);
  observed=rows(output)[0].waiters;if(observed===labels.length)return observed;
  await new Promise(resolve=>setTimeout(resolve,15));
 }
 throw Error('Owned lock wait was not observed: '+observed);
}
