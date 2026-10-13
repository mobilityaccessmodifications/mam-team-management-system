begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
do $annual_continuous_predecessor$ begin
 if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
  raise exception 'Annual continuous accrual requires the exact reviewed predecessor catalog.' using errcode='55000';
 end if;
end $annual_continuous_predecessor$;
create temporary table annual_continuous_relation_spec(schema_name text,relation_name text,relation_kind text,primary key(schema_name,relation_name)) on commit drop;
insert into annual_continuous_relation_spec values
('private','annual_leave_day_accounting','r'),
('private','annual_leave_day_accounting_pkey','i'),
('private','annual_leave_day_accounting_latest','i');
create temporary table annual_continuous_function_spec(signature text primary key,before_sha256 text,after_sha256 text not null,new_metadata jsonb) on commit drop;
insert into annual_continuous_function_spec(signature,before_sha256,after_sha256) values
('private.calculate_leave_entitlement(uuid,text,date)','32843b768f85879c6d158f5b0e4122da3ae9638d5525aa3bc8646941e677efc9','381e3e425e7a35659f8a12385eae0d3015d82fc8b4bed76406dfa8de1cc3e6c3'),
('private.project_annual_leave_balance(uuid,date)','b88e6a78a3c43681496f9649611cc06df507955bf10929f1b27970cd2ff848d0','98385266f9a1a77aaf975d95e2fbea2272cf8940601d9230fe6ce26d0e036ec4'),
('public.refresh_employee_leave_accrual()','b28d90fab6681579c29843799c31ea578e43caf04e75b0bced4277be6cb4fb3e','e1fcc431a959a1929bc46e25bdf31a58c469265329edaa7a28e967b38eeff292'),
('private.leave_request_quantity(uuid,date,date,time,time,numeric)','bbd035ddbad9d5afdc7ab4105e0c4aed449d42923f1d71330aeb3bd0daaadb61','c5a17eb132bbd9e599576e97df07bf30bdcfd6c9eddacf4b7d3b82f9b38f8c2c'),
('private.leave_payroll_day_hours(uuid,date)','c404ccc94bd8967bf47d4d58188ca4e9e9e02bf4f2a8d690418a2b515a00e5bc','be264b6b847de447fbed6a5f893d11c0af96fefd269678d1478ebf8823972ced'),
('private.payroll_request_hours_after(uuid,date)','fa4c121210ae3c9dddb8007460f0d5b633299592ef680ed7579c499f5cd68e0f','eeb5380b3f249f806704d88746754242b59097ae8b16a3eb004f3a1426a02f30'),
('private.payroll_request_unconsumed_hours(uuid,date,date)','89a010fb374fd93dff5e5e3a6f0be23039a8e3946c31189c71d1696d225375bf','5195fc234b82a5d34b9e142d464b4e597fb0fe37d281715bf5bee275356de190'),
('private.enforce_banked_annual_leave_request()','8443b5e62134cf6cb797743b36418b9a4b332f1f205c814522d47ccd6ca1b684','3702438e5c6836c1ae5b7db0dece7a14aabb8a7f1eb1353d87bde697c5e536ae'),
('private.approved_leave_hours_after(uuid,text[],date)','03833b5e9266e4da7386994162bed27660c583b8f21eac95143046a4d3936f65','a94b51d4400a12acb82675e6a8c3db0217a295ec13adea9a365352224c83d9dc');
insert into annual_continuous_function_spec values
('private.annual_leave_retained_usage(uuid)',null,'18cd2d65bb202709232f23f767b1317320fbc5a11213e9a714feea4fb889c57b','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.annual_leave_accounting_day(uuid,date)',null,'26e40841d15dd8ec3bea036fb73657afc8399613eccae16fa2ced0dfef9557ee','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.capture_annual_leave_accounting(uuid,date,date,boolean)',null,'213dc31563244fe1845a2c9db420c6f2529e51e88c61f428401e55f9833ca19b','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.retain_completed_annual_leave_accounting()',null,'31b3d93692aa59c4d8f1b77c52bed38c13639609f6402fe29b42fe2bf066155d','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb);
do $annual_continuous_functions$ declare item record; begin
 if exists(select 1 from annual_continuous_relation_spec s join pg_namespace n on n.nspname=s.schema_name join pg_class c on c.relnamespace=n.oid and c.relname=s.relation_name) then raise exception 'Annual accounting relation already exists.' using errcode='55000';end if;
 for item in select * from annual_continuous_function_spec loop
  if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
   raise exception 'Annual continuous predecessor function differs: %',item.signature using errcode='55000';
  end if;
 end loop;
end $annual_continuous_functions$;
create temporary table annual_continuous_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from annual_continuous_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
do $annual_continuous_collector$ declare query text; anchor text; begin
 select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
 anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
 if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then raise exception 'Annual continuous collector differs.' using errcode='55000';end if;
 execute 'create function pg_temp.annual_continuous_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(replace(query,anchor,'select definition from ('));
end $annual_continuous_collector$;
create temporary table annual_continuous_catalog_before on commit drop as select * from pg_temp.annual_continuous_catalog();
create function pg_temp.annual_continuous_table_metadata(p_table oid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',case when c.relacl::text='{postgres=arwdDxtm/postgres}' then '{postgres=arwdDxt/postgres}' else c.relacl::text end,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions,
 'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'acl',a.attacl::text,'identity',a.attidentity,'generated',a.attgenerated,'collation',case when a.attcollation=0 then null else a.attcollation::regcollation::text end,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'toast_table',(select jsonb_build_object('owner',pg_get_userbyid(t.relowner),'acl',t.relacl::text,'options',t.reloptions,'rls',t.relrowsecurity,'force_rls',t.relforcerowsecurity) from pg_class t where t.oid=c.reltoastrelid),
 'toast_indexes',(select coalesce(jsonb_agg((to_jsonb(i)-array['indexrelid','indrelid','indclass','indcollation'])||jsonb_build_object('owner',pg_get_userbyid(ic.relowner),'acl',ic.relacl::text,'options',ic.reloptions,'opclasses',array(select n.nspname||'.'||o.opcname from unnest(i.indclass) with ordinality u(class_id,position) join pg_opclass o on o.oid=u.class_id join pg_namespace n on n.oid=o.opcnamespace order by u.position),'definition',replace(pg_get_indexdef(i.indexrelid),c.oid::text,'<parent>')) order by i.indexrelid),'[]') from pg_index i join pg_class ic on ic.oid=i.indexrelid where i.indrelid=c.reltoastrelid),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid),'deferrable',condeferrable,'deferred',condeferred,'validated',convalidated) order by conname),'[]') from pg_constraint where conrelid=c.oid),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid),'function_sha256',encode(extensions.digest(pg_get_functiondef(tgfoid),'sha256'),'hex')) order by tgname),'[]') from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'foreign_key_triggers',(select coalesce(jsonb_agg((to_jsonb(t)-array['oid','tgname','tgrelid','tgfoid','tgconstrrelid','tgconstrindid','tgconstraint','tgparentid'])||jsonb_build_object('relation',t.tgrelid::regclass::text,'function',t.tgfoid::regprocedure::text,'constraint',k.conname,'constraint_relation',t.tgconstrrelid::regclass::text) order by t.tgrelid::regclass::text,t.tgfoid::regprocedure::text),'[]') from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint where k.conrelid=c.oid and k.contype='f'),
 'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'permissive',polpermissive,'roles',array(select rolname from pg_roles where oid=any(polroles) order by rolname),'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) order by polname),'[]') from pg_policy where polrelid=c.oid))
from pg_class c where c.oid=p_table;
$$;
create function pg_temp.annual_continuous_index_metadata(p_index oid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'definition',pg_get_indexdef(c.oid),'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,'immediate',i.indimmediate,'clustered',i.indisclustered,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'replica_identity',i.indisreplident,'nulls_not_distinct',i.indnullsnotdistinct,'columns',i.indnatts,'key_columns',i.indnkeyatts)
from pg_class c join pg_index i on i.indexrelid=c.oid where c.oid=p_index;
$$;
create function pg_temp.annual_continuous_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'column_defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from annual_continuous_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname)),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from pg_class c join pg_namespace cn on cn.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=cn.nspname and s.relation_name=c.relname where s.relation_kind='r' and (t.typrelid=c.oid or t.typelem=c.reltype))),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not a.attisdropped and a.attnum>0 and not exists(select 1 from annual_continuous_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname) and not exists(select 1 from annual_continuous_relation_spec s join pg_namespace pn on pn.nspname=s.schema_name join pg_class parent on parent.relnamespace=pn.oid and parent.relname=s.relation_name where s.relation_kind='r' and (parent.reltoastrelid=c.oid or exists(select 1 from pg_index i where i.indrelid=parent.reltoastrelid and i.indexrelid=c.oid)))),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from annual_continuous_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname) and not exists(select 1 from annual_continuous_relation_spec s join pg_namespace pn on pn.nspname=s.schema_name join pg_class parent on parent.relnamespace=pn.oid and parent.relname=s.relation_name where s.relation_kind='r' and (parent.reltoastrelid=c.oid or exists(select 1 from pg_index i where i.indrelid=parent.reltoastrelid and i.indexrelid=c.oid)))),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k where not exists(select 1 from pg_namespace n where n.oid=k.connamespace and (n.nspname ~ '^pg_temp_' or n.nspname ~ '^pg_toast_temp_')) and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where c.oid=k.conrelid)),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from annual_continuous_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname) and not(c.oid='public.leave_requests'::regclass and t.tgname='ab_retain_completed_annual_leave_accounting') and not exists(select 1 from annual_continuous_relation_spec s join pg_namespace pn on pn.nspname=s.schema_name join pg_class parent on parent.relnamespace=pn.oid and parent.relname=s.relation_name where s.relation_kind='r' and (parent.reltoastrelid=c.oid or exists(select 1 from pg_index i where i.indrelid=parent.reltoastrelid and i.indexrelid=c.oid))) and not exists(select 1 from pg_constraint k join pg_class child on child.oid=k.conrelid join pg_namespace kn on kn.oid=child.relnamespace join annual_continuous_relation_spec rs on rs.schema_name=kn.nspname and rs.relation_name=child.relname where rs.relation_kind='r' and k.oid=t.tgconstraint)),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from annual_continuous_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname) and not exists(select 1 from annual_continuous_relation_spec s join pg_namespace pn on pn.nspname=s.schema_name join pg_class parent on parent.relnamespace=pn.oid and parent.relname=s.relation_name where s.relation_kind='r' and parent.reltoastrelid=i.indrelid))
);
$$;
create temporary table annual_continuous_security_before on commit drop as select pg_temp.annual_continuous_security() value;

create function pg_temp.annual_continuous_data() returns jsonb language plpgsql stable set search_path='' as $$
declare relation text; result jsonb:='{}'::jsonb; value jsonb; begin
  foreach relation in array array['public.internal_org_people','public.profiles','private.portal_account_admins','private.employee_directory_details','public.leave_requests','private.leave_accrual_policies','private.leave_accrual_day_reviews','private.leave_accrual_calculations','private.employee_annual_leave_balances','private.employee_sick_leave_balances','private.annual_leave_balance_history','private.sick_leave_balance_history','private.payroll_balance_imports','private.payroll_balance_import_batches','private.payroll_balance_import_stage_rows','private.payroll_balance_comparisons','private.payroll_balance_source_archives','private.payroll_closing_receipts','private.payroll_carryforward_events','private.payroll_closing_write_claims','private.confirmed_test_identity_purges','private.leave_bank_sources','private.leave_bank_adoption_receipts','private.leave_payroll_calendars'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),''[]''::jsonb) from %s t',relation::regclass) into value;
    result:=result||jsonb_build_object(relation,value);
  end loop;
  return result;
end;
$$;
create temporary table annual_continuous_data_before on commit drop as select pg_temp.annual_continuous_data() value;

create table private.annual_leave_day_accounting (
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.internal_org_people(id),
 service_date date not null,
 state jsonb not null check(jsonb_typeof(state)='object' and state->>'status'='current'),
 created_at timestamptz not null default clock_timestamp()
);
create index annual_leave_day_accounting_latest on private.annual_leave_day_accounting(person_id,service_date,created_at desc,id desc);
alter table private.annual_leave_day_accounting enable row level security;
alter table private.annual_leave_day_accounting force row level security;
revoke all on private.annual_leave_day_accounting from public,anon,authenticated,service_role;
create trigger annual_leave_day_accounting_immutable before update or delete on private.annual_leave_day_accounting for each row execute function private.payroll_closing_immutable();
create trigger annual_leave_day_accounting_no_truncate before truncate on private.annual_leave_day_accounting for each statement execute function private.payroll_closing_immutable();
create trigger reject_retired_test_identity_reference before insert or update on private.annual_leave_day_accounting for each row execute function private.reject_retired_test_identity_reference();
CREATE OR REPLACE FUNCTION private.annual_leave_retained_usage(p_person uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare basis jsonb; cutoff date; identity text; entries jsonb:='[]'; included numeric; amount numeric; e record; saved record;
begin
 basis:=private.leave_bank_basis(p_person,'annual');cutoff:=(basis->>'coveredThrough')::date;identity:=coalesce(basis->>'sourceId',extract(epoch from (basis->>'updatedAt')::timestamptz)::text);
 if basis->>'status'<>'current' or cutoff is null then return jsonb_build_object('hours',0,'requestUsage',entries);end if;
 for e in select carry.*,req.status,req.request_type_label,req.pay_treatment from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person and leave_kind='annual' order by request_id,id desc)carry join public.leave_requests req on req.id=carry.request_id where carry.pending_hours>0 and carry.through_date<=cutoff and carry.through_date<=(now() at time zone 'Australia/Melbourne')::date-1 and req.status='approved' and req.request_type_label='Annual leave' and req.pay_treatment='paid_entitlement' loop
  select coalesce(sum((value->>'includedPendingHours')::numeric),0) into included from jsonb_array_elements(coalesce(basis->'includedUsage','[]'::jsonb)) where value->>'requestId'=e.request_id::text;
  amount:=greatest(0,e.pending_hours-included);
  if amount>0 then entries:=entries||jsonb_build_array(jsonb_build_object('requestId',e.request_id,'eventId',e.id,'hours',amount,'throughDate',e.through_date,'basisIdentity',identity,'coveredThrough',cutoff));end if;
 end loop;
 for saved in select distinct on(entry->>'requestId',entry->>'eventId') entry from private.annual_leave_day_accounting a cross join lateral jsonb_array_elements(coalesce(a.state->'retainedUsage','[]'::jsonb))entry
  where a.person_id=p_person and entry->>'basisIdentity'=identity and (entry->>'coveredThrough')::date=cutoff order by entry->>'requestId',entry->>'eventId',a.created_at desc,a.id desc loop
  if not exists(select 1 from jsonb_array_elements(entries)value where value->>'requestId'=saved.entry->>'requestId') then entries:=entries||jsonb_build_array(saved.entry);end if;
 end loop;
 return jsonb_build_object('hours',coalesce((select sum((value->>'hours')::numeric) from jsonb_array_elements(entries)),0),'requestUsage',entries);
end $function$
;
revoke all on function private.annual_leave_retained_usage(uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.annual_leave_accounting_day(p_person uuid, p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pol private.leave_accrual_policies%rowtype; rev private.leave_accrual_day_reviews%rowtype; saved jsonb; result jsonb;
 fingerprint text; ordinary numeric; unpaid numeric:=0; qty numeric; taken numeric:=0; matched numeric:=0; count_annual integer:=0; requests jsonb:='[]'; r record; start_day date; end_day date;
begin
 fingerprint:=private.leave_accrual_request_fingerprint(p_person,p_day);
 select * into pol from private.leave_accrual_policies where person_id=p_person and effective_from<=p_day order by effective_from desc,created_at desc,id desc limit 1;
 if pol.id is null or cardinality(pol.weekdays)<>(select count(distinct value) from unnest(pol.weekdays)value) then return jsonb_build_object('status','needs_review','taken',0);end if;
 select p.started_date,d.scheduled_employment_end_date into start_day,end_day from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id where p.id=p_person;
 ordinary:=case when pol.enabled and extract(isodow from p_day)::integer=any(pol.weekdays) then pol.weekly_hours*(420/cardinality(pol.weekdays)) else 0 end;
 select * into rev from private.leave_accrual_day_reviews where person_id=p_person and service_date=p_day order by created_at desc,id desc limit 1;
 if p_day<=(now() at time zone 'Australia/Melbourne')::date-1 then
  select state into saved from private.annual_leave_day_accounting where person_id=p_person and service_date=p_day and not coalesce((state->>'retainedOnly')::boolean,false) order by created_at desc,id desc limit 1;
 end if;
 if (rev.id is not null and rev.request_fingerprint<>fingerprint) or (pol.requires_review and rev.id is null) then return jsonb_build_object('status','needs_review','taken',coalesce((saved->>'taken')::numeric,0));end if;
 if saved is not null and saved->>'reviewId' is not distinct from rev.id::text then
  requests:=saved->'requestUsage';taken:=(saved->>'taken')::numeric;
  for r in select * from public.leave_requests where employee_person_id=p_person and status='approved' and p_day between start_date and end_date loop
   if ordinary>0 and (r.pay_treatment is null or r.pay_treatment not in ('paid_entitlement','paid_other','unpaid')) and rev.id is null then return saved||jsonb_build_object('status','needs_review');end if;
   if ordinary>0 and r.pay_treatment='unpaid' and rev.id is null then
    qty:=private.leave_payroll_day_hours(r.id,p_day);if qty is null then return saved||jsonb_build_object('status','needs_review');end if;unpaid:=unpaid+qty*420;
   end if;
   if r.leave_type='annual' and r.request_type_label='Annual leave' and r.pay_treatment='paid_entitlement' and not exists(select 1 from jsonb_array_elements(requests)entry where entry->>'requestId'=r.id::text) then
    qty:=private.leave_payroll_day_hours(r.id,p_day);
    if qty is null then return saved||jsonb_build_object('status','needs_review');end if;
    requests:=requests||jsonb_build_array(jsonb_build_object('requestId',r.id,'hours',qty,'fingerprint',private.payroll_request_fingerprint(to_jsonb(r))));taken:=taken+qty;
   end if;
  end loop;
  return saved||jsonb_build_object('policyId',pol.id,'eligibleNumerator',case when p_day<coalesce(start_day,p_day) or p_day>coalesce(end_day,p_day) then 0 when rev.id is not null then (saved->>'eligibleNumerator')::numeric else greatest(0,ordinary-unpaid) end,'taken',taken,'requestUsage',requests,'requestFingerprint',fingerprint);
 end if;
 for r in select * from public.leave_requests where employee_person_id=p_person and status='approved' and p_day between start_date and end_date loop
  if ordinary>0 and (r.pay_treatment is null or r.pay_treatment not in ('paid_entitlement','paid_other','unpaid')) and rev.id is null then return jsonb_build_object('status','needs_review','taken',0);end if;
  if ordinary>0 and r.pay_treatment='unpaid' and rev.id is null then
   qty:=private.leave_payroll_day_hours(r.id,p_day);if qty is null then return jsonb_build_object('status','needs_review','taken',0);end if;unpaid:=unpaid+qty*420;
  end if;
  if p_day<=(now() at time zone 'Australia/Melbourne')::date-1 and r.leave_type='annual' and r.request_type_label='Annual leave' and r.pay_treatment='paid_entitlement' then
   qty:=private.leave_payroll_day_hours(r.id,p_day);if qty is null then return jsonb_build_object('status','needs_review','taken',0);end if;
   if qty>0 then count_annual:=count_annual+1;end if;
   qty:=case when rev.id is null then qty else least(qty,rev.annual_taken_hours) end;
   requests:=requests||jsonb_build_array(jsonb_build_object('requestId',r.id,'hours',qty,'fingerprint',private.payroll_request_fingerprint(to_jsonb(r))));matched:=matched+qty;
  end if;
 end loop;
 if rev.id is not null and count_annual>1 and rev.annual_taken_hours>0 then return jsonb_build_object('status','needs_review','taken',coalesce((saved->>'taken')::numeric,0));end if;
 taken:=case when p_day>(now() at time zone 'Australia/Melbourne')::date-1 then 0 when rev.id is not null then rev.annual_taken_hours else matched end;
 result:=jsonb_build_object('status','current','policyId',pol.id,'eligibleNumerator',case when p_day<coalesce(start_day,p_day) or p_day>coalesce(end_day,p_day) then 0 when pol.enabled or pol.requires_review then coalesce(rev.annual_eligible_hours*420,greatest(0,ordinary-unpaid)) else 0 end,
  'taken',taken,'requestUsage',requests,'requestFingerprint',fingerprint,'reviewId',rev.id);
 return result;
end $function$
;
revoke all on function private.annual_leave_accounting_day(uuid,date) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.capture_annual_leave_accounting(p_person uuid, p_from date, p_through date, p_strict boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare basis jsonb; day date; value jsonb; previous jsonb;
begin
 perform private.lock_annual_leave_budget();
 basis:=private.leave_bank_basis(p_person,'annual');
 if basis->>'status'<>'current' or basis->>'coveredThrough' is null then return;end if;
 if p_through-p_from>3660 then raise exception 'Annual accounting interval requires a reviewed closing balance.' using errcode='55000';end if;
 for day in select d::date from generate_series(greatest(p_from,(basis->>'coveredThrough')::date+1),least(p_through,(now() at time zone 'Australia/Melbourne')::date-1),interval '1 day')d loop
  value:=private.annual_leave_accounting_day(p_person,day);
  if value->>'status'<>'current' then
   if p_strict then raise exception 'Completed annual accounting requires a confirmed day review.' using errcode='55000';end if;
   continue;
  end if;
  select state into previous from private.annual_leave_day_accounting where person_id=p_person and service_date=day and not coalesce((state->>'retainedOnly')::boolean,false) order by created_at desc,id desc limit 1;
  if previous is distinct from value then insert into private.annual_leave_day_accounting(person_id,service_date,state)values(p_person,day,value);end if;
 end loop;
end $function$
;
revoke all on function private.capture_annual_leave_accounting(uuid,date,date,boolean) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.retain_completed_annual_leave_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare retained jsonb; retained_entry jsonb;
begin
 if tg_op='DELETE' or private.payroll_request_money(to_jsonb(old)) is distinct from private.payroll_request_money(to_jsonb(new)) then
  if old.status='approved' and old.leave_type='annual' and old.request_type_label='Annual leave' and old.pay_treatment='paid_entitlement' then
   perform private.capture_annual_leave_accounting(old.employee_person_id,old.start_date,old.end_date,true);
   retained:=private.annual_leave_retained_usage(old.employee_person_id);
   for retained_entry in select value from jsonb_array_elements(retained->'requestUsage') where value->>'requestId'=old.id::text loop
    insert into private.annual_leave_day_accounting(person_id,service_date,state) values(old.employee_person_id,(retained_entry->>'throughDate')::date,jsonb_build_object('status','current','retainedOnly',true,'retainedUsage',jsonb_build_array(retained_entry)));
   end loop;
  end if;
  if tg_op='DELETE' and exists(select 1 from private.annual_leave_day_accounting where person_id=old.employee_person_id and (exists(select 1 from jsonb_array_elements(state->'requestUsage')entry where entry->>'requestId'=old.id::text) or exists(select 1 from jsonb_array_elements(state->'retainedUsage')entry where entry->>'requestId'=old.id::text))) then
   raise exception 'Accounted annual leave retains its request history.' using errcode='55000';
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $function$
;
revoke all on function private.retain_completed_annual_leave_accounting() from public,anon,authenticated,service_role;
create trigger ab_retain_completed_annual_leave_accounting before update or delete on public.leave_requests for each row execute function private.retain_completed_annual_leave_accounting();

CREATE OR REPLACE FUNCTION private.calculate_leave_entitlement(p_person uuid, p_kind text, p_through date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare basis jsonb; pol private.leave_accrual_policies%rowtype; rev private.leave_accrual_day_reviews%rowtype;
 day date; cutoff date; through_day date; review_day date; start_day date; end_day date; ordinary numeric; eligible numeric; earned_numerator numeric:=0; taken numeric:=0;
 status text; qty numeric; r record; requires_actual boolean; policy_id uuid; terms jsonb:='{}'; term jsonb; future_unpaid numeric; legacy_quantity numeric; eligibility_status text:='current'; usage_review_day date; usage_through date; day_state jsonb; retained jsonb;
begin
 basis:=private.leave_bank_basis(p_person,p_kind); cutoff:=(basis->>'coveredThrough')::date; status:=basis->>'status'; through_day:=cutoff;
 select p.started_date,d.scheduled_employment_end_date into start_day,end_day from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id where p.id=p_person;
 if p_through is null or basis->>'bankHours' is null or not exists(select 1 from private.leave_accrual_policies where person_id=p_person) then status:='not_configured';
 elsif status='current' and p_through-cutoff>3660 then status:='needs_review';eligibility_status:='needs_review';review_day:=cutoff+1;
 elsif status='current' then
  for day in select d::date from generate_series(cutoff+1,p_through,interval '1 day') d loop
   if day<coalesce(start_day,day) or day>coalesce(end_day,day) then through_day:=day; continue; end if;
   select * into pol from private.leave_accrual_policies where person_id=p_person and effective_from<=day order by effective_from desc,created_at desc,id desc limit 1;
   if not found or cardinality(pol.weekdays)<>(select count(distinct value) from unnest(pol.weekdays) value) then status:='needs_review';eligibility_status:='needs_review';review_day:=day;exit; end if;
   policy_id:=pol.id;
   ordinary:=case when pol.enabled and extract(isodow from day)::integer=any(pol.weekdays) then pol.weekly_hours*(420/cardinality(pol.weekdays)) else 0 end;
   if p_kind='annual' then
    day_state:=private.annual_leave_accounting_day(p_person,day);
    if day_state->>'status'<>'current' then status:='needs_review';eligibility_status:='needs_review';review_day:=day;exit;end if;
    eligible:=(day_state->>'eligibleNumerator')::numeric;
   else
   select * into rev from private.leave_accrual_day_reviews where person_id=p_person and service_date=day order by created_at desc,id desc limit 1;
   requires_actual:=pol.requires_review and rev.id is null; future_unpaid:=0;
   for r in select req.* from public.leave_requests req where req.employee_person_id=p_person and req.status='approved' and day between req.start_date and req.end_date loop
    qty:=private.leave_payroll_day_hours(r.id,day);
    if ordinary>0 and r.pay_treatment='unpaid' and r.hours is not null and r.start_date<>r.end_date and qty is not null and day>(now() at time zone 'Australia/Melbourne')::date-1 then
     select case when count(*) filter(where policy_row.id is null or cardinality(policy_row.weekdays)<>(select count(distinct value) from unnest(policy_row.weekdays)value))>0 then null else coalesce(sum(case when extract(isodow from d)::integer=any(policy_row.weekdays) then policy_row.weekly_hours/cardinality(policy_row.weekdays) else 0 end),0) end into legacy_quantity
      from generate_series(r.start_date,r.end_date,interval '1 day')d left join lateral(select * from private.leave_accrual_policies where person_id=p_person and effective_from<=d::date order by effective_from desc,created_at desc,id desc limit 1)policy_row on true;
     qty:=case when legacy_quantity is null or abs(legacy_quantity-r.hours)>0.0001 then null else pol.weekly_hours/cardinality(pol.weekdays) end;
    end if;
    if ordinary>0 and (r.pay_treatment is null or r.pay_treatment not in ('paid_entitlement','paid_other','unpaid')) then requires_actual:=true; end if;
    if ordinary>0 and r.pay_treatment='unpaid' then
     if qty is null or (p_kind<>'annual' and day<=(now() at time zone 'Australia/Melbourne')::date-1) then requires_actual:=true; else future_unpaid:=future_unpaid+qty*420; end if;
    end if;
    if day<=(now() at time zone 'Australia/Melbourne')::date-1 and r.pay_treatment='paid_entitlement' and
     ((p_kind='annual' and r.request_type_label='Annual leave' and qty is null) or(p_kind='personal' and r.request_type_label in ('Sick leave','Carer''s leave') and (qty is null or qty>0))) and rev.id is null then usage_review_day:=coalesce(usage_review_day,day); end if;
   end loop;
   if (rev.id is not null and rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,day)) or (requires_actual and rev.id is null) then status:='needs_review';eligibility_status:='needs_review';review_day:=day;exit; end if;
   eligible:=case when pol.enabled or pol.requires_review then coalesce(case when p_kind='annual' then rev.annual_eligible_hours else rev.personal_eligible_hours end*420,greatest(0,ordinary-future_unpaid)) else 0 end;
   end if;
   term:=coalesce(terms->pol.id::text,jsonb_build_object('fromDate',day,'weeklyHours',pol.weekly_hours,'weekdays',pol.weekdays,'annualWeeks',pol.annual_weeks,'personalWeeks',pol.personal_weeks,'eligibleNumerator',0));
   term:=term||jsonb_build_object('throughDate',day,'eligibleNumerator',(term->>'eligibleNumerator')::numeric+eligible);terms:=jsonb_set(terms,array[pol.id::text],term);
   earned_numerator:=earned_numerator+eligible*case when p_kind='annual' then pol.annual_weeks else pol.personal_weeks end;
   through_day:=day;
  end loop;
 end if;
 if cutoff is not null and p_through is not null then
  usage_through:=greatest(cutoff,least(p_through,(now() at time zone 'Australia/Melbourne')::date-1));
  if p_kind='annual' then
   retained:=private.annual_leave_retained_usage(p_person);taken:=taken+(retained->>'hours')::numeric;
   for day in select d::date from generate_series(cutoff+1,usage_through,interval '1 day') d loop
    day_state:=private.annual_leave_accounting_day(p_person,day);
    if day_state->>'status'<>'current' then usage_review_day:=least(usage_review_day,day);end if;
    taken:=taken+coalesce((day_state->>'taken')::numeric,0);
   end loop;
  else
  for rev in select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=p_person and service_date>cutoff and service_date<=usage_through order by service_date,created_at desc,id desc loop
   if rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,rev.service_date) then
    usage_review_day:=least(usage_review_day,rev.service_date);continue;
   end if;
   taken:=taken+coalesce(case when p_kind='annual' then rev.annual_taken_hours else rev.personal_taken_hours end,0);
  end loop;
  end if;
 end if;
 if usage_review_day is not null then status:='needs_review';review_day:=least(review_day,usage_review_day); end if;
 return jsonb_build_object('status',status,'eligibilityStatus',eligibility_status,'usageThroughDate',usage_through,'reviewDate',review_day,'hours',round((basis->>'bankHours')::numeric+earned_numerator/(420*52)-taken,4),
  'exactHours',(basis->>'bankHours')::numeric+earned_numerator/(420*52)-taken,'earned',earned_numerator/(420*52),'taken',taken,
  'asOf',coalesce(through_day,(basis->>'reportDate')::date),'payrollHours',basis->'bankHours','payrollDate',basis->'reportDate',
  'coveredThrough',basis->'coveredThrough','sourceKind',basis->'sourceKind','policyId',policy_id,
  'terms',coalesce((select jsonb_agg((value-'eligibleNumerator')||jsonb_build_object('eligibleHours',(value->>'eligibleNumerator')::numeric/420,
   'accruedHours',(value->>'eligibleNumerator')::numeric*(value->>case when p_kind='annual' then 'annualWeeks' else 'personalWeeks' end)::numeric/(420*52)) order by value->>'fromDate') from jsonb_each(terms)),'[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION private.project_annual_leave_balance(p_person uuid, p_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare basis jsonb; c jsonb; approved numeric; consumed numeric:=0; day date; qty numeric; taken numeric; r record; rev private.leave_accrual_day_reviews%rowtype; terms jsonb; projection_status text; day_state jsonb; entry jsonb; retained jsonb;
begin
 basis:=private.leave_bank_basis(p_person,'annual');
 if p_start is null or basis->>'bankHours' is null then return jsonb_build_object('status','unavailable','projectedDate',p_start); end if;
 c:=private.calculate_leave_entitlement(p_person,'annual',p_start-1);
 approved:=private.approved_leave_hours_after(p_person,array['Annual leave'],(basis->>'reportDate')::date);
 retained:=private.annual_leave_retained_usage(p_person);
 for entry in select value from jsonb_array_elements(retained->'requestUsage') loop
  if exists(select 1 from public.leave_requests where id=(entry->>'requestId')::uuid and employee_person_id=p_person and status='approved' and leave_type='annual' and request_type_label='Annual leave' and pay_treatment='paid_entitlement') then consumed:=consumed+(entry->>'hours')::numeric;end if;
 end loop;
 if basis->>'coveredThrough' is not null then
  for day in select d::date from generate_series((basis->>'coveredThrough')::date+1,least(p_start-1,(c->>'usageThroughDate')::date),interval '1 day') d loop
   day_state:=private.annual_leave_accounting_day(p_person,day);
   if day_state->>'status'<>'current' then approved:=null;exit;end if;
   for entry in select value from jsonb_array_elements(day_state->'requestUsage') loop
    if exists(select 1 from public.leave_requests where id=(entry->>'requestId')::uuid and employee_person_id=p_person and status='approved' and leave_type='annual' and request_type_label='Annual leave' and pay_treatment='paid_entitlement') then
     qty:=private.leave_payroll_day_hours((entry->>'requestId')::uuid,day);
     if qty is null then approved:=null;exit;end if;
     consumed:=consumed+least((entry->>'hours')::numeric,qty);
    end if;
   end loop;
  end loop;
 end if;
 terms:=c->'terms';projection_status:=case when approved is null or c->>'status'='not_configured' or basis->>'status'='needs_review' then 'unavailable' when (basis->>'coveredThrough')::date>=p_start then 'banked_only' when basis->>'status'='current' and c->>'eligibilityStatus'='current' then 'projected' else 'banked_only' end;
 return jsonb_build_object('status',projection_status,
  'accrualStatus',c->'status','projectedDate',p_start,'fromDate',(basis->>'coveredThrough')::date+1,'throughDate',p_start-1,
  'payrollDate',basis->'reportDate','bankReportDate',basis->'reportDate','coveredServiceThrough',basis->'coveredThrough','payrollHours',basis->'bankHours',
  'approvedHours',approved,'retainedHours',basis->'retainedHours',
  'balanceSource',basis->'sourceKind','sourceKind',basis->'sourceKind','accruedHours',c->'earned','otherTakenHours',greatest(0,(c->>'taken')::numeric-consumed),
  'availableHours',case when projection_status='unavailable' then null else (basis->>'bankHours')::numeric+(c->>'earned')::numeric-approved-greatest(0,(c->>'taken')::numeric-consumed) end,'terms',terms);
end $function$
;

CREATE OR REPLACE FUNCTION public.refresh_employee_leave_accrual()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer; person uuid; basis jsonb;
begin
 perform private.lock_annual_leave_budget();
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Annual refresh requires a fresh READ COMMITTED transaction.' using errcode='55000';end if;
 for person in select distinct person_id from private.leave_accrual_policies order by person_id loop
  basis:=private.leave_bank_basis(person,'annual');
  perform private.capture_annual_leave_accounting(person,(basis->>'coveredThrough')::date+1,(now() at time zone 'Australia/Melbourne')::date-1,false);
 end loop;
 insert into private.leave_accrual_calculations(person_id,result)
 select distinct p.person_id,private.calculate_employee_leave_accrual(p.person_id,(now() at time zone 'Australia/Melbourne')::date-1)
 from private.leave_accrual_policies p on conflict(person_id,result) do nothing;
 get diagnostics n=row_count; return n;
end;
$function$
;
CREATE OR REPLACE FUNCTION private.leave_request_quantity(p_person uuid, p_start date, p_end date, p_start_time time without time zone, p_end_time time without time zone, p_hours numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare day date; pol private.leave_accrual_policies%rowtype; calendar text; ordinary numeric; total numeric:=0; elapsed numeric; ordinary_days integer:=0;
begin
 if p_start is null or p_end is null or p_end<p_start or p_end-p_start>3660 or ((p_start_time is null)<>(p_end_time is null)) then return null; end if;
 if p_hours is not null and (p_hours<=0 or p_hours::text in ('NaN','Infinity','-Infinity')) then return null;end if;
 if p_start_time is not null and p_start<>p_end then return null; end if;
 select calendar_key into calendar from private.leave_payroll_calendars where person_id=p_person;
 for day in select d::date from generate_series(p_start,p_end,interval '1 day') d loop
  select * into pol from private.leave_accrual_policies where person_id=p_person and effective_from<=day order by effective_from desc,created_at desc,id desc limit 1;
  if not found or cardinality(pol.weekdays)<>(select count(distinct value) from unnest(pol.weekdays) value) then return null; end if;
  ordinary:=case when extract(isodow from day)::integer=any(pol.weekdays) then pol.weekly_hours/cardinality(pol.weekdays) else 0 end;
  if ordinary=0 then continue; end if;
  if exists(select 1 from private.victorian_public_holidays where holiday_date=day) then
   if calendar='victoria' then continue; end if;
  end if;
  ordinary_days:=ordinary_days+1;
  if p_start_time is not null then
   elapsed:=extract(epoch from(p_end_time-p_start_time))/3600;
   if elapsed<=0 or elapsed>24 or (p_hours is not null and abs(p_hours-round(elapsed,2))>0.0001) then return null; end if;
   total:=total+elapsed;
  elsif p_start=p_end and p_hours is not null then
   if p_hours<=0 or p_hours>24 or p_hours::text in ('NaN','Infinity','-Infinity') then return null; end if;
   total:=total+p_hours;
  else total:=total+ordinary; end if;
 end loop;
 if p_hours is not null and p_start<>p_end then if p_hours>ordinary_days*24 then return null;end if;return p_hours;end if;
 return total;
end $function$
;
CREATE OR REPLACE FUNCTION private.leave_payroll_day_hours(p_request uuid, p_day date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.leave_requests%rowtype; pol private.leave_accrual_policies%rowtype; ordinary numeric; calendar text; total numeric; elapsed numeric; cumulative numeric;
begin
 select * into r from public.leave_requests where id=p_request;
 if not found then return null; end if;
 if p_day<r.start_date or p_day>r.end_date then return 0; end if;
 select * into pol from private.leave_accrual_policies where person_id=r.employee_person_id and effective_from<=p_day order by effective_from desc,created_at desc,id desc limit 1;
 if not found or cardinality(pol.weekdays)<>(select count(distinct value) from unnest(pol.weekdays) value) then return null; end if;
 ordinary:=case when extract(isodow from p_day)::integer=any(pol.weekdays) then pol.weekly_hours/cardinality(pol.weekdays) else 0 end;
 if ordinary=0 then return 0; end if;
 if r.pay_treatment='paid_entitlement' and exists(select 1 from private.victorian_public_holidays where holiday_date=p_day) then
  select calendar_key into calendar from private.leave_payroll_calendars where person_id=r.employee_person_id;
  if calendar is null and r.leave_type is distinct from 'annual' then return null;elsif calendar='victoria' then return 0; end if;
 end if;
 if r.start_time is not null or r.end_time is not null then
  if r.start_date<>r.end_date or r.start_time is null or r.end_time is null then return null; end if;
  elapsed:=extract(epoch from(r.end_time-r.start_time))/3600;
  if elapsed<=0 or elapsed>24 or (r.hours is not null and abs(r.hours-round(elapsed,2))>0.0001) then return null; end if;
  return elapsed;
 end if;
 if r.hours is not null then
  if r.start_date=r.end_date and r.hours>0 and r.hours<=24 then return r.hours; end if;
  if r.pay_treatment='paid_entitlement' then
   if r.leave_type is distinct from 'annual' and not exists(select 1 from private.leave_payroll_calendars where person_id=r.employee_person_id)
    and exists(select 1 from private.victorian_public_holidays h cross join lateral(select p.weekdays from private.leave_accrual_policies p where p.person_id=r.employee_person_id and p.effective_from<=h.holiday_date order by p.effective_from desc,p.created_at desc,p.id desc limit 1)holiday_policy where h.holiday_date between r.start_date and r.end_date and extract(isodow from h.holiday_date)::integer=any(holiday_policy.weekdays)) then return null;end if;
   total:=private.leave_request_quantity(r.employee_person_id,r.start_date,r.end_date,null,null,null);
   if r.leave_type='annual' then cumulative:=private.leave_request_quantity(r.employee_person_id,r.start_date,p_day,null,null,null);
   elsif abs(total-r.hours)>0.0001 then total:=null;end if;
  else
   select case when count(*) filter(where p.id is null or cardinality(p.weekdays)<>(select count(distinct value) from unnest(p.weekdays) value))>0 then null else coalesce(sum(case when extract(isodow from d)::integer=any(p.weekdays) then p.weekly_hours/cardinality(p.weekdays) else 0 end),0) end,
    coalesce(sum(case when d::date<=p_day and extract(isodow from d)::integer=any(p.weekdays) then p.weekly_hours/cardinality(p.weekdays) else 0 end),0) into total,cumulative
    from generate_series(r.start_date,r.end_date,interval '1 day')d left join lateral(select * from private.leave_accrual_policies where person_id=r.employee_person_id and effective_from<=d::date order by effective_from desc,created_at desc,id desc limit 1)p on true;
   if r.pay_treatment<>'unpaid' and abs(total-r.hours)>0.0001 then total:=null;end if;
  end if;
  if r.leave_type='annual' or r.pay_treatment='unpaid' then
   if total is null or total<=0 or cumulative is null or r.hours<=0 or r.hours::text in ('NaN','Infinity','-Infinity') or r.hours>r.business_days*24 then return null;end if;
   return r.hours*cumulative/total-r.hours*(cumulative-ordinary)/total;
  end if;
  if total is null then return null; end if;
 end if;
 return ordinary;
end $function$
;
CREATE OR REPLACE FUNCTION private.payroll_request_hours_after(p_request uuid, p_after date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select case when p_after is null then null when r.end_date<=p_after then 0 when p_after<r.start_date and r.hours is not null and r.pay_treatment='paid_entitlement' then
 case when r.leave_type is distinct from 'annual' and not exists(select 1 from private.leave_payroll_calendars where person_id=r.employee_person_id)
  and exists(select 1 from private.victorian_public_holidays h cross join lateral(select p.weekdays from private.leave_accrual_policies p where p.person_id=r.employee_person_id and p.effective_from<=h.holiday_date order by p.effective_from desc,p.created_at desc,p.id desc limit 1)pol where h.holiday_date between r.start_date and r.end_date and extract(isodow from h.holiday_date)::integer=any(pol.weekdays)) then null
 else private.leave_request_quantity(r.employee_person_id,r.start_date,r.end_date,r.start_time,r.end_time,r.hours) end else
 (select case when count(*) filter(where qty is null)>0 then null else coalesce(sum(qty),0) end
 from(select private.leave_payroll_day_hours(r.id,d::date) qty from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') d) amounts) end
 from public.leave_requests r where r.id=p_request;
$function$
;
CREATE OR REPLACE FUNCTION private.payroll_request_unconsumed_hours(p_person uuid, p_after date, p_through date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare committed numeric; consumed numeric:=0; day date; day_state jsonb; entry jsonb; scheduled numeric; retained jsonb;
begin
  if p_after is null or p_through is null or p_through<p_after or p_through-p_after>3660 then return null; end if;
  committed:=private.approved_leave_hours_after(p_person,array['Annual leave'],p_after);
  if committed is null then return null; end if;
  retained:=private.annual_leave_retained_usage(p_person);
  for entry in select value from jsonb_array_elements(retained->'requestUsage') loop
   if (entry->>'throughDate')::date<=p_after and exists(select 1 from public.leave_requests where id=(entry->>'requestId')::uuid and employee_person_id=p_person and status='approved' and leave_type='annual' and request_type_label='Annual leave' and pay_treatment='paid_entitlement') then consumed:=consumed+(entry->>'hours')::numeric;end if;
  end loop;
  for day in select x::date from generate_series(p_after+1,least(p_through,(now() at time zone 'Australia/Melbourne')::date-1),interval '1 day') x loop
    day_state:=private.annual_leave_accounting_day(p_person,day);
    if day_state->>'status'<>'current' then return null; end if;
    for entry in select value from jsonb_array_elements(coalesce(day_state->'requestUsage','[]'::jsonb)) loop
      if exists(select 1 from public.leave_requests where id=(entry->>'requestId')::uuid and employee_person_id=p_person and status='approved' and leave_type='annual' and request_type_label='Annual leave' and pay_treatment='paid_entitlement') then
        scheduled:=private.leave_payroll_day_hours((entry->>'requestId')::uuid,day);
        if scheduled is null then return null; end if;
        consumed:=consumed+least((entry->>'hours')::numeric,scheduled);
      end if;
    end loop;
  end loop;
  return committed-consumed;
end;
$function$
;
CREATE OR REPLACE FUNCTION private.enforce_banked_annual_leave_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare projection jsonb; required numeric; available numeric; own_hours numeric:=0; basis jsonb;
 classification text; budget_classification text; changed boolean:=true; days integer; scheduled numeric; day date; day_state jsonb; entry jsonb;
begin
 if tg_op='UPDATE' then
  changed:=row(new.employee_person_id,new.leave_type,new.request_type_label,new.start_date,new.end_date,new.start_time,new.end_time,new.business_days,new.hours,new.employment_type_snapshot,new.pay_treatment)
   is distinct from row(old.employee_person_id,old.leave_type,old.request_type_label,old.start_date,old.end_date,old.start_time,old.end_time,old.business_days,old.hours,old.employment_type_snapshot,old.pay_treatment);
  if new.status in ('cancelled','rejected') and not changed then return new; end if;
  if not changed and (new.status is not distinct from old.status or(old.status='approved' and new.status<>'approved')) then return new; end if;
 end if;
 if new.request_type_label<>'Annual leave' and new.leave_type<>'annual' then return new; end if;
 perform private.lock_annual_leave_budget();
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Annual leave changes require a fresh READ COMMITTED transaction.' using errcode='55000'; end if;
 if new.request_type_label is distinct from 'Annual leave' or new.leave_type is distinct from 'annual' or new.pay_treatment is distinct from 'paid_entitlement' then raise exception 'Annual leave classification is inconsistent.' using errcode='22023'; end if;
 perform private.assert_leave_date_range(new.start_date,new.end_date);
 select employment_type into classification from private.employee_directory_details where person_id=new.employee_person_id;
 if tg_op='INSERT' and new.employment_type_snapshot is null then new.employment_type_snapshot:=classification; end if;
 budget_classification:=coalesce(new.employment_type_snapshot,classification);
 if budget_classification is null or budget_classification not in ('full_time','part_time')
  or(tg_op='INSERT' and new.employment_type_snapshot is distinct from classification)
  or(tg_op='UPDATE' and(new.employment_type_snapshot is distinct from old.employment_type_snapshot or new.employee_person_id is distinct from old.employee_person_id) and budget_classification is distinct from classification) then
  raise exception 'Annual leave employment snapshot is inconsistent.' using errcode='22023'; end if;
 select count(*)::integer into days from generate_series(new.start_date,new.end_date,interval '1 day') d
  cross join lateral(select ap.weekdays from private.leave_accrual_policies ap where ap.person_id=new.employee_person_id and ap.effective_from<=d::date order by ap.effective_from desc,ap.created_at desc,ap.id desc limit 1)p
  where extract(isodow from d)::integer=any(p.weekdays);
 if days<1 or new.business_days is distinct from days then raise exception 'Annual leave working days are inconsistent.' using errcode='22023'; end if;
 if new.start_date=new.end_date and new.start_time is not null and new.end_time is not null and new.hours is distinct from round(extract(epoch from(new.end_time-new.start_time))/3600,2) then
  raise exception 'Annual leave timed hours are inconsistent.' using errcode='22023'; end if;
 required:=private.leave_request_quantity(new.employee_person_id,new.start_date,new.end_date,new.start_time,new.end_time,new.hours);
 projection:=private.project_annual_leave_balance(new.employee_person_id,new.start_date);
 basis:=private.leave_bank_basis(new.employee_person_id,'annual');
 if tg_op='UPDATE' and old.status='approved' and old.request_type_label='Annual leave' and old.employee_person_id=new.employee_person_id then
  own_hours:=private.payroll_request_hours_after(old.id,coalesce((basis->>'coveredThrough')::date,(basis->>'reportDate')::date));
  if basis->>'sourceId' is null then
   own_hours:=own_hours+coalesce((select pending_hours from private.payroll_carryforward_events where request_id=old.id and leave_kind='annual' and through_date<=(basis->>'reportDate')::date order by id desc limit 1),0);
  end if;
  <<own_days>>
  for day in select d::date from generate_series(greatest(coalesce((basis->>'coveredThrough')::date,(basis->>'reportDate')::date)+1,old.start_date),least((projection->>'throughDate')::date,(now() at time zone 'Australia/Melbourne')::date-1,old.end_date),interval '1 day') d loop
   day_state:=private.annual_leave_accounting_day(old.employee_person_id,day);
   if day_state->>'status'<>'current' then own_hours:=null;exit own_days;end if;
   for entry in select value from jsonb_array_elements(coalesce(day_state->'requestUsage','[]'::jsonb)) where value->>'requestId'=old.id::text loop
    scheduled:=private.leave_payroll_day_hours(old.id,day);
    if scheduled is null then own_hours:=null;exit own_days;end if;
    own_hours:=greatest(0,own_hours-least((entry->>'hours')::numeric,scheduled));
   end loop;
  end loop;
 end if;
 available:=(projection->>'availableHours')::numeric+own_hours;
 if new.hours is not null and coalesce(required,new.hours)>available then raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023'; end if;
 if projection->>'status'='unavailable' or required is null or required<=0 or available is null or required::text in('NaN','Infinity','-Infinity') then
  raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023'; end if;
 if required>available then
  if projection->>'status'='banked_only' then raise exception 'Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.' using errcode='22023'; end if;
  raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023'; end if;
 return new;
end $function$
;
CREATE OR REPLACE FUNCTION private.approved_leave_hours_after(p_person_id uuid, p_leave_types text[], p_after date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.leave_requests%rowtype; total numeric:=0; qty numeric; kind text; basis jsonb; cutoff date; pending numeric; carry record; included numeric; window_from date; window_through date; review private.leave_accrual_day_reviews%rowtype; consumed numeric; day_qty numeric; taken_qty numeric; matching_requests integer; day date; day_state jsonb;
begin
 if p_after is null then return null; end if;
 kind:=case when 'Annual leave'=any(p_leave_types) then 'annual' when 'Sick leave'=any(p_leave_types) or 'Carer''s leave'=any(p_leave_types) then 'personal' end;
 if kind is not null then
  basis:=private.leave_bank_basis(p_person_id,kind);
  if basis->>'status'='needs_review' then return null; end if;
  if basis->>'sourceId' is not null then
   if basis->>'coveredThrough' is null then
    if exists(select 1 from public.leave_requests where employee_person_id=p_person_id and status='approved' and request_type_label=any(p_leave_types) and pay_treatment='paid_entitlement' and start_date<=(basis->>'reportDate')::date) then return null; end if;
    cutoff:=(basis->>'reportDate')::date;
   else cutoff:=(basis->>'coveredThrough')::date; end if;
  else cutoff:=p_after; end if;
 else cutoff:=p_after; end if;
 if exists(select 1 from (select distinct on(e.request_id,e.leave_kind) e.* from private.payroll_carryforward_events e where e.person_id=p_person_id order by e.request_id,e.leave_kind,e.id desc) e
  join public.leave_requests req on req.id=e.request_id where (kind is null or e.leave_kind=kind) and
   (e.request_fingerprint<>private.payroll_request_fingerprint(to_jsonb(req)) or e.company_key is distinct from(select company_key from public.internal_org_people where id=p_person_id))) then return null; end if;
 if not exists(select 1 from private.leave_accrual_policies where person_id=p_person_id) and basis->>'sourceId' is null then
  return private.approved_leave_hours_after_before_carryforward(p_person_id,p_leave_types,p_after);
 end if;
 for r in select * from public.leave_requests where employee_person_id=p_person_id and status='approved' and request_type_label=any(p_leave_types) and end_date>cutoff and (kind is null or pay_treatment='paid_entitlement') loop
  qty:=private.payroll_request_hours_after(r.id,cutoff); if qty is null then return null; end if; total:=total+qty;
 end loop;
 if basis->>'sourceId' is not null then
  for carry in select e.*,req.start_date,req.end_date,req.status,req.pay_treatment,req.request_type_label from
   (select distinct on(e.request_id,e.leave_kind) e.* from private.payroll_carryforward_events e where e.person_id=p_person_id and e.leave_kind=kind order by e.request_id,e.leave_kind,e.id desc)e
   join public.leave_requests req on req.id=e.request_id where e.pending_hours>0 loop
   select coalesce(sum((value->>'includedPendingHours')::numeric),0) into included from jsonb_array_elements(coalesce(basis->'includedUsage','[]'::jsonb)) where value->>'requestId'=carry.request_id::text;
   pending:=carry.pending_hours-included;
   if pending<0 then return null;elsif pending=0 then continue;end if;
   if carry.status<>'approved' or carry.pay_treatment is distinct from 'paid_entitlement' or not(carry.request_type_label=any(p_leave_types)) then return null;end if;
   window_from:=greatest(carry.start_date,carry.origin_after+1);window_through:=least(carry.end_date,carry.through_date);
   if window_through<window_from then return null;
   elsif window_through<=cutoff then total:=total+pending;
   elsif window_from>cutoff then
    qty:=private.payroll_request_hours_after(carry.request_id,cutoff);if qty is null then return null;end if;
    consumed:=0;
    if kind='annual' then
     for day in select d::date from generate_series(greatest(cutoff+1,carry.start_date),least(carry.end_date,(now() at time zone 'Australia/Melbourne')::date-1),interval '1 day') d loop
      day_state:=private.annual_leave_accounting_day(p_person_id,day);
      if day_state->>'status'<>'current' then return null;end if;
      if day_state->>'reviewId' is null then continue;end if;
      select coalesce(sum((value->>'hours')::numeric),0) into taken_qty from jsonb_array_elements(coalesce(day_state->'requestUsage','[]'::jsonb)) where value->>'requestId'=carry.request_id::text;
      if taken_qty>0 then
       day_qty:=private.leave_payroll_day_hours(carry.request_id,day);if day_qty is null then return null;end if;
       consumed:=consumed+least(taken_qty,day_qty);
      end if;
     end loop;
    else
    for review in select distinct on(service_date) * from private.leave_accrual_day_reviews
     where person_id=p_person_id and service_date>cutoff and service_date between carry.start_date and carry.end_date
      and service_date<=(now() at time zone 'Australia/Melbourne')::date-1 order by service_date,created_at desc,id desc loop
     if review.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person_id,review.service_date) then return null;end if;
     taken_qty:=case when kind='annual' then review.annual_taken_hours else review.personal_taken_hours end;
     if taken_qty>0 then
      day_qty:=private.leave_payroll_day_hours(carry.request_id,review.service_date);if day_qty is null then return null;end if;
      select count(*) into matching_requests from public.leave_requests req where req.employee_person_id=p_person_id and req.status='approved'
       and req.pay_treatment='paid_entitlement' and req.request_type_label=any(p_leave_types) and review.service_date between req.start_date and req.end_date;
      if matching_requests<>1 then return null;end if;
      consumed:=consumed+least(taken_qty,day_qty);
     end if;
    end loop;
    end if;
    if consumed>qty then return null;end if;
    total:=total+greatest(0,pending-greatest(0,qty-consumed));
   else return null;end if;
  end loop;
 else
  select coalesce(sum(e.pending_hours),0) into pending from (select distinct on(e.request_id,e.leave_kind) e.* from private.payroll_carryforward_events e where e.person_id=p_person_id and (kind is null or e.leave_kind=kind) and e.through_date<=p_after order by e.request_id,e.leave_kind,e.id desc)e;
  total:=total+pending;
 end if;
 return total;
end $function$
;
create temporary table annual_continuous_relation_expected(name text primary key,metadata jsonb not null) on commit drop;
insert into annual_continuous_relation_expected values
('private.annual_leave_day_accounting','{"acl":"{postgres=arwdDxt/postgres}","rls":true,"owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"person_id","type":"uuid","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"service_date","type":"date","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"state","type":"jsonb","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"collation":null,"generated":""}],"options":null,"policies":[],"triggers":[{"name":"annual_leave_day_accounting_immutable","enabled":"O","definition":"CREATE TRIGGER annual_leave_day_accounting_immutable BEFORE DELETE OR UPDATE ON private.annual_leave_day_accounting FOR EACH ROW EXECUTE FUNCTION private.payroll_closing_immutable()","function_sha256":"11be86ce1c1df90c08ef68ab20a174105f81661e445df52c21433f552575e094"},{"name":"annual_leave_day_accounting_no_truncate","enabled":"O","definition":"CREATE TRIGGER annual_leave_day_accounting_no_truncate BEFORE TRUNCATE ON private.annual_leave_day_accounting FOR EACH STATEMENT EXECUTE FUNCTION private.payroll_closing_immutable()","function_sha256":"11be86ce1c1df90c08ef68ab20a174105f81661e445df52c21433f552575e094"},{"name":"reject_retired_test_identity_reference","enabled":"O","definition":"CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.annual_leave_day_accounting FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()","function_sha256":"bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb"}],"force_rls":true,"constraints":[{"name":"annual_leave_day_accounting_person_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"name":"annual_leave_day_accounting_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"annual_leave_day_accounting_state_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((jsonb_typeof(state) = ''object''::text) AND ((state ->> ''status''::text) = ''current''::text)))"}],"toast_table":{"acl":null,"rls":false,"owner":"postgres","options":null,"force_rls":false},"toast_indexes":[{"acl":null,"owner":"postgres","indkey":[1,2],"indpred":null,"options":null,"indexprs":null,"indnatts":2,"indislive":true,"indoption":[0,0],"opclasses":["pg_catalog.oid_ops","pg_catalog.int4_ops"],"definition":"CREATE UNIQUE INDEX pg_toast_<parent>_index ON pg_toast.pg_toast_<parent> USING btree (chunk_id, chunk_seq)","indisready":true,"indisvalid":true,"indisunique":true,"indnkeyatts":2,"indcheckxmin":false,"indimmediate":true,"indisprimary":true,"indisclustered":false,"indisexclusion":false,"indisreplident":false,"indnullsnotdistinct":false}],"foreign_key_triggers":[{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":5,"tgnargs":0,"function":"\"RI_FKey_check_ins\"()","relation":"private.annual_leave_day_accounting","tgenabled":"O","constraint":"annual_leave_day_accounting_person_id_fkey","tgnewtable":null,"tgoldtable":null,"tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"constraint_relation":"public.internal_org_people"},{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":17,"tgnargs":0,"function":"\"RI_FKey_check_upd\"()","relation":"private.annual_leave_day_accounting","tgenabled":"O","constraint":"annual_leave_day_accounting_person_id_fkey","tgnewtable":null,"tgoldtable":null,"tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"constraint_relation":"public.internal_org_people"},{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":9,"tgnargs":0,"function":"\"RI_FKey_noaction_del\"()","relation":"public.internal_org_people","tgenabled":"O","constraint":"annual_leave_day_accounting_person_id_fkey","tgnewtable":null,"tgoldtable":null,"tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"constraint_relation":"private.annual_leave_day_accounting"},{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":17,"tgnargs":0,"function":"\"RI_FKey_noaction_upd\"()","relation":"public.internal_org_people","tgenabled":"O","constraint":"annual_leave_day_accounting_person_id_fkey","tgnewtable":null,"tgoldtable":null,"tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"constraint_relation":"private.annual_leave_day_accounting"}]}'::jsonb),
('private.annual_leave_day_accounting_latest','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":false,"columns":4,"options":null,"primary":false,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE INDEX annual_leave_day_accounting_latest ON private.annual_leave_day_accounting USING btree (person_id, service_date, created_at DESC, id DESC)","key_columns":4,"replica_identity":false,"nulls_not_distinct":false}'::jsonb),
('private.annual_leave_day_accounting_pkey','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":true,"columns":1,"options":null,"primary":true,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE UNIQUE INDEX annual_leave_day_accounting_pkey ON private.annual_leave_day_accounting USING btree (id)","key_columns":1,"replica_identity":false,"nulls_not_distinct":false}'::jsonb);
create function pg_temp.annual_continuous_assert_objects() returns void language plpgsql set search_path='' as $$
begin
 if (select count(*) from annual_continuous_relation_expected)<>3 or exists(select 1 from annual_continuous_relation_expected e left join annual_continuous_relation_spec s on s.schema_name||'.'||s.relation_name=e.name where e.metadata is distinct from case when s.relation_kind='r' then pg_temp.annual_continuous_table_metadata(to_regclass(e.name)) else pg_temp.annual_continuous_index_metadata(to_regclass(e.name)) end)
 or (select count(*) from annual_continuous_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature))<>(select count(*) from annual_continuous_function_spec)
 or not exists(select 1 from pg_trigger where tgrelid='public.leave_requests'::regclass and tgname='ab_retain_completed_annual_leave_accounting' and tgenabled='O' and not tgisinternal and pg_get_triggerdef(oid)='CREATE TRIGGER ab_retain_completed_annual_leave_accounting BEFORE DELETE OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.retain_completed_annual_leave_accounting()') then raise exception 'Annual accounting exact objects differ.' using errcode='55000';end if;
end $$;
select pg_temp.annual_continuous_assert_objects();
create temporary table annual_continuous_function_after on commit drop as select s.signature,pg_get_functiondef(p.oid) definition,(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata from annual_continuous_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table annual_continuous_catalog_after on commit drop as select * from pg_temp.annual_continuous_catalog();
create temporary table annual_continuous_catalog_added on commit drop as
 select n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||c.relforcerowsecurity definition from pg_class c join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where c.relkind in ('r','p','v','m')
 union all select a.attrelid::regclass::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where a.attnum>0 and not a.attisdropped
 union all select k.conrelid::regclass::text||':'||pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname
 union all select t.tgrelid::regclass::text||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where not t.tgisinternal
 union all select c.oid::regclass::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'default') from pg_class c join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where c.relkind in ('r','p','v','m')
 union all select p.polrelid::regclass::text||':'||p.polname||':'||p.polcmd::text||':'||p.polpermissive::text||':'||p.polroles::text||':'||coalesce(pg_get_expr(p.polqual,p.polrelid),'')||':'||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace join annual_continuous_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname
 union all select pg_get_functiondef(to_regprocedure(signature)) from annual_continuous_function_spec
 union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from annual_continuous_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.before_sha256 is null;
insert into annual_continuous_catalog_added select t.tgrelid::regclass::text||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid='public.leave_requests'::regclass and t.tgname='ab_retain_completed_annual_leave_accounting';
create temporary table annual_continuous_catalog_normalized on commit drop as
 select definition from annual_continuous_catalog_after except all select definition from annual_continuous_catalog_added;
insert into annual_continuous_catalog_normalized select definition from annual_continuous_function_before;
set constraints all immediate;
do $annual_continuous_delta$ begin
 if exists(select 1 from annual_continuous_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) left join annual_continuous_function_before b using(signature)
 where encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is distinct from s.after_sha256 or (s.before_sha256 is not null and b.metadata is distinct from (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))) or (s.before_sha256 is null and s.new_metadata is distinct from jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)))
 or exists((select definition collate "C" from annual_continuous_catalog_before except all select definition collate "C" from annual_continuous_catalog_normalized) union all (select definition collate "C" from annual_continuous_catalog_normalized except all select definition collate "C" from annual_continuous_catalog_before))
 or pg_temp.annual_continuous_security() is distinct from (select value from annual_continuous_security_before)
 or pg_temp.annual_continuous_data() is distinct from (select value from annual_continuous_data_before)
 or exists(select 1 from private.annual_leave_day_accounting) then
  raise exception 'Annual continuous accrual contains changes outside the reviewed delta.' using errcode='55000';
 end if;
end $annual_continuous_delta$;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
create function pg_temp.annual_continuous_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 perform pg_temp.annual_continuous_assert_objects();
 if exists(select 1 from annual_continuous_function_after a left join pg_proc p on p.oid=to_regprocedure(a.signature) where p.oid is null or pg_get_functiondef(p.oid) is distinct from a.definition or a.metadata is distinct from (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))
 or pg_temp.annual_continuous_data() is distinct from (select value from annual_continuous_data_before)
 or exists(select 1 from private.annual_leave_day_accounting)
 or exists((select definition collate "C" from pg_temp.annual_continuous_catalog() except all select definition collate "C" from annual_continuous_catalog_after) union all (select definition collate "C" from annual_continuous_catalog_after except all select definition collate "C" from pg_temp.annual_continuous_catalog()))
 or pg_temp.annual_continuous_security() is distinct from (select value from annual_continuous_security_before)
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
  raise exception 'Annual continuous final catalog or security drift.' using errcode='55000';
 end if;
end $$;
select pg_temp.annual_continuous_assert_delta();
commit;
