import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {sql} from '../../scripts/local-test-postgres.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
export async function runP0ActionBoundary(socket,database,actorId,targetId,only=null,options={}){
 const calls=[],events=[],pins=new Map();let authCalls=0,targetAuthReads=0,targetAuthMutations=0,actorSessionAuthCalls=0;
 const literal=x=>x===null?'null':typeof x==='boolean'?String(x):typeof x==='number'?String(x):"'"+String(x).replaceAll("'","''")+"'";
 const identity=(role)=>`set local role ${role};select set_config('request.jwt.claim.sub',${literal(role==='service_role'?'':actorId)},true);select set_config('request.jwt.claims',jsonb_build_object('sub',${role==='service_role'?'null':literal(actorId)},'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,'role',${literal(role)})::text,true);`;
 function rpc(role){return async(name,args={})=>{
  assert.match(name,/^[a-z][a-z0-9_]*$/);calls.push(name);events.push(name);
  const expression=`public.${name}(${Object.values(args).map(literal).join(',')})`;
  const boolean=name.startsWith('can_')||['claim_portal_account_status_execution','record_portal_account_status_execution'].includes(name);
  try{
   const raw=sql(socket,database,`begin;${identity(role)}${boolean?'select to_jsonb('+expression+');':`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from ${expression} r;`}commit;`).trim().split('\n').at(-1);
   return {data:JSON.parse(raw),error:null};
  }catch(e){return {data:null,error:{code:e.message.match(/ERROR:\s+(\w+):/)?.[1]??'42501',message:'Synthetic database denial'}};}
 };}
 const ok=data=>({data,error:null});
 const client={auth:{getUser:async()=>{actorSessionAuthCalls++;return ok({user:{id:actorId}});}},rpc:rpc('authenticated')};
 const admin={rpc:rpc('service_role'),from(table){
  assert.ok(['profiles','internal_org_people'].includes(table));let fields='*',filters=[],head=false;
  const query={select(columns,options){fields=columns;head=options?.head===true;return query;},eq(column,value){assert.match(column,/^[a-z_]+$/);filters.push(column+'='+literal(value));return query;},
   async single(){return query.read();},async maybeSingle(){return query.read();},async read(){
    const where=filters.length?' where '+filters.join(' and '):'';
    if(head)return {data:null,error:null,count:Number(sql(socket,database,`select count(*) from public.${table}${where};`).trim())};
    assert.match(fields,/^(?:\*|[a-z_,]+)$/);
    const row=sql(socket,database,`select row_to_json(r) from (select ${fields} from public.${table}${where}) r;`).trim();
    return ok(row?JSON.parse(row):null);
   },then(resolve,reject){return query.read().then(resolve,reject);}};return query;
 },auth:{admin:{getUserById:async(id)=>{authCalls++;targetAuthReads++;events.push('target-auth-read');return ok({user:{id,last_sign_in_at:'2026-01-01T00:00:00Z'}});},updateUserById:async(id)=>{authCalls++;targetAuthMutations++;events.push('target-auth-update');return options.providerSuccess?ok({user:{id}}):{data:{user:null},error:{message:'Synthetic provider boundary'}};},createUser:async()=>{authCalls++;targetAuthMutations++;return {data:{user:null},error:{message:'Synthetic provider boundary'}};},deleteUser:async()=>{authCalls++;targetAuthMutations++;return {error:{message:'Synthetic provider boundary'}};}}}};
 const cache=new Map();
 function load(file){
  if(cache.has(file))return cache.get(file).exports;
  const bytes=readFileSync(file);pins.set(file,createHash('sha256').update(bytes).digest('hex'));
  const loaded={exports:{}};cache.set(file,loaded);
  const source=ts.transpileModule(bytes.toString(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',source)((name)=>{
   if(name==='server-only')return {};
   if(name==='next/cache')return {revalidatePath(){}};
   if(name==='@/lib/supabase/admin')return {createAdminClient:()=>admin};
   if(name==='@/lib/supabase/server')return {createClient:async()=>client};
   if(name.startsWith('@/'))return load('src/'+name.slice(2)+'.ts');
   return require(name);
  },loaded,loaded.exports);return loaded.exports;
 }
 const account=load('src/app/accounts/actions.ts'),people=load('src/app/people/actions.ts');
 const currentDate=sql(socket,database,'select current_date;').trim();
 const cases=[
  ['reset',()=>account.resetPortalPassword({personId:targetId,userId:targetId,accountVersion:1,newPassword:'Synthetic-Password-123!',...options.resetInput})],
  ['toggle',()=>account.togglePortalAccount({personId:targetId,userId:targetId,accountVersion:1,enabled:false})],
  ['create',()=>account.createPortalAccount({personId:targetId,accountVersion:1,loginName:'synthetic-p0-create@example.test',newPassword:'Synthetic-Password-123!'})],
  ['archive',()=>people.archiveEmployeeDirectoryRecord({personId:targetId,personVersion:1,detailVersion:1,endDate:currentDate,reason:'Other'})],
 ];
 const results=[];
 for(const [name,run] of cases.filter(([name])=>!only||name===only)){
  const before={authCalls,targetAuthReads,targetAuthMutations,actorSessionAuthCalls};let rejected=false,account,hasOneTimePassword=false;
  try{const result=await run();rejected=result?.ok===false||Boolean(result?.error);account=result?.account;hasOneTimePassword=typeof result?.oneTimePassword==='string';}catch{rejected=true;}
  const counts={authCalls:authCalls-before.authCalls,targetAuthReads:targetAuthReads-before.targetAuthReads,targetAuthMutations:targetAuthMutations-before.targetAuthMutations,actorSessionAuthCalls:actorSessionAuthCalls-before.actorSessionAuthCalls};
  results.push({name,rejected,...counts,account,hasOneTimePassword,passed:rejected&&counts.authCalls===0});
 }
 for(const [file,sha]of pins)assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),sha,'Actual action dependency remained frozen');
 return {results,calls,events,authCalls,targetAuthReads,targetAuthMutations,actorSessionAuthCalls,pins:Object.fromEntries(pins)};
}
