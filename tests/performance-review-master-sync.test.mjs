import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const workerUrl=new URL('../deploy/n8n/performance-review-master-sync-v1/classify-result.mjs',import.meta.url);
const adapter=existsSync(workerUrl)?require(workerUrl.pathname):{};

import {fixture} from './performance-review-master-sync-fixtures.mjs';

for(const [name,mutate] of [
 ['duplicate key',f=>{f.state.keys[0]=f.job.reviewId;f.state.keys[1]=f.job.reviewId;}],
 ['unknown canonical UUID',f=>{f.state.keys[2]='90000000-0000-4000-8000-000000000001';}],
 ['foreign occupied slot',f=>{f.state.row[1]='do not overwrite';}],
 ['moved parent',f=>{f.meta.item.parentReference.id='foreign';}],
 ['wrong drive',f=>{f.meta.item.parentReference.driveId='foreign';}],
 ['different document',f=>{f.meta.item.sharepointIds.listItemUniqueId='90000000-0000-4000-8000-000000000002';}],
 ['column reorder',f=>{[f.meta.columns.value[1],f.meta.columns.value[2]]=[f.meta.columns.value[2],f.meta.columns.value[1]];}],
 ['extra column',f=>{f.meta.columns.value.push({id:'54',name:'foreign',index:53});}],
 ['partial columns',f=>{f.meta.columns['@odata.nextLink']='unread';}],
 ['totals row',f=>{f.meta.table.showTotals=true;}],
 ['range offset drift',f=>{f.meta.body.columnIndex=0;}],
 ['capacity drift',f=>{f.meta.body.rowCount=9;}],
 ['unproved text format',f=>{f.state.formats[1]='General';}],
 ['foreign formula',f=>{f.state.formulas[1]='=1+1';}],
])test('pre-dispatch '+name+' holds without entering a writer',async()=>{
 const f=fixture();mutate(f);const result=await adapter.runMasterJob(f.job,f.binding,f.ports);
 assert.equal(result.status,'prewrite_failed');assert.equal(f.state.begins,0);assert.equal(f.state.writes.length,0);assert.equal(f.state.finishes[0].outcome,'prewrite_failed');
});

for(const [name,mutate] of [
 ['private note',f=>Object.defineProperty(f.job,'managerNote',{enumerable:true,get(){throw Error('private read');}})],
 ['symbol extra',f=>{f.job[Symbol('extra')]=true;}],
 ['arbitrary URL',f=>{f.binding.itemId='https://example.invalid';}],
 ['foreign identity',f=>{f.binding.connectionId='10000000-0000-4000-8000-000000000002';}],
 ['draft disclosure',f=>{f.job.approvedColumnValues[22]='draft';f.job.projectionSha256=createHash('sha256').update(JSON.stringify(f.job.approvedColumnValues)).digest('hex');}],
 ['wrong content hash',f=>{f.job.projectionSha256='0'.repeat(64);}],
])test('closed job rejects '+name+' before any transport',async()=>{
 const f=fixture();mutate(f);assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports)).status,'invalid_job');assert.equal(f.state.reads.length,0);assert.equal(f.state.writes.length,0);assert.equal(f.state.finishes.length,0);
});

test('malformed successful PATCH acknowledgement is sticky unknown even when a later GET would match',async()=>{
 const f=fixture();const patch=f.ports.patch;f.ports.patch=async req=>{const ack=await patch(req);ack.body.address="'Foreign'!A1:BA1";return ack;};
 assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports)).status,'unknown');assert.equal(f.state.writes.length,1);assert.equal(f.state.reads.length,8);assert.equal(f.state.finishes.at(-1).outcome,'unknown');
});

test('known write with readback failure settles only by GET-only reconciliation',async()=>{
 const f=fixture();let afterWrite=false;const patch=f.ports.patch,read=f.ports.read;
 f.ports.patch=async req=>{const ack=await patch(req);afterWrite=true;return ack;};
 f.ports.read=async req=>{if(afterWrite)throw Error('read unavailable');return read(req);};
 assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports)).status,'readback_pending');assert.equal(f.state.writes.length,1);
 f.ports.read=read;f.ports.reconcile=async()=>({decision:'read_only'});
 assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports,{readOnly:true})).status,'verified');assert.equal(f.state.writes.length,1);
 f.ports.reconcile=async()=>({decision:'hold'});const before=f.state.reads.length;
 assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports,{readOnly:true})).status,'hold');assert.equal(f.state.reads.length,before);assert.equal(f.state.writes.length,1);
});

test('entered never-settling write reaches bounded unknown without a second PATCH or implicit release',async()=>{
 const f=fixture();f.ports.patch=async req=>{f.state.writes.push(req);return new Promise(()=>{});};
 assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports,{timeoutMs:25})).status,'unknown');assert.equal(f.state.writes.length,1);
 f.ports.reconcile=async()=>({decision:'hold'});assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports,{readOnly:true})).status,'hold');assert.equal(f.state.writes.length,1);
});

test('date/time type coercion is not silently normalized during readback',async()=>{
 const f=fixture();f.job.approvedColumnValues[8]='2026-10-19T00:00:00.000000Z';f.job.approvedColumnValues[3]='Awaiting Manager';f.job.projectionSha256=createHash('sha256').update(JSON.stringify(f.job.approvedColumnValues)).digest('hex');
 const read=f.ports.read;f.ports.read=async req=>{const r=await read(req);if(f.state.writes.length && req.kind==='row')r.body.values[0][8]=46314;return r;};
 assert.equal((await adapter.runMasterJob(f.job,f.binding,f.ports)).status,'readback_pending');assert.equal(f.state.writes.length,1);assert.equal(f.state.finishes.at(-1).outcome,'readback_pending');
});

for(const prefix of ['=','+','-','@'])test('authorized 53-column literal '+prefix+' job writes once and settles exact values',async()=>{
 assert.equal(typeof adapter.runMasterJob,'function','real Excel worker must exist');
 const f=fixture(); f.job.approvedColumnValues[1]=prefix+'literal 🦽\nline';
 f.job.projectionSha256=createHash('sha256').update(JSON.stringify(f.job.approvedColumnValues)).digest('hex');
 const result=await adapter.runMasterJob(f.job,f.binding,f.ports);
 assert.equal(result.status,'verified');assert.equal(f.state.begins,1);assert.equal(f.state.writes.length,1);
 assert.equal(f.state.writes[0].method,'PATCH');assert.match(f.state.writes[0].path,/C7:BC7/);
 assert.deepEqual(f.state.row,f.job.approvedColumnValues);assert.deepEqual(f.state.formulas,Array(53).fill(''));
 assert.deepEqual(f.state.finishes,[{outcome:'verified',receipt:{targetFingerprint:f.job.targetFingerprint,reviewId:f.job.reviewId,revision:1,projectionSha256:f.job.projectionSha256,range:'C7:BC7',values:f.job.approvedColumnValues}}]);
});
