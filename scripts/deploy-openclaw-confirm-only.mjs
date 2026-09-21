// Never invoked by tests/imports. Apply requires explicit production authority,
// the MAM credential helper, exact target evidence and the reviewed SQL hash.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const version='20260921150000';
export const name='openclaw_confirm_only';
export const projectId='xtwlrjqbusadghavchqm';
export const organizationId='fwlmbmospuwoaosffvmw';
export const signatures=['public.openclaw_leave_v3_snapshot(text,uuid)','public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text)'];
const requireCondition=(ok,message)=>{if(!ok)throw new Error(message);};
const literal=value=>`'${value.replaceAll("'","''")}'`;
const hash=(algorithm,value)=>createHash(algorithm).update(value).digest('hex');
export const sql=readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`,import.meta.url),'utf8');
export const sha256=hash('sha256',sql);
export function bodyHash(source,signature){
 const start=source.indexOf(`function ${signature.split('(')[0]}(`);
 requireCondition(start>=0,'Function source missing');
 const body=source.slice(start).match(/as \$\$([\s\S]*?)\$\$;/)?.[1];
 requireCondition(typeof body==='string','Function body missing');return hash('md5',body);
}
const prior=readFileSync(new URL('../supabase/migrations/20260920120000_openclaw_quoted_confirm.sql',import.meta.url),'utf8');
const prerequisiteSignatures=['private.openclaw_leave_people()','private.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)'];
const bodies=(source,sigs)=>sigs.map(s=>`(select md5(prosrc) from pg_proc where oid=to_regprocedure(${literal(s)}))=${literal(bodyHash(source,s))}`).join(' and ');
const acl=sigs=>`not exists(select 1 from unnest(array[${sigs.map(literal).join(',')}]) s(signature)
 left join pg_proc p on p.oid=to_regprocedure(s.signature)
 where p.oid is null or not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'],false)
 or has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')
 or has_function_privilege('service_role',p.oid,'execute') is distinct from (s.signature like 'public.%')
 or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))`;
const prerequisite=`exists(select 1 from supabase_migrations.schema_migrations where version='20260920120000') and (${bodies(prior,prerequisiteSignatures)}) and (${acl(prerequisiteSignatures)})`;
const absent=signatures.map(s=>`to_regprocedure(${literal(s)}) is null`).join(' and ');
const valid=`(${bodies(sql,signatures)}) and (${acl(signatures)})`;
export function applyQuery(reviewedHash){
 requireCondition(reviewedHash===sha256,'Reviewed migration hash mismatch');
 requireCondition(sql.startsWith('begin;')&&sql.split('\ncommit;').length===2,'Unexpected transaction structure');
 const guard=`do $mam$ begin if not coalesce((${prerequisite}) and (${absent}),false) then raise exception 'Prerequisite, permissions or existing function drift'; end if; end $mam$;`;
 const record=`insert into supabase_migrations.schema_migrations(version,name,statements) values(${literal(version)},${literal(name)},ARRAY[${literal(sql)}]);`;
 return sql.replace('begin;',()=>`begin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\n${guard}`)
   .replace('\ncommit;',()=>`\n${record}\nnotify pgrst,'reload schema';\ncommit;`);
}
async function main(){
 const operation=process.argv[2];
 requireCondition(['inspect','apply'].includes(operation),'Use inspect or apply <reviewed-sha256>');
 requireCondition(process.env.CODEX_COMPANY_PROFILE==='mam','MAM credential helper required');
 requireCondition(!!process.env.SUPABASE_ACCESS_TOKEN,'Scoped management credential required');
 // Wrong hash fails BEFORE any provider query.
 if(operation==='apply')requireCondition(process.argv[3]===sha256,'Reviewed migration hash mismatch');
 const api=async(path,body)=>{
  const r=await fetch(`https://api.supabase.com/v1/projects/${projectId}${path}`,{method:body?'POST':'GET',
   headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},
   body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
  requireCondition(r.ok,`Management API status ${r.status}`);return r.json();
 };
 const project=await api(''); requireCondition(project.id===projectId&&project.organization_id===organizationId,'MAM target mismatch');
 const query=q=>api('/database/query',{query:q});
 const historyQuery=`select statements from supabase_migrations.schema_migrations where version=${literal(version)}`;
 const historyMatches=rows=>rows.length===1&&rows[0].statements?.length===1&&rows[0].statements[0]===sql;
 const inspect=async()=>({history:await query(historyQuery),state:(await query(`select coalesce((${prerequisite}),false) as prerequisites,
 (${absent}) as absent,coalesce((${valid}),false) as valid`))[0]});
 let {history,state}=await inspect();
 requireCondition(state.prerequisites,'Prerequisite function or permissions drift');
 requireCondition(history.length?historyMatches(history)&&state.valid:state.absent,'Migration/function drift; do not overwrite');
 if(operation==='apply'&&!history.length){
  await query(applyQuery(process.argv[3]));
  ({history,state}=await inspect());
  requireCondition(historyMatches(history)&&state.valid&&state.prerequisites,'Incomplete v3 deployment');
 }
 console.log(JSON.stringify({projectId,organizationId,operation,sha256,recorded:!!history.length,...state}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
