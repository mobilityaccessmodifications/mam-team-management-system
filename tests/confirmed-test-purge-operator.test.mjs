import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
const source='src/app/api/admin/confirmed-test-purge/route.ts';
let POST;
if(existsSync(source)) {
 const result=await build({entryPoints:[source],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'operator-test',setup(b){
 b.onResolve({filter:/confirmed-test-purge\/actions$/},()=>({path:'action',namespace:'test'}));
 b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export async function confirmedTestIdentityPurge(input) { globalThis.__purgeCalls.push(input); return {phase:"complete",id:"synthetic-receipt"}; }'}));
 }}]});
 POST=(await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).POST;
}
test('operator POST: same-origin bounded request reaches the independently authenticated action',async()=>{
 assert.equal(typeof POST,'function','Missing supported operator endpoint'); globalThis.__purgeCalls=[];
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:JSON.stringify({mode:'preview'})}));
 assert.equal(r.status,200); assert.deepEqual(globalThis.__purgeCalls,[{mode:'preview'}]);
});
test('operator POST: cross-origin requests never invoke the action',async()=>{
 globalThis.__purgeCalls=[];
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',headers:{origin:'https://attacker.test','content-type':'application/json'},body:'{}'}));
 assert.equal(r.status,403); assert.equal(globalThis.__purgeCalls.length,0);
});
test('operator POST: oversized body never invokes the action',async()=>{
 globalThis.__purgeCalls=[];
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:'x'.repeat(8193)}));
 assert.equal(r.status,413); assert.equal(globalThis.__purgeCalls.length,0);
});
test('operator POST: streaming limit cancels without draining arbitrary bytes',async()=>{
 globalThis.__purgeCalls=[]; let pulled=0,cancelled=false;
 const body=new ReadableStream({pull(c){if(++pulled>5)c.close();else c.enqueue(new Uint8Array(4096));},cancel(){cancelled=true;}},{highWaterMark:0});
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',duplex:'half',headers:{origin:'https://example.test','content-type':'application/json'},body}));
 assert.equal(r.status,413); assert.equal(cancelled,true); assert.ok(pulled<=3); assert.equal(globalThis.__purgeCalls.length,0);
});
test('operator POST: declared oversized length rejects before reading',async()=>{
 let pulled=0; const body=new ReadableStream({pull(c){pulled++;c.close();}},{highWaterMark:0});
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',duplex:'half',headers:{origin:'https://example.test','content-type':'application/json','content-length':'8193'},body}));
 assert.equal(r.status,413); assert.equal(pulled,0);
});
test('operator POST: byte limit includes multibyte UTF-8',async()=>{
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:JSON.stringify({name:'é'.repeat(4096)})})); assert.equal(r.status,413);
});
test('operator POST: stalled body is cancelled at request deadline',async()=>{
 let cancelled=false; const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}},{highWaterMark:0});
 const request=new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',duplex:'half',headers:{origin:'https://example.test','content-type':'application/json'},body});
 const r=await Promise.race([POST(request),new Promise(r=>setTimeout(()=>r({status:999}),5500))]); assert.equal(r.status,408); assert.equal(cancelled,true);
});
test('operator POST: invalid JSON never invokes the action',async()=>{
 globalThis.__purgeCalls=[];
 const r=await POST(new Request('https://example.test/api/admin/confirmed-test-purge',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:'{'}));
 assert.equal(r.status,400); assert.equal(globalThis.__purgeCalls.length,0);
});
