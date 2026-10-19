import {array,validateJob,digest} from './validate-job.mjs';

export function column(n) {
  if (!Number.isInteger(n) || n<1 || n>16384) throw Error('invalid_column');
  let value='';for (;n>0;n=Math.floor((n-1)/26)) value=String.fromCharCode(65+(n-1)%26)+value;
  return value;
}
export function rowRange(job,b) {const row=b.headerRow+job.slot+1;return `${column(b.firstColumn)}${row}:${column(b.firstColumn+52)}${row}`;}
export function excelRequests(job,b) {
  validateJob(job,b);
  const base=`/drives/${encodeURIComponent(b.driveId)}/items/${encodeURIComponent(b.itemId)}`;
  const sheet=`${base}/workbook/worksheets/${encodeURIComponent(b.worksheetId)}`;
  const table=`${sheet}/tables/${encodeURIComponent(b.tableId)}`;
  const range=address=>`${sheet}/range(address='${address}')`;
  return [
    {kind:'item',path:base+'?$select=id,parentReference,sharepointIds'},
    {kind:'sheet',path:sheet+'?$select=id,name'},
    {kind:'table',path:table+'?$select=id,name,showTotals,showHeaders'},
    {kind:'columns',path:table+'/columns?$select=id,name,index&$top=54'},
    {kind:'header',path:table+'/headerRowRange?$select=rowIndex,columnIndex,rowCount,columnCount,values'},
    {kind:'body',path:table+'/dataBodyRange?$select=rowIndex,columnIndex,rowCount,columnCount'},
    {kind:'keys',path:range(`${column(b.firstColumn)}${b.headerRow+1}:${column(b.firstColumn)}${b.headerRow+b.capacity}`)+'?$select=address,rowIndex,columnIndex,rowCount,columnCount,values'},
    {kind:'row',path:range(rowRange(job,b))+'?$select=address,rowIndex,columnIndex,rowCount,columnCount,values,formulas,numberFormat'},
  ].map(r=>({...r,method:'GET'}));
}
export function validateSnapshot(job,b,s,headers,{readback=false}={}) {
  validateJob(job,b);
  if (s.item?.id!==b.itemId || s.item?.parentReference?.driveId!==b.driveId || s.item?.parentReference?.id!==b.parentId
    || s.item?.sharepointIds?.listItemUniqueId!==b.documentId || s.sheet?.id!==b.worksheetId || s.sheet?.name!==b.worksheetName
    || s.table?.id!==b.tableId || s.table?.name!==b.tableName || s.table?.showTotals!==false || s.table?.showHeaders!==true) throw Error('target_drift');
  if (s.columns?.['@odata.nextLink']) throw Error('incomplete_schema');
  const cols=array(s.columns?.value,53);
  if(cols.some((c,i)=>c.id!==b.columnIds[i] || c.name!==headers[i] || c.index!==i)) throw Error('schema_drift');
  const geometry=(r,row,col,height,width)=>r?.rowIndex===row && r?.columnIndex===col && r?.rowCount===height && r?.columnCount===width;
  if (!geometry(s.header,b.headerRow-1,b.firstColumn-1,1,53) || JSON.stringify(array(s.header.values,1)[0])!==JSON.stringify(headers)
    || !geometry(s.body,b.headerRow,b.firstColumn-1,b.capacity,53) || !geometry(s.keys,b.headerRow,b.firstColumn-1,b.capacity,1)
    || !geometry(s.row,b.headerRow+job.slot,b.firstColumn-1,1,53)) throw Error('range_drift');
  const sheet="'"+b.worksheetName.replaceAll("'","''")+"'!";
  if(s.row.address!==sheet+rowRange(job,b) || s.keys.address!==sheet+`${column(b.firstColumn)}${b.headerRow+1}:${column(b.firstColumn)}${b.headerRow+b.capacity}`) throw Error('range_identity');
  const keyRows=array(s.keys.values,b.capacity);const seen=new Set();
  for(let i=0;i<keyRows.length;i++) {
    const key=array(keyRows[i],1)[0];
    if(key==='')continue;
    if(typeof key!=='string' || seen.has(key) || !job.reservations.some(r=>r.slot===i && r.reviewId===key)) throw Error('foreign_or_duplicate_key');
    seen.add(key);
  }
  const values=array(array(s.row.values,1)[0],53),formulas=array(array(s.row.formulas,1)[0],53),formats=array(array(s.row.numberFormat,1)[0],53);
  if (values[0]!==keyRows[job.slot][0] || values[0]!=='' && values[0]!==job.reviewId || values[0]==='' && values.some(v=>v!=='')) throw Error('foreign_slot');
  if (formulas.some((f,i)=>f!=='' && f!==values[i]) || formats.some((f,i)=>f!==(i===15 && typeof job.approvedColumnValues[i]==='number'?'0':'@'))) throw Error('unsafe_cell');
  if (readback && (JSON.stringify(values)!==JSON.stringify(job.approvedColumnValues) || digest(values)!==job.projectionSha256)) throw Error('readback_mismatch');
  return values;
}
export function writePlan(job,b) {
  validateJob(job,b);
  return {method:'PATCH',path:excelRequests(job,b).find(r=>r.kind==='row').path.split('?')[0],body:{values:[job.approvedColumnValues.slice()]}};
}
export function verifyWriteAck(job,b,response) {
  const r=response?.body;
  if (response?.status!==200 || r?.address!=="'"+b.worksheetName.replaceAll("'","''")+"'!"+rowRange(job,b)
    || r.rowIndex!==b.headerRow+job.slot || r.columnIndex!==b.firstColumn-1 || r.rowCount!==1 || r.columnCount!==53
    || JSON.stringify(array(r.values,1)[0])!==JSON.stringify(job.approvedColumnValues)
    || array(array(r.formulas,1)[0],53).some((f,i)=>f!=='' && f!==job.approvedColumnValues[i])
    || array(array(r.numberFormat,1)[0],53).some((f,i)=>f!==(i===15 && typeof job.approvedColumnValues[i]==='number'?'0':'@'))) throw Error('unknown_write');
}
export function exactReceipt(job,b) {return {targetFingerprint:job.targetFingerprint,reviewId:job.reviewId,revision:job.revision,projectionSha256:job.projectionSha256,range:rowRange(job,b),values:job.approvedColumnValues.slice()};}
