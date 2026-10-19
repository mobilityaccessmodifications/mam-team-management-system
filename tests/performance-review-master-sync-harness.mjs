import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'next/server.js';
import {binding} from './performance-review-master-sync-fixtures.mjs';
const require=createRequire(import.meta.url);
export const app='https://mam-team-management-system-ten.vercel.app';
export const secret='synthetic_master_secret_012345678901234567890123456789';
export function harness({rpc,mode='live',target={enabled:true,singleWriterAdmitted:true,binding},env={}}={}) {
 const calls=[],retries=[],counts={claims:0,client:0,config:0},logs=[];
 const sources=['src/lib/performance-review-master-sync.ts','src/app/api/performance-reviews/master-sync/route.ts','src/proxy.ts','src/lib/sandbox-safety.ts'];
 const cache=new Map();
 function load(file) {
  if(cache.has(file))return cache.get(file).exports;
  if(!existsSync(file))return {};
  assert.ok(sources.includes(file),file);
  const mod={exports:{}};cache.set(file,mod);
  const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,resolveJsonModule:true}}).outputText;
  new Function('require','module','exports','process','console',compiled)(id=>{
   if(id==='server-only')return {};
   if(id==='next/server')return {NextResponse};
   if(id==='@supabase/ssr')return {createServerClient(){counts.client++;return {auth:{async getClaims(){counts.claims++;return {data:{claims:null}};}}};}};
   if(id==='@/lib/supabase/config')return {isSupabaseConfigured(){counts.config++;return true;},requireSupabaseConfig(){return {supabaseUrl:'http://127.0.0.1:1',supabasePublishableKey:'synthetic'};}};
   if(id==='@/lib/asset-qr')return {assetLoginReturnPath:()=>null};
   if(id==='@/lib/supabase/admin')return {createAdminClient(){counts.client++;return {rpc(name,args){calls.push({name,args});const operation=Promise.resolve().then(()=>{if(!rpc)throw Error('unexpected_sql');return rpc(name,args);});operation.retry=x=>{retries.push(x);return operation;};operation.abortSignal=()=>operation;return operation;}};}};
   if(id.includes('performance-review-master-sync-v1/target.json'))return structuredClone(target);
   if(id.includes('performance-review-master-sync-v1/validate-job.mjs'))return require('../deploy/n8n/performance-review-master-sync-v1/validate-job.mjs');
   if(id.startsWith('@/'))return load('src/'+id.slice(2)+'.ts');
   if(id==='node:crypto')return require(id);
   throw Error('closed_import:'+id);
  },mod,mod.exports,{env:{PERFORMANCE_REVIEW_MASTER_SYNC_MODE:mode,MAM_N8N_PERFORMANCE_MASTER_SYNC_SECRET:secret,NEXT_PUBLIC_APP_URL:app,...env}},Object.fromEntries(['log','error','warn','info'].map(k=>[k,(...args)=>logs.push(args)])));
  return mod.exports;
 }
 return {calls,retries,counts,logs,load,route:()=>load(sources[1]),async handle(request){const p=await load('src/proxy.ts').proxy(new NextRequest(request.clone()));return p.headers.get('x-middleware-next')==='1'?load(sources[1])[request.method](request):p;}};
}
export function request(body,{key=secret,path='/api/performance-reviews/master-sync',headers={},raw=false}={}) {
 return new Request(app+path,{method:'POST',headers:{'X-MAM-Performance-Master-Secret':key,'Content-Type':'application/json',...headers},body:raw?body:JSON.stringify(body)});
}
