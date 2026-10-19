import {createHash} from 'node:crypto';

export const TARGET_KEY = 'master-reviews-v1';
export const BINDING_FIELDS = ['namespace','connectionId','driveId','itemId','documentId','parentId','worksheetId','worksheetName','tableId','tableName','headerRow','firstColumn','capacity','columnIds'];
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function closed(raw,keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(raw,key)) || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw,key),'value'))) throw Error('invalid_schema');
  return raw;
}
export function array(raw,length) {
  if (!Array.isArray(raw) || raw.length !== length || Reflect.ownKeys(raw).length !== length+1
    || Array.from({length},(_,i)=>i).some(i => !Object.hasOwn(raw,i) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw,String(i)),'value'))) throw Error('invalid_array');
  return raw;
}
export function bindingFingerprint(binding) { return digest(BINDING_FIELDS.map(key=>binding[key])); }
export function validateBinding(raw) {
  const b=closed(raw,BINDING_FIELDS);
  const handle=value=>typeof value==='string' && /^[A-Za-z0-9!{}_-]{1,256}$/.test(value);
  if (b.namespace!=='mam-performance-master-v1' || b.connectionId!=='46493908-cc6e-4209-b743-0d51abe3937a'
    || !['driveId','itemId','parentId','worksheetId','tableId'].every(k=>handle(b[k])) || !uuid(b.documentId)
    || b.worksheetName!=='Consolidated Reviews' || b.tableName!=='MasterReviews'
    || !Number.isSafeInteger(b.headerRow) || b.headerRow<1 || !Number.isSafeInteger(b.firstColumn) || b.firstColumn<1 || b.firstColumn+52>16384
    || !Number.isSafeInteger(b.capacity) || b.capacity<1 || b.capacity>10000 || b.headerRow+b.capacity>1048576) throw Error('invalid_binding');
  array(b.columnIds,53);
  if (!b.columnIds.every(handle) || new Set(b.columnIds).size!==53) throw Error('invalid_columns');
  return b;
}
export function validateJob(raw,binding) {
  const b=validateBinding(binding);
  const j=closed(raw,['schemaVersion','targetKey','jobId','claimToken','reviewId','revision','projectionSha256','approvedColumnValues','slot','targetFingerprint','reservations']);
  if (j.schemaVersion!==1 || j.targetKey!==TARGET_KEY || ![j.jobId,j.claimToken,j.reviewId].every(uuid)
    || !Number.isSafeInteger(j.revision) || j.revision<1 || !Number.isInteger(j.slot) || j.slot<0 || j.slot>=b.capacity
    || j.targetFingerprint!==bindingFingerprint(b)) throw Error('invalid_job');
  const v=array(j.approvedColumnValues,53);
  const text=value=>typeof value==='string' && value.length<=8000 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/u.test(value);
  if (!v.every((value,i)=>i===15 && Number.isInteger(value) && value>=5 && value<=480 || text(value))
    || v[0]!==j.reviewId || !['MAM','Equipsy'].includes(v[2]) || !/^[0-9]{4}$/.test(v[5])
    || !['Yes','No'].includes(v[9]) || !['Yes','No'].includes(v[12]) || j.projectionSha256!==digest(v)) throw Error('invalid_values');
  const submitted=v[8]!=='';const completed=v[9]==='Yes';const final=v[11]!=='';
  if (!submitted && v.slice(22,34).some(x=>x!=='') || !completed && [v[10],v[20],v[21],...v.slice(34)].some(x=>x!=='') || !final && v[19]!==''
    || final && (!submitted || !completed || v[18]==='' || v[12]!=='Yes')
    || v[3] !== (final?'Submitted':!submitted?'Awaiting Employee':!completed || v[12]==='No'?'Awaiting Manager':'Meeting scheduled')) throw Error('invalid_stage');
  if (!Array.isArray(j.reservations) || j.reservations.length<1 || j.reservations.length>b.capacity) throw Error('invalid_reservations');
  array(j.reservations,j.reservations.length);
  const seenSlots=new Set(),seenIds=new Set();
  for (const r of j.reservations) {
    closed(r,['slot','reviewId']);
    if (!Number.isInteger(r.slot) || r.slot<0 || r.slot>=b.capacity || !uuid(r.reviewId) || seenSlots.has(r.slot) || seenIds.has(r.reviewId)) throw Error('invalid_reservations');
    seenSlots.add(r.slot);seenIds.add(r.reviewId);
  }
  if (!j.reservations.some(r=>r.slot===j.slot && r.reviewId===j.reviewId)) throw Error('missing_reservation');
  return j;
}
