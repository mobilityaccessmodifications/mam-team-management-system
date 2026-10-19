import {validateJob} from './validate-job.mjs';
import {excelRequests,validateSnapshot,writePlan,exactReceipt,verifyWriteAck} from './project-row.mjs';
import schema from './schema.json' with {type:'json'};

export async function runMasterJob(raw,binding,ports,{timeoutMs=25000,readOnly=false}={}) {
  let job;
  try {job=validateJob(raw,binding);} catch {return {status:'invalid_job'};}
  const deadline=Date.now()+timeoutMs;
  async function bounded(operation) {
    let timer;
    try {return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline')),Math.max(0,deadline-Date.now()));})]);}
    finally {clearTimeout(timer);}
  }
  async function snapshot() {
    const result={};
    for(const request of excelRequests(job,binding)) {
      const response=await bounded(()=>ports.read(request));
      if(response?.status!==200) throw Error('read_failed');
      result[request.kind]=response.body;
    }
    return result;
  }
  async function finish(outcome,receipt=null) {
    try {return await bounded(()=>ports.finish(outcome,receipt))===true;}catch{return false;}
  }
  if(readOnly) {
    try {
      const decision=await bounded(()=>ports.reconcile());
      if(decision?.decision!=='read_only')return {status:'hold'};
      validateSnapshot(job,binding,await snapshot(),schema.headers,{readback:true});
      return {status:await finish('verified',exactReceipt(job,binding))?'verified':'hold'};
    }catch{return {status:'hold'};}
  }
  try {validateSnapshot(job,binding,await snapshot(),schema.headers);}catch {
    await finish('prewrite_failed');return {status:'prewrite_failed'};
  }
  let permit;
  try {permit=await bounded(()=>ports.begin());}catch{return {status:'hold'};}
  if(permit!==true)return {status:'hold'};
  let ack;
  try {
    ack=await bounded(()=>ports.patch(writePlan(job,binding)));
    verifyWriteAck(job,binding,ack);
  }catch {await finish('unknown');return {status:'unknown'};}
  try {validateSnapshot(job,binding,await snapshot(),schema.headers,{readback:true});}
  catch {await finish('readback_pending');return {status:'readback_pending'};}
  return {status:await finish('verified',exactReceipt(job,binding))?'verified':'hold'};
}
