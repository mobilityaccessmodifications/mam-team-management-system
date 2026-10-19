begin;
set local search_path='';
set local lock_timeout='3s';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
do $master_predecessor$
begin
 if current_setting('server_version_num')::integer/10000 not in (16,17)
   or (select count(*) from private.confirmed_test_purge_schema)<>1
   or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
   or to_regprocedure('private.performance_review_docx_bytes(jsonb)') is null then
   raise exception 'Master requires the captured completion predecessor.' using errcode='55000';
 end if;
end $master_predecessor$;
do $master_locks$
declare item record; total integer:=0;
begin
 for item in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in ('r','p') order by n.nspname,c.relname loop
  total:=total+1; if total>512 then raise exception 'Unbounded Master relation set.' using errcode='55000'; end if;
  execute format('lock table %I.%I in share row exclusive mode nowait',item.nspname,item.relname);
 end loop;
end $master_locks$;
create function pg_temp.master_preserve_catalog() returns jsonb language sql stable set search_path='' as $performance_security$
with feature_base as (select c.oid,c.reltoastrelid from pg_class c where c.oid in(select to_regclass(name) from unnest(array['private.performance_review_master_targets','private.performance_review_master_queue','private.performance_review_master_attempts']::text[]) name)), feature_relations as (
select oid from feature_base union select reltoastrelid from feature_base where reltoastrelid<>0 union select indexrelid from pg_index where indrelid in(select oid from feature_base union select reltoastrelid from feature_base)
), feature_types as (select t.oid from pg_type t where t.typrelid in(select oid from feature_relations) or t.typelem in(select c.reltype from pg_class c where c.oid in(select oid from feature_relations) and c.reltype<>0))
select jsonb_build_object(
  'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
  'role_memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor,m.oid) from pg_auth_members m),
  'role_database_settings',(select jsonb_agg(to_jsonb(s) order by s.setdatabase,s.setrole) from pg_db_role_setting s),
  'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and t.oid not in (select oid from feature_types)),
  'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
  'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w join pg_class c on c.oid=w.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and c.oid not in (select oid from feature_relations)),
  'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and c.oid not in (select oid from feature_relations)),
  'relations',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and c.oid not in (select oid from feature_relations)),
  'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and c.oid not in (select oid from feature_relations)),
  'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and k.conrelid not in (select oid from feature_relations) and not (k.conrelid='private.performance_reviews'::regclass and k.conname='performance_review_master_enqueue' and k.contype='t')),
  'defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and c.oid not in (select oid from feature_relations)),
  'routines',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'
    and not exists(select 1 from (values ('private','performance_review_master_canonical'),('private','performance_review_master_digest'),('private','performance_review_master_fingerprint'),('private','performance_review_master_binding_valid'),('private','performance_review_master_projection'),('private','performance_review_master_enqueue'),('private','performance_review_master_column'),('private','performance_review_master_range'),('public','claim_performance_review_master_sync'),('public','begin_performance_review_master_sync'),('public','finish_performance_review_master_sync'),('public','reconcile_performance_review_master_sync')) f(schema_name,function_name) where f.schema_name=n.nspname and f.function_name=p.proname)),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and c.oid not in (select oid from feature_relations) and not exists(select 1 from pg_constraint k where k.oid=t.tgconstraint and k.conrelid in (select oid from feature_relations)) and not (t.tgrelid='private.performance_reviews'::regclass and t.tgname='performance_review_master_enqueue' and t.tgfoid=to_regprocedure('private.performance_review_master_enqueue()'))),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and i.indexrelid not in (select oid from feature_relations)), 'sequences',(select jsonb_agg(to_jsonb(s) order by s.seqrelid) from pg_sequence s where s.seqrelid not in(select oid from feature_relations)));
$performance_security$;
create function pg_temp.master_preserve_data() returns jsonb language sql stable set search_path='' as $performance_data$
select jsonb_build_object('tables',(select jsonb_object_agg(n.nspname||'.'||c.relname,(xpath('/table/row/hash/text()',query_to_xml(format('select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),''[]'')::text,''sha256''),''hex'') as hash from %I.%I t',n.nspname,c.relname),false,false,'')))[1]::text order by n.nspname,c.relname)
from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in('r','p') and c.oid not in(select to_regclass(name) from unnest(array['private.performance_review_master_targets','private.performance_review_master_queue','private.performance_review_master_attempts']::text[]||array['private.confirmed_test_purge_schema']) name where to_regclass(name) is not null)),'sequences',(select jsonb_object_agg(n.nspname||'.'||c.relname,(xpath('/table/row/value/text()',query_to_xml(format('select jsonb_build_array(last_value,is_called)::text as value from %I.%I',n.nspname,c.relname),false,false,'')))[1]::text order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind='S'));
$performance_data$;
create function pg_temp.master_feature_metadata() returns jsonb language sql stable set search_path='' as $performance_metadata$
select jsonb_build_object(
'functions',(select coalesce(jsonb_object_agg(n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',jsonb_build_object('sha256',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig)),'{}') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where exists(select 1 from(values ('private','performance_review_master_canonical'),('private','performance_review_master_digest'),('private','performance_review_master_fingerprint'),('private','performance_review_master_binding_valid'),('private','performance_review_master_projection'),('private','performance_review_master_enqueue'),('private','performance_review_master_column'),('private','performance_review_master_range'),('public','claim_performance_review_master_sync'),('public','begin_performance_review_master_sync'),('public','finish_performance_review_master_sync'),('public','reconcile_performance_review_master_sync')) f(schema_name,function_name) where n.nspname=f.schema_name and p.proname=f.function_name)),
'relations',(select jsonb_object_agg(target,(select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'kind',c.relkind,'persistence',c.relpersistence,'options',c.reloptions,'replicaIdentity',c.relreplident,'accessMethod',(select amname from pg_am where oid=c.relam),
'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'acl',a.attacl::text,'identity',a.attidentity::text,'generated',a.attgenerated::text,'storage',a.attstorage::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid)) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid=c.oid),
'policies',(select jsonb_agg(to_jsonb(p) order by p.polname) from pg_policy p where p.polrelid=c.oid),
'fkTriggers',(select jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,'function',t.tgfoid::regprocedure::text,'type',t.tgtype,'enabled',t.tgenabled,'constraint',pg_get_constraintdef(t.tgconstraint),'internal',t.tgisinternal,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,'arguments',encode(t.tgargs,'hex'),'name',portable.name,'definition',case when portable.name<>t.tgname then overlay(pg_get_triggerdef(t.oid) placing quote_ident(portable.name) from length('CREATE CONSTRAINT TRIGGER ')+1 for length(quote_ident(t.tgname))) else pg_get_triggerdef(t.oid) end,'when',pg_get_expr(t.tgqual,t.tgrelid),'updateColumns',t.tgattr::text,'argumentCount',t.tgnargs,'constraintName',k.conname,'constraintRelation',nullif(t.tgconstrrelid,0)::regclass::text,'constraintIndex',nullif(t.tgconstrindid,0)::regclass::text,'parent',t.tgparentid::text,'oldTable',t.tgoldtable,'newTable',t.tgnewtable) order by t.tgrelid::regclass::text,t.tgfoid::regprocedure::text,k.conname,portable.name) from pg_trigger t left join pg_constraint k on k.oid=t.tgconstraint cross join lateral (select case when t.tgisinternal and k.contype='f' and t.tgname=('RI_ConstraintTrigger_'||case when t.tgrelid=k.conrelid then 'c' else 'a' end||'_'||t.oid::text) then 'RI_ConstraintTrigger_'||case when t.tgrelid=k.conrelid then 'c' else 'a' end||'_<oid>' else t.tgname::text end as name) portable where t.tgrelid=c.oid or t.tgconstraint in (select k.oid from pg_constraint k where k.conrelid=c.oid))) from pg_class c where c.oid=to_regclass(target))) from unnest(array['private.performance_review_master_targets','private.performance_review_master_queue','private.performance_review_master_attempts']::text[]) target),
'sequences',(select jsonb_object_agg(target,(select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'parameters',jsonb_build_object('type',format_type(s.seqtypid,null),'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle)) from pg_class c join pg_sequence s on s.seqrelid=c.oid where c.oid=to_regclass(target))) from unnest(array[]::text[]) target));
$performance_metadata$;
create temporary table master_preservation_before on commit drop as select pg_temp.master_preserve_catalog() catalog,pg_temp.master_preserve_data() data;
create table private.performance_review_master_targets (
 target_key text primary key check(target_key='master-reviews-v1'),
 enabled boolean not null default false,
 writer_admitted boolean not null default false,
 capture_after timestamptz,
 binding jsonb,
 active_job uuid,
 held boolean not null default false
);
create table private.performance_review_master_queue (
 review_id uuid primary key references private.performance_reviews(id) on delete restrict,
 target_key text not null references private.performance_review_master_targets(target_key) on delete restrict,
 desired_revision bigint not null check(desired_revision>0),
 desired_values jsonb not null check(jsonb_typeof(desired_values)='array' and jsonb_array_length(desired_values)=53),
 desired_sha256 text not null check(desired_sha256 ~ '^[0-9a-f]{64}$'),
 applied_revision bigint not null default 0 check(applied_revision>=0 and applied_revision<=desired_revision),
 slot integer check(slot>=0),
 unique(target_key,slot)
);
create table private.performance_review_master_attempts (
 job_id uuid primary key default gen_random_uuid(),
 review_id uuid not null references private.performance_review_master_queue(review_id) on delete restrict,
 claim_token uuid not null default gen_random_uuid(),
 revision bigint not null check(revision>0),
 projection_sha256 text not null check(projection_sha256 ~ '^[0-9a-f]{64}$'),
 approved_values jsonb not null check(jsonb_typeof(approved_values)='array' and jsonb_array_length(approved_values)=53),
 target_fingerprint text not null check(target_fingerprint ~ '^[0-9a-f]{64}$'),
 slot integer not null check(slot>=0),
 state text not null default 'claimed' check(state in ('claimed','entered','verified','prewrite_failed','readback_pending','unknown')),
 claimed_at timestamptz not null default clock_timestamp(),
 entered_at timestamptz,
 receipt jsonb,
 check((state in ('claimed','prewrite_failed') and entered_at is null) or (state in ('entered','verified','readback_pending','unknown') and entered_at is not null))
);
insert into private.performance_review_master_targets(target_key) values('master-reviews-v1');
alter table private.performance_review_master_targets enable row level security;
alter table private.performance_review_master_targets force row level security;
alter table private.performance_review_master_queue enable row level security;
alter table private.performance_review_master_queue force row level security;
alter table private.performance_review_master_attempts enable row level security;
alter table private.performance_review_master_attempts force row level security;
revoke all on private.performance_review_master_targets,private.performance_review_master_queue,private.performance_review_master_attempts from public,anon,authenticated,service_role;
create trigger reject_retired_test_identity_reference before insert or update on private.performance_review_master_targets for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.performance_review_master_queue for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.performance_review_master_attempts for each row execute function private.reject_retired_test_identity_reference();
create function private.performance_review_master_canonical(p_value jsonb) returns text
language plpgsql immutable strict set search_path='' as $$
begin
 if jsonb_typeof(p_value)='array' then return '['||(select coalesce(string_agg(private.performance_review_master_canonical(value),',' order by ordinal),'') from jsonb_array_elements(p_value) with ordinality v(value,ordinal))||']'; end if;
 if jsonb_typeof(p_value) in ('string','number','boolean','null') then return p_value::text; end if;
 raise exception 'Invalid Master hash shape.' using errcode='22023';
end $$;
create function private.performance_review_master_digest(p_values jsonb) returns text
language sql immutable strict set search_path='' as $$
 select encode(extensions.digest(private.performance_review_master_canonical(p_values),'sha256'),'hex');
$$;
create function private.performance_review_master_fingerprint(p_binding jsonb) returns text
language sql immutable strict set search_path='' as $$
 select private.performance_review_master_digest(jsonb_build_array(p_binding->'namespace',p_binding->'connectionId',p_binding->'driveId',p_binding->'itemId',p_binding->'documentId',p_binding->'parentId',p_binding->'worksheetId',p_binding->'worksheetName',p_binding->'tableId',p_binding->'tableName',p_binding->'headerRow',p_binding->'firstColumn',p_binding->'capacity',p_binding->'columnIds'));
$$;
create function private.performance_review_master_binding_valid(p_binding jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare key_ text; value_ jsonb;
begin
 if not coalesce(private.performance_review_closed(p_binding,array['namespace','connectionId','driveId','itemId','documentId','parentId','worksheetId','worksheetName','tableId','tableName','headerRow','firstColumn','capacity','columnIds']),false) then return false; end if;
 foreach key_ in array array['namespace','connectionId','documentId','worksheetName','tableName'] loop
  if jsonb_typeof(p_binding->key_) is distinct from 'string' then return false; end if;
 end loop;
 if p_binding->>'namespace'<>'mam-performance-master-v1' or p_binding->>'connectionId'<>'46493908-cc6e-4209-b743-0d51abe3937a' or p_binding->>'tableName'<>'MasterReviews' or p_binding->>'worksheetName'<>'Consolidated Reviews' or p_binding->>'documentId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
 foreach key_ in array array['driveId','itemId','parentId','worksheetId','tableId'] loop
  if jsonb_typeof(p_binding->key_)<>'string' or p_binding->>key_ !~ '^[A-Za-z0-9!{}_\-]{1,200}[A-Za-z0-9!{}_\-]{0,56}$' then return false; end if;
 end loop;
 foreach key_ in array array['headerRow','firstColumn','capacity'] loop
  if jsonb_typeof(p_binding->key_)<>'number' or p_binding->>key_ !~ '^[1-9][0-9]{0,6}$' then return false; end if;
 end loop;
 if (p_binding->>'capacity')::integer>10000 or (p_binding->>'headerRow')::integer+(p_binding->>'capacity')::integer>1048576 or (p_binding->>'firstColumn')::integer+52>16384 or jsonb_typeof(p_binding->'columnIds')<>'array' then return false; end if;
 if jsonb_array_length(p_binding->'columnIds')<>53 or (select count(distinct v) from jsonb_array_elements(p_binding->'columnIds') v)<>53 then return false; end if;
 for value_ in select value from jsonb_array_elements(p_binding->'columnIds') loop
  if jsonb_typeof(value_)<>'string' or value_#>>'{}' !~ '^[A-Za-z0-9!{}_\-]{1,200}[A-Za-z0-9!{}_\-]{0,56}$' then return false; end if;
 end loop;
 return true;
exception when others then return false;
end $$;
alter table private.performance_review_master_targets add constraint performance_review_master_binding_closed check(binding is null or private.performance_review_master_binding_valid(binding));
revoke all on function private.performance_review_master_binding_valid(jsonb) from public,anon,authenticated,service_role;
create function private.performance_review_master_projection(p_review private.performance_reviews) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r private.performance_reviews:=p_review; d jsonb; m jsonb; values_ jsonb; i integer; submitted boolean:=r.self_submitted_at is not null; completed boolean:=r.manager_completed_at is not null; final_ boolean:=r.finalised_at is not null;
begin
 d:=case when final_ then r.final_document end;
 if final_ and (not submitted or not completed or r.meeting_held_at is null or d is null) then raise exception 'Incomplete Master final projection.' using errcode='23514'; end if;
 m:=case when final_ then d->'meeting' else r.meeting end;
 values_:=jsonb_build_array(r.id,r.employee_identity->>'name',r.employee_identity->>'company',case when final_ then 'Submitted' when not submitted then 'Awaiting Employee' when not completed or m is null then 'Awaiting Manager' else 'Meeting scheduled' end,r.employee_identity->>'team',r.cycle,r.employee_identity->>'jobTitle',r.manager_identity->>'name',coalesce(to_char(r.self_submitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),''),case when completed then 'Yes' else 'No' end,coalesce(to_char(r.manager_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),''),coalesce(to_char(r.finalised_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),''),case when m is null then 'No' else 'Yes' end,coalesce(m->>'date',''),coalesce(m->>'time',''),coalesce(m->'duration','""'::jsonb),case m->>'mode' when 'in_person' then 'In person' when 'teams' then 'Teams' when 'phone' then 'Phone' else '' end,coalesce(m->>'location',''),case when r.meeting_held_at is not null then coalesce(m->>'date','') else '' end,case when final_ then coalesce(m->>'notes','') else '' end,case when completed then case when final_ then d->>'summary' else r.summary end else '' end,case when completed then case when final_ then d->>'overallRating' else r.overall_rating end else '' end);
 for i in 0..11 loop values_:=values_||jsonb_build_array(case when submitted then case when final_ then d->'selfAnswers'->>i else r.self_answers->>i end else '' end); end loop;
 for i in 0..11 loop values_:=values_||jsonb_build_array(case when completed then case when final_ then d->'managerAnswers'->>i else r.manager_answers->>i end else '' end); end loop;
 foreach i in array array[0,1,2,6,7,8,9] loop values_:=values_||jsonb_build_array(case when completed then case when final_ then d->'ratings'->>i else r.ratings->>i end else '' end); end loop;
 return values_;
end $$;
create function private.performance_review_master_enqueue() returns trigger
language plpgsql volatile security definer set search_path='' as $$
declare t private.performance_review_master_targets%rowtype; r private.performance_reviews%rowtype; v jsonb; h text;
begin
 select * into t from private.performance_review_master_targets where target_key='master-reviews-v1' for update;
 if not t.enabled or t.capture_after is null or clock_timestamp()<t.capture_after then return null; end if;
 select * into r from private.performance_reviews where id=new.id;
 if not found then return null; end if;
 v:=private.performance_review_master_projection(r);
 if tg_op='UPDATE' and (old.finalised_at is null or old.final_document is not null) then
  if private.performance_review_master_projection(old)=v then return null; end if;
 end if;
 h:=private.performance_review_master_digest(v);
 insert into private.performance_review_master_queue(review_id,target_key,desired_revision,desired_values,desired_sha256) values(r.id,t.target_key,1,v,h)
 on conflict(review_id) do update set desired_revision=performance_review_master_queue.desired_revision+1,desired_values=excluded.desired_values,desired_sha256=excluded.desired_sha256
 where performance_review_master_queue.desired_sha256 is distinct from excluded.desired_sha256;
 return null;
end $$;
create constraint trigger performance_review_master_enqueue after insert or update on private.performance_reviews deferrable initially deferred for each row execute function private.performance_review_master_enqueue();
create function private.performance_review_master_column(p_column integer) returns text
language plpgsql immutable strict set search_path='' as $$
declare n integer:=p_column; value_ text:='';
begin
 if n<1 or n>16384 then raise exception 'Invalid Master column.' using errcode='22023'; end if;
 while n>0 loop value_:=chr(65+(n-1)%26)||value_; n:=(n-1)/26; end loop;
 return value_;
end $$;
create function private.performance_review_master_range(p_binding jsonb,p_slot integer) returns text
language sql immutable strict set search_path='' as $$
 select private.performance_review_master_column((p_binding->>'firstColumn')::integer)||((p_binding->>'headerRow')::integer+p_slot+1)::text||':'||private.performance_review_master_column((p_binding->>'firstColumn')::integer+52)||((p_binding->>'headerRow')::integer+p_slot+1)::text;
$$;
create function public.claim_performance_review_master_sync(p_target_key text,p_limit integer default 1) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare t private.performance_review_master_targets%rowtype; q private.performance_review_master_queue%rowtype; a private.performance_review_master_attempts%rowtype; s integer;
begin
 if p_target_key is distinct from 'master-reviews-v1' or p_limit is distinct from 1 then raise exception 'Invalid Master claim.' using errcode='22023'; end if;
 select * into t from private.performance_review_master_targets where target_key=p_target_key for update;
 if not t.enabled or not t.writer_admitted or t.binding is null or t.capture_after is null or clock_timestamp()<t.capture_after or t.held or t.active_job is not null then return '[]'; end if;
 select * into q from private.performance_review_master_queue where target_key=p_target_key and desired_revision>applied_revision order by review_id limit 1 for update;
 if not found then return '[]'; end if;
 s:=q.slot;
 if s is null then
   select n into s from generate_series(0,(t.binding->>'capacity')::integer-1) n where not exists(select 1 from private.performance_review_master_queue occupied where occupied.target_key=p_target_key and occupied.slot=n) order by n limit 1;
   if s is null then raise exception 'Master approved capacity exhausted.' using errcode='55000'; end if;
   update private.performance_review_master_queue set slot=s where review_id=q.review_id;
 end if;
 insert into private.performance_review_master_attempts(review_id,revision,projection_sha256,approved_values,target_fingerprint,slot) values(q.review_id,q.desired_revision,q.desired_sha256,q.desired_values,private.performance_review_master_fingerprint(t.binding),s) returning * into a;
 update private.performance_review_master_targets set active_job=a.job_id where target_key=p_target_key;
 return jsonb_build_array(jsonb_build_object('schemaVersion',1,'targetKey',p_target_key,'jobId',a.job_id,'claimToken',a.claim_token,'reviewId',a.review_id,'revision',a.revision,'projectionSha256',a.projection_sha256,'approvedColumnValues',a.approved_values,'slot',a.slot,'targetFingerprint',a.target_fingerprint,'reservations',(select coalesce(jsonb_agg(jsonb_build_object('slot',r.slot,'reviewId',r.review_id) order by r.slot),'[]') from private.performance_review_master_queue r where r.target_key=p_target_key and r.slot is not null)));
end $$;
create function public.begin_performance_review_master_sync(p_job_id uuid,p_claim_token uuid,p_revision bigint,p_projection_sha256 text,p_target_fingerprint text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare t private.performance_review_master_targets%rowtype; a private.performance_review_master_attempts%rowtype; q private.performance_review_master_queue%rowtype;
begin
 select * into t from private.performance_review_master_targets where target_key='master-reviews-v1' for update;
 select * into a from private.performance_review_master_attempts where job_id=p_job_id for update;
 if not found or a.claim_token is distinct from p_claim_token or a.revision is distinct from p_revision or a.projection_sha256 is distinct from p_projection_sha256 or a.target_fingerprint is distinct from p_target_fingerprint or t.active_job is distinct from p_job_id or a.state<>'claimed' then return false; end if;
 select * into q from private.performance_review_master_queue where review_id=a.review_id;
 if not t.enabled or not t.writer_admitted or t.held or private.performance_review_master_fingerprint(t.binding) is distinct from a.target_fingerprint or q.desired_revision<>a.revision then
   update private.performance_review_master_attempts set state='prewrite_failed' where job_id=a.job_id;
   update private.performance_review_master_targets set active_job=null where target_key=t.target_key;
   return false;
 end if;
 update private.performance_review_master_attempts set state='entered',entered_at=clock_timestamp() where job_id=a.job_id;
 return true;
end $$;
create function public.finish_performance_review_master_sync(p_job_id uuid,p_claim_token uuid,p_revision bigint,p_projection_sha256 text,p_outcome text,p_receipt jsonb) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare t private.performance_review_master_targets%rowtype; a private.performance_review_master_attempts%rowtype; expected jsonb;
begin
 select * into t from private.performance_review_master_targets where target_key='master-reviews-v1' for update;
 select * into a from private.performance_review_master_attempts where job_id=p_job_id for update;
 if not found or a.claim_token is distinct from p_claim_token or a.revision is distinct from p_revision or a.projection_sha256 is distinct from p_projection_sha256 then return false; end if;
 expected:=jsonb_build_object('targetFingerprint',a.target_fingerprint,'reviewId',a.review_id,'revision',a.revision,'projectionSha256',a.projection_sha256,'range',private.performance_review_master_range(t.binding,a.slot),'values',a.approved_values);
 if a.state='verified' then return p_outcome='verified' and p_receipt=a.receipt; end if;
 if t.active_job is distinct from p_job_id then return false; end if;
 if p_outcome='prewrite_failed' and a.state='claimed' and (p_receipt is null or p_receipt='null'::jsonb) then
   update private.performance_review_master_attempts set state='prewrite_failed' where job_id=a.job_id;
   update private.performance_review_master_targets set active_job=null where target_key=t.target_key;
   return true;
 end if;
 if a.state not in ('entered','readback_pending') then return false; end if;
 if p_outcome='verified' and p_receipt=expected and private.performance_review_master_fingerprint(t.binding)=a.target_fingerprint then
   update private.performance_review_master_attempts set state='verified',receipt=p_receipt where job_id=a.job_id;
   update private.performance_review_master_queue set applied_revision=greatest(applied_revision,a.revision) where review_id=a.review_id;
   update private.performance_review_master_targets set active_job=null where target_key=t.target_key;
   return true;
 end if;
 if p_outcome in ('unknown','readback_pending') and (p_receipt is null or p_receipt='null'::jsonb) then
   update private.performance_review_master_attempts set state=p_outcome where job_id=a.job_id;
   update private.performance_review_master_targets set held=(p_outcome='unknown') where target_key=t.target_key;
   return true;
 end if;
 return false;
end $$;
create function public.reconcile_performance_review_master_sync(p_job_id uuid,p_claim_token uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a private.performance_review_master_attempts%rowtype;
begin
 select * into a from private.performance_review_master_attempts where job_id=p_job_id and claim_token=p_claim_token;
 if not found then return jsonb_build_object('decision','denied'); end if;
 return jsonb_build_object('decision',case a.state when 'verified' then 'settled' when 'readback_pending' then 'read_only' else 'hold' end);
end $$;
revoke all on function private.performance_review_master_canonical(jsonb),private.performance_review_master_digest(jsonb),private.performance_review_master_fingerprint(jsonb),private.performance_review_master_projection(private.performance_reviews),private.performance_review_master_enqueue(),private.performance_review_master_column(integer),private.performance_review_master_range(jsonb,integer),public.claim_performance_review_master_sync(text,integer),public.begin_performance_review_master_sync(uuid,uuid,bigint,text,text),public.finish_performance_review_master_sync(uuid,uuid,bigint,text,text,jsonb),public.reconcile_performance_review_master_sync(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_performance_review_master_sync(text,integer),public.begin_performance_review_master_sync(uuid,uuid,bigint,text,text),public.finish_performance_review_master_sync(uuid,uuid,bigint,text,text,jsonb),public.reconcile_performance_review_master_sync(uuid,uuid) to service_role;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
do $master_preservation_final$
declare expected jsonb:=$master_bodies${"private.performance_review_master_canonical(jsonb)":"20ab9df3f73ee745ac61f7c551dc27a2776499ae6ea96ad76a9afac8fbca1d81","private.performance_review_master_digest(jsonb)":"f0f05001a98e5e7c5e7d915aa93ef28f51c0ec3bb344134f2caea9a20b87eb95","private.performance_review_master_fingerprint(jsonb)":"903619f57530ec3c12b5b7345792f2e8ae483bb34f3c985fee18e6603c106d22","private.performance_review_master_binding_valid(jsonb)":"a8c5afc13e07a26fd63b5090b1ba17192a609586233c6aa6935118f5db89ddb2","private.performance_review_master_projection(private.performance_reviews)":"250a5e6dc1d61ccf0b72ceda28d8514ed0910adfab05d3b4bb4068b862a6d530","private.performance_review_master_enqueue()":"dd52dec7aee355b57d10a7d0e967337f406dbe77e2eaa9a699b7c010928ab0a7","private.performance_review_master_column(integer)":"7ec7222dd180a67ca12a5ec11aaa73c6e89412662439472436a8c0a1125a5d22","private.performance_review_master_range(jsonb, integer)":"52a869851c02d18e0df5347f88a6ccab6ae0072db0709be0e82ca9b234986123","public.claim_performance_review_master_sync(text, integer)":"f7ee39c609a72d1e32f3b7631e9d0ee38497cf77d0b7c20203d5011fa8b132a6","public.begin_performance_review_master_sync(uuid, uuid, bigint, text, text)":"d3e35a384df4f49b00fc93dd3a23c19bd02ef866f2947b5283283d067962df41","public.finish_performance_review_master_sync(uuid, uuid, bigint, text, text, jsonb)":"eac5d062bb2ef0052980de21a24f734a0d7c1b0f97affaad66664d8245833310","public.reconcile_performance_review_master_sync(uuid, uuid)":"90e4b835d7ca6a5447294cd4c1b94a6e54ba1cd9b3620c232f2cac97b4868afc"}$master_bodies$::jsonb; actual jsonb;
begin
 if pg_temp.master_preserve_catalog() is distinct from (select catalog from master_preservation_before)
  or pg_temp.master_preserve_data() is distinct from (select data from master_preservation_before)
  or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then raise exception 'Master preservation mismatch.' using errcode='55000'; end if;
 select jsonb_object_agg(n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',encode(extensions.digest(p.prosrc,'sha256'),'hex')) into actual from pg_proc p join pg_namespace n on n.oid=p.pronamespace where exists(select 1 from (values ('private','performance_review_master_canonical'),('private','performance_review_master_digest'),('private','performance_review_master_fingerprint'),('private','performance_review_master_binding_valid'),('private','performance_review_master_projection'),('private','performance_review_master_enqueue'),('private','performance_review_master_column'),('private','performance_review_master_range'),('public','claim_performance_review_master_sync'),('public','begin_performance_review_master_sync'),('public','finish_performance_review_master_sync'),('public','reconcile_performance_review_master_sync')) f(schema_name,function_name) where f.schema_name=n.nspname and f.function_name=p.proname);
 if encode(extensions.digest(pg_temp.master_feature_metadata()::text,'sha256'),'hex') is distinct from ($master_feature_pins${"16":"23cc4ceb05d63c232f348c4ce74acbdcc5126a37b2d297206831b9f6b21f01fa","17":"f120144bdcd8a3d24796f8ad7b0d85ef03f4b0444327d32b94eaaf5a62a4afa2"}$master_feature_pins$::jsonb->>(current_setting('server_version_num')::integer/10000)::text) then raise exception 'Master complete feature metadata mismatch.' using errcode='55000'; end if;
 if actual is distinct from expected then raise exception 'Master routine contract mismatch.' using errcode='55000'; end if;
 if (select count(*) from pg_class where oid in ('private.performance_review_master_targets'::regclass,'private.performance_review_master_queue'::regclass,'private.performance_review_master_attempts'::regclass) and relrowsecurity and relforcerowsecurity and relowner='postgres'::regrole)<>3
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl where c.oid in ('private.performance_review_master_targets'::regclass,'private.performance_review_master_queue'::regclass,'private.performance_review_master_attempts'::regclass) and acl.grantee<>'postgres'::regrole)
  or (select count(*) from pg_trigger where tgrelid='private.performance_reviews'::regclass and tgname='performance_review_master_enqueue' and not tgisinternal and tgtype=21 and tgenabled='O' and tgdeferrable and tginitdeferred and tgfoid='private.performance_review_master_enqueue()'::regprocedure and tgqual is null and tgattr=''::int2vector and tgnargs=0)<>1 then raise exception 'Master table or trigger security mismatch.' using errcode='55000'; end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where expected ? (n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')') and (p.proowner<>'postgres'::regrole or p.proconfig is distinct from array['search_path=""'] or acl.grantee not in ('postgres'::regrole,case when n.nspname='public' then 'service_role'::regrole else 'postgres'::regrole end))) then raise exception 'Master routine ACL mismatch.' using errcode='55000'; end if;
 if (select count(*) from private.performance_review_master_targets where target_key='master-reviews-v1' and not enabled and not writer_admitted and capture_after is null and binding is null and active_job is null and not held)<>1 or exists(select 1 from private.performance_review_master_queue) or exists(select 1 from private.performance_review_master_attempts) then raise exception 'Master must install disabled without historical work.' using errcode='55000'; end if;
end $master_preservation_final$;
commit;
