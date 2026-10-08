begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
do $annual_source_predecessor$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or (select count(*) from private.confirmed_test_purge_schema)<>1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Annual source bank requires the exact reviewed predecessor catalog.' using errcode='55000';
  end if;
end $annual_source_predecessor$;
create temporary table annual_source_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into annual_source_function_spec values
('private.calculate_employee_leave_accrual(uuid,date)',true,'1006d839cb1f2019acea176d2b0e16ee6a0d923a81c9bdc0f46284797338b1ee','c798f362037f8e9e074b227d42a78574d924195dfe1f05e64a0a6c02dca5e4ab',null),
('private.payroll_request_hours_after(uuid,date)',true,'3f4505db5271b025109f00cb7915435e852c5fa46fa20aabdd499e17786cf541','fa4c121210ae3c9dddb8007460f0d5b633299592ef680ed7579c499f5cd68e0f',null),
('private.approved_leave_hours_after(uuid,text[],date)',true,'251bfea3140b47d8067928c2daf65801555b118a612c3cfa5989fae52141648b','5a4fc5021ba4c613cb9031514ad362b5910ab8aea6d808e46522f1680ef04155',null),
('private.project_annual_leave_balance(uuid,date)',true,'ee185baa6a8dfa834b77cdfeb60339e70d39f42915ec00112142536126c4de4a','b88e6a78a3c43681496f9649611cc06df507955bf10929f1b27970cd2ff848d0',null),
('private.enforce_banked_annual_leave_request()',true,'ae1525bd291ea9265dd731a91eefb00b9f33dc3693577c1e73c3a2edb5186350','701b0c8de1a8d099430f8abf5feda4f73d3bb6146e3a1ef0f2e6ec3aca38a09f',null),
('private.leave_payroll_balance_sufficient(uuid)',true,'c38b9655a39149fc1d8b6c4d1f538f1cca22cf248ea61c2b9ba18f0022c56814','9360cad546ee72d8297c8aabdfc30ec93177576f4c85af9ce0019f79e9b270ec',null),
('public.get_leave_priority_workspace(uuid)',true,'14f3fab427dcf668cea958a12c5f63420a2a213a1f042e8ac96d33eb28c8010a','387adba7c8121c288ec8014047867a1287e521a3d51413167bb51ef477e1511d',null),
('private.leave_request_required_hours(uuid)',true,'681d232c53dbe0588b6b3385536046e0babc58bef865f6d268120bb9975ffbc5','5dbc557b82ea473692dc0dd2fe82443114e0c7287b4e69321235d56fc96641f7',null),
('public.stage_payroll_balance_import(uuid,text,jsonb,jsonb)',true,'df1e25106f7352bd6e47d409833595520072aac3773a7afbca33e4d31e8af600','df1e25106f7352bd6e47d409833595520072aac3773a7afbca33e4d31e8af600',null),
('private.freeze_payroll_balance_comparison(uuid)',true,'23439afa06e8c51f8da3d221684f08e6a1e184a9ab555f9112dd081cfebae9b5','312caf027b965cb7cb1ae07571f2d73d7326571211efc4c64de42607f52cdb60',null),
('private.payroll_closing_snapshot_guard()',true,'cfa2d5e78095d24027a37c973d3b895f93edc2dfa22fb8b1dee1303544fb8512','4c1f3d978922f27297961d2aff9ea6211e7a219a88fdc541683187589101e4aa',null),
('private.payroll_balance_import_batch_projection_before_comparison(uuid)',true,'6a56ff1e9d48891b812edb8aae567a36cac4363ef6d1ecd8006740df60b45a4b','841639117403118f2f571ca745d7739473e3c0d35d41ca938faf668bb82f375f',null),
('private.payroll_closing_fingerprint(uuid)',true,'fcb3cd13d50f90db2d48d99b2fe894a1e8a1d276acec44a89636e4ede393f664','b493117f4f48dd813f551893802309f988d634b3af14ab1a18a40ce871763c5c',null),
('public.preview_payroll_closing_reconciliation(uuid)',true,'25a70dc8133395f81a0b535190697f62078a32ca9711d4ce3a6bcaff50b575e2','15b3d80bed8a81958798f55e1154cd5d6710cae6055959e63dd4f612138cd8c6',null),
('public.submit_my_leave_request(text,date,date,time,time,text)',true,'e9b1becc475538749d869e20b1097e3db00abd54f4fba84103d312ea92f9268c','f356cac9b4720d4a05c715867fc8a64b216c121adc4c900353e869f40b9ca915',null),
('public.submit_selected_employee_leave_request(uuid,text,date,date,time,time,text)',true,'86c48e29da1aad4a3bca871bacaa7e58f8cd79ddffd741239653e3211cb8e22e','0d4c6c27b4148950c14fb1e83c23f197ced06fb128502ce345dde75289467c07',null),
('private.openclaw_submit_self(uuid,text,date,date,time,time,text)',true,'c07b73136a9d569286e30131d0bfb8fc98ae47a7cb9a0047c3473921ff6bac8f','9fc31b148db1bb70cc137cf50013dee23920b3fb33539f92ef2486f52051ea2e',null),
('public.set_employee_leave_accrual_policy(uuid,numeric,numeric,numeric,boolean,boolean,text)',true,'5801f93155c7b4e9d6cb40e51bacbff7643c8dc7cffbb0f644165d6a5b5fa8d6','c53f9141657702799d4db13a6eb0a0d39cdf6c93aabfb56de616e7069a4db0f5',null),
('private.leave_bank_basis(uuid,text)',false,null,'b6ad67f7ad0b2c11c51c70c91fa7276abc469a3ac9ed305e1b0357394aa01faf','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.leave_payroll_day_hours(uuid,date)',false,null,'b4a35fba7a47bc4c82b1a47747117c511d91f22e76eed163ee2f3a4d8650985d','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.calculate_leave_entitlement(uuid,text,date)',false,null,'7e5156169f5079119cdc98072940b9df9d08f1f7b055fa1e6075868d07bb65e6','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.leave_request_quantity(uuid,date,date,time,time,numeric)',false,null,'68f9448e18dfdf34d1bea1cc4d558fc6669e840e92dfee8bfebec740673c8b0b','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb),
('private.adopt_leave_bank_sources(text,text,jsonb)',false,null,'ba43296857b750d82797027130e753acd21569cf814e6d9616d2127f6b5614de','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":false}'::jsonb),
('private.reject_leave_bank_source_mutation()',false,null,'c7582653b887df78b36e447364aa428504e6f401772362aa0477192728afb296','{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":false}'::jsonb),
('public.preview_annual_leave_request(uuid,date,date,time,time,uuid)',false,null,'ee919150e1caf4b47f3dd36e23b11b33aa5225b7042ca6ae6307e2b65132cd9f','{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"security_definer":true}'::jsonb);
create temporary table annual_source_relation_spec(schema_name text,relation_name text,relation_kind text,primary key(schema_name,relation_name)) on commit drop;
insert into annual_source_relation_spec values
('private','leave_bank_sources','r'),
('private','leave_bank_adoption_receipts','r'),
('private','leave_payroll_calendars','r'),
('private','leave_bank_sources_pkey','i'),
('private','leave_bank_adoption_receipts_pkey','i'),
('private','leave_payroll_calendars_pkey','i'),
('private','leave_bank_sources_latest','i'),
('private','leave_bank_adoption_receipts_owner_key_key','i'),
('private','leave_bank_adoption_receipts_plan_hash_key','i');
do $annual_source_function_predecessor$ declare item record; begin
  if (select count(*) from annual_source_function_spec where is_existing)<>18 or (select count(*) from annual_source_function_spec where not is_existing)<>7
    or exists(select 1 from annual_source_relation_spec s join pg_namespace n on n.nspname=s.schema_name join pg_class c on c.relnamespace=n.oid and c.relname=s.relation_name) then
    raise exception 'Annual source bank scope or new-relation predecessor differs.' using errcode='55000';
  end if;
  for item in select * from annual_source_function_spec loop
    if item.is_existing then
      if item.before_sha256 is null or encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
        raise exception 'Annual source bank predecessor function differs: %',item.signature using errcode='55000';
      end if;
    elsif to_regprocedure(item.signature) is not null then
      raise exception 'Annual source bank new function already exists: %',item.signature using errcode='55000';
    end if;
  end loop;
end $annual_source_function_predecessor$;
create temporary table annual_source_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from annual_source_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $annual_source_collector$ declare query text; anchor text; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Annual source bank collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.annual_source_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end $annual_source_collector$;
create temporary table annual_source_catalog_before on commit drop as select * from pg_temp.annual_source_catalog();
create function pg_temp.annual_source_table_metadata(p_table oid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',case when c.relacl::text='{postgres=arwdDxtm/postgres}' then '{postgres=arwdDxt/postgres}' else c.relacl::text end,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions,
 'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'acl',a.attacl::text,'identity',a.attidentity,'generated',a.attgenerated,'collation',case when a.attcollation=0 then null else a.attcollation::regcollation::text end,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'toast_table',(select jsonb_build_object('owner',pg_get_userbyid(t.relowner),'acl',t.relacl::text,'options',t.reloptions,'rls',t.relrowsecurity,'force_rls',t.relforcerowsecurity) from pg_class t where t.oid=c.reltoastrelid),
 'toast_indexes',(select coalesce(jsonb_agg((to_jsonb(i)-array['indexrelid','indrelid','indclass','indcollation'])||jsonb_build_object('owner',pg_get_userbyid(ic.relowner),'acl',ic.relacl::text,'options',ic.reloptions,'opclasses',array(select n.nspname||'.'||o.opcname from unnest(i.indclass) with ordinality u(class_id,position) join pg_opclass o on o.oid=u.class_id join pg_namespace n on n.oid=o.opcnamespace order by u.position),'definition',replace(pg_get_indexdef(i.indexrelid),c.oid::text,'<parent>')) order by i.indexrelid),'[]') from pg_index i join pg_class ic on ic.oid=i.indexrelid where i.indrelid=c.reltoastrelid),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid),'deferrable',condeferrable,'deferred',condeferred,'validated',convalidated) order by conname),'[]') from pg_constraint where conrelid=c.oid),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid),'function_sha256',encode(extensions.digest(pg_get_functiondef(tgfoid),'sha256'),'hex')) order by tgname),'[]') from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'permissive',polpermissive,'roles',array(select rolname from pg_roles where oid=any(polroles) order by rolname),'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) order by polname),'[]') from pg_policy where polrelid=c.oid))
from pg_class c where c.oid=p_table;
$$;
create function pg_temp.annual_source_index_metadata(p_index oid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'definition',pg_get_indexdef(c.oid),'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,'immediate',i.indimmediate,'clustered',i.indisclustered,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'replica_identity',i.indisreplident,'nulls_not_distinct',i.indnullsnotdistinct,'columns',i.indnatts,'key_columns',i.indnkeyatts)
from pg_class c join pg_index i on i.indexrelid=c.oid where c.oid=p_index;
$$;
create function pg_temp.annual_source_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'column_defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from annual_source_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname)),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from pg_class c join pg_namespace cn on cn.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=cn.nspname and s.relation_name=c.relname where s.relation_kind='r' and (t.typrelid=c.oid or t.typelem=c.reltype))),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and not a.attisdropped and a.attnum>0 and not exists(select 1 from annual_source_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname)),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and not exists(select 1 from annual_source_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname)),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k where not exists(select 1 from pg_namespace n where n.oid=k.connamespace and (n.nspname ~ '^pg_temp_' or n.nspname ~ '^pg_toast_temp_')) and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where c.oid=k.conrelid)),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from annual_source_relation_spec s where s.schema_name=n.nspname and s.relation_name=c.relname) and not exists(select 1 from annual_source_relation_spec s join pg_namespace pn on pn.nspname=s.schema_name join pg_class parent on parent.relnamespace=pn.oid and parent.relname=s.relation_name where s.relation_kind='r' and parent.reltoastrelid=i.indrelid))
);
$$;
create temporary table annual_source_security_before on commit drop as select pg_temp.annual_source_security() value;
create function pg_temp.annual_source_data() returns jsonb language plpgsql stable set search_path='' as $$
declare relation text; result jsonb:='{}'::jsonb; value jsonb; begin
  foreach relation in array array['public.internal_org_people','public.profiles','private.portal_account_admins','private.employee_directory_details','public.leave_requests','private.leave_accrual_policies','private.leave_accrual_day_reviews','private.leave_accrual_calculations','private.employee_annual_leave_balances','private.employee_sick_leave_balances','private.annual_leave_balance_history','private.sick_leave_balance_history','private.payroll_balance_imports','private.payroll_balance_import_batches','private.payroll_balance_import_stage_rows','private.payroll_balance_comparisons','private.payroll_balance_source_archives','private.payroll_closing_receipts','private.payroll_carryforward_events','private.payroll_closing_write_claims','private.confirmed_test_identity_purges'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),''[]''::jsonb) from %s t',relation::regclass) into value;
    result:=result||jsonb_build_object(relation,value);
  end loop;
  return result;
end;
$$;
create temporary table annual_source_data_before on commit drop as select pg_temp.annual_source_data() value;

create table private.leave_bank_adoption_receipts (
 id uuid primary key default gen_random_uuid(), owner_key text not null unique check(length(owner_key) between 1 and 200),
 plan_hash text not null unique check(plan_hash ~ '^[a-f0-9]{64}$'), operator_role text not null,
 created_at timestamptz not null default clock_timestamp(), source_count integer not null check(source_count between 1 and 200)
);
create table private.leave_bank_sources (
 id uuid primary key default gen_random_uuid(), person_id uuid not null references public.internal_org_people(id),
 leave_kind text not null check(leave_kind in ('annual','personal')), hours numeric(12,4) not null check(hours between -10000 and 100000),
 report_date date not null, covered_service_through date check(covered_service_through<=report_date),
 source_kind text not null check(source_kind in ('payroll_report','payslip','manual_snapshot')),
 source_archive_id uuid references private.payroll_balance_source_archives(id),
 source_row_id bigint references private.payroll_balance_import_stage_rows(id), source_import_id uuid references private.payroll_balance_imports(id),
 source_fingerprint text not null check(source_fingerprint ~ '^[a-f0-9]{64}$'), note text not null check(length(note) between 1 and 2000),
 adopted_at timestamptz not null default clock_timestamp(), operator_role text not null,
 adoption_receipt_id uuid references private.leave_bank_adoption_receipts(id),
 legacy_snapshot_fingerprint text check(legacy_snapshot_fingerprint ~ '^[a-f0-9]{64}$'),
 included_usage jsonb not null default '[]'::jsonb check(jsonb_typeof(included_usage)='array' and jsonb_array_length(included_usage)<=200)
);
create index leave_bank_sources_latest on private.leave_bank_sources(person_id,leave_kind,adopted_at desc,id desc);
create table private.leave_payroll_calendars (
 person_id uuid primary key references public.internal_org_people(id), calendar_key text not null check(calendar_key in ('victoria','none'))
);
alter table private.leave_bank_sources enable row level security;
alter table private.leave_bank_adoption_receipts enable row level security;
alter table private.leave_payroll_calendars enable row level security;
alter table private.leave_bank_sources force row level security;
alter table private.leave_bank_adoption_receipts force row level security;
alter table private.leave_payroll_calendars force row level security;
revoke all on private.leave_bank_sources,private.leave_bank_adoption_receipts,private.leave_payroll_calendars from public,anon,authenticated,service_role;
create function private.reject_leave_bank_source_mutation() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Leave bank source evidence is immutable.' using errcode='55000'; end $$;
revoke all on function private.reject_leave_bank_source_mutation() from public,anon,authenticated,service_role;
create trigger leave_bank_sources_immutable before update or delete on private.leave_bank_sources for each row execute function private.reject_leave_bank_source_mutation();
create trigger leave_bank_receipts_immutable before update or delete on private.leave_bank_adoption_receipts for each row execute function private.reject_leave_bank_source_mutation();
create trigger reject_retired_test_identity_reference before insert or update on private.leave_bank_sources for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.leave_bank_adoption_receipts for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.leave_payroll_calendars for each row execute function private.reject_retired_test_identity_reference();

create function private.leave_bank_basis(p_person uuid,p_kind text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare src private.leave_bank_sources%rowtype; legacy jsonb; bank numeric; day date; fingerprint text; provenance text;
 proof jsonb; req public.leave_requests%rowtype; carry private.payroll_carryforward_events%rowtype; included numeric;
 included_pending numeric; covered_qty numeric; retained numeric:=0; seen uuid[]:='{}'; invalid_proof boolean:=false; invalid_carry boolean:=false;
begin
 if p_kind not in ('annual','personal') then raise exception 'Unknown leave entitlement.' using errcode='22023'; end if;
 if p_kind='annual' then select to_jsonb(b),case when not b.is_example then b.hours end,b.as_of into legacy,bank,day from private.employee_annual_leave_balances b where person_id=p_person;
 else select to_jsonb(b),b.hours,b.as_of into legacy,bank,day from private.employee_sick_leave_balances b where person_id=p_person; end if;
 select * into src from private.leave_bank_sources where person_id=p_person and leave_kind=p_kind order by adopted_at desc,id desc limit 1;
 if found then
  if jsonb_typeof(src.included_usage)<>'array' or jsonb_array_length(src.included_usage)>200 then invalid_proof:=true;
  elsif jsonb_array_length(src.included_usage)>0 and src.covered_service_through is null then invalid_proof:=true;
  else
   for proof in select value from jsonb_array_elements(src.included_usage) loop
    if jsonb_typeof(proof)<>'object' then invalid_proof:=true;exit;end if;
    if (select count(*) from jsonb_object_keys(proof))<>5 or not(proof ?& array['requestId','includedHours','includedPendingHours','requestFingerprint','evidenceHash'])
      or coalesce(proof->>'requestId','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(proof->>'includedHours','')!~'^[0-9]+([.][0-9]+)?$' or coalesce(proof->>'includedPendingHours','')!~'^[0-9]+([.][0-9]+)?$'
      or coalesce(proof->>'requestFingerprint','')!~'^[0-9a-f]{64}$' or coalesce(proof->>'evidenceHash','')!~'^[0-9a-f]{64}$' then invalid_proof:=true;exit;end if;
    if (proof->>'requestId')::uuid=any(seen) then invalid_proof:=true;exit;end if;
    seen:=array_append(seen,(proof->>'requestId')::uuid);
    included:=(proof->>'includedHours')::numeric;included_pending:=(proof->>'includedPendingHours')::numeric;
    if included<=0 or included>100000 or included_pending<0 or included_pending>included then invalid_proof:=true;exit;end if;
    select * into req from public.leave_requests where id=(proof->>'requestId')::uuid and employee_person_id=p_person;
    if not found or req.status<>'approved' or req.pay_treatment is distinct from 'paid_entitlement'
      or (p_kind='annual' and (req.leave_type is distinct from 'annual' or req.request_type_label is distinct from 'Annual leave'))
      or (p_kind='personal' and (req.leave_type is distinct from 'personal' or req.request_type_label is null or req.request_type_label not in ('Sick leave','Carer''s leave')))
      or proof->>'requestFingerprint' is distinct from private.payroll_request_fingerprint(to_jsonb(req)) then invalid_proof:=true;exit;end if;
    covered_qty:=private.payroll_request_hours_after(req.id,req.start_date-1)-private.payroll_request_hours_after(req.id,src.covered_service_through);
    if covered_qty is null or included>covered_qty then invalid_proof:=true;exit;end if;
    if included_pending>0 then
     select * into carry from private.payroll_carryforward_events where person_id=p_person and leave_kind=p_kind and request_id=req.id order by id desc limit 1;
     if not found or carry.request_fingerprint is distinct from proof->>'requestFingerprint' or included_pending>carry.pending_hours
       or least(req.end_date,carry.through_date)>src.covered_service_through then invalid_proof:=true;exit;end if;
    end if;
   end loop;
  end if;
  for carry in select distinct on(request_id,leave_kind) * from private.payroll_carryforward_events where person_id=p_person and leave_kind=p_kind order by request_id,leave_kind,id desc loop
   select * into req from public.leave_requests where id=carry.request_id;
   if not found or carry.request_fingerprint is distinct from private.payroll_request_fingerprint(to_jsonb(req))
     or carry.company_key is distinct from(select company_key from public.internal_org_people where id=p_person) then invalid_carry:=true;end if;
   included_pending:=0;
   if not invalid_proof then
    select coalesce(sum((value->>'includedPendingHours')::numeric),0) into included_pending from jsonb_array_elements(src.included_usage) where value->>'requestId'=carry.request_id::text;
   end if;
   retained:=retained+greatest(0,carry.pending_hours-included_pending);
  end loop;
  fingerprint:=encode(extensions.digest(coalesce(legacy,'null'::jsonb)::text,'sha256'),'hex');
  return jsonb_build_object('bankHours',src.hours,'reportDate',src.report_date,'coveredThrough',src.covered_service_through,
   'sourceKind',src.source_kind,'sourceId',src.id,'adoptedAt',src.adopted_at,'updatedAt',src.adopted_at,'includedUsage',src.included_usage,'retainedHours',retained,
   'status',case when invalid_proof or invalid_carry or (src.legacy_snapshot_fingerprint is not null and src.legacy_snapshot_fingerprint<>fingerprint) then 'needs_review'
    when src.covered_service_through is null then 'coverage_unconfirmed' else 'current' end);
 end if;
 retained:=private.payroll_retained_hours(p_person,p_kind);
 if legacy->>'source_import_id' is not null and legacy->>'closing_receipt_id' is null then
  return jsonb_build_object('bankHours',bank,'reportDate',day,'coveredThrough',null,'sourceKind','payroll_report','sourceId',legacy->'source_import_id','updatedAt',legacy->'updated_at','includedUsage','[]'::jsonb,'retainedHours',retained,'status',case when bank is null then 'not_configured' else 'coverage_unconfirmed' end);
 end if;
 if legacy->>'closing_receipt_id' is not null then select case when operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where id=(legacy->>'closing_receipt_id')::uuid; end if;
 return jsonb_build_object('bankHours',bank,'reportDate',day,'coveredThrough',day,'sourceKind',provenance,'updatedAt',legacy->'updated_at','includedUsage','[]'::jsonb,'retainedHours',retained,
  'status',case when bank is null then 'not_configured' else 'current' end);
end $$;
revoke all on function private.leave_bank_basis(uuid,text) from public,anon,authenticated,service_role;

create function private.leave_request_quantity(p_person uuid,p_start date,p_end date,p_start_time time,p_end_time time,p_hours numeric)
returns numeric language plpgsql stable security definer set search_path='' as $$
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
   if calendar is null then return null; elsif calendar='victoria' then continue; end if;
  end if;
  ordinary_days:=ordinary_days+1;
  if p_start_time is not null then
   elapsed:=extract(epoch from(p_end_time-p_start_time))/3600;
   if elapsed<=0 or elapsed>24 or (p_hours is not null and abs(p_hours-elapsed)>0.0001) then return null; end if;
   total:=total+elapsed;
  elsif p_start=p_end and p_hours is not null then
   if p_hours<=0 or p_hours>24 or p_hours::text in ('NaN','Infinity','-Infinity') then return null; end if;
   total:=total+p_hours;
  else total:=total+ordinary; end if;
 end loop;
 if p_hours is not null and p_start<>p_end then if p_hours>ordinary_days*24 then return null;end if;return p_hours;end if;
 return total;
end $$;
revoke all on function private.leave_request_quantity(uuid,date,date,time,time,numeric) from public,anon,authenticated,service_role;

create function private.leave_payroll_day_hours(p_request uuid,p_day date) returns numeric language plpgsql stable security definer set search_path='' as $$
declare r public.leave_requests%rowtype; pol private.leave_accrual_policies%rowtype; ordinary numeric; calendar text; total numeric; elapsed numeric;
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
  if calendar is null then return null; elsif calendar='victoria' then return 0; end if;
 end if;
 if r.start_time is not null or r.end_time is not null then
  if r.start_date<>r.end_date or r.start_time is null or r.end_time is null then return null; end if;
  elapsed:=extract(epoch from(r.end_time-r.start_time))/3600;
  if elapsed<=0 or elapsed>24 or (r.hours is not null and abs(r.hours-elapsed)>0.0001) then return null; end if;
  return elapsed;
 end if;
 if r.hours is not null then
  if r.start_date=r.end_date and r.hours>0 and r.hours<=24 then return r.hours; end if;
  if r.pay_treatment='paid_entitlement' then
   total:=private.leave_request_quantity(r.employee_person_id,r.start_date,r.end_date,null,null,null);
   if abs(total-r.hours)>0.0001 then total:=null;end if;
  else
   select case when count(*) filter(where p.id is null or cardinality(p.weekdays)<>(select count(distinct value) from unnest(p.weekdays) value))>0 then null else coalesce(sum(case when extract(isodow from d)::integer=any(p.weekdays) then p.weekly_hours/cardinality(p.weekdays) else 0 end),0) end into total
    from generate_series(r.start_date,r.end_date,interval '1 day')d left join lateral(select * from private.leave_accrual_policies where person_id=r.employee_person_id and effective_from<=d::date order by effective_from desc,created_at desc,id desc limit 1)p on true;
   if abs(total-r.hours)>0.0001 then total:=null;end if;
  end if;
  if total is null then return null; end if;
 end if;
 return ordinary;
end $$;
revoke all on function private.leave_payroll_day_hours(uuid,date) from public,anon,authenticated,service_role;

create or replace function private.payroll_request_hours_after(p_request uuid,p_after date) returns numeric language sql stable security definer set search_path='' as $$
 select case when p_after is null then null when r.end_date<=p_after then 0 when p_after<r.start_date and r.hours is not null and r.pay_treatment='paid_entitlement' then private.leave_request_quantity(r.employee_person_id,r.start_date,r.end_date,r.start_time,r.end_time,r.hours) else
 (select case when count(*) filter(where qty is null)>0 then null else coalesce(sum(qty),0) end
 from(select private.leave_payroll_day_hours(r.id,d::date) qty from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') d) amounts) end
 from public.leave_requests r where r.id=p_request;
$$;

create or replace function private.approved_leave_hours_after(p_person_id uuid,p_leave_types text[],p_after date) returns numeric language plpgsql stable security definer set search_path='' as $$
declare r public.leave_requests%rowtype; total numeric:=0; qty numeric; kind text; basis jsonb; cutoff date; pending numeric; carry record; included numeric; window_from date; window_through date;
begin
 if p_after is null then return null; end if;
 kind:=case when 'Annual leave'=any(p_leave_types) then 'annual' when 'Sick leave'=any(p_leave_types) or 'Carer''s leave'=any(p_leave_types) then 'personal' end;
 if kind is not null then
  basis:=private.leave_bank_basis(p_person_id,kind);
  if basis->>'status'='needs_review' then return null; end if;
  if basis->>'sourceId' is not null then
   if basis->>'coveredThrough' is null then
    if exists(select 1 from public.leave_requests where employee_person_id=p_person_id and status='approved' and request_type_label=any(p_leave_types) and pay_treatment='paid_entitlement' and start_date<=(basis->>'reportDate')::date
      and end_date>coalesce((select min(effective_from)-1 from private.leave_accrual_policies where person_id=p_person_id),date '1900-01-01')) then return null; end if;
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
   elsif window_from>cutoff then continue;
   else return null;end if;
  end loop;
 else
  select coalesce(sum(e.pending_hours),0) into pending from (select distinct on(e.request_id,e.leave_kind) e.* from private.payroll_carryforward_events e where e.person_id=p_person_id and (kind is null or e.leave_kind=kind) and e.through_date<=p_after order by e.request_id,e.leave_kind,e.id desc)e;
  total:=total+pending;
 end if;
 return total;
end $$;

create function private.calculate_leave_entitlement(p_person uuid,p_kind text,p_through date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare basis jsonb; pol private.leave_accrual_policies%rowtype; rev private.leave_accrual_day_reviews%rowtype;
 day date; cutoff date; through_day date; review_day date; start_day date; end_day date; ordinary numeric; eligible numeric; earned_numerator numeric:=0; taken numeric:=0;
 status text; qty numeric; r record; requires_actual boolean; policy_id uuid; terms jsonb:='{}'; term jsonb; future_unpaid numeric; eligibility_status text:='current'; usage_review_day date; usage_through date;
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
   select * into rev from private.leave_accrual_day_reviews where person_id=p_person and service_date=day order by created_at desc,id desc limit 1;
   requires_actual:=pol.requires_review and rev.id is null; future_unpaid:=0;
   for r in select req.* from public.leave_requests req where req.employee_person_id=p_person and req.status='approved' and day between req.start_date and req.end_date loop
    qty:=private.leave_payroll_day_hours(r.id,day);
    if ordinary>0 and (r.pay_treatment is null or r.pay_treatment not in ('paid_entitlement','paid_other','unpaid')) then requires_actual:=true; end if;
    if ordinary>0 and r.pay_treatment='unpaid' then
     if day<=(now() at time zone 'Australia/Melbourne')::date-1 or qty is null then requires_actual:=true; else future_unpaid:=future_unpaid+qty*420; end if;
    end if;
    if day<=(now() at time zone 'Australia/Melbourne')::date-1 and r.pay_treatment='paid_entitlement' and
     ((p_kind='annual' and r.request_type_label='Annual leave') or(p_kind='personal' and r.request_type_label in ('Sick leave','Carer''s leave'))) and (qty is null or qty>0) and rev.id is null then usage_review_day:=coalesce(usage_review_day,day); end if;
   end loop;
   if (rev.id is not null and rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,day)) or (requires_actual and rev.id is null) then status:='needs_review';eligibility_status:='needs_review';review_day:=day;exit; end if;
   eligible:=case when pol.enabled or pol.requires_review then coalesce(case when p_kind='annual' then rev.annual_eligible_hours else rev.personal_eligible_hours end*420,greatest(0,ordinary-future_unpaid)) else 0 end;
   term:=coalesce(terms->pol.id::text,jsonb_build_object('fromDate',day,'weeklyHours',pol.weekly_hours,'weekdays',pol.weekdays,'annualWeeks',pol.annual_weeks,'personalWeeks',pol.personal_weeks,'eligibleNumerator',0));
   term:=term||jsonb_build_object('throughDate',day,'eligibleNumerator',(term->>'eligibleNumerator')::numeric+eligible);terms:=jsonb_set(terms,array[pol.id::text],term);
   earned_numerator:=earned_numerator+eligible*case when p_kind='annual' then pol.annual_weeks else pol.personal_weeks end;
   through_day:=day;
  end loop;
 end if;
 if cutoff is not null and p_through is not null then
  usage_through:=greatest(cutoff,least(p_through,(now() at time zone 'Australia/Melbourne')::date-1));
  for rev in select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=p_person and service_date>cutoff and service_date<=usage_through order by service_date,created_at desc,id desc loop
   if rev.service_date<coalesce(start_day,rev.service_date) or rev.service_date>coalesce(end_day,rev.service_date) then continue;end if;
   if rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,rev.service_date) then
    usage_review_day:=least(usage_review_day,rev.service_date);continue;
   end if;
   taken:=taken+coalesce(case when p_kind='annual' then rev.annual_taken_hours else rev.personal_taken_hours end,0);
  end loop;
 end if;
 if usage_review_day is not null then status:='needs_review';review_day:=least(review_day,usage_review_day); end if;
 return jsonb_build_object('status',status,'eligibilityStatus',eligibility_status,'usageThroughDate',usage_through,'reviewDate',review_day,'hours',round((basis->>'bankHours')::numeric+earned_numerator/(420*52)-taken,4),
  'exactHours',(basis->>'bankHours')::numeric+earned_numerator/(420*52)-taken,'earned',earned_numerator/(420*52),'taken',taken,
  'asOf',coalesce(through_day,(basis->>'reportDate')::date),'payrollHours',basis->'bankHours','payrollDate',basis->'reportDate',
  'coveredThrough',basis->'coveredThrough','sourceKind',basis->'sourceKind','policyId',policy_id,
  'terms',coalesce((select jsonb_agg((value-'eligibleNumerator')||jsonb_build_object('eligibleHours',(value->>'eligibleNumerator')::numeric/420,
   'accruedHours',(value->>'eligibleNumerator')::numeric*(value->>case when p_kind='annual' then 'annualWeeks' else 'personalWeeks' end)::numeric/(420*52)) order by value->>'fromDate') from jsonb_each(terms)),'[]'::jsonb));
end $$;
revoke all on function private.calculate_leave_entitlement(uuid,text,date) from public,anon,authenticated,service_role;

create or replace function private.calculate_employee_leave_accrual(p_person uuid,p_through date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a jsonb; s jsonb; status text;
begin
 a:=private.calculate_leave_entitlement(p_person,'annual',least(p_through,(now() at time zone 'Australia/Melbourne')::date-1));
 s:=private.calculate_leave_entitlement(p_person,'personal',least(p_through,(now() at time zone 'Australia/Melbourne')::date-1));
 status:=case when a->>'status'='needs_review' or s->>'status'='needs_review' then 'needs_review' when a->>'status'='current' or s->>'status'='current' then 'current' else 'not_configured' end;
 return jsonb_build_object('status',status,'reviewDate',least((a->>'reviewDate')::date,(s->>'reviewDate')::date),'policyId',coalesce(a->'policyId',s->'policyId'),
  'annualStatus',a->'status','personalStatus',s->'status','annualHours',a->'hours','personalHours',s->'hours',
  'annualExactHours',a->'exactHours','personalExactHours',s->'exactHours','annualAsOf',a->'asOf','personalAsOf',s->'asOf',
  'annualPayrollHours',a->'payrollHours','personalPayrollHours',s->'payrollHours','annualPayrollDate',a->'payrollDate','personalPayrollDate',s->'payrollDate',
  'annualEarned',a->'earned','personalEarned',s->'earned','annualTaken',a->'taken','personalTaken',s->'taken');
end $$;

create or replace function private.project_annual_leave_balance(p_person uuid,p_start date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare basis jsonb; c jsonb; approved numeric; consumed numeric:=0; day date; qty numeric; taken numeric; r record; rev private.leave_accrual_day_reviews%rowtype; terms jsonb; projection_status text;
begin
 basis:=private.leave_bank_basis(p_person,'annual');
 if p_start is null or basis->>'bankHours' is null then return jsonb_build_object('status','unavailable','projectedDate',p_start); end if;
 c:=private.calculate_leave_entitlement(p_person,'annual',p_start-1);
 approved:=private.approved_leave_hours_after(p_person,array['Annual leave'],(basis->>'reportDate')::date);
 if basis->>'coveredThrough' is not null then
  for rev in select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=p_person and service_date>(basis->>'coveredThrough')::date and service_date<p_start and service_date<=(c->>'usageThroughDate')::date order by service_date,created_at desc,id desc loop
   if rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,rev.service_date) then approved:=null;exit; end if;
   qty:=0;
   for r in select id from public.leave_requests where employee_person_id=p_person and status='approved' and pay_treatment='paid_entitlement' and request_type_label='Annual leave' and rev.service_date between start_date and end_date loop
    taken:=private.leave_payroll_day_hours(r.id,rev.service_date); if taken is null then approved:=null;exit; end if;qty:=qty+taken;
   end loop;
   consumed:=consumed+least(rev.annual_taken_hours,qty);
  end loop;
 end if;
 terms:=c->'terms';projection_status:=case when approved is null or c->>'status'='not_configured' or basis->>'status'='needs_review' then 'unavailable' when (basis->>'coveredThrough')::date>=p_start then 'banked_only' when basis->>'status'='current' and c->>'eligibilityStatus'='current' then 'projected' else 'banked_only' end;
 return jsonb_build_object('status',projection_status,
  'accrualStatus',c->'status','projectedDate',p_start,'fromDate',(basis->>'coveredThrough')::date+1,'throughDate',p_start-1,
  'payrollDate',basis->'reportDate','bankReportDate',basis->'reportDate','coveredServiceThrough',basis->'coveredThrough','payrollHours',basis->'bankHours',
  'approvedHours',approved,'retainedHours',basis->'retainedHours',
  'balanceSource',basis->'sourceKind','sourceKind',basis->'sourceKind','accruedHours',c->'earned','otherTakenHours',greatest(0,(c->>'taken')::numeric-consumed),
  'availableHours',case when projection_status='unavailable' then null else (basis->>'bankHours')::numeric+(c->>'earned')::numeric-approved-greatest(0,(c->>'taken')::numeric-consumed) end,'terms',terms);
end $$;

create or replace function private.leave_request_required_hours(p_request_id uuid) returns numeric language sql stable security definer set search_path='' as $$
 select case when r.leave_type='annual' and r.request_type_label='Annual leave' and r.pay_treatment='paid_entitlement' then private.leave_request_quantity(r.employee_person_id,r.start_date,r.end_date,r.start_time,r.end_time,r.hours) else private.payroll_request_hours_after(r.id,r.start_date-1) end from public.leave_requests r where r.id=p_request_id;
$$;

create or replace function private.enforce_banked_annual_leave_request() returns trigger language plpgsql volatile security definer set search_path='' as $$
declare projection jsonb; required numeric; available numeric; own_hours numeric:=0; basis jsonb;
 classification text; budget_classification text; changed boolean:=true; days integer; review private.leave_accrual_day_reviews%rowtype; scheduled numeric; overlapping integer;
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
  for review in select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=old.employee_person_id and service_date>coalesce((basis->>'coveredThrough')::date,(basis->>'reportDate')::date) and service_date<=(projection->>'throughDate')::date and service_date between old.start_date and old.end_date order by service_date,created_at desc,id desc loop
   if review.request_fingerprint<>private.leave_accrual_request_fingerprint(old.employee_person_id,review.service_date) then own_hours:=null;exit;end if;
   if review.annual_taken_hours>0 then
    select count(*) into overlapping from public.leave_requests r where r.employee_person_id=old.employee_person_id and r.status='approved' and r.request_type_label='Annual leave' and r.pay_treatment='paid_entitlement' and review.service_date between r.start_date and r.end_date;
    scheduled:=private.leave_payroll_day_hours(old.id,review.service_date);
    if overlapping<>1 or scheduled is null then own_hours:=null;exit;end if;
    own_hours:=greatest(0,own_hours-least(review.annual_taken_hours,scheduled));
   end if;
  end loop;
 end if;
 available:=(projection->>'availableHours')::numeric+own_hours;
 if new.hours is not null and new.hours>available then raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023'; end if;
 if projection->>'status'='unavailable' or required is null or required<=0 or available is null or required::text in('NaN','Infinity','-Infinity') then
  raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023'; end if;
 if required>available then
  if projection->>'status'='banked_only' then raise exception 'Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.' using errcode='22023'; end if;
  raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023'; end if;
 return new;
end $$;

create or replace function private.leave_payroll_balance_sufficient(p_request_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leave_requests r join private.leave_balance_approvals a on a.request_id=r.id
 join public.internal_org_people p on p.id=r.employee_person_id and p.is_active
 cross join lateral(select private.project_annual_leave_balance(p.id,(now() at time zone 'Australia/Melbourne')::date) result)c
 cross join lateral(select private.leave_bank_basis(p.id,'annual') result)b
 where r.id=p_request_id and r.status='submitted' and r.record_origin='portal' and r.approval_required and r.request_type_label='Annual leave'
 and c.result->>'status' in ('projected','banked_only') and c.result->>'accrualStatus'='current' and(c.result->>'availableHours')::numeric>=a.required_hours
 and case when (b.result->>'coveredThrough')::date<(now() at time zone 'Australia/Melbourne')::date then private.payroll_request_unconsumed_hours(p.id,(b.result->>'coveredThrough')::date,(now() at time zone 'Australia/Melbourne')::date-1) is not null else true end
 and case when c.result->>'status'='projected' then greatest((b.result->>'coveredThrough')::date,(c.result->>'throughDate')::date)>=(a.approved_at at time zone 'Australia/Melbourne')::date
 else b.result->>'status'='current' and (b.result->>'updatedAt')::timestamptz>=a.approved_at and (b.result->>'coveredThrough')::date>=(a.approved_at at time zone 'Australia/Melbourne')::date end);
$$;

create or replace function public.get_leave_priority_workspace(p_preview_person_id uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w jsonb; person jsonb; people jsonb:='[]'; requests jsonb:='[]'; req jsonb; pid uuid; a jsonb; s jsonb; c jsonb; pr jsonb; pol private.leave_accrual_policies%rowtype; qty numeric; approved numeric; consumed numeric; actual_qty numeric; rr record; review private.leave_accrual_day_reviews%rowtype;
begin
 w:=public.get_leave_priority_workspace_before_carryforward(p_preview_person_id);
 for person in select value from jsonb_array_elements(w->'people') loop
  pid:=(person->>'personId')::uuid;
  if coalesce((person->>'canViewBalance')::boolean,false) or coalesce((person->>'canViewSickBalance')::boolean,false) then
   select * into pol from private.leave_accrual_policies where person_id=pid and effective_from<=(now() at time zone 'Australia/Melbourne')::date order by effective_from desc,created_at desc,id desc limit 1;
   person:=person||jsonb_build_object('requestWorkPolicy',case when pol.id is null then null else jsonb_build_object('weeklyHours',pol.weekly_hours,'weekdays',pol.weekdays,'calendarKey',(select calendar_key from private.leave_payroll_calendars where person_id=pid)) end);
  end if;
  if coalesce((person->>'canViewBalance')::boolean,false) and coalesce((person->>'paidLeave')::boolean,false) then
   a:=private.leave_bank_basis(pid,'annual');c:=private.calculate_leave_entitlement(pid,'annual',(now() at time zone 'Australia/Melbourne')::date-1);
   pr:=private.project_annual_leave_balance(pid,(now() at time zone 'Australia/Melbourne')::date);
   person:=person||jsonb_build_object('hours',c->'hours','asOf',c->'asOf','annualPayrollHours',a->'bankHours','annualPayrollDate',a->'reportDate',
    'annualApprovedHours',pr->'approvedHours','annualAvailableHours',pr->'availableHours','annualRetainedHours',pr->'retainedHours',
    'annualBalanceSource',a->'sourceKind','annualSourceKind',a->'sourceKind','annualAccrualStatus',c->'status','annualEligibilityStatus',c->'eligibilityStatus','annualEarnedHours',c->'earned','annualCoveredServiceThrough',a->'coveredThrough');
  end if;
  if coalesce((person->>'canViewSickBalance')::boolean,false) then
   s:=private.leave_bank_basis(pid,'personal');c:=private.calculate_leave_entitlement(pid,'personal',(now() at time zone 'Australia/Melbourne')::date-1);
   approved:=private.approved_leave_hours_after(pid,array['Sick leave','Carer''s leave'],(s->>'reportDate')::date);
   consumed:=0;
   if s->>'coveredThrough' is not null then
    for review in select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=pid and service_date>(s->>'coveredThrough')::date and service_date<=(c->>'usageThroughDate')::date order by service_date,created_at desc,id desc loop
     if review.request_fingerprint<>private.leave_accrual_request_fingerprint(pid,review.service_date) then approved:=null;exit;end if;
     qty:=0;
     for rr in select id from public.leave_requests where employee_person_id=pid and status='approved' and pay_treatment='paid_entitlement' and request_type_label in ('Sick leave','Carer''s leave') and review.service_date between start_date and end_date loop
      actual_qty:=private.leave_payroll_day_hours(rr.id,review.service_date);if actual_qty is null then approved:=null;exit;end if;qty:=qty+actual_qty;
     end loop;
     consumed:=consumed+least(review.personal_taken_hours,qty);
    end loop;
   end if;
   person:=person||jsonb_build_object('sickHours',c->'hours','sickAsOf',c->'asOf','sickPayrollHours',s->'bankHours','sickPayrollDate',s->'reportDate',
    'sickApprovedHours',approved,'sickAvailableHours',case when c->>'status'='current' then (c->>'exactHours')::numeric-approved+consumed else null end,
    'sickRetainedHours',s->'retainedHours','sickBalanceSource',s->'sourceKind','sickAccrualStatus',c->'status');
  end if;
  people:=people||jsonb_build_array(person);
 end loop;
 for req in select value from jsonb_array_elements(w->'requests') loop
  qty:=private.leave_request_required_hours((req->>'id')::uuid);
  requests:=requests||jsonb_build_array(req||jsonb_build_object('requiredHours',qty));
 end loop;
 return jsonb_set(jsonb_set(w,'{people}',people),'{requests}',requests);
end $$;

create function public.preview_annual_leave_request(p_person_id uuid,p_start_date date,p_end_date date,p_start_time time,p_end_time time,p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w jsonb; result jsonb; pol private.leave_accrual_policies%rowtype; calendar text;
begin
 w:=public.get_leave_priority_workspace(p_preview_person_id);
 if not exists(select 1 from jsonb_array_elements(w->'people') person where person->>'personId'=p_person_id::text and(person->>'canViewBalance')::boolean and(person->>'paidLeave')::boolean) then
  raise exception 'Annual leave balance access denied.' using errcode='42501'; end if;
 perform private.assert_leave_date_range(p_start_date,p_end_date);
 result:=private.project_annual_leave_balance(p_person_id,p_start_date);
 select * into pol from private.leave_accrual_policies where person_id=p_person_id and effective_from<=p_start_date order by effective_from desc,created_at desc,id desc limit 1;
 select calendar_key into calendar from private.leave_payroll_calendars where person_id=p_person_id;
 return result||jsonb_build_object('requestedHours',private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null),
 'quantityPolicy',case when pol.id is null or exists(select 1 from private.leave_accrual_policies where person_id=p_person_id and effective_from>p_start_date and effective_from<=p_end_date) then null else jsonb_build_object('weeklyHours',pol.weekly_hours,'weekdays',pol.weekdays,'calendarKey',calendar,
 'publicHolidayDates',(select coalesce(jsonb_agg(holiday_date order by holiday_date),'[]') from private.victorian_public_holidays where holiday_date between p_start_date and p_end_date)) end);
end $$;
revoke all on function public.preview_annual_leave_request(uuid,date,date,time,time,uuid) from public,anon,authenticated,service_role;
grant execute on function public.preview_annual_leave_request(uuid,date,date,time,time,uuid) to authenticated;

create function private.adopt_leave_bank_sources(p_owner_key text,p_plan_hash text,p_rows jsonb) returns uuid language plpgsql volatile set search_path='' as $$
declare receipt uuid:=gen_random_uuid(); item jsonb; pid uuid; legacy jsonb; old_hash text; stage private.payroll_balance_import_stage_rows%rowtype; imported private.payroll_balance_imports%rowtype; archive private.payroll_balance_source_archives%rowtype; qty numeric;
begin
 if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then raise exception 'Source adoption requires the approved database operator.' using errcode='42501'; end if;
 if p_plan_hash!~'^[a-f0-9]{64}$' or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200 then raise exception 'Invalid source adoption plan.' using errcode='22023'; end if;
 perform private.lock_annual_leave_budget();
 lock table private.employee_annual_leave_balances,private.employee_sick_leave_balances,private.leave_bank_sources,
 private.leave_bank_adoption_receipts,private.payroll_balance_import_stage_rows,private.payroll_balance_imports,private.payroll_balance_source_archives,public.internal_org_people,private.employee_directory_details,public.leave_requests,private.leave_accrual_policies,private.leave_accrual_day_reviews,private.payroll_carryforward_events in share row exclusive mode nowait;
 if exists(select 1 from private.leave_bank_adoption_receipts where owner_key=p_owner_key or plan_hash=p_plan_hash) then raise exception 'Source adoption is already recorded; reconcile readback.' using errcode='55000'; end if;
 insert into private.leave_bank_adoption_receipts(id,owner_key,plan_hash,operator_role,source_count) values(receipt,p_owner_key,p_plan_hash,current_user,jsonb_array_length(p_rows));
 for item in select value from jsonb_array_elements(p_rows) loop
  pid:=(item->>'personId')::uuid;qty:=(item->>'hours')::numeric;
  if item->>'kind' is distinct from 'annual' then raise exception 'This adoption operation is annual only.' using errcode='22023'; end if;
  select to_jsonb(b) into legacy from private.employee_annual_leave_balances b where b.person_id=pid;
  old_hash:=encode(extensions.digest(coalesce(legacy,'null'::jsonb)::text,'sha256'),'hex');
  if old_hash is distinct from item->>'expectedLegacyHash' then raise exception 'Opening balance changed; reconcile fresh target.' using errcode='40001'; end if;
  if item->>'sourceKind'='payroll_report' then
   select * into strict stage from private.payroll_balance_import_stage_rows where id=(item->>'stageRowId')::bigint;
   select * into strict imported from private.payroll_balance_imports where id=(item->>'identityImportId')::uuid;
   select * into strict archive from private.payroll_balance_source_archives where id=(item->>'archiveId')::uuid;
   if imported.person_id is distinct from pid or stage.source_sha256 is distinct from encode(extensions.digest(archive.source_sha256,'sha256'),'hex') or imported.company_key is distinct from stage.company_key or stage.batch_id is distinct from archive.batch_id
    or stage.annual_hours is distinct from qty or stage.as_of is distinct from (item->>'reportDate')::date
    or stage.normalised_employee_name is distinct from private.normalise_payroll_employee_name(imported.employee_name)
    or (stage.person_id is not null and stage.person_id is distinct from pid)
    or archive.source_sha256 is distinct from item->>'fileSha256'
    or encode(extensions.digest(to_jsonb(stage)::text,'sha256'),'hex') is distinct from item->>'expectedStageHash'
    or encode(extensions.digest(to_jsonb(imported)::text,'sha256'),'hex') is distinct from item->>'expectedIdentityHash'
    or encode(extensions.digest(to_jsonb(archive)::text,'sha256'),'hex') is distinct from item->>'expectedArchiveHash' then raise exception 'Source or stable identity evidence differs.' using errcode='55000'; end if;
  elsif item->>'sourceKind'='payslip' then
   if item->>'coveredThrough' is null or item->>'sourceFingerprint'!~'^[a-f0-9]{64}$' or length(item->>'note')<1 then raise exception 'Payslip coverage evidence required.' using errcode='22023'; end if;
  else raise exception 'Unsupported source adoption kind.' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(item->'includedUsage','[]'::jsonb))<>'array' or jsonb_array_length(coalesce(item->'includedUsage','[]'::jsonb))>200 then raise exception 'Invalid source usage inclusion evidence.' using errcode='22023';end if;
  insert into private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_archive_id,source_row_id,source_import_id,source_fingerprint,note,operator_role,adoption_receipt_id,legacy_snapshot_fingerprint,included_usage)
  values(pid,'annual',qty,(item->>'reportDate')::date,(item->>'coveredThrough')::date,item->>'sourceKind',(item->>'archiveId')::uuid,(item->>'stageRowId')::bigint,(item->>'identityImportId')::uuid,item->>'sourceFingerprint',item->>'note',current_user,receipt,old_hash,coalesce(item->'includedUsage','[]'::jsonb));
  if jsonb_array_length(coalesce(item->'includedUsage','[]'::jsonb))>0 and private.leave_bank_basis(pid,'annual')->>'status'='needs_review' then raise exception 'Source usage inclusion evidence differs.' using errcode='22023';end if;
 end loop;
 return receipt;
end $$;
revoke all on function private.adopt_leave_bank_sources(text,text,jsonb) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.stage_payroll_balance_import(p_actor_user_id uuid, p_source_digest text, p_files jsonb, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb; bid uuid;
begin
  perform 1 from public.profiles profile where profile.id=p_actor_user_id for share;
  result:=public.stage_payroll_balance_import_before_comparison(p_actor_user_id,p_source_digest,p_files,p_rows);
  bid:=(result->>'batchId')::uuid;
  if private.payroll_comparison_only(p_actor_user_id) then
    perform private.freeze_payroll_balance_comparison(bid);
  end if;
  return private.payroll_balance_import_batch_projection(bid);
end;
$function$;


CREATE OR REPLACE FUNCTION private.freeze_payroll_balance_comparison(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare comparison jsonb; differences integer;
begin
  perform 1 from private.payroll_balance_import_batches where id=p_batch_id for update;
  if not found then raise exception 'The payroll import is unavailable.' using errcode='42501'; end if;
  update private.payroll_balance_import_batches set comparison_only=true where id=p_batch_id and not comparison_only;
  with mappings as (
   select distinct prior.company_key,prior.normalised_employee_name,source.person_id
   from private.leave_bank_sources source join private.payroll_balance_import_stage_rows prior on prior.id=source.source_row_id
   join public.internal_org_people p on p.id=source.person_id and p.company_key=prior.company_key
   where source.source_kind='payroll_report'
  ), unique_mappings as (
   select company_key,normalised_employee_name,min(person_id::text)::uuid person_id from mappings group by company_key,normalised_employee_name having count(*)=1
  ) update private.payroll_balance_import_stage_rows s set person_id=m.person_id,match_status=case when p.is_active then 'linked' else 'inactive' end
    from unique_mappings m join public.internal_org_people p on p.id=m.person_id
    where s.batch_id=p_batch_id and s.person_id is null and s.match_status='unmatched' and s.company_key=m.company_key and s.normalised_employee_name=m.normalised_employee_name;
  if not exists(select 1 from private.payroll_balance_comparisons where batch_id=p_batch_id) then
    with values_to_compare as (
      select s.id,s.employee_name,s.company_key,s.as_of,s.match_status,
        v.kind,v.uploaded,v.system_hours,v.system_as_of
      from private.payroll_balance_import_stage_rows s
      cross join lateral(select private.leave_bank_basis(s.person_id,'annual') basis)a
      cross join lateral(select private.leave_bank_basis(s.person_id,'personal') basis)k
      cross join lateral (values
        ('annual',s.annual_hours,case when a.basis->>'status'<>'needs_review' then(a.basis->>'bankHours')::numeric end,(a.basis->>'reportDate')::date),
        ('sick',s.sick_hours,case when k.basis->>'status'<>'needs_review' then(k.basis->>'bankHours')::numeric end,(k.basis->>'reportDate')::date)
      ) v(kind,uploaded,system_hours,system_as_of)
      where s.batch_id=p_batch_id and v.uploaded is not null
    ), compared as (
      select *,match_status<>'linked' or system_hours is null or system_as_of is distinct from as_of or round(uploaded,2) is distinct from round(system_hours,2) as different
      from values_to_compare
    )
    select jsonb_agg(jsonb_build_object('rowId',id,'employeeName',employee_name,'company',company_key,'kind',kind,
      'uploadedHours',uploaded,'systemHours',system_hours,'fileAsOf',as_of,'systemAsOf',system_as_of,
      'matchStatus',match_status,'different',different) order by company_key,employee_name,kind),count(*) filter(where different)
      into comparison,differences from compared;
    insert into private.payroll_balance_comparisons(batch_id,rows,difference_count)
      values(p_batch_id,coalesce(comparison,'[]'),differences);
  end if;
end;
$function$;


CREATE OR REPLACE FUNCTION private.payroll_closing_snapshot_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare person uuid; receipt uuid; actor uuid;
begin
  if tg_table_schema='private' and tg_table_name='employee_annual_leave_balances' and exists(select 1 from private.leave_bank_sources where leave_kind='annual' and (person_id=case when tg_op='DELETE' then old.person_id else new.person_id end or (tg_op='UPDATE' and person_id=old.person_id))) then
    raise exception 'Use audited annual source adoption for this payroll balance.' using errcode='55000';
  end if;
  person:=case when tg_op='DELETE' then old.person_id else new.person_id end;
  if tg_op='UPDATE' and new.person_id is distinct from old.person_id then
    if tg_table_schema='private' and tg_table_name in ('employee_annual_leave_balances','employee_sick_leave_balances') then
      if old.closing_receipt_id is not null then
        raise exception 'Payroll snapshot identity cannot change.' using errcode='55000';
      end if;
    end if;
    actor:=private.assert_employee_identity_actor();
    if tg_table_schema='private' and tg_table_name in ('employee_annual_leave_balances','employee_sick_leave_balances')
      and to_jsonb(new)-'person_id'=to_jsonb(old)-'person_id'
      and old.closing_receipt_id is null
      and exists(select 1 from private.employee_identity_consolidations c
        join public.internal_org_people source on source.id=c.source_person_id
        join public.internal_org_people target on target.id=c.canonical_person_id
        where c.source_person_id=old.person_id and c.canonical_person_id=new.person_id
          and c.actor_user_id=actor and c.reviewed_plan->>'actor_user_id'=actor::text
          and c.reviewed_plan->>'source_person_id'=old.person_id::text
          and c.reviewed_plan->>'canonical_person_id'=new.person_id::text
          and not source.is_active and source.auth_user_id is null
          and source.company_key=c.source_company_key and target.company_key=c.source_company_key
          and target.is_active and target.auth_user_id is not null
          and exists(select 1 from jsonb_array_elements(c.archived_rows->(tg_table_schema||'.'||tg_table_name)) archived
            where archived=to_jsonb(old))) then
      -- Return the unchanged full row apart from its reviewed owner. Do not
      -- reset a closing receipt, synthesize claims, or reinterpret economics.
      return new;
    end if;
    raise exception 'Payroll snapshot identity cannot change.' using errcode='55000';
  end if;
  select receipt_id into receipt from private.payroll_closing_write_claims where person_id=person and transaction_id=pg_current_xact_id();
  if exists(select 1 from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=person order by request_id,id desc) e where pending_hours>0 or accounted_hours>0)
    and receipt is null then
    raise exception 'Use audited payroll reconciliation for retained commitments.' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  new.closing_receipt_id:=receipt;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION private.payroll_balance_import_batch_projection_before_comparison(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'batchId', batch.id,
    'version', batch.version,
    'status', batch.batch_status,
    'files', batch.source_files,
    'createdAt', batch.created_at,
    'committedAt', batch.committed_at,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rowId', stage.id,
        'employeeName', stage.employee_name,
        'company', stage.company_key,
        'annualHours', stage.annual_hours,
        'sickHours', stage.sick_hours,
        'asOf', stage.as_of,
        'status', stage.match_status,
        'linkedName', person.full_name,
        'willApplyAnnual', stage.match_status = 'linked'
          and not exists(select 1 from private.leave_bank_sources where person_id=stage.person_id and leave_kind='annual')
          and stage.annual_hours is not null
          and not exists (
            select 1
            from private.payroll_balance_import_stage_rows newer
            where newer.batch_id = stage.batch_id
              and newer.person_id = stage.person_id
              and newer.match_status = 'linked'
              and newer.annual_hours is not null
              and newer.as_of > stage.as_of
          )
          and (
            annual_balance.person_id is null
            or annual_balance.as_of < stage.as_of
            or (
              annual_balance.as_of = stage.as_of
              and (
                annual_balance.hours is distinct from stage.annual_hours
                or annual_balance.is_example
              )
            )
          ),
        'willApplySick', stage.match_status = 'linked'
          and stage.sick_hours is not null
          and not exists (
            select 1
            from private.payroll_balance_import_stage_rows newer
            where newer.batch_id = stage.batch_id
              and newer.person_id = stage.person_id
              and newer.match_status = 'linked'
              and newer.sick_hours is not null
              and newer.as_of > stage.as_of
          )
          and (
            sick_balance.person_id is null
            or sick_balance.as_of < stage.as_of
            or (
              sick_balance.as_of = stage.as_of
              and sick_balance.hours is distinct from stage.sick_hours
            )
          )
      ) order by stage.company_key, lower(stage.employee_name), stage.id)
      from private.payroll_balance_import_stage_rows stage
      left join public.internal_org_people person on person.id = stage.person_id
      left join private.employee_annual_leave_balances annual_balance on annual_balance.person_id = stage.person_id
      left join private.employee_sick_leave_balances sick_balance on sick_balance.person_id = stage.person_id
      where stage.batch_id = batch.id
    ), '[]'::jsonb)
  )
  from private.payroll_balance_import_batches batch
  where batch.id = p_batch_id;
$function$;


CREATE OR REPLACE FUNCTION private.payroll_closing_fingerprint(p_person uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select encode(sha256(convert_to(jsonb_build_object(
    'person',(select jsonb_build_array(id,company_key,is_active,node_kind,auth_user_id,started_date) from public.internal_org_people where id=p_person),
    'detail',(select jsonb_build_array(employment_type,working_weekdays,scheduled_employment_end_date) from private.employee_directory_details where person_id=p_person),
    'annual',(select to_jsonb(b) from private.employee_annual_leave_balances b where person_id=p_person),
    'personal',(select to_jsonb(b) from private.employee_sick_leave_balances b where person_id=p_person),
    'annualSources',(select coalesce(jsonb_agg(to_jsonb(s) order by adopted_at,id),'[]') from private.leave_bank_sources s where person_id=p_person and leave_kind='annual'),
    'annualHistory',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from private.annual_leave_balance_history h where person_id=p_person),
    'personalHistory',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from private.sick_leave_balance_history h where person_id=p_person),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from private.leave_accrual_policies p where person_id=p_person),
    'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from private.leave_accrual_day_reviews r where person_id=p_person),
    'requests',(select coalesce(jsonb_agg(private.payroll_request_money(to_jsonb(r)) order by id),'[]') from public.leave_requests r where employee_person_id=p_person),
    'carry',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from private.payroll_carryforward_events e where person_id=p_person)
  )::text,'UTF8')),'hex');
$function$;


CREATE OR REPLACE FUNCTION public.preview_payroll_closing_reconciliation(p_person_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.payroll_closing_assert_actor();
  if not exists(select 1 from public.internal_org_people where id=p_person_id and node_kind='person' and is_active) then
    raise exception 'A canonical active employee is required.' using errcode='22023';
  end if;
  return jsonb_build_object('fingerprint',private.payroll_closing_fingerprint(p_person_id),
    'annual',coalesce((select to_jsonb(b) from private.employee_annual_leave_balances b where person_id=p_person_id),'{}')||jsonb_build_object('person_id',p_person_id,'hours',(private.leave_bank_basis(p_person_id,'annual')->>'bankHours')::numeric,'as_of',(private.leave_bank_basis(p_person_id,'annual')->>'reportDate')::date,'source',private.leave_bank_basis(p_person_id,'annual')),
    'personal',(select to_jsonb(b) from private.employee_sick_leave_balances b where person_id=p_person_id),
    'reservations',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e));
end;
$function$;


CREATE OR REPLACE FUNCTION public.submit_my_leave_request(p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, approval_required boolean, assigned_reviewer_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_leave_type text;
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to submit leave.'
      using errcode = '42501';
  end if;

  v_actor_person_id := private.current_active_portal_employee_id();
  if v_actor_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in (
    'Annual leave',
    'Sick leave',
    'Carer''s leave',
    'Unpaid leave'
  ) then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;

  perform private.assert_leave_date_range(p_start_date, p_end_date);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;

  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  if v_request_type_label='Annual leave' and exists(select 1 from private.employee_directory_details where person_id=v_actor_person_id and employment_type in ('full_time','part_time')) then
    select count(*)::integer into v_business_days from generate_series(p_start_date,p_end_date,interval '1 day') day
      cross join lateral(select ap.weekdays from private.leave_accrual_policies ap where ap.person_id=v_actor_person_id and ap.effective_from<=day::date order by ap.effective_from desc,ap.created_at desc,ap.id desc limit 1) policy
      where extract(isodow from day)::integer=any(policy.weekdays);
    if p_start_time is not null and (p_start_time<time '06:00' or p_start_time>=time '18:00' or p_end_time<=time '06:00' or p_end_time>time '18:00' or extract(minute from p_start_time)::integer%15<>0 or extract(minute from p_end_time)::integer%15<>0) then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode='22023';
    end if;
    if v_business_days<1 or private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null) is null or private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null)<=0 then
      raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
    end if;
    if p_start_time is not null then v_hours:=round(private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null),2); end if;
  else
  select count(*)::integer
  into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;

  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00'
      or p_start_time >= time '18:00'
      or p_end_time <= time '06:00'
      or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.'
        using errcode = '22023';
    end if;

    select round(sum(
      case
        when day::date = p_start_date and day::date = p_end_date then
          (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
        when day::date = p_start_date then
          (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
        when day::date = p_end_date then
          (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
        else 12::numeric
      end
    ), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;

    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  end if;

  -- Lock the hierarchy and the grant configuration in one stable order before
  -- deriving the snapshot. Organisation edits and grant changes therefore
  -- affect either this request or a later request, never half of each.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));

  select count(distinct candidate.reviewer_user_id)::integer
  into v_reviewer_count
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id;

  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this request.'
      using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id
  order by
    case candidate.scope_kind
      when 'team' then 0
      when 'subtree' then 1
      else 2
    end,
    candidate.scope_priority,
    candidate.scope_depth,
    candidate.grant_id
  limit 1;

  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
  end;

  insert into public.leave_requests (
    user_id,
    leave_type,
    request_type_label,
    start_date,
    end_date,
    start_time,
    end_time,
    business_days,
    hours,
    approval_required,
    manager_user_id,
    manager_name_snapshot,
    reason,
    status,
    submitted_at,
    decided_at,
    decided_by,
    created_at,
    updated_at
  )
  values (
    v_actor_user_id,
    v_leave_type,
    v_request_type_label,
    p_start_date,
    p_end_date,
    p_start_time,
    p_end_time,
    v_business_days,
    v_hours,
    true,
    v_primary_reviewer_user_id,
    v_primary_reviewer_label,
    v_employee_note,
    'submitted',
    clock_timestamp(),
    null,
    null,
    clock_timestamp(),
    clock_timestamp()
  )
  returning * into v_request;

  with candidates as (
    select candidate.*
    from private.resolve_leave_approval_grants(v_actor_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_actor_user_id
  ),
  distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id)
      candidate.*
    from candidates candidate
    order by
      candidate.reviewer_user_id,
      case candidate.scope_kind
        when 'team' then 0
        when 'subtree' then 1
        else 2
      end,
      candidate.scope_priority,
      candidate.scope_depth,
      candidate.grant_id
  ),
  ranked_reviewers as (
    select
      candidate.*,
      row_number() over (
        order by
          case candidate.scope_kind
            when 'team' then 0
            when 'subtree' then 1
            else 2
          end,
          candidate.scope_priority,
          candidate.scope_depth,
          candidate.grant_id
      ) as route_rank
    from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id,
    reviewer_user_id,
    source_grant_id,
    assignment_kind,
    reviewer_label,
    is_primary
  )
  select
    v_request.id,
    candidate.reviewer_user_id,
    candidate.grant_id,
    candidate.scope_kind,
    candidate.reviewer_label,
    candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values
    (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query
  select
    v_request.id,
    'Pending',
    v_request.approval_required,
    v_primary_reviewer_label;
end;
$function$;


CREATE OR REPLACE FUNCTION public.submit_selected_employee_leave_request(p_person_id uuid, p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, approval_required boolean, assigned_reviewer_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_actor_user_id uuid := (select auth.uid());
  v_target_user_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_leave_type text;
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account()
    or not (private.is_operational_portal_admin() or private.can_submit_team_leave(p_person_id)) then
    raise exception 'Only Super Admin may submit leave for a selected profile.' using errcode = '42501';
  end if;

  select person.auth_user_id into v_target_user_id
  from public.internal_org_people person
  join public.profiles target_profile
    on target_profile.id = person.auth_user_id
   and target_profile.account_status = 'active'
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active = true
    and person.auth_user_id is not null;

  if v_target_user_id is null or not private.is_active_portal_account(v_target_user_id) then
    raise exception 'The selected profile is not an active linked employee.' using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in ('Annual leave', 'Sick leave', 'Carer''s leave', 'Unpaid leave') then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;
  perform private.assert_leave_date_range(p_start_date, p_end_date);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;
  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;
  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  if v_request_type_label='Annual leave' and exists(select 1 from private.employee_directory_details where person_id=p_person_id and employment_type in ('full_time','part_time')) then
    select count(*)::integer into v_business_days from generate_series(p_start_date,p_end_date,interval '1 day') day
      cross join lateral(select ap.weekdays from private.leave_accrual_policies ap where ap.person_id=p_person_id and ap.effective_from<=day::date order by ap.effective_from desc,ap.created_at desc,ap.id desc limit 1) policy
      where extract(isodow from day)::integer=any(policy.weekdays);
    if p_start_time is not null and (p_start_time<time '06:00' or p_start_time>=time '18:00' or p_end_time<=time '06:00' or p_end_time>time '18:00' or extract(minute from p_start_time)::integer%15<>0 or extract(minute from p_end_time)::integer%15<>0) then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode='22023';
    end if;
    if v_business_days<1 or private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null) is null or private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null)<=0 then
      raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
    end if;
    if p_start_time is not null then v_hours:=round(private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null),2); end if;
  else
  select count(*)::integer into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;
  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00' or p_start_time >= time '18:00'
      or p_end_time <= time '06:00' or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode = '22023';
    end if;
    select round(sum(case
      when day::date = p_start_date and day::date = p_end_date then (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
      when day::date = p_start_date then (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
      when day::date = p_end_date then (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
      else 12::numeric end), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;
    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));
  select count(distinct candidate.reviewer_user_id)::integer into v_reviewer_count
  from private.resolve_leave_approval_grants(p_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_target_user_id;
  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this employee.' using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(p_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_target_user_id
  order by case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
    candidate.scope_priority, candidate.scope_depth, candidate.grant_id
  limit 1;
  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
  end;

  insert into public.leave_requests (
    user_id, leave_type, request_type_label, start_date, end_date, start_time,
    end_time, business_days, hours, approval_required, manager_user_id,
    manager_name_snapshot, reason, status, submitted_at, decided_at, decided_by,
    created_at, updated_at
  ) values (
    v_target_user_id, v_leave_type, v_request_type_label, p_start_date, p_end_date,
    p_start_time, p_end_time, v_business_days, v_hours, true,
    v_primary_reviewer_user_id, v_primary_reviewer_label, v_employee_note,
    'submitted', clock_timestamp(), null, null, clock_timestamp(), clock_timestamp()
  ) returning * into v_request;

  with candidates as (
    select candidate.* from private.resolve_leave_approval_grants(p_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_target_user_id
  ), distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id) candidate.* from candidates candidate
    order by candidate.reviewer_user_id,
      case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
      candidate.scope_priority, candidate.scope_depth, candidate.grant_id
  ), ranked_reviewers as (
    select candidate.*, row_number() over (
      order by case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
        candidate.scope_priority, candidate.scope_depth, candidate.grant_id
    ) as route_rank from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id, reviewer_user_id, source_grant_id, assignment_kind, reviewer_label, is_primary
  )
  select v_request.id, candidate.reviewer_user_id, candidate.grant_id,
    candidate.scope_kind, candidate.reviewer_label, candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (leave_request_id, actor_user_id, event_type, note)
  values (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query select v_request.id, 'Pending', v_request.approval_required, v_primary_reviewer_label;
end;
$function$;


CREATE OR REPLACE FUNCTION private.openclaw_submit_self(p_actor_user_id uuid, p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, approval_required boolean, assigned_reviewer_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := p_actor_user_id;
  v_actor_person_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_leave_type text;
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null

    or not private.is_active_portal_account(v_actor_user_id) then
    raise exception 'An active portal account is required to submit leave.'
      using errcode = '42501';
  end if;

  select person.id into strict v_actor_person_id from public.internal_org_people person where person.auth_user_id=v_actor_user_id and person.is_active and person.node_kind='person' and person.company_key='mam';
  if v_actor_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in (
    'Annual leave',
    'Sick leave',
    'Carer''s leave',
    'Unpaid leave'
  ) then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;

  perform private.assert_leave_date_range(p_start_date, p_end_date);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;

  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  if v_request_type_label='Annual leave' and exists(select 1 from private.employee_directory_details where person_id=v_actor_person_id and employment_type in ('full_time','part_time')) then
    select count(*)::integer into v_business_days from generate_series(p_start_date,p_end_date,interval '1 day') day
      cross join lateral(select ap.weekdays from private.leave_accrual_policies ap where ap.person_id=v_actor_person_id and ap.effective_from<=day::date order by ap.effective_from desc,ap.created_at desc,ap.id desc limit 1) policy
      where extract(isodow from day)::integer=any(policy.weekdays);
    if p_start_time is not null and (p_start_time<time '06:00' or p_start_time>=time '18:00' or p_end_time<=time '06:00' or p_end_time>time '18:00' or extract(minute from p_start_time)::integer%15<>0 or extract(minute from p_end_time)::integer%15<>0) then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode='22023';
    end if;
    if v_business_days<1 or private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null) is null or private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null)<=0 then
      raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
    end if;
    if p_start_time is not null then v_hours:=round(private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null),2); end if;
  else
  select count(*)::integer
  into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;

  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00'
      or p_start_time >= time '18:00'
      or p_end_time <= time '06:00'
      or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.'
        using errcode = '22023';
    end if;

    select round(sum(
      case
        when day::date = p_start_date and day::date = p_end_date then
          (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
        when day::date = p_start_date then
          (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
        when day::date = p_end_date then
          (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
        else 12::numeric
      end
    ), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;

    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  end if;

  -- Lock the hierarchy and the grant configuration in one stable order before
  -- deriving the snapshot. Organisation edits and grant changes therefore
  -- affect either this request or a later request, never half of each.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));

  select count(distinct candidate.reviewer_user_id)::integer
  into v_reviewer_count
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id;

  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this request.'
      using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id
  order by
    case candidate.scope_kind
      when 'team' then 0
      when 'subtree' then 1
      else 2
    end,
    candidate.scope_priority,
    candidate.scope_depth,
    candidate.grant_id
  limit 1;

  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
  end;

  insert into public.leave_requests (
    user_id,
    leave_type,
    request_type_label,
    start_date,
    end_date,
    start_time,
    end_time,
    business_days,
    hours,
    approval_required,
    manager_user_id,
    manager_name_snapshot,
    reason,
    status,
    submitted_at,
    decided_at,
    decided_by,
    created_at,
    updated_at
  )
  values (
    v_actor_user_id,
    v_leave_type,
    v_request_type_label,
    p_start_date,
    p_end_date,
    p_start_time,
    p_end_time,
    v_business_days,
    v_hours,
    true,
    v_primary_reviewer_user_id,
    v_primary_reviewer_label,
    v_employee_note,
    'submitted',
    clock_timestamp(),
    null,
    null,
    clock_timestamp(),
    clock_timestamp()
  )
  returning * into v_request;

  with candidates as (
    select candidate.*
    from private.resolve_leave_approval_grants(v_actor_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_actor_user_id
  ),
  distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id)
      candidate.*
    from candidates candidate
    order by
      candidate.reviewer_user_id,
      case candidate.scope_kind
        when 'team' then 0
        when 'subtree' then 1
        else 2
      end,
      candidate.scope_priority,
      candidate.scope_depth,
      candidate.grant_id
  ),
  ranked_reviewers as (
    select
      candidate.*,
      row_number() over (
        order by
          case candidate.scope_kind
            when 'team' then 0
            when 'subtree' then 1
            else 2
          end,
          candidate.scope_priority,
          candidate.scope_depth,
          candidate.grant_id
      ) as route_rank
    from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id,
    reviewer_user_id,
    source_grant_id,
    assignment_kind,
    reviewer_label,
    is_primary
  )
  select
    v_request.id,
    candidate.reviewer_user_id,
    candidate.grant_id,
    candidate.scope_kind,
    candidate.reviewer_label,
    candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values
    (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query
  select
    v_request.id,
    'Pending',
    v_request.approval_required,
    v_primary_reviewer_label;
end;
$function$;


CREATE OR REPLACE FUNCTION public.set_employee_leave_accrual_policy(p_person_id uuid, p_weekly_hours numeric, p_annual_weeks numeric, p_personal_weeks numeric, p_shiftworker boolean, p_enabled boolean, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor(); weekdays integer[]; employment text;
begin
  if not private.is_operational_portal_admin() then raise exception 'Only System Admin can configure accrual.' using errcode='42501';end if;
  select d.employment_type,case when cardinality(d.working_weekdays)>0 then d.working_weekdays else array[1,2,3,4,5] end into employment,weekdays
  from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id=p_person_id and p.is_active for update of p,d;
  if not found or employment not in ('full_time','part_time') or employment is null then raise exception 'An active permanent employee is required.';end if;
  if p_enabled and not exists(select 1 from private.leave_accrual_policies where person_id=p_person_id) then
    if private.leave_bank_basis(p_person_id,'annual')->>'bankHours' is null and private.leave_bank_basis(p_person_id,'personal')->>'bankHours' is null then
      raise exception 'Supply an authoritative opening payroll balance first.';
    end if;
    if exists(select 1 from unnest(array['annual','personal']) kind cross join lateral(select private.leave_bank_basis(p_person_id,kind) basis)b where b.basis->>'bankHours' is not null and (b.basis->>'status'<>'current' or (b.basis->>'coveredThrough')::date<(now() at time zone 'Australia/Melbourne')::date-1)) then
      raise exception 'Supply opening payroll balances covering yesterday before first activation.';
    end if;
  end if;
  if p_weekly_hours::text in ('NaN','Infinity','-Infinity') or p_annual_weeks::text in ('NaN','Infinity','-Infinity') or p_personal_weeks::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter finite hours and entitlements.';end if;
  insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,shiftworker,enabled,note,actor_user_id)
  values(p_person_id,greatest((now() at time zone 'Australia/Melbourne')::date,(select max(effective_from) from private.leave_accrual_policies where person_id=p_person_id)),p_weekly_hours,weekdays,p_annual_weeks,p_personal_weeks,p_shiftworker,p_enabled,btrim(p_note),auth.uid());
end;
$function$;


create temporary table annual_source_function_after on commit drop as
select s.signature,s.is_existing,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable_metadata
from annual_source_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table annual_source_new_relation_expected(name text primary key,metadata jsonb not null) on commit drop;
insert into annual_source_new_relation_expected values
('private.leave_bank_sources','{"acl":"{postgres=arwdDxt/postgres}","rls":true,"owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"person_id","type":"uuid","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"leave_kind","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"hours","type":"numeric(12,4)","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"report_date","type":"date","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"covered_service_through","type":"date","default":null,"identity":"","not_null":false,"collation":null,"generated":""},{"acl":null,"name":"source_kind","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"source_archive_id","type":"uuid","default":null,"identity":"","not_null":false,"collation":null,"generated":""},{"acl":null,"name":"source_row_id","type":"bigint","default":null,"identity":"","not_null":false,"collation":null,"generated":""},{"acl":null,"name":"source_import_id","type":"uuid","default":null,"identity":"","not_null":false,"collation":null,"generated":""},{"acl":null,"name":"source_fingerprint","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"note","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"adopted_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"operator_role","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"adoption_receipt_id","type":"uuid","default":null,"identity":"","not_null":false,"collation":null,"generated":""},{"acl":null,"name":"legacy_snapshot_fingerprint","type":"text","default":null,"identity":"","not_null":false,"collation":"\"default\"","generated":""},{"acl":null,"name":"included_usage","type":"jsonb","default":"''[]''::jsonb","identity":"","not_null":true,"collation":null,"generated":""}],"options":null,"policies":[],"triggers":[{"name":"leave_bank_sources_immutable","enabled":"O","definition":"CREATE TRIGGER leave_bank_sources_immutable BEFORE DELETE OR UPDATE ON private.leave_bank_sources FOR EACH ROW EXECUTE FUNCTION private.reject_leave_bank_source_mutation()","function_sha256":"c7582653b887df78b36e447364aa428504e6f401772362aa0477192728afb296"},{"name":"reject_retired_test_identity_reference","enabled":"O","definition":"CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.leave_bank_sources FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()","function_sha256":"bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb"}],"force_rls":true,"constraints":[{"name":"leave_bank_sources_adoption_receipt_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (adoption_receipt_id) REFERENCES private.leave_bank_adoption_receipts(id)"},{"name":"leave_bank_sources_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((covered_service_through <= report_date))"},{"name":"leave_bank_sources_hours_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((hours >= (''-10000''::integer)::numeric) AND (hours <= (100000)::numeric)))"},{"name":"leave_bank_sources_included_usage_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((jsonb_typeof(included_usage) = ''array''::text) AND (jsonb_array_length(included_usage) <= 200)))"},{"name":"leave_bank_sources_leave_kind_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((leave_kind = ANY (ARRAY[''annual''::text, ''personal''::text])))"},{"name":"leave_bank_sources_legacy_snapshot_fingerprint_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((legacy_snapshot_fingerprint ~ ''^[a-f0-9]{64}$''::text))"},{"name":"leave_bank_sources_note_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((length(note) >= 1) AND (length(note) <= 2000)))"},{"name":"leave_bank_sources_person_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"name":"leave_bank_sources_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"leave_bank_sources_source_archive_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (source_archive_id) REFERENCES private.payroll_balance_source_archives(id)"},{"name":"leave_bank_sources_source_fingerprint_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((source_fingerprint ~ ''^[a-f0-9]{64}$''::text))"},{"name":"leave_bank_sources_source_import_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (source_import_id) REFERENCES private.payroll_balance_imports(id)"},{"name":"leave_bank_sources_source_kind_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((source_kind = ANY (ARRAY[''payroll_report''::text, ''payslip''::text, ''manual_snapshot''::text])))"},{"name":"leave_bank_sources_source_row_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (source_row_id) REFERENCES private.payroll_balance_import_stage_rows(id)"}],"toast_table":{"acl":null,"rls":false,"owner":"postgres","options":null,"force_rls":false},"toast_indexes":[{"acl":null,"owner":"postgres","indkey":[1,2],"indpred":null,"options":null,"indexprs":null,"indnatts":2,"indislive":true,"indoption":[0,0],"opclasses":["pg_catalog.oid_ops","pg_catalog.int4_ops"],"definition":"CREATE UNIQUE INDEX pg_toast_<parent>_index ON pg_toast.pg_toast_<parent> USING btree (chunk_id, chunk_seq)","indisready":true,"indisvalid":true,"indisunique":true,"indnkeyatts":2,"indcheckxmin":false,"indimmediate":true,"indisprimary":true,"indisclustered":false,"indisexclusion":false,"indisreplident":false,"indnullsnotdistinct":false}]}'::jsonb),
('private.leave_bank_sources_pkey','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":true,"columns":1,"options":null,"primary":true,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE UNIQUE INDEX leave_bank_sources_pkey ON private.leave_bank_sources USING btree (id)","key_columns":1,"replica_identity":false,"nulls_not_distinct":false}'::jsonb),
('private.leave_payroll_calendars','{"acl":"{postgres=arwdDxt/postgres}","rls":true,"owner":"postgres","columns":[{"acl":null,"name":"person_id","type":"uuid","default":null,"identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"calendar_key","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""}],"options":null,"policies":[],"triggers":[{"name":"reject_retired_test_identity_reference","enabled":"O","definition":"CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.leave_payroll_calendars FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()","function_sha256":"bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb"}],"force_rls":true,"constraints":[{"name":"leave_payroll_calendars_calendar_key_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((calendar_key = ANY (ARRAY[''victoria''::text, ''none''::text])))"},{"name":"leave_payroll_calendars_person_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"name":"leave_payroll_calendars_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (person_id)"}],"toast_table":{"acl":null,"rls":false,"owner":"postgres","options":null,"force_rls":false},"toast_indexes":[{"acl":null,"owner":"postgres","indkey":[1,2],"indpred":null,"options":null,"indexprs":null,"indnatts":2,"indislive":true,"indoption":[0,0],"opclasses":["pg_catalog.oid_ops","pg_catalog.int4_ops"],"definition":"CREATE UNIQUE INDEX pg_toast_<parent>_index ON pg_toast.pg_toast_<parent> USING btree (chunk_id, chunk_seq)","indisready":true,"indisvalid":true,"indisunique":true,"indnkeyatts":2,"indcheckxmin":false,"indimmediate":true,"indisprimary":true,"indisclustered":false,"indisexclusion":false,"indisreplident":false,"indnullsnotdistinct":false}]}'::jsonb),
('private.leave_bank_sources_latest','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":false,"columns":4,"options":null,"primary":false,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE INDEX leave_bank_sources_latest ON private.leave_bank_sources USING btree (person_id, leave_kind, adopted_at DESC, id DESC)","key_columns":4,"replica_identity":false,"nulls_not_distinct":false}'::jsonb),
('private.leave_bank_adoption_receipts','{"acl":"{postgres=arwdDxt/postgres}","rls":true,"owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"owner_key","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"plan_hash","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"operator_role","type":"text","default":null,"identity":"","not_null":true,"collation":"\"default\"","generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"collation":null,"generated":""},{"acl":null,"name":"source_count","type":"integer","default":null,"identity":"","not_null":true,"collation":null,"generated":""}],"options":null,"policies":[],"triggers":[{"name":"leave_bank_receipts_immutable","enabled":"O","definition":"CREATE TRIGGER leave_bank_receipts_immutable BEFORE DELETE OR UPDATE ON private.leave_bank_adoption_receipts FOR EACH ROW EXECUTE FUNCTION private.reject_leave_bank_source_mutation()","function_sha256":"c7582653b887df78b36e447364aa428504e6f401772362aa0477192728afb296"},{"name":"reject_retired_test_identity_reference","enabled":"O","definition":"CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.leave_bank_adoption_receipts FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()","function_sha256":"bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb"}],"force_rls":true,"constraints":[{"name":"leave_bank_adoption_receipts_owner_key_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((length(owner_key) >= 1) AND (length(owner_key) <= 200)))"},{"name":"leave_bank_adoption_receipts_owner_key_key","type":"u","deferred":false,"validated":true,"deferrable":false,"definition":"UNIQUE (owner_key)"},{"name":"leave_bank_adoption_receipts_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"leave_bank_adoption_receipts_plan_hash_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((plan_hash ~ ''^[a-f0-9]{64}$''::text))"},{"name":"leave_bank_adoption_receipts_plan_hash_key","type":"u","deferred":false,"validated":true,"deferrable":false,"definition":"UNIQUE (plan_hash)"},{"name":"leave_bank_adoption_receipts_source_count_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((source_count >= 1) AND (source_count <= 200)))"}],"toast_table":{"acl":null,"rls":false,"owner":"postgres","options":null,"force_rls":false},"toast_indexes":[{"acl":null,"owner":"postgres","indkey":[1,2],"indpred":null,"options":null,"indexprs":null,"indnatts":2,"indislive":true,"indoption":[0,0],"opclasses":["pg_catalog.oid_ops","pg_catalog.int4_ops"],"definition":"CREATE UNIQUE INDEX pg_toast_<parent>_index ON pg_toast.pg_toast_<parent> USING btree (chunk_id, chunk_seq)","indisready":true,"indisvalid":true,"indisunique":true,"indnkeyatts":2,"indcheckxmin":false,"indimmediate":true,"indisprimary":true,"indisclustered":false,"indisexclusion":false,"indisreplident":false,"indnullsnotdistinct":false}]}'::jsonb),
('private.leave_payroll_calendars_pkey','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":true,"columns":1,"options":null,"primary":true,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE UNIQUE INDEX leave_payroll_calendars_pkey ON private.leave_payroll_calendars USING btree (person_id)","key_columns":1,"replica_identity":false,"nulls_not_distinct":false}'::jsonb),
('private.leave_bank_adoption_receipts_pkey','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":true,"columns":1,"options":null,"primary":true,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE UNIQUE INDEX leave_bank_adoption_receipts_pkey ON private.leave_bank_adoption_receipts USING btree (id)","key_columns":1,"replica_identity":false,"nulls_not_distinct":false}'::jsonb),
('private.leave_bank_adoption_receipts_owner_key_key','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":true,"columns":1,"options":null,"primary":false,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE UNIQUE INDEX leave_bank_adoption_receipts_owner_key_key ON private.leave_bank_adoption_receipts USING btree (owner_key)","key_columns":1,"replica_identity":false,"nulls_not_distinct":false}'::jsonb),
('private.leave_bank_adoption_receipts_plan_hash_key','{"acl":null,"live":true,"owner":"postgres","ready":true,"valid":true,"unique":true,"columns":1,"options":null,"primary":false,"clustered":false,"exclusion":false,"immediate":true,"definition":"CREATE UNIQUE INDEX leave_bank_adoption_receipts_plan_hash_key ON private.leave_bank_adoption_receipts USING btree (plan_hash)","key_columns":1,"replica_identity":false,"nulls_not_distinct":false}'::jsonb);
create temporary table annual_source_new_relation_actual on commit drop as
select s.schema_name||'.'||s.relation_name name,s.relation_kind,c.oid,
  case when s.relation_kind='r' then pg_temp.annual_source_table_metadata(c.oid) else pg_temp.annual_source_index_metadata(c.oid) end metadata
from annual_source_relation_spec s join pg_namespace n on n.nspname=s.schema_name join pg_class c on c.relnamespace=n.oid and c.relname=s.relation_name and c.relkind::text=s.relation_kind;
create temporary table annual_source_catalog_after on commit drop as select * from pg_temp.annual_source_catalog();
create temporary table annual_source_catalog_added on commit drop as
 select n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||c.relforcerowsecurity definition from pg_class c join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where c.relkind in ('r','p','v','m')
 union all select a.attrelid::regclass::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where a.attnum>0 and not a.attisdropped
 union all select k.conrelid::regclass::text||':'||pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname
 union all select t.tgrelid::regclass::text||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where not t.tgisinternal
 union all select c.oid::regclass::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'default') from pg_class c join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname where c.relkind in ('r','p','v','m')
 union all select p.polrelid::regclass::text||':'||p.polname||':'||p.polcmd::text||':'||p.polpermissive::text||':'||p.polroles::text||':'||coalesce(pg_get_expr(p.polqual,p.polrelid),'')||':'||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace join annual_source_relation_spec s on s.schema_name=n.nspname and s.relation_name=c.relname
 union all select definition from annual_source_function_after
 union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from annual_source_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where not s.is_existing;
create temporary table annual_source_catalog_normalized on commit drop as
 select definition from annual_source_catalog_after except all select definition from annual_source_catalog_added;
insert into annual_source_catalog_normalized select definition from annual_source_function_before;
set constraints all immediate;
do $annual_source_intended_delta$ declare relation record; has_rows boolean; begin
 if (select count(*) from annual_source_function_after)<>25
   or (select count(*) from annual_source_new_relation_actual)<>9
   or (select count(*) from annual_source_new_relation_expected)<>9
   or exists(select 1 from annual_source_function_spec s left join annual_source_function_after a using(signature) where a.signature is null or s.after_sha256 is null or encode(extensions.digest(a.definition,'sha256'),'hex') is distinct from s.after_sha256 or (not s.is_existing and (s.new_metadata is null or a.portable_metadata is distinct from s.new_metadata)))
   or exists(select 1 from annual_source_function_before b join annual_source_function_after a using(signature) where b.metadata is distinct from a.metadata)
   or exists(select 1 from annual_source_new_relation_expected e full join annual_source_new_relation_actual a using(name) where a.metadata is distinct from e.metadata)
   or exists((select definition collate "C" from annual_source_catalog_before except all select definition collate "C" from annual_source_catalog_normalized) union all (select definition collate "C" from annual_source_catalog_normalized except all select definition collate "C" from annual_source_catalog_before))
   or pg_temp.annual_source_security() is distinct from (select value from annual_source_security_before)
   or pg_temp.annual_source_data() is distinct from (select value from annual_source_data_before) then
   raise exception 'Annual source bank contains changes outside the exact reviewed delta.' using errcode='55000';
 end if;
 for relation in select * from annual_source_new_relation_actual where relation_kind='r' loop
   if exists(select 1 from pg_class c where c.oid=relation.oid and (not c.relrowsecurity or not c.relforcerowsecurity)) then
     raise exception 'Annual source bank private tables require forced RLS.' using errcode='55000';
   end if;
   execute format('select exists(select 1 from %s)',relation.name::regclass) into has_rows;
   if has_rows then raise exception 'Schema migration must not seed employee bank data.' using errcode='55000'; end if;
 end loop;
end $annual_source_intended_delta$;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
do $annual_source_final$ begin
 if exists((select definition collate "C" from pg_temp.annual_source_catalog() except all select definition collate "C" from annual_source_catalog_after) union all (select definition collate "C" from annual_source_catalog_after except all select definition collate "C" from pg_temp.annual_source_catalog()))
   or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
   or pg_temp.annual_source_security() is distinct from (select value from annual_source_security_before)
   or pg_temp.annual_source_data() is distinct from (select value from annual_source_data_before) then
   raise exception 'Annual source bank final catalog, security or retained data differs.' using errcode='55000';
 end if;
end $annual_source_final$;
create function pg_temp.annual_source_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if exists(select 1 from annual_source_new_relation_actual a join annual_source_new_relation_expected e using(name)
  where e.metadata is distinct from case when a.relation_kind='r' then pg_temp.annual_source_table_metadata(to_regclass(a.name)) else pg_temp.annual_source_index_metadata(to_regclass(a.name)) end)
 or exists(select 1 from annual_source_function_after a left join pg_proc p on p.oid=to_regprocedure(a.signature)
  where p.oid is null or pg_get_functiondef(p.oid) is distinct from a.definition or ((to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))) is distinct from a.metadata)
 or exists((select definition collate "C" from pg_temp.annual_source_catalog() except all select definition collate "C" from annual_source_catalog_after) union all(select definition collate "C" from annual_source_catalog_after except all select definition collate "C" from pg_temp.annual_source_catalog()))
 or pg_temp.annual_source_data() is distinct from (select value from annual_source_data_before) then
  raise exception 'Annual source bank reviewed delta drifted after constraint drain.' using errcode='55000';
 end if;
end $$;
select pg_temp.annual_source_assert_delta();
commit;
