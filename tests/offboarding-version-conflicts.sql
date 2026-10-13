
\set ON_ERROR_STOP on
begin;
set local role postgres;
set local search_path='';
do $$ begin assert current_database() ~ '^mam_test_' and inet_server_addr() is null and current_setting('listen_addresses')=''; end $$;
set local statement_timeout='5s';
set local lock_timeout='1s';
create temporary table vc_params as select
 'a7300000-0000-4000-8000-000000000001'::uuid actor,
 'a7300000-0000-4000-8000-000000000002'::uuid ordinary,
 'a7300000-0000-4000-8000-000000000003'::uuid target,
 'a7300000-0000-4000-8000-000000000004'::uuid child,
 'a7300000-0000-4000-8000-000000000005'::uuid ancestor,
 'a7300000-0000-4000-8000-000000000006'::uuid p0,gen_random_uuid() executor;
grant select on vc_params to authenticated,service_role;
insert into auth.users(id,email,email_confirmed_at) select v.id,v.email,clock_timestamp() from vc_params x cross join lateral (values
 (x.actor,'vc-actor@example.test'),(x.ordinary,'vc-ordinary@example.test'),(x.target,'vc-target@example.test'),(x.p0,'vc-p0@example.test')) v(id,email);
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after) select v.id,'Synthetic Version Conflict',v.role,v.login,'active',clock_timestamp()-interval '1 day' from vc_params x cross join lateral (values
 (x.actor,'admin','vc-actor@example.test'),(x.ordinary,'employee','vc-ordinary@example.test'),(x.target,'employee','vc-target@example.test'),(x.p0,'system_admin','vc-p0@example.test')) v(id,role,login);
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active) select v.id,'Synthetic Version Conflict','mam','Synthetic role',v.id,true from vc_params x cross join lateral (values(x.actor),(x.ordinary),(x.target),(x.p0)) v(id);
insert into public.internal_org_people(id,node_kind,full_name,company_key,position_title,is_active,parent_id)
 select x.ancestor,'org_unit',null,'mam','Synthetic ancestor',true,null from vc_params x
 union all select x.child,'person','Synthetic child','mam','Synthetic role',true,x.target from vc_params x;
update public.internal_org_people set parent_id=(select ancestor from vc_params) where id=(select target from vc_params);
insert into private.employee_directory_details(person_id,first_name,employment_type,team_name) select v.id,'Synthetic','full_time','Major' from vc_params x cross join lateral (values(x.actor),(x.ordinary),(x.target),(x.child),(x.p0)) v(id);
create temporary table vc_versions as select p.version pv,d.version dv from vc_params x join public.internal_org_people p on p.id=x.target join private.employee_directory_details d on d.person_id=x.target;
grant select on vc_versions to authenticated;
create function pg_temp.vc_actor(p_ordinary boolean default false) returns void language plpgsql as $$
declare a uuid; r text;
begin
 select case when p_ordinary then x.ordinary else x.actor end into a from vc_params x;
 select app_role into r from public.profiles where id=a;
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,'app_metadata',jsonb_build_object('org_role',r))::text,true);
end $$;

reset role;
create function pg_temp.vc_data_frame() returns jsonb language plpgsql security definer set search_path='' as $$
declare x record; h text; n bigint; rows jsonb:='{}'::jsonb;
begin
 for x in select ns.nspname,c.relname,c.oid from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where c.relkind in ('r','p') and ns.nspname !~ '^pg_' and ns.nspname<>'information_schema' order by ns.nspname,c.relname loop
  execute format('select count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),''[]''::jsonb)::text,''sha256''),''hex'') from %I.%I t',x.nspname,x.relname) into n,h;
  rows:=rows||jsonb_build_object(x.nspname||'.'||x.relname,jsonb_build_object('count',n,'sha256',h));
 end loop;
 return rows;
end $$;
create function pg_temp.vc_sequence_frame() returns jsonb language plpgsql security definer set search_path='' as $$
declare x record; v jsonb; rows jsonb:='{}'::jsonb;
begin
 for x in select ns.nspname,c.relname from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
  where c.relkind='S' and ns.nspname !~ '^pg_' and ns.nspname<>'information_schema' order by ns.nspname,c.relname loop
  execute format('select jsonb_build_object(''last_value'',s.last_value,''log_cnt'',s.log_cnt,''is_called'',s.is_called) from %I.%I s',x.nspname,x.relname) into v;
  rows:=rows||jsonb_build_object(x.nspname||'.'||x.relname,v);
 end loop;
 return rows;
end $$;
create function pg_temp.vc_security_frame() returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object(
 'database_role_settings',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(s),'arrayText',s.setconfig::text,'dimensions',array_dims(s.setconfig),'cardinality',cardinality(s.setconfig)) order by s.setdatabase,s.setrole),'[]'::jsonb) from pg_db_role_setting s),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'memberships',(select coalesce(jsonb_agg(to_jsonb(r) order by r.oid),'[]'::jsonb) from pg_auth_members r),
 'defaults',(select coalesce(jsonb_agg(to_jsonb(r) order by r.oid),'[]'::jsonb) from pg_default_acl r),
 'schema',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'routines',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'relations',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.oid),'[]'::jsonb) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')
);
$$;
create function pg_temp.vc_frame(phase text) returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object('type','footprint','phase',phase,'data',pg_temp.vc_data_frame(),'sequences',pg_temp.vc_sequence_frame(),
 'securitySha256',encode(extensions.digest(pg_temp.vc_security_frame()::text,'sha256'),'hex'),
 'rpcSources',(select jsonb_object_agg(p.oid::regprocedure::text,encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex')) from pg_proc p where p.oid in ('public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)'::regprocedure,'public.archive_employee_directory_record(uuid,bigint,bigint,date,text)'::regprocedure)));
$$;

create temporary table vc_results(id text primary key,passed boolean not null,result jsonb not null);
grant insert,select on vc_results to authenticated;
create function pg_temp.vc_check(p_id text,p_rpc text,p_target uuid,p_pv bigint,p_dv bigint,p_state text,p_message text default null) returns jsonb language plpgsql set search_path='' as $$
declare s text;m text;c text;v boolean;before jsonb;after jsonb;result jsonb;
begin
 before:=pg_temp.vc_frame('before')-'phase';
 begin
  if p_rpc='preflight' then
   v:=public.preflight_employee_removal_reporting_splice(p_target,p_pv,p_dv,date '2026-10-12','Other');
  elsif p_rpc='archive' then
   perform * from public.archive_employee_directory_record(p_target,p_pv,p_dv,date '2026-10-12','Other');
  else raise exception 'Unknown fixture RPC';end if;
 exception when others then
  get stacked diagnostics s=returned_sqlstate,m=message_text,c=pg_exception_context;
 end;
 after:=pg_temp.vc_frame('after')-'phase';
 result:=jsonb_build_object('id',p_id,'sqlstate',s,'message',m,'context',c,'boolean',v,'currentRole',current_user,'authRole',auth.role(),'footprintExact',before=after,'expectedState',p_state);
 insert into vc_results values(p_id,(p_state is null and s is null and v is true or s=p_state and (p_message is null or m=p_message)) and before=after,result);
 return result;
end $$;
select pg_temp.vc_actor();
set local role authenticated;
do $$ begin assert public.can_manage_employee_directory(); end $$;
select pg_temp.vc_check('healthy_preflight','preflight',(select target from vc_params),(select pv from vc_versions),(select dv from vc_versions),null);
select pg_temp.vc_check('preflight_person_stale','preflight',(select target from vc_params),(select pv+5 from vc_versions),(select dv from vc_versions),'PT409','This employee changed since it was opened. Refresh and try again.');
select pg_temp.vc_check('preflight_detail_stale','preflight',(select target from vc_params),(select pv from vc_versions),(select dv+5 from vc_versions),'PT409','This employee detail changed since it was opened. Refresh and try again.');
select pg_temp.vc_check('archive_person_stale','archive',(select target from vc_params),(select pv+5 from vc_versions),(select dv from vc_versions),'PT409','This employee changed since it was opened. Refresh and try again.');
select pg_temp.vc_check('archive_detail_stale','archive',(select target from vc_params),(select pv from vc_versions),(select dv+5 from vc_versions),'PT409','This employee detail changed since it was opened. Refresh and try again.');
reset role;
select pg_temp.vc_actor(true);
set local role authenticated;
select pg_temp.vc_check('ordinary_preflight','preflight',(select target from vc_params),(select pv from vc_versions),(select dv from vc_versions),'42501');
select pg_temp.vc_check('ordinary_archive','archive',(select target from vc_params),(select pv from vc_versions),(select dv from vc_versions),'42501');
reset role;
select pg_temp.vc_actor();
set local role authenticated;
select pg_temp.vc_check('self_preflight','preflight',(select actor from vc_params),1,1,'42501');
select pg_temp.vc_check('self_archive','archive',(select actor from vc_params),1,1,'42501');
select pg_temp.vc_check('p0_preflight','preflight',(select p0 from vc_params),1,1,'42501');
select pg_temp.vc_check('p0_archive','archive',(select p0 from vc_params),1,1,'42501');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
set local role authenticated;
select pg_temp.vc_check('unauthenticated_preflight','preflight',(select target from vc_params),(select pv from vc_versions),(select dv from vc_versions),'42501');
select pg_temp.vc_check('unauthenticated_archive','archive',(select target from vc_params),(select pv from vc_versions),(select dv from vc_versions),'42501');
reset role;
select pg_temp.vc_actor();
savepoint claimed_stale;
set local role authenticated;
create temporary table vc_claim as select * from public.begin_portal_account_status_change((select target from vc_params),(select target from vc_params),false,1);
grant select on vc_claim to postgres,service_role;
set local role postgres;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$ begin
 assert public.claim_portal_account_status_execution((select target from vc_params),(select change_token from vc_claim),(select actor from vc_params),(select executor from vc_params))='execute';
 assert public.record_portal_account_status_execution((select target from vc_params),(select change_token from vc_claim),(select executor from vc_params),true);
end $$;
set local role postgres;
select pg_temp.vc_actor();
set local role authenticated;
select pg_temp.vc_check('acknowledged_receipt_archive_person_stale','archive',(select target from vc_params),(select pv+5 from vc_versions),(select dv from vc_versions),'PT409','This employee changed since it was opened. Refresh and try again.');
select pg_temp.vc_check('acknowledged_receipt_archive_detail_stale','archive',(select target from vc_params),(select pv from vc_versions),(select dv+5 from vc_versions),'PT409','This employee detail changed since it was opened. Refresh and try again.');
reset role;
select jsonb_build_object('id','pending_synthetic_receipt_control','passed',c.status='pending' and c.provider_status='succeeded' and c.claimed_by=x.actor and c.person_id=x.target and not c.requested_enabled and p.is_active and f.account_status='active' and f.account_version=1,'providerClass','SQL_SYNTHETIC_RECEIPT_NOT_AUTH_BAN') from vc_params x join private.portal_account_status_change_claims c on c.auth_user_id=x.target join public.internal_org_people p on p.id=x.target join public.profiles f on f.id=x.target;
select jsonb_build_object('type','summary','caseCount',count(*),'pass',count(*) filter(where passed),'fail',count(*) filter(where not passed),'cases',jsonb_agg(jsonb_build_object('id',id,'passed',passed,'result',result) order by id)) from vc_results;
do $$ begin assert (select count(*)=15 and bool_and(passed) from vc_results),'Expected exact finite stale-version response/unchanged controls';end $$;
rollback;
