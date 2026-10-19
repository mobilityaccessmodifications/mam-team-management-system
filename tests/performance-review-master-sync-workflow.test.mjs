import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fixture,binding} from './performance-review-master-sync-fixtures.mjs';
const require=createRequire(import.meta.url);
const builder='scripts/build-performance-review-master-sync-workflow.py';
function build(target){
 assert.ok(existsSync(builder),'independent Master workflow builder must exist');
 const dir=mkdtempSync(path.join(os.tmpdir(),'master-graph-'));const file=path.join(dir,'target.json');
 writeFileSync(file,JSON.stringify(target));const r=spawnSync('python3',['-B',builder,'--target',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
function executeCode(node,input,results){const f=new Function('$input','$','require',node.parameters.jsCode);return f({first:()=>({json:input})},name=>({first:()=>({json:results.get(name)})}),id=>{assert.equal(id,'crypto');return require('node:crypto');})[0].json;}
export async function runGraph(graph,io){
 const nodes=new Map(graph.nodes.map(n=>[n.name,n])),results=new Map();let current='Initialise',input={};let steps=0;
 while(current){assert.ok(++steps<100);const n=nodes.get(current);let branch=0;
  if(n.type.endsWith('.code'))input=executeCode(n,input,results);
  else if(n.type.endsWith('.if')){const cond=n.parameters.conditions.conditions[0];const name=/\$json\.(\w+)/.exec(cond.leftValue)[1];branch=input[name]===true?0:1;}
  else if(n.type.endsWith('.httpRequest'))input=await io(n,input,results);
  else throw Error('unexpected node');
  results.set(current,input);current=graph.connections[current]?.main?.[branch]?.[0]?.node;
 }
 return {result:input,results,steps};
}
test('independent Master-only generated graph executes its own positive Code/HTTP continuation and settles',async()=>{
 const graph=build({enabled:true,singleWriterAdmitted:true,binding});const f=fixture();
 const {result}=await runGraph(JSON.parse(JSON.stringify(graph)),async(n,input,results)=>{
  if(n.name==='Claim')return {statusCode:200,body:{ok:true,jobs:[f.job]}};
  if(n.name==='Begin')return {statusCode:200,body:{ok:true,allowed:await f.ports.begin()}};
  if(n.name==='Patch Row'){const r=await f.ports.patch(results.get('Plan').write);return {statusCode:r.status,body:r.body};}
  if(n.name==='Finish'){const r=await f.ports.finish(input.finishBody.outcome,input.finishBody.receipt);return {statusCode:200,body:{ok:true,recorded:r}};}
  const kind=n.name.split(' ').at(-1);const req=results.get('Validate Claim').reads.find(r=>r.kind===kind);const r=await f.ports.read(req);return {statusCode:r.status,body:r.body};
 });
 assert.equal(result.status,'verified');assert.equal(f.state.writes.length,1);assert.equal(graph.active,false);
 assert.ok(graph.nodes.every(n=>n.retryOnFail===false));assert.equal(graph.settings.saveDataSuccessExecution,'none');assert.equal(graph.settings.saveDataErrorExecution,'none');
 const serialized=JSON.stringify(graph);assert.doesNotMatch(serialized,/sendMail|outlook|performance-reviews\/mail|\/events\b|rows\/add/i);
 assert.equal(graph.nodes.filter(n=>n.type.endsWith('.scheduleTrigger')).length,1);
});
test('default sealed target generates a disabled workflow with zero transport calls',async()=>{
 const target=JSON.parse(readFileSync('deploy/n8n/performance-review-master-sync-v1/target.json'));assert.deepEqual(target,{enabled:false,singleWriterAdmitted:false,binding:null});
 const graph=build(target);let calls=0;const {result}=await runGraph(graph,()=>{calls++;throw Error('no transport allowed');});assert.equal(result.status,'disabled');assert.equal(calls,0);
});
