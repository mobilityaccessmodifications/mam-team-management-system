import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
const require = createRequire(import.meta.url);
export function load(file, imports) {
  const ts = require('typescript'), mod = { exports: {} };
  new Function('require','module','exports',ts.transpileModule(readFileSync(file,'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(id => { if (!(id in imports)) throw new Error(id); return imports[id]; },mod,mod.exports);
  return mod.exports;
}
const phone=load('src/lib/openclaw-allowlist.ts',{'server-only':{},'node:crypto':crypto,'libphonenumber-js/max':require('libphonenumber-js/max')});
const priority=load('src/lib/leave-priority.ts',{});
export const notice=load('src/lib/leave-notice.ts',{'@/lib/leave-priority':priority});
export const api=load('src/lib/openclaw-leave-contract.ts',{'server-only':{},'node:crypto':crypto,'./openclaw-allowlist':phone,'./leave-notice':notice});
export const config={key:'synthetic-only-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',account:'mam-test'};
export const now=Date.parse('2026-09-21T01:00:00Z');
export const employee=()=>({personId:'10000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000001',
  company:'mam',active:true,nodeKind:'person',accountActive:true,phone:'0400000001',country:'Australia',fullName:'Synthetic Employee',employmentType:'full_time'});
export const input=()=>({leaveType:'Annual leave',startDate:'2026-10-12',endDate:'2026-10-12',employeeNote:''});
export function fixture(customStore) {
  let rows=[employee()], reads=0, writes=0, sequence=0;
  const receipts=new Map(), nonces=new Map();
  const store=customStore??{
    async snapshot(key,id) { reads++; return {complete:true,rows:structuredClone(rows),fingerprint:'a'.repeat(64),receipt:receipts.get(key)??null,submitted:nonces.get(id)??null}; },
    async submit(p) {
      writes++;
      if(receipts.has(p.key))return receipts.get(p.key).result;
      const result=nonces.get(p.draft.id)?.result??{requestId:crypto.randomUUID(),status:'Pending'};
      nonces.set(p.draft.id,{...p.draft,tokenHash:p.tokenHash,result});
      const body={code:'submitted',...result};
      receipts.set(p.key,{fingerprint:p.fingerprint,personId:p.employee.personId,userId:p.employee.userId,result:body});
      return body;
    },
  };
  const packet=(operation,payload,extra={})=>({version:3,account:config.account,channel:'whatsapp',sender:'+61400000001',session:'synthetic',eventId:`event-${++sequence}`,operation,payload,...extra});
  const call=(p,time=now,secret=config.key)=>{
    const raw=JSON.stringify(p),ts=String(time),sig=crypto.createHmac('sha256',secret).update(`POST\n${api.LEAVE_BRIDGE_PATH}\n${ts}\n${raw}`).digest('hex');
    return api.handleLeaveBridge(raw,ts,sig,config,store,time);
  };
  const ready=async()=>{
    const prepared=await call(packet('prepare',input()));
    return {prepared,confirm:packet('confirm',{draftToken:prepared.body.draftToken,shownMessageId:'provider-1',replyToMessageId:null,text:'Confirm'})};
  };
  return {call,packet,ready,setRows:r=>{rows=r;},reads:()=>reads,writes:()=>writes,receipts,nonces};
}
