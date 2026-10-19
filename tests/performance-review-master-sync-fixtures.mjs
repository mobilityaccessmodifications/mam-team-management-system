import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
export const binding={namespace:'mam-performance-master-v1',connectionId:'46493908-cc6e-4209-b743-0d51abe3937a',driveId:'synthetic-drive',itemId:'synthetic-item',documentId:'92000000-0000-4000-8000-000000000001',parentId:'synthetic-parent',worksheetId:'synthetic-sheet',worksheetName:'Consolidated Reviews',tableId:'synthetic-table',tableName:'MasterReviews',headerRow:6,firstColumn:3,capacity:8,columnIds:Array.from({length:53},(_,i)=>String(i+1))};
export const values=()=>{const v=Array(53).fill('');Object.assign(v,{0:'10000000-0000-4000-8000-000000000001',1:'Synthetic Employee',2:'MAM',3:'Awaiting Employee',4:'Minor',5:'2026',6:'Synthetic role',7:'Synthetic Manager',9:'No',12:'No'});return v;};
export function fixture(){
 const schema=require('../deploy/n8n/performance-review-master-sync-v1/schema.json');
 const v=values(); const fingerprint=createHash('sha256').update(JSON.stringify(Object.values(binding))).digest('hex');
 const job={schemaVersion:1,targetKey:'master-reviews-v1',jobId:'20000000-0000-4000-8000-000000000001',claimToken:'30000000-0000-4000-8000-000000000001',reviewId:v[0],revision:1,projectionSha256:createHash('sha256').update(JSON.stringify(v)).digest('hex'),approvedColumnValues:v,slot:0,targetFingerprint:fingerprint,reservations:[{slot:0,reviewId:v[0]}]};
 const blank=()=>Array(53).fill('');
 const state={row:blank(),formulas:blank(),formats:Array(53).fill('@'),keys:Array(8).fill(''),writes:[],reads:[],finishes:[],begins:0};
 const meta={item:{id:binding.itemId,parentReference:{id:binding.parentId,driveId:binding.driveId},sharepointIds:{listItemUniqueId:binding.documentId}},sheet:{id:binding.worksheetId,name:binding.worksheetName},table:{id:binding.tableId,name:binding.tableName,showTotals:false,showHeaders:true},columns:{value:schema.headers.map((name,i)=>({id:binding.columnIds[i],name,index:i}))},header:{rowIndex:5,columnIndex:2,rowCount:1,columnCount:53,values:[schema.headers]},body:{rowIndex:6,columnIndex:2,rowCount:8,columnCount:53}};
 const ports={
  async read(req){state.reads.push(req);const b=req.kind==='keys'?{address:"'Consolidated Reviews'!C7:C14",rowIndex:6,columnIndex:2,rowCount:8,columnCount:1,values:state.keys.map(k=>[k])}:req.kind==='row'?{address:"'Consolidated Reviews'!C7:BC7",rowIndex:6,columnIndex:2,rowCount:1,columnCount:53,values:[state.row.slice()],formulas:[state.formulas.slice()],numberFormat:[state.formats.slice()]}:structuredClone(meta[req.kind]);return {status:200,body:b};},
  async begin(){state.begins++;return true;},
  async patch(req){state.writes.push(req);state.row=req.body.values[0].slice();state.keys[0]=state.row[0];return {status:200,body:{address:"'Consolidated Reviews'!C7:BC7",rowIndex:6,columnIndex:2,rowCount:1,columnCount:53,values:[state.row.slice()],formulas:[state.formulas.slice()],numberFormat:[state.formats.slice()]}};},
  async finish(outcome,receipt){state.finishes.push({outcome,receipt});return true;},
 };
 return {job,binding:structuredClone(binding),state,meta,ports};
}
