begin;
set local search_path='';
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
do $sr_predecessor$ begin
  if not pg_try_advisory_xact_lock(hashtextextended('mam:confirmed-test-purge',0)) then
    raise exception 'Subscription request schema is busy.' using errcode='55000';
  end if;
end $sr_predecessor$;
lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table auth.users,private.employee_team_manager_defaults,private.leave_bank_adoption_receipts,private.leave_bank_sources,private.leave_payroll_calendars,private.portal_account_admin_events,private.portal_account_admins,private.subscription_audit_events,private.subscription_credential_access_audit_events,private.subscription_credential_access_grants,private.subscription_credential_audit_events,private.subscription_credential_grant_changes,private.subscription_credential_vault,private.subscription_management_grant_events,private.subscription_management_grants,private.subscription_memberships,private.subscription_register,public.internal_org_people,public.profiles in share row exclusive mode nowait;
do $sr_predecessor$ declare predecessor_hash text; begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1 then
    raise exception 'Subscription requests require one predecessor ledger.' using errcode='55000';
  end if;
  select schema_hash into predecessor_hash from private.confirmed_test_purge_schema where singleton;
  if private.confirmed_test_purge_schema_hash() is distinct from predecessor_hash then
    raise exception 'Subscription requests require the reviewed predecessor catalog.' using errcode='55000';
  end if;
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') <> '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54' then
    raise exception 'Catalog collector differs.' using errcode='55000';
  end if;
  perform set_config('mam.sr_predecessor_hash',predecessor_hash,true);
end $sr_predecessor$;
create function pg_temp.sr_inventory()
returns table(kind text,object_identity text,definition text)
language plpgsql stable set search_path = '' as $catalog$
declare builtin_count bigint; builtin_hash text;
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_(toast_)?temp_' and p.prokind<>'f'
      and not (n.nspname='pg_catalog' and p.oid<16384)) then
    raise exception 'Subscription requests requires the reviewed built-in non-function routine inventory.' using errcode='55000';
  end if;
  with routines as (
    select format('%I.%I(%s)',n.nspname,p.proname,oidvectortypes(p.proargtypes)) as identity,p.prokind as kind,
      jsonb_build_object('proc',to_jsonb(p)-'oid',
        'aggregate',case when p.prokind='a' then to_jsonb(a)-'aggfnoid' else null end) as metadata
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join pg_aggregate a on a.aggfnoid=p.oid
    where n.nspname !~ '^pg_(toast_)?temp_' and p.prokind<>'f'
  )
  select count(*),encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_array(r.identity,r.kind,r.metadata)
    order by r.identity collate "C"),'[]'::jsonb)::text,'sha256'),'hex') into builtin_count,builtin_hash from routines r;
  if builtin_count<>172 or builtin_hash is distinct from (case current_setting('server_version_num')::integer/10000
    when 16 then 'c87f2f680aab3a071915bcc5c7774820f57a7e6c20b5be465cd3dffada088512'
    when 17 then 'd6785c452e91fdc4bdeb4e75a3d07e003d778eb59831717421f45bb63bd71f75'
    else null end) then
    raise exception 'Subscription requests built-in non-function routine metadata changed.' using errcode='55000';
  end if;
  return query
  select 'relation',format('%I.%I',n.nspname,c.relname),jsonb_build_object(
    'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',r.rolname,
    'acl',c.relacl::text,'options',c.reloptions,'persistence',c.relpersistence,'replica_identity',c.relreplident,
    'partition',c.relispartition,'partition_key',pg_get_partkeydef(c.oid),'partition_bound',pg_get_expr(c.relpartbound,c.oid))::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
  where n.nspname in ('public','private','storage') and c.relkind in ('r','p','v','m','S','f')
  union all
  select 'column',format('%I.%I.%I',n.nspname,c.relname,a.attname),jsonb_build_object(
    'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
    'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
    'collation',case when a.attcollation=0 then null else a.attcollation::regcollation::text end,'acl',a.attacl::text)::text
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped
  union all
  select 'constraint',(case when k.conrelid=0 then format('%I.%I',kn.nspname,typ.typname)
    else format('%I.%I',n.nspname,c.relname) end)||':'||k.conname,jsonb_build_object(
    'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred)::text
  from pg_constraint k join pg_namespace kn on kn.oid=k.connamespace
    left join pg_class c on c.oid=k.conrelid left join pg_namespace n on n.oid=c.relnamespace
    left join pg_type typ on typ.oid=k.contypid
  where k.connamespace in (select oid from pg_namespace where nspname in ('public','private','storage'))
    or (kn.nspname='pg_catalog' and k.contypid<>0 and typ.typtype='d')
    or k.confrelid='auth.users'::regclass or k.confrelid in (
      select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname in ('public','private','storage'))
  union all
  select 'trigger',format('%I.%I',n.nspname,c.relname)||':'||t.tgname,
    jsonb_build_object('enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid))::text
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where not t.tgisinternal and (n.nspname in ('public','private','storage') or c.oid='auth.users'::regclass)
  union all
  select 'function',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',
    case when p.prokind in ('a','w') then jsonb_build_object('proc',to_jsonb(p)-'oid',
      'aggregate',case when p.prokind='a' then to_jsonb(a)-'aggfnoid' else null end)::text
      else pg_get_functiondef(p.oid) end
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join pg_aggregate a on a.aggfnoid=p.oid
  where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'routine_kind',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',p.prokind::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'function_security',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',jsonb_build_object(
    'owner',r.rolname,'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,
    'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof)::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
  where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'view',format('%I.%I',n.nspname,c.relname),pg_get_viewdef(c.oid)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('v','m')
  union all
  select 'policy',format('%I.%I',n.nspname,c.relname)||':'||p.polname,jsonb_build_object(
    'command',p.polcmd,'permissive',p.polpermissive,
    'roles',array(select case when role_id=0 then 'PUBLIC' else (select rolname from pg_roles where oid=role_id) end from unnest(p.polroles) role_id),
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))::text
  from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'index',format('%I.%I',n.nspname,c.relname),jsonb_build_object(
    'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,
    'clustered',i.indisclustered,'replica_identity',i.indisreplident)::text
  from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'sequence',format('%I.%I',n.nspname,c.relname),jsonb_build_object(
    'type',format_type(s.seqtypid,null),'start',s.seqstart,'increment',s.seqincrement,'maximum',s.seqmax,
    'minimum',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle,
    'owned_by',(select format('%I.%I.%I',tn.nspname,tc.relname,a.attname) from pg_depend dep
      join pg_class tc on tc.oid=dep.refobjid join pg_namespace tn on tn.oid=tc.relnamespace
      join pg_attribute a on a.attrelid=dep.refobjid and a.attnum=dep.refobjsubid
      where dep.classid='pg_class'::regclass and dep.objid=c.oid and dep.refclassid='pg_class'::regclass and dep.deptype in ('a','i')))::text
  from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'schema',n.nspname,jsonb_build_object('owner',r.rolname,'acl',n.nspacl::text)::text
  from pg_namespace n join pg_roles r on r.oid=n.nspowner
  where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'default_acl',r.rolname||':'||coalesce(n.nspname,'GLOBAL')||':'||d.defaclobjtype::text,d.defaclacl::text
  from pg_default_acl d join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace
  union all
  select 'role',r.rolname,jsonb_build_object('oid',r.oid,'superuser',r.rolsuper,'inherit',r.rolinherit,'create_role',r.rolcreaterole,
    'create_db',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,
    'connection_limit',r.rolconnlimit,'valid_until',r.rolvaliduntil)::text
  from pg_roles r
  union all
  select 'role_membership',parent.rolname||':'||member.rolname||':'||grantor.rolname,
    jsonb_build_object('admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)::text
  from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
    join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor
  union all
  select 'global_relation_acl',format('%I.%I',n.nspname,c.relname),c.relacl::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relacl is not null and n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'global_column_acl',format('%I.%I.%I',n.nspname,c.relname,a.attname),a.attacl::text
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  where a.attacl is not null and n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'global_function_acl',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',coalesce(p.proacl,acldefault('f',p.proowner))::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'type',format('%I.%I',n.nspname,t.typname),jsonb_build_object(
    'owner',r.rolname,'acl',t.typacl::text,'kind',t.typtype,'category',t.typcategory,
    'preferred',t.typispreferred,'defined',t.typisdefined,'not_null',t.typnotnull,
    'length',t.typlen,'by_value',t.typbyval,'alignment',t.typalign,'storage',t.typstorage,
    'delimiter',t.typdelim,'base',case when t.typbasetype=0 then null else format_type(t.typbasetype,t.typtypmod) end,
    'modifier',t.typtypmod,'dimensions',t.typndims,
    'element',case when t.typelem=0 then null else format_type(t.typelem,null) end,
    'array',case when t.typarray=0 then null else format_type(t.typarray,null) end,
    'relation',case when t.typrelid=0 then null else t.typrelid::regclass::text end,
    'collation',case when t.typcollation=0 then null else t.typcollation::regcollation::text end,
    'default',t.typdefault,'default_expression',pg_get_expr(t.typdefaultbin,0),
    'input',t.typinput::regproc::text,'output',t.typoutput::regproc::text,
    'receive',t.typreceive::regproc::text,'send',t.typsend::regproc::text,
    'modifier_input',t.typmodin::regproc::text,'modifier_output',t.typmodout::regproc::text,
    'analyze',t.typanalyze::regproc::text,'subscript',t.typsubscript::regproc::text)::text
  from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_roles r on r.oid=t.typowner
  where n.nspname in ('public','private','storage')
    or (n.nspname='pg_catalog' and (t.typtype='d' or exists(
      select 1 from pg_type element where element.oid=t.typelem and element.typtype='d' and element.typnamespace=n.oid)))
  union all
  select 'enum',format('%I.%I',n.nspname,t.typname)||':'||e.enumlabel,
    jsonb_build_object('label',e.enumlabel,'order',e.enumsortorder)::text
  from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'range',format('%I.%I',n.nspname,t.typname),jsonb_build_object(
    'subtype',format_type(g.rngsubtype,null),'multirange',format_type(g.rngmultitypid,null),
    'collation',case when g.rngcollation=0 then null else g.rngcollation::regcollation::text end,
    'opclass',(select format('%I.%I',onsp.nspname,o.opcname) from pg_opclass o join pg_namespace onsp on onsp.oid=o.opcnamespace where o.oid=g.rngsubopc),
    'canonical',g.rngcanonical::regproc::text,'difference',g.rngsubdiff::regproc::text)::text
  from pg_range g join pg_type t on t.oid=g.rngtypid join pg_namespace n on n.oid=t.typnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'rewrite',format('%I.%I',n.nspname,c.relname)||':'||w.rulename,
    jsonb_build_object('event',w.ev_type,'enabled',w.ev_enabled,'instead',w.is_instead,
      'definition',pg_get_ruledef(w.oid))::text
  from pg_rewrite w join pg_class c on c.oid=w.ev_class join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage');
end;
$catalog$;
create temporary table sr_published_predecessor(kind text not null,object_identity text not null,after_hash text not null,before_definition text,primary key(kind,object_identity)) on commit drop;
insert into sr_published_predecessor values
  ('column','private.employee_team_manager_defaults.company_key','e6605275024bf56ce66d3ab37b2568d0d8bb0e61006cc87b1b79e5f67a167468',null),
  ('column','private.employee_team_manager_defaults.configured_at','be398acfa5d9d0dcb83cec2fe9670a09c1ed2d5782fe8ecb34d16a2117ac8cb1',null),
  ('column','private.employee_team_manager_defaults.configured_by_auth_user_id','115ab150dcd80075f83c73b5c9c1850acbc4d8b2b33039a4b4e75c8bc0b0450e',null),
  ('column','private.employee_team_manager_defaults.configured_by_database_role','31211cdfe198bfe29619232e9038808fd3029333225fb6f811cce007d5a86e68',null),
  ('column','private.employee_team_manager_defaults.manager_person_id','af3eac436abb751f4a9d978f730f881f15388a93b37a05ab5fa31a0f485d4c8e',null),
  ('column','private.employee_team_manager_defaults.team_name','485c07e7ec42ac0a6aa108931d58b3645b610d165a15ba19f98b7948d462d976',null),
  ('column','private.employee_team_manager_defaults.version','2a6c34f89054acc3661378c3deb660358d757e5bfae6fb8e870719419f4b88ff',null),
  ('column','private.employee_team_manager_defaults_pkey.company_key','18f7571ef0723d2e4f19c869a52679a06f9e96067bb1c1999516e5135f19bc9e',null),
  ('column','private.employee_team_manager_defaults_pkey.team_name','8cf8c9b217e34994afc9862d9bc1e478863200715dc4bcc5b4812916ccb8a3ae',null),
  ('constraint','private.employee_team_manager_defaults:employee_team_manager_defaults_company_key_check','b93d8f30ffea3296cb163e75f440f8e9082d2915dbb30e5e34d80d43086717ca',null),
  ('constraint','private.employee_team_manager_defaults:employee_team_manager_defaults_configured_by_auth_user_id_fkey','75e7bcf18c501f7fdf09fab734184790017be8eb4bbf0bc03b5437bf69ecddf8',null),
  ('constraint','private.employee_team_manager_defaults:employee_team_manager_defaults_manager_person_id_fkey','88a4400f1df9eaaec51b3b52a52e2bc32b029d4f5c29a43beaa46c90b7f80598',null),
  ('constraint','private.employee_team_manager_defaults:employee_team_manager_defaults_pkey','aaa2ce0ee2127137105507e1dda207a65640160acf14e8eb46c72d81cb1ded31',null),
  ('constraint','private.employee_team_manager_defaults:employee_team_manager_defaults_team_name_check','47f35f8659cbab738f1018c0ef8e1504edfd06a62906a4375f13c9424a9ce645',null),
  ('constraint','private.employee_team_manager_defaults:employee_team_manager_defaults_version_check','00d9a2d858138d9c8377b040fb3f07ff072cd3bb40a2a473934ff729d6ba78f0',null),
  ('function','public.create_employee_directory_record(text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], integer)','d5f3f4cababd7e532df61c7a4fcec2410acbbeb8ebf32ac157ca3068760ea296',$sr_published_before$CREATE OR REPLACE FUNCTION public.create_employee_directory_record(p_first_name text, p_last_name text, p_work_email text, p_personal_email text, p_phone text, p_position_title text, p_team_name text, p_manager_id uuid, p_country text, p_date_of_birth date, p_started_date date, p_scheduled_employment_end_date date, p_company_key text, p_is_active boolean, p_laptop_supplied text, p_laptop_id text, p_mouse_id text, p_keyboard_id text, p_asset_tags text[], p_sort_order integer DEFAULT 0)
 RETURNS TABLE(person_id uuid, person_version bigint, detail_version bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_actor uuid := (select auth.uid());
  v_first_name text;
  v_last_name text;
  v_work_email text;
  v_personal_email text;
  v_phone text;
  v_position_title text;
  v_team_name text;
  v_country text;
  v_laptop_supplied text;
  v_laptop_id text;
  v_mouse_id text;
  v_keyboard_id text;
  v_asset_tags text[];
  v_company_key text := lower(nullif(btrim(p_company_key), ''));
  v_full_name text;
  v_sort_order integer := coalesce(p_sort_order, 0);
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can create employee directory records.'
      using errcode = '42501';
  end if;

  v_first_name := private.normalise_employee_directory_text(p_first_name, 80, true, 'First name');
  v_last_name := private.normalise_employee_directory_text(p_last_name, 120, false, 'Last name');
  v_work_email := private.normalise_employee_directory_email(p_work_email, 'Work email');
  v_personal_email := private.normalise_employee_directory_email(p_personal_email, 'Personal email');
  v_phone := private.normalise_employee_directory_text(p_phone, 64, false, 'Phone');
  v_position_title := private.normalise_employee_directory_text(p_position_title, 120, true, 'Job title');
  v_team_name := private.normalise_employee_directory_text(p_team_name, 120, false, 'Team');
  v_country := private.normalise_employee_directory_text(p_country, 120, false, 'Country');
  v_laptop_supplied := private.normalise_employee_directory_laptop_supplied(p_laptop_supplied);
  v_laptop_id := private.normalise_employee_directory_text(p_laptop_id, 120, false, 'Laptop ID');
  v_mouse_id := private.normalise_employee_directory_text(p_mouse_id, 120, false, 'Mouse ID');
  v_keyboard_id := private.normalise_employee_directory_text(p_keyboard_id, 120, false, 'Keyboard ID');
  v_asset_tags := private.normalise_employee_directory_asset_tags(p_asset_tags);
  v_full_name := concat_ws(' ', v_first_name, v_last_name);

  if char_length(v_full_name) > 120 then
    raise exception 'First and last name together are too long.' using errcode = '22001';
  end if;

  if v_company_key is null or v_company_key not in ('mam', 'equipsy') then
    raise exception 'Choose MAM or Equipsy as the company.' using errcode = '22023';
  end if;

  if p_is_active is null then
    raise exception 'Choose whether the employee is active.' using errcode = '22004';
  end if;

  if v_laptop_supplied = 'mam_laptop' and v_laptop_id is null then
    raise exception 'A Laptop ID is required for a MAM laptop.' using errcode = '22004';
  end if;

  if v_sort_order not between 0 and 32767 then
    raise exception 'Sort order must be between 0 and 32767.' using errcode = '22023';
  end if;

  if p_date_of_birth is not null and p_date_of_birth > current_date then
    raise exception 'Date of birth cannot be in the future.' using errcode = '22023';
  end if;

  if p_scheduled_employment_end_date is not null
    and p_started_date is not null
    and p_scheduled_employment_end_date < p_started_date then
    raise exception 'Scheduled employment end date cannot be before the start date.'
      using errcode = '22023';
  end if;

  if p_manager_id is not null then
    if not exists (
      select 1
      from public.internal_org_people manager
      where manager.id = p_manager_id
        and manager.node_kind = 'person'
        and manager.is_active
    ) then
      raise exception 'Choose an active employee as the manager.' using errcode = '23503';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  insert into public.internal_org_people (
    company_key,
    node_kind,
    position_title,
    full_name,
    parent_id,
    started_date,
    sort_order,
    is_active,
    auth_user_id,
    created_by,
    updated_by
  )
  values (
    v_company_key,
    'person',
    v_position_title,
    v_full_name,
    p_manager_id,
    p_started_date,
    v_sort_order,
    p_is_active,
    null,
    v_actor,
    v_actor
  )
  returning * into v_person;

  insert into private.employee_directory_details (
    person_id,
    first_name,
    last_name,
    work_email,
    personal_email,
    phone,
    team_name,
    country,
    date_of_birth,
    scheduled_employment_end_date,
    laptop_supplied,
    laptop_id,
    mouse_id,
    keyboard_id,
    asset_tags,
    created_by,
    updated_by
  )
  values (
    v_person.id,
    v_first_name,
    v_last_name,
    v_work_email,
    v_personal_email,
    v_phone,
    v_team_name,
    v_country,
    p_date_of_birth,
    p_scheduled_employment_end_date,
    v_laptop_supplied,
    v_laptop_id,
    v_mouse_id,
    v_keyboard_id,
    v_asset_tags,
    v_actor,
    v_actor
  )
  returning * into v_detail;

  insert into private.employee_directory_audit_events (
    person_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    v_person.id,
    v_actor,
    'created',
    array[
      'first_name',
      'last_name',
      'work_email',
      'personal_email',
      'phone',
      'position_title',
      'team_name',
      'manager_id',
      'country',
      'date_of_birth',
      'started_date',
      'scheduled_employment_end_date',
      'company_key',
      'is_active',
      'sort_order',
      'laptop_supplied',
      'laptop_id',
      'mouse_id',
      'keyboard_id',
      'asset_tags'
    ]::text[]
  );

  return query select v_person.id, v_person.version, v_detail.version;
end;
$function$
$sr_published_before$),
  ('function','public.get_employee_team_manager_default(text, text)','3301244c4cbf06ae7e0ecfa1711c73d58a05bdac2e0cd2f914197d8f169a155a',null),
  ('function_security','public.get_employee_team_manager_default(text, text)','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404',null),
  ('global_function_acl','public.get_employee_team_manager_default(text, text)','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9',null),
  ('global_relation_acl','private.employee_team_manager_defaults',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end,null),
  ('index','private.employee_team_manager_defaults_pkey','3c6f840a81fa52e854aa4423490e7c6b8667091b53e4e20f1536c831e31fefaf',null),
  ('relation','private.employee_team_manager_defaults',case current_setting('server_version_num')::integer/10000 when 16 then 'd07dee95e06b266e400556fe83f155d3bc1acedfe62716a92195d68da9b63a6a' when 17 then '441c0e971192032eedaebcff160a2cfc9b91cafaaf71ca7a0472da6aa5d01e07' end,null),
  ('routine_kind','public.get_employee_team_manager_default(text, text)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('type','private._employee_team_manager_defaults','f34a8c0c042c2f43ba2d26ca715887f97cd06218084b6066532b06990343e9a2',null),
  ('type','private.employee_team_manager_defaults','cbc380d1794b5266d8c1a87401bd65d7ad562c355a63d3988777884c613fc3d7',null);
-- Published PR222 annual-source-bank metadata, derived from unchanged source
-- on supported PostgreSQL 16/17. Keep the original initial aggregates.
-- Exactly 108 added identities and 18 retained before-definition substitutions.
insert into pg_temp.sr_published_predecessor(kind,object_identity,after_hash,before_definition) values
  ('column','private.leave_bank_adoption_receipts.created_at','be398acfa5d9d0dcb83cec2fe9670a09c1ed2d5782fe8ecb34d16a2117ac8cb1',null),
  ('column','private.leave_bank_adoption_receipts.id','0f16bb55407d689a68d5bcfcbb95c0689e517f3499bf0c9697acd6a3bbe1720e',null),
  ('column','private.leave_bank_adoption_receipts.operator_role','527d3b3e78afe547b11cb6ef5d3164df0348e331302661c2fd559131d61a3176',null),
  ('column','private.leave_bank_adoption_receipts.owner_key','485c07e7ec42ac0a6aa108931d58b3645b610d165a15ba19f98b7948d462d976',null),
  ('column','private.leave_bank_adoption_receipts.plan_hash','01319dab08245aa2f08d254ed76a7744506792a3818b242e7ecfc2771ae88746',null),
  ('column','private.leave_bank_adoption_receipts.source_count','328bc3ccb4c0b83b0d8f15d2d8f64a9d45dbb5a95532ec35986d2a15a8ecabc3',null),
  ('column','private.leave_bank_adoption_receipts_owner_key_key.owner_key','18f7571ef0723d2e4f19c869a52679a06f9e96067bb1c1999516e5135f19bc9e',null),
  ('column','private.leave_bank_adoption_receipts_pkey.id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab',null),
  ('column','private.leave_bank_adoption_receipts_plan_hash_key.plan_hash','18f7571ef0723d2e4f19c869a52679a06f9e96067bb1c1999516e5135f19bc9e',null),
  ('column','private.leave_bank_sources.adopted_at','ad1e8e76de3a7ece422ca0a46aa636eaad6a7357f48def79d3d4918fafa8ea18',null),
  ('column','private.leave_bank_sources.adoption_receipt_id','720e625a4d8c5ae475100d2ed1c40eba89cf7075af0b18564ffe558476fed8eb',null),
  ('column','private.leave_bank_sources.covered_service_through','e56049936e78ddf7ecb810873694c36eb421c7b8b40a2b490e04f353ee42bfa0',null),
  ('column','private.leave_bank_sources.hours','8042523b5dc3bb497d983728274fa16a3618834b64a59f57b7c785c5d31383ce',null),
  ('column','private.leave_bank_sources.id','0f16bb55407d689a68d5bcfcbb95c0689e517f3499bf0c9697acd6a3bbe1720e',null),
  ('column','private.leave_bank_sources.included_usage','5d7bbe2740ee90cb7a742f06763423827b86c4eb465e1f8c5fb22dee7ef00d90',null),
  ('column','private.leave_bank_sources.leave_kind','01319dab08245aa2f08d254ed76a7744506792a3818b242e7ecfc2771ae88746',null),
  ('column','private.leave_bank_sources.legacy_snapshot_fingerprint','92dd64855c41c498e84bd9e2d55a32b9d5b2c1eaaa8f763cea9c997bc5881f50',null),
  ('column','private.leave_bank_sources.note','969fdfdfb71b550c21c03dd68e9db5d7ae776fb29ab48388b90ad64a4f1b3ff8',null),
  ('column','private.leave_bank_sources.operator_role','f6a37495db8670dff591659543cd30a39e81e077b8d2225c06005c665aab611d',null),
  ('column','private.leave_bank_sources.person_id','bf71b2c32cd53e7cdd9e391222788131b8a4498ef022ebb8561afa4fc4fff578',null),
  ('column','private.leave_bank_sources.report_date','f1e8ffc7cdc5fd3c3bb706f04df9259e6b1cd5f4468c13546551daba4e555bde',null),
  ('column','private.leave_bank_sources.source_archive_id','700522dc0e2c49dd80ca603fcf2c9f38ba4faf9a224a194d85e051e960200337',null),
  ('column','private.leave_bank_sources.source_fingerprint','777f46b98bede7bf7163cdd2f85b66c47469d7d7603b426dcaf2dcf647146ae8',null),
  ('column','private.leave_bank_sources.source_import_id','09e777a8d2a36443023dbdb295e10879e42e5ce2cf298882ccb5529786b33d40',null),
  ('column','private.leave_bank_sources.source_kind','3997a8c3c57fe69cf23f34e703d954ffe36bbccae0f15db0da7b5fa91e3841c2',null),
  ('column','private.leave_bank_sources.source_row_id','438cdd5bb8014320071c39e72311da3b79ac1bacdbd910cccd8bbb0e70519b61',null),
  ('column','private.leave_bank_sources_latest.adopted_at','33dfe7398fdee5d9e6001f4de6e56b68b374a2067b288909294a5d6c8089eae3',null),
  ('column','private.leave_bank_sources_latest.id','9eb186c427a36fa6c6f151613ef41ebaca5cd36d39b5ab180091936248c54680',null),
  ('column','private.leave_bank_sources_latest.leave_kind','8cf8c9b217e34994afc9862d9bc1e478863200715dc4bcc5b4812916ccb8a3ae',null),
  ('column','private.leave_bank_sources_latest.person_id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab',null),
  ('column','private.leave_bank_sources_pkey.id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab',null),
  ('column','private.leave_payroll_calendars.calendar_key','485c07e7ec42ac0a6aa108931d58b3645b610d165a15ba19f98b7948d462d976',null),
  ('column','private.leave_payroll_calendars.person_id','652219c5442a9aa75c9914348de1bb4f02c16fc10c41ace8445c2bb95a8ac76c',null),
  ('column','private.leave_payroll_calendars_pkey.person_id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab',null),
  ('constraint','private.leave_bank_adoption_receipts:leave_bank_adoption_receipts_owner_key_check','39fc3942e5bfe8be2fa9fd2e65185435645e280298eb65fb09d58a318c59dd20',null),
  ('constraint','private.leave_bank_adoption_receipts:leave_bank_adoption_receipts_owner_key_key','2a7ca5c3ac06e72617b43ae24fe5a613943b1d840a6f8e91ad98f4b6ab327c21',null),
  ('constraint','private.leave_bank_adoption_receipts:leave_bank_adoption_receipts_pkey','ceeed3e1b6b0f71197286468986349d099d90ea1af0bc7dc10eec8147ca0bd38',null),
  ('constraint','private.leave_bank_adoption_receipts:leave_bank_adoption_receipts_plan_hash_check','e3cdafb12a6d6ec562d2718e81657ceea35caf2e121256a86b94a6921cc34abd',null),
  ('constraint','private.leave_bank_adoption_receipts:leave_bank_adoption_receipts_plan_hash_key','d86d7b171dcc0ba3f6f68bcce2f67d5ddc9f36165462a4359b5b2a302168563b',null),
  ('constraint','private.leave_bank_adoption_receipts:leave_bank_adoption_receipts_source_count_check','c6aa4609cfa209643c1a9d65b0a3dea2b612f21b6e341bcc863afbcef0c1ab30',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_adoption_receipt_id_fkey','d22d78fa07d4f4d68306ad4d06d8b0ec1cc2039d4f2fb7a4d772d0b96120c9a4',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_check','2e3080d30ab0dfaf62bfaeab0011fd62be040beed5111872e960b897c261ab7d',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_hours_check','4894d2dbf63d795d0db951dcd937d24f73394349fd7d8e82064e8e78889caba4',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_included_usage_check','8e6a55f782c87db3335a30b03cdd58ced042566bebe6d529e651a2e8f9307dd2',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_leave_kind_check','f65b24511bc02b5ba715d7769cd9967eaadf6fcb07a727375f2d047907650b6b',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_legacy_snapshot_fingerprint_check','58b2d0b496c3d6b4af1d3368ff001f255cf16efcdbf6fa05b9860e5877e730cf',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_note_check','0053e559cd123d8eaf2f9b43b0a0e6ec61ab6ae3375dbeb020c2bde09aeafd34',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_person_id_fkey','c667c97ff1d4aaf96e577d9a1718cfacaac3c6093fcbf24b34c86b4a6ceed7a7',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_pkey','ceeed3e1b6b0f71197286468986349d099d90ea1af0bc7dc10eec8147ca0bd38',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_source_archive_id_fkey','a6a1668c9cf739669fcceebe434d57b8cf1d422afdee2e31e8848f7476cdcf0a',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_source_fingerprint_check','258c9cc6a668b84656b4ef77f970975031f3fc919f14957c258477c4336e01c3',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_source_import_id_fkey','908c50a805bb5c146f92ff9739276d9e2a9f77d7acb0eb1b6363fededf263c75',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_source_kind_check','7794690d1191a18970b45386a68e020fc5910b34b207b6e537d951d0f6a1dfeb',null),
  ('constraint','private.leave_bank_sources:leave_bank_sources_source_row_id_fkey','97f037d4a5ec9111952adb30fb31b1aa9b4536ae23a6daa8db1d41268f6cff07',null),
  ('constraint','private.leave_payroll_calendars:leave_payroll_calendars_calendar_key_check','5844f03078974d0f6bec1bccab5055121ddaa8f03e6254dfa052754975ffc442',null),
  ('constraint','private.leave_payroll_calendars:leave_payroll_calendars_person_id_fkey','c667c97ff1d4aaf96e577d9a1718cfacaac3c6093fcbf24b34c86b4a6ceed7a7',null),
  ('constraint','private.leave_payroll_calendars:leave_payroll_calendars_pkey','291d7371f8b0754070a4eff1e1e89f5d793f005c0b0ad4b821c54adfeda73530',null),
  ('function','private.adopt_leave_bank_sources(text, text, jsonb)','3abf4e9666d95e464a3799f5896321cbd25571e67dab0761037eb161d39e7263',null),
  ('function','private.approved_leave_hours_after(uuid, text[], date)','03833b5e9266e4da7386994162bed27660c583b8f21eac95143046a4d3936f65',$sr_annual_before$CREATE OR REPLACE FUNCTION private.approved_leave_hours_after(p_person_id uuid, p_leave_types text[], p_after date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pending numeric;
begin
  if p_after is null then return null; end if;
  if exists(select 1 from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e
    join public.leave_requests r on r.id=e.request_id
    join public.internal_org_people p on p.id=e.person_id
    where e.request_fingerprint<>private.payroll_request_fingerprint(to_jsonb(r)) or e.company_key<>p.company_key) then
    return null;
  end if;
  select coalesce(sum(e.pending_hours),0) into pending
  from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e
  where e.through_date<=p_after and case when e.leave_kind='annual' then 'Annual leave'=any(p_leave_types)
    else ('Sick leave'=any(p_leave_types) or 'Carer''s leave'=any(p_leave_types)) end;
  return private.approved_leave_hours_after_before_carryforward(p_person_id,p_leave_types,p_after)+pending;
end;
$function$
$sr_annual_before$),
  ('function','private.calculate_employee_leave_accrual(uuid, date)','c798f362037f8e9e074b227d42a78574d924195dfe1f05e64a0a6c02dca5e4ab',$sr_annual_before$CREATE OR REPLACE FUNCTION private.calculate_employee_leave_accrual(p_person uuid, p_through date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a private.employee_annual_leave_balances%rowtype; s private.employee_sick_leave_balances%rowtype;
  pol private.leave_accrual_policies%rowtype; rev private.leave_accrual_day_reviews%rowtype;
  day date; through_day date; first_day date; review_day date; ordinary numeric;
  annual_delta numeric:=0; personal_delta numeric:=0; annual_taken numeric:=0; personal_taken numeric:=0;
  annual_eligible numeric; personal_eligible numeric; start_day date; end_day date; enabled_any boolean;
  fingerprint text; policy_id uuid; status text;
begin
  select * into a from private.employee_annual_leave_balances where person_id=p_person;
  select * into s from private.employee_sick_leave_balances where person_id=p_person;
  select p.started_date,d.scheduled_employment_end_date into start_day,end_day
  from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id where p.id=p_person;
  through_day:=least(p_through,(now() at time zone 'Australia/Melbourne')::date-1);
  select exists(select 1 from private.leave_accrual_policies where person_id=p_person) into enabled_any;
  if p_through is null or ((a.person_id is null or a.is_example) and s.person_id is null) or not enabled_any then
    return jsonb_build_object('status','not_configured','annualHours',a.hours,'personalHours',s.hours,'annualAsOf',a.as_of,'personalAsOf',s.as_of,
      'annualPayrollHours',a.hours,'personalPayrollHours',s.hours,'annualPayrollDate',a.as_of,'personalPayrollDate',s.as_of);
  end if;
  first_day:=least(case when a.person_id is not null and not a.is_example then a.as_of end,s.as_of)+1;
  -- Never silently drop older periods from a very old payroll baseline.
  if through_day-first_day>3660 then
    return jsonb_build_object('status','needs_review','reviewDate',first_day,'annualHours',a.hours,'personalHours',s.hours,'annualAsOf',a.as_of,'personalAsOf',s.as_of,
      'annualPayrollHours',a.hours,'personalPayrollHours',s.hours,'annualPayrollDate',a.as_of,'personalPayrollDate',s.as_of);
  end if;
  for day in select x::date from generate_series(first_day,through_day,interval '1 day') x loop
    if day<coalesce(start_day,day) or day>coalesce(end_day,day) then continue; end if;
    select * into pol from private.leave_accrual_policies where person_id=p_person and effective_from<=day order by effective_from desc,created_at desc,id desc limit 1;
    if not found then
      -- Unknown service/usage between the payroll close and first policy is
      -- not a zero-credit/zero-debit interval. A newer opening snapshot is needed.
      review_day:=day; through_day:=day-1; exit;
    end if;
    policy_id:=pol.id;
    fingerprint:=private.leave_accrual_request_fingerprint(p_person,day);
    select * into rev from private.leave_accrual_day_reviews where person_id=p_person and service_date=day order by created_at desc,id desc limit 1;
    if (pol.requires_review and rev.id is null)
      or (rev.id is not null and rev.request_fingerprint<>fingerprint)
      or (rev.id is null and fingerprint<>md5('[]')) then
      review_day:=day; through_day:=day-1; exit;
    end if;
    -- 420 is divisible by every possible weekday count (1..7). Keep the
    -- numerator exact across days/policies and divide once after summation.
    ordinary:=case when pol.enabled and extract(isodow from day)::integer=any(pol.weekdays) then pol.weekly_hours*(420/cardinality(pol.weekdays)) else 0 end;
    annual_eligible:=case when pol.enabled or pol.requires_review then coalesce(rev.annual_eligible_hours*420,ordinary) else 0 end;
    personal_eligible:=case when pol.enabled or pol.requires_review then coalesce(rev.personal_eligible_hours*420,ordinary) else 0 end;
    if a.person_id is not null and not a.is_example and day>a.as_of then
      annual_delta:=annual_delta+annual_eligible*pol.annual_weeks;
      annual_taken:=annual_taken+coalesce(rev.annual_taken_hours,0);
    end if;
    if day>s.as_of then
      personal_delta:=personal_delta+personal_eligible*pol.personal_weeks;
      personal_taken:=personal_taken+coalesce(rev.personal_taken_hours,0);
    end if;
  end loop;
  annual_delta:=annual_delta/(420*52); personal_delta:=personal_delta/(420*52);
  status:=case when review_day is not null then 'needs_review' else 'current' end;
  return jsonb_build_object('status',status,'reviewDate',review_day,
    'annualHours',round(a.hours+annual_delta-annual_taken,4),'personalHours',round(s.hours+personal_delta-personal_taken,4),
    'annualExactHours',a.hours+annual_delta-annual_taken,'personalExactHours',s.hours+personal_delta-personal_taken,
    'annualAsOf',case when a.person_id is null or a.is_example then a.as_of else greatest(a.as_of,through_day) end,'personalAsOf',case when s.person_id is null then null else greatest(s.as_of,through_day) end,'policyId',policy_id,
    'annualPayrollHours',a.hours,'personalPayrollHours',s.hours,'annualPayrollDate',a.as_of,'personalPayrollDate',s.as_of,
    'annualEarned',annual_delta,'personalEarned',personal_delta,'annualTaken',annual_taken,'personalTaken',personal_taken);
end;
$function$
$sr_annual_before$),
  ('function','private.calculate_leave_entitlement(uuid, text, date)','32843b768f85879c6d158f5b0e4122da3ae9638d5525aa3bc8646941e677efc9',null),
  ('function','private.enforce_banked_annual_leave_request()','8443b5e62134cf6cb797743b36418b9a4b332f1f205c814522d47ccd6ca1b684',$sr_annual_before$CREATE OR REPLACE FUNCTION private.enforce_banked_annual_leave_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare projection jsonb; required numeric; available numeric; own_hours numeric := 0;
  bank_date date; classification text; budget_classification text; changed boolean := true; timed_hours numeric; days integer;
begin
  if tg_op='UPDATE' then
    changed := row(new.employee_person_id,new.leave_type,new.request_type_label,new.start_date,new.end_date,
      new.start_time,new.end_time,new.business_days,new.hours,new.employment_type_snapshot,new.pay_treatment)
      is distinct from row(old.employee_person_id,old.leave_type,old.request_type_label,old.start_date,old.end_date,
        old.start_time,old.end_time,old.business_days,old.hours,old.employment_type_snapshot,old.pay_treatment);
    if new.status in ('cancelled','rejected') and not changed then return new; end if;
    if not changed and (new.status is not distinct from old.status
      or (old.status='approved' and new.status<>'approved')) then return new; end if;
  end if;
  if new.request_type_label <> 'Annual leave' and new.leave_type <> 'annual' then return new; end if;
  perform private.lock_annual_leave_budget();
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Annual leave changes require a fresh READ COMMITTED transaction.' using errcode='55000';
  end if;
  if new.request_type_label is distinct from 'Annual leave' or new.leave_type is distinct from 'annual'
    or new.pay_treatment is distinct from 'paid_entitlement' then
    raise exception 'Annual leave classification is inconsistent.' using errcode='22023';
  end if;
  perform private.assert_leave_date_range(new.start_date,new.end_date);
  select employment_type into classification from private.employee_directory_details where person_id=new.employee_person_id;
  if tg_op='INSERT' and new.employment_type_snapshot is null then new.employment_type_snapshot:=classification; end if;
  budget_classification:=coalesce(new.employment_type_snapshot,classification);
  if budget_classification not in ('full_time','part_time')
    or budget_classification is null
    or (tg_op='INSERT' and new.employment_type_snapshot is distinct from classification)
    or (tg_op='UPDATE' and (new.employment_type_snapshot is distinct from old.employment_type_snapshot
      or new.employee_person_id is distinct from old.employee_person_id)
      and budget_classification is distinct from classification) then
    raise exception 'Annual leave employment snapshot is inconsistent.' using errcode='22023';
  end if;
  select count(*)::integer into days from generate_series(new.start_date,new.end_date,interval '1 day') day
    where extract(isodow from day) between 1 and 5;
  if days<1 or new.business_days is distinct from days then
    raise exception 'Annual leave working days are inconsistent.' using errcode='22023';
  end if;
  if new.start_time is not null or new.end_time is not null then
    select round(sum(case when day::date=new.start_date and day::date=new.end_date then extract(epoch from(new.end_time-new.start_time))/3600
      when day::date=new.start_date then extract(epoch from(time '18:00'-new.start_time))/3600
      when day::date=new.end_date then extract(epoch from(new.end_time-time '06:00'))/3600 else 12 end),2)
    into timed_hours from generate_series(new.start_date,new.end_date,interval '1 day') day
      where extract(isodow from day) between 1 and 5;
    if new.start_time is null or new.end_time is null or new.hours is distinct from timed_hours then
      raise exception 'Annual leave timed hours are inconsistent.' using errcode='22023';
    end if;
  end if;
  projection := private.project_annual_leave_balance(new.employee_person_id,new.start_date);
  required := coalesce(new.hours,new.business_days*case when budget_classification='full_time' then 7.6 else 7.5 end);
  if tg_op='UPDATE' and old.status='approved' and old.request_type_label='Annual leave'
    and old.employee_person_id=new.employee_person_id then
    select as_of into bank_date from private.employee_annual_leave_balances where person_id=new.employee_person_id;
    own_hours:=private.payroll_request_hours_after(old.id,bank_date);
    select own_hours+coalesce((select e.pending_hours from private.payroll_carryforward_events e
      where e.request_id=old.id and e.leave_kind='annual' and e.through_date<=bank_date order by e.id desc limit 1),0) into own_hours;
  end if;
  available:=(projection->>'availableHours')::numeric+own_hours;
  if projection->>'status'='unavailable' or required is null or required<=0 or available is null
    or required::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
  end if;
  if required>available then
    if projection->>'status'='banked_only' then
      raise exception 'Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.' using errcode='22023';
    end if;
    raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023';
  end if;
  return new;
end;
$function$
$sr_annual_before$),
  ('function','private.fill_leave_balance_required_hours()','d815207f35ecc6808d08a5f997ab3a5c1019f03f6a2524cbcdc58b690a797951',$sr_annual_before$CREATE OR REPLACE FUNCTION private.fill_leave_balance_required_hours()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare required numeric;
begin
  required:=private.leave_request_required_hours(new.request_id);
  if required is null or required<=0 or (new.required_hours is not null and new.required_hours is distinct from required) then
    raise exception 'Paid hours are calculated automatically for this request.' using errcode='22023';
  end if;
  new.required_hours:=required;
  return new;
end;
$function$
$sr_annual_before$),
  ('function','private.freeze_payroll_balance_comparison(uuid)','312caf027b965cb7cb1ae07571f2d73d7326571211efc4c64de42607f52cdb60',$sr_annual_before$CREATE OR REPLACE FUNCTION private.freeze_payroll_balance_comparison(p_batch_id uuid)
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
  if not exists(select 1 from private.payroll_balance_comparisons where batch_id=p_batch_id) then
    with values_to_compare as (
      select s.id,s.employee_name,s.company_key,s.as_of,s.match_status,
        v.kind,v.uploaded,v.system_hours,v.system_as_of
      from private.payroll_balance_import_stage_rows s
      left join private.employee_annual_leave_balances a on a.person_id=s.person_id
      left join private.employee_sick_leave_balances k on k.person_id=s.person_id
      cross join lateral (values
        ('annual',s.annual_hours,case when not a.is_example then a.hours-private.approved_leave_hours_after(s.person_id,array['Annual leave'],a.as_of) end,a.as_of),
        ('sick',s.sick_hours,k.hours-private.approved_leave_hours_after(s.person_id,array['Sick leave','Carer''s leave'],k.as_of),k.as_of)
      ) v(kind,uploaded,system_hours,system_as_of)
      where s.batch_id=p_batch_id and v.uploaded is not null
    ), compared as (
      select *,match_status<>'linked' or system_hours is null or round(uploaded,2) is distinct from round(system_hours,2) as different
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
$function$
$sr_annual_before$),
  ('function','private.leave_bank_basis(uuid, text)','b6ad67f7ad0b2c11c51c70c91fa7276abc469a3ac9ed305e1b0357394aa01faf',null),
  ('function','private.leave_payroll_balance_sufficient(uuid)','3ca926e6db700a3cae42341a738413ee5ce4eba03ac3d09bb671e44373af5619',$sr_annual_before$CREATE OR REPLACE FUNCTION private.leave_payroll_balance_sufficient(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.leave_requests request
    join private.leave_balance_approvals approval
      on approval.request_id = request.id
    join private.employee_annual_leave_balances balance
      on balance.person_id = request.employee_person_id
    join public.internal_org_people person
      on person.id = request.employee_person_id and person.is_active
    cross join lateral (
      select private.calculate_employee_leave_accrual(
        person.id,
        (now() at time zone 'Australia/Melbourne')::date - 1
      ) calculation
    ) calculated
    where request.id = p_request_id
      and request.status = 'submitted'
      and request.record_origin = 'portal'
      and request.approval_required
      and request.request_type_label = 'Annual leave'
      and not balance.is_example
      and calculated.calculation ->> 'status' <> 'needs_review'
      and case
        when calculated.calculation ->> 'status' = 'current' then
          (calculated.calculation ->> 'annualAsOf')::date
            >= (approval.approved_at at time zone 'Australia/Melbourne')::date
          and (
            (calculated.calculation ->> 'annualExactHours')::numeric
            - (private.payroll_request_unconsumed_hours(
                person.id,
                balance.as_of,
                (calculated.calculation ->> 'annualAsOf')::date
              ))
          ) >= approval.required_hours
        else
          balance.updated_at >= approval.approved_at
          and balance.as_of >= (approval.approved_at at time zone 'Australia/Melbourne')::date
          and (
            balance.hours
            - (private.approved_leave_hours_after(
                person.id,
                array['Annual leave']::text[],
                balance.as_of
              ))
          ) >= approval.required_hours
      end
  );
$function$
$sr_annual_before$),
  ('function','private.leave_payroll_day_hours(uuid, date)','c404ccc94bd8967bf47d4d58188ca4e9e9e02bf4f2a8d690418a2b515a00e5bc',null),
  ('function','private.leave_request_quantity(uuid, date, date, time without time zone, time without time zone, numeric)','bbd035ddbad9d5afdc7ab4105e0c4aed449d42923f1d71330aeb3bd0daaadb61',null),
  ('function','private.leave_request_required_hours(uuid)','5dbc557b82ea473692dc0dd2fe82443114e0c7287b4e69321235d56fc96641f7',$sr_annual_before$CREATE OR REPLACE FUNCTION private.leave_request_required_hours(p_request_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    request.hours,
    request.business_days::numeric
      * case
          when coalesce(request.employment_type_snapshot, detail.employment_type) = 'full_time'
            then 7.6
          else 7.5
        end
  )
  from public.leave_requests request
  left join private.employee_directory_details detail
    on detail.person_id = request.employee_person_id
  where request.id = p_request_id;
$function$
$sr_annual_before$),
  ('function','private.openclaw_submit_self(uuid, text, date, date, time without time zone, time without time zone, text)','9fc31b148db1bb70cc137cf50013dee23920b3fb33539f92ef2486f52051ea2e',E'CREATE OR REPLACE FUNCTION private.openclaw_submit_self(p_actor_user_id uuid, p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)\n RETURNS TABLE(id uuid, status text, approval_required boolean, assigned_reviewer_label text)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''''\nAS $function$\ndeclare\n  v_actor_user_id uuid := p_actor_user_id;\n  v_actor_person_id uuid;\n  v_request_type_label text := nullif(btrim(p_request_type_label), '''');\n  v_leave_type text;\n  v_employee_note text := nullif(btrim(p_employee_note), '''');\n  v_business_days integer;\n  v_hours numeric(7, 2);\n  v_primary_reviewer_user_id uuid;\n  v_primary_reviewer_label text;\n  v_reviewer_count integer;\n  v_request public.leave_requests%rowtype;\nbegin\n  if v_actor_user_id is null\n    \n    or not private.is_active_portal_account(v_actor_user_id) then\n    raise exception ''An active portal account is required to submit leave.''\n      using errcode = ''42501'';\n  end if;\n\n  select person.id into strict v_actor_person_id from public.internal_org_people person where person.auth_user_id=v_actor_user_id and person.is_active and person.node_kind=''person'' and person.company_key=''mam'';\n  if v_actor_person_id is null then\n    raise exception ''An active linked employee account is required to submit leave.''\n      using errcode = ''42501'';\n  end if;\n\n  if v_request_type_label is null or v_request_type_label not in (\n    ''Annual leave'',\n    ''Sick leave'',\n    ''Carer''''s leave'',\n    ''Unpaid leave''\n  ) then\n    raise exception ''Choose a valid leave type.'' using errcode = ''22023'';\n  end if;\n\n  perform private.assert_leave_date_range(p_start_date, p_end_date);\n  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then\n    raise exception ''End date must be on or after start date.'' using errcode = ''22023'';\n  end if;\n\n  if (p_start_time is null) <> (p_end_time is null) then\n    raise exception ''Choose both times or neither.'' using errcode = ''22023'';\n  end if;\n\n  if v_employee_note is not null and char_length(v_employee_note) > 2000 then\n    raise exception ''Leave note is too long.'' using errcode = ''22001'';\n  end if;\n\n  select count(*)::integer\n  into v_business_days\n  from generate_series(p_start_date, p_end_date, interval ''1 day'') day\n  where extract(isodow from day) between 1 and 5;\n\n  if v_business_days < 1 then\n    raise exception ''Choose at least one weekday for this request.'' using errcode = ''22023'';\n  end if;\n\n  if p_start_time is not null then\n    if extract(isodow from p_start_date) not between 1 and 5\n      or extract(isodow from p_end_date) not between 1 and 5\n      or p_start_time < time ''06:00''\n      or p_start_time >= time ''18:00''\n      or p_end_time <= time ''06:00''\n      or p_end_time > time ''18:00''\n      or (p_start_date = p_end_date and p_end_time <= p_start_time)\n      or extract(minute from p_start_time)::integer % 15 <> 0\n      or extract(minute from p_end_time)::integer % 15 <> 0 then\n      raise exception ''Times must use 15-minute intervals within 06:00 to 18:00.''\n        using errcode = ''22023'';\n    end if;\n\n    select round(sum(\n      case\n        when day::date = p_start_date and day::date = p_end_date then\n          (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric\n        when day::date = p_start_date then\n          (extract(epoch from (time ''18:00'' - p_start_time)) / 3600)::numeric\n        when day::date = p_end_date then\n          (extract(epoch from (p_end_time - time ''06:00'')) / 3600)::numeric\n        else 12::numeric\n      end\n    ), 2)\n    into v_hours\n    from generate_series(p_start_date, p_end_date, interval ''1 day'') day\n    where extract(isodow from day) between 1 and 5;\n\n    if v_hours is null or v_hours <= 0 then\n      raise exception ''Choose a time range with working hours.'' using errcode = ''22023'';\n    end if;\n  end if;\n\n  -- Lock the hierarchy and the grant configuration in one stable order before\n  -- deriving the snapshot. Organisation edits and grant changes therefore\n  -- affect either this request or a later request, never half of each.\n  perform pg_advisory_xact_lock(hashtextextended(''internal_org_people_hierarchy'', 0));\n  perform pg_advisory_xact_lock(hashtextextended(''leave_approval_grants'', 0));\n\n  select count(distinct candidate.reviewer_user_id)::integer\n  into v_reviewer_count\n  from private.resolve_leave_approval_grants(v_actor_person_id) candidate\n  where candidate.reviewer_user_id is distinct from v_actor_user_id;\n\n  if coalesce(v_reviewer_count, 0) < 1 then\n    raise exception ''No authorised leave reviewer is configured for this request.''\n      using errcode = ''42501'';\n  end if;\n\n  select candidate.reviewer_user_id, candidate.reviewer_label\n  into v_primary_reviewer_user_id, v_primary_reviewer_label\n  from private.resolve_leave_approval_grants(v_actor_person_id) candidate\n  where candidate.reviewer_user_id is distinct from v_actor_user_id\n  order by\n    case candidate.scope_kind\n      when ''team'' then 0\n      when ''subtree'' then 1\n      else 2\n    end,\n    candidate.scope_priority,\n    candidate.scope_depth,\n    candidate.grant_id\n  limit 1;\n\n  v_leave_type := case v_request_type_label\n    when ''Annual leave'' then ''annual''\n    when ''Sick leave'' then ''personal''\n    when ''Carer''''s leave'' then ''personal''\n    when ''Unpaid leave'' then ''unpaid''\n  end;\n\n  insert into public.leave_requests (\n    user_id,\n    leave_type,\n    request_type_label,\n    start_date,\n    end_date,\n    start_time,\n    end_time,\n    business_days,\n    hours,\n    approval_required,\n    manager_user_id,\n    manager_name_snapshot,\n    reason,\n    status,\n    submitted_at,\n    decided_at,\n    decided_by,\n    created_at,\n    updated_at\n  )\n  values (\n    v_actor_user_id,\n    v_leave_type,\n    v_request_type_label,\n    p_start_date,\n    p_end_date,\n    p_start_time,\n    p_end_time,\n    v_business_days,\n    v_hours,\n    true,\n    v_primary_reviewer_user_id,\n    v_primary_reviewer_label,\n    v_employee_note,\n    ''submitted'',\n    clock_timestamp(),\n    null,\n    null,\n    clock_timestamp(),\n    clock_timestamp()\n  )\n  returning * into v_request;\n\n  with candidates as (\n    select candidate.*\n    from private.resolve_leave_approval_grants(v_actor_person_id) candidate\n    where candidate.reviewer_user_id is distinct from v_actor_user_id\n  ),\n  distinct_reviewers as (\n    select distinct on (candidate.reviewer_user_id)\n      candidate.*\n    from candidates candidate\n    order by\n      candidate.reviewer_user_id,\n      case candidate.scope_kind\n        when ''team'' then 0\n        when ''subtree'' then 1\n        else 2\n      end,\n      candidate.scope_priority,\n      candidate.scope_depth,\n      candidate.grant_id\n  ),\n  ranked_reviewers as (\n    select\n      candidate.*,\n      row_number() over (\n        order by\n          case candidate.scope_kind\n            when ''team'' then 0\n            when ''subtree'' then 1\n            else 2\n          end,\n          candidate.scope_priority,\n          candidate.scope_depth,\n          candidate.grant_id\n      ) as route_rank\n    from distinct_reviewers candidate\n  )\n  insert into private.leave_request_reviewer_assignments (\n    leave_request_id,\n    reviewer_user_id,\n    source_grant_id,\n    assignment_kind,\n    reviewer_label,\n    is_primary\n  )\n  select\n    v_request.id,\n    candidate.reviewer_user_id,\n    candidate.grant_id,\n    candidate.scope_kind,\n    candidate.reviewer_label,\n    candidate.route_rank = 1\n  from ranked_reviewers candidate;\n\n  insert into public.leave_request_events (\n    leave_request_id,\n    actor_user_id,\n    event_type,\n    note\n  )\n  values\n    (v_request.id, v_actor_user_id, ''created'', null),\n    (v_request.id, v_actor_user_id, ''submitted'', null);\n\n  return query\n  select\n    v_request.id,\n    ''Pending'',\n    v_request.approval_required,\n    v_primary_reviewer_label;\nend;\n$function$\n'),
  ('function','private.payroll_balance_import_batch_projection_before_comparison(uuid)','841639117403118f2f571ca745d7739473e3c0d35d41ca938faf668bb82f375f',$sr_annual_before$CREATE OR REPLACE FUNCTION private.payroll_balance_import_batch_projection_before_comparison(p_batch_id uuid)
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
$function$
$sr_annual_before$),
  ('function','private.payroll_closing_fingerprint(uuid)','b493117f4f48dd813f551893802309f988d634b3af14ab1a18a40ce871763c5c',$sr_annual_before$CREATE OR REPLACE FUNCTION private.payroll_closing_fingerprint(p_person uuid)
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
    'annualHistory',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from private.annual_leave_balance_history h where person_id=p_person),
    'personalHistory',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from private.sick_leave_balance_history h where person_id=p_person),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from private.leave_accrual_policies p where person_id=p_person),
    'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from private.leave_accrual_day_reviews r where person_id=p_person),
    'requests',(select coalesce(jsonb_agg(private.payroll_request_money(to_jsonb(r)) order by id),'[]') from public.leave_requests r where employee_person_id=p_person),
    'carry',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from private.payroll_carryforward_events e where person_id=p_person)
  )::text,'UTF8')),'hex');
$function$
$sr_annual_before$),
  ('function','private.payroll_closing_snapshot_guard()','4c1f3d978922f27297961d2aff9ea6211e7a219a88fdc541683187589101e4aa',$sr_annual_before$CREATE OR REPLACE FUNCTION private.payroll_closing_snapshot_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare person uuid; receipt uuid; actor uuid;
begin
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
$function$
$sr_annual_before$),
  ('function','private.payroll_request_hours_after(uuid, date)','fa4c121210ae3c9dddb8007460f0d5b633299592ef680ed7579c499f5cd68e0f',$sr_annual_before$CREATE OR REPLACE FUNCTION private.payroll_request_hours_after(p_request uuid, p_after date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when r.status<>'approved' or p_after is null then null else
    case when r.hours is null then (select count(*)*case when coalesce(r.employment_type_snapshot,d.employment_type)='full_time' then 7.6 else 7.5 end
      from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5)
    when r.start_time is null or r.end_time is null then r.hours*(select count(*) from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5)
      /nullif((select count(*) from generate_series(r.start_date,r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5),0)
    else (select coalesce(sum(case when day::date=r.start_date and day::date=r.end_date then extract(epoch from(r.end_time-r.start_time))/3600
      when day::date=r.start_date then extract(epoch from(time '18:00'-r.start_time))/3600
      when day::date=r.end_date then extract(epoch from(r.end_time-time '06:00'))/3600 else 12 end),0)
      from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5) end end
  from public.leave_requests r left join private.employee_directory_details d on d.person_id=r.employee_person_id where r.id=p_request;
$function$
$sr_annual_before$),
  ('function','private.project_annual_leave_balance(uuid, date)','b88e6a78a3c43681496f9649611cc06df507955bf10929f1b27970cd2ff848d0',$sr_annual_before$CREATE OR REPLACE FUNCTION private.project_annual_leave_balance(p_person uuid, p_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb; bank private.employee_annual_leave_balances%rowtype; provenance text;
begin
  select * into bank from private.employee_annual_leave_balances where person_id=p_person;
  if bank.person_id is null or bank.is_example or p_start is null
    or private.approved_leave_hours_after(p_person,array['Annual leave'],bank.as_of) is null then
    return jsonb_build_object('status','unavailable','projectedDate',p_start);
  end if;
  result:=private.project_annual_leave_balance_before_carryforward(p_person,p_start);
  select case when r.operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where id=bank.closing_receipt_id;
  return result||jsonb_build_object('retainedHours',private.payroll_retained_hours(p_person,'annual'),'balanceSource',provenance);
end;
$function$
$sr_annual_before$),
  ('function','private.reject_leave_bank_source_mutation()','c7582653b887df78b36e447364aa428504e6f401772362aa0477192728afb296',null),
  ('function','public.get_leave_priority_workspace(uuid)','387adba7c8121c288ec8014047867a1287e521a3d51413167bb51ef477e1511d',$sr_annual_before$CREATE OR REPLACE FUNCTION public.get_leave_priority_workspace(p_preview_person_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare workspace jsonb; person jsonb; people jsonb:='[]'; pid uuid;
  a private.employee_annual_leave_balances%rowtype; s private.employee_sick_leave_balances%rowtype;
  approved numeric; provenance text;
begin
  workspace:=public.get_leave_priority_workspace_before_carryforward(p_preview_person_id);
  for person in select value from jsonb_array_elements(workspace->'people') loop
    pid:=(person->>'personId')::uuid;
    if coalesce((person->>'canViewBalance')::boolean,false) and coalesce((person->>'paidLeave')::boolean,false) then
      select * into a from private.employee_annual_leave_balances where person_id=pid;
      select case when r.operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where r.id=a.closing_receipt_id;
      approved:=private.approved_leave_hours_after(pid,array['Annual leave'],a.as_of);
      person:=person||jsonb_build_object('annualPayrollHours',case when not a.is_example then a.hours end,'annualPayrollDate',a.as_of,
        'annualApprovedHours',approved,'annualAvailableHours',case when not a.is_example then a.hours-approved end,
        'annualRetainedHours',case when not a.is_example then private.payroll_retained_hours(pid,'annual') end,
        'annualBalanceSource',provenance);
    end if;
    if coalesce((person->>'canViewSickBalance')::boolean,false) then
      select * into s from private.employee_sick_leave_balances where person_id=pid;
      select case when r.operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where r.id=s.closing_receipt_id;
      approved:=private.approved_leave_hours_after(pid,array['Sick leave','Carer''s leave'],s.as_of);
      person:=person||jsonb_build_object('sickPayrollHours',s.hours,'sickPayrollDate',s.as_of,'sickApprovedHours',approved,
        'sickAvailableHours',s.hours-approved,'sickRetainedHours',case when s.person_id is not null then private.payroll_retained_hours(pid,'personal') end,
        'sickBalanceSource',provenance);
    end if;
    people:=people||jsonb_build_array(person);
  end loop;
  return jsonb_set(workspace,'{people}',people);
end;
$function$
$sr_annual_before$),
  ('function','public.preview_annual_leave_request(uuid, date, date, time without time zone, time without time zone, uuid)','ee919150e1caf4b47f3dd36e23b11b33aa5225b7042ca6ae6307e2b65132cd9f',null),
  ('function','public.preview_payroll_closing_reconciliation(uuid)','15b3d80bed8a81958798f55e1154cd5d6710cae6055959e63dd4f612138cd8c6',$sr_annual_before$CREATE OR REPLACE FUNCTION public.preview_payroll_closing_reconciliation(p_person_id uuid)
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
    'annual',(select to_jsonb(b) from private.employee_annual_leave_balances b where person_id=p_person_id),
    'personal',(select to_jsonb(b) from private.employee_sick_leave_balances b where person_id=p_person_id),
    'reservations',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e));
end;
$function$
$sr_annual_before$),
  ('function','public.set_employee_leave_accrual_policy(uuid, numeric, numeric, numeric, boolean, boolean, text)','c53f9141657702799d4db13a6eb0a0d39cdf6c93aabfb56de616e7069a4db0f5',$sr_annual_before$CREATE OR REPLACE FUNCTION public.set_employee_leave_accrual_policy(p_person_id uuid, p_weekly_hours numeric, p_annual_weeks numeric, p_personal_weeks numeric, p_shiftworker boolean, p_enabled boolean, p_note text)
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
    if not exists(select 1 from private.employee_annual_leave_balances where person_id=p_person_id and not is_example)
      and not exists(select 1 from private.employee_sick_leave_balances where person_id=p_person_id) then
      raise exception 'Supply an authoritative opening payroll balance first.';
    end if;
    if exists(select 1 from private.employee_annual_leave_balances where person_id=p_person_id and not is_example and as_of<(now() at time zone 'Australia/Melbourne')::date-1)
      or exists(select 1 from private.employee_sick_leave_balances where person_id=p_person_id and as_of<(now() at time zone 'Australia/Melbourne')::date-1) then
      raise exception 'Supply opening payroll balances covering yesterday before first activation.';
    end if;
  end if;
  if p_weekly_hours::text in ('NaN','Infinity','-Infinity') or p_annual_weeks::text in ('NaN','Infinity','-Infinity') or p_personal_weeks::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter finite hours and entitlements.';end if;
  insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,shiftworker,enabled,note,actor_user_id)
  values(p_person_id,greatest((now() at time zone 'Australia/Melbourne')::date,(select max(effective_from) from private.leave_accrual_policies where person_id=p_person_id)),p_weekly_hours,weekdays,p_annual_weeks,p_personal_weeks,p_shiftworker,p_enabled,btrim(p_note),auth.uid());
end;
$function$
$sr_annual_before$),
  ('function','public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text)','f356cac9b4720d4a05c715867fc8a64b216c121adc4c900353e869f40b9ca915',$sr_annual_before$CREATE OR REPLACE FUNCTION public.submit_my_leave_request(p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
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
$function$
$sr_annual_before$),
  ('function','public.submit_selected_employee_leave_request(uuid, text, date, date, time without time zone, time without time zone, text)','0d4c6c27b4148950c14fb1e83c23f197ced06fb128502ce345dde75289467c07',$sr_annual_before$CREATE OR REPLACE FUNCTION public.submit_selected_employee_leave_request(p_person_id uuid, p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
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
$function$
$sr_annual_before$),
  ('function_security','private.adopt_leave_bank_sources(text, text, jsonb)','b222cdf5ff00d23de129118bc17a83fe1c3bcc69143f7587b67aef8a3ff38e36',null),
  ('function_security','private.calculate_leave_entitlement(uuid, text, date)','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80',null),
  ('function_security','private.leave_bank_basis(uuid, text)','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80',null),
  ('function_security','private.leave_payroll_day_hours(uuid, date)','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80',null),
  ('function_security','private.leave_request_quantity(uuid, date, date, time without time zone, time without time zone, numeric)','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80',null),
  ('function_security','private.reject_leave_bank_source_mutation()','b222cdf5ff00d23de129118bc17a83fe1c3bcc69143f7587b67aef8a3ff38e36',null),
  ('function_security','public.preview_annual_leave_request(uuid, date, date, time without time zone, time without time zone, uuid)','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404',null),
  ('global_function_acl','private.adopt_leave_bank_sources(text, text, jsonb)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3',null),
  ('global_function_acl','private.calculate_leave_entitlement(uuid, text, date)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3',null),
  ('global_function_acl','private.leave_bank_basis(uuid, text)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3',null),
  ('global_function_acl','private.leave_payroll_day_hours(uuid, date)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3',null),
  ('global_function_acl','private.leave_request_quantity(uuid, date, date, time without time zone, time without time zone, numeric)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3',null),
  ('global_function_acl','private.reject_leave_bank_source_mutation()','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3',null),
  ('global_function_acl','public.preview_annual_leave_request(uuid, date, date, time without time zone, time without time zone, uuid)','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9',null),
  ('global_relation_acl','private.leave_bank_adoption_receipts',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end,null),
  ('global_relation_acl','private.leave_bank_sources',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end,null),
  ('global_relation_acl','private.leave_payroll_calendars',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end,null),
  ('index','private.leave_bank_adoption_receipts_owner_key_key','a5b84c5895e8d375e652e5e01ecd7eb05cfe4a85c5e6f6c918f34b3f942d3973',null),
  ('index','private.leave_bank_adoption_receipts_pkey','19c7d4195cf0f1d923480778c2b8e29232e12420d530678d2744755e8d862994',null),
  ('index','private.leave_bank_adoption_receipts_plan_hash_key','cbfabc4c211bae563e462249f97081912760c8d4b924245e973390b43fab8085',null),
  ('index','private.leave_bank_sources_latest','06365b62c189c55f0ecbb4a07e0f4eb4ee746d0f2a3b3bb1e4fb253bdca8e09e',null),
  ('index','private.leave_bank_sources_pkey','33f561b8ed7685ce76a161aeb9a918a2d1045f5cddd94acc4027b2d28aaaeae3',null),
  ('index','private.leave_payroll_calendars_pkey','82d8a571df855f229ee84303ab11fbee48e85095dee400be6984fda295f0dce6',null),
  ('relation','private.leave_bank_adoption_receipts',case current_setting('server_version_num')::integer/10000 when 16 then 'd07dee95e06b266e400556fe83f155d3bc1acedfe62716a92195d68da9b63a6a' when 17 then '441c0e971192032eedaebcff160a2cfc9b91cafaaf71ca7a0472da6aa5d01e07' end,null),
  ('relation','private.leave_bank_sources',case current_setting('server_version_num')::integer/10000 when 16 then 'd07dee95e06b266e400556fe83f155d3bc1acedfe62716a92195d68da9b63a6a' when 17 then '441c0e971192032eedaebcff160a2cfc9b91cafaaf71ca7a0472da6aa5d01e07' end,null),
  ('relation','private.leave_payroll_calendars',case current_setting('server_version_num')::integer/10000 when 16 then 'd07dee95e06b266e400556fe83f155d3bc1acedfe62716a92195d68da9b63a6a' when 17 then '441c0e971192032eedaebcff160a2cfc9b91cafaaf71ca7a0472da6aa5d01e07' end,null),
  ('routine_kind','private.adopt_leave_bank_sources(text, text, jsonb)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('routine_kind','private.calculate_leave_entitlement(uuid, text, date)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('routine_kind','private.leave_bank_basis(uuid, text)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('routine_kind','private.leave_payroll_day_hours(uuid, date)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('routine_kind','private.leave_request_quantity(uuid, date, date, time without time zone, time without time zone, numeric)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('routine_kind','private.reject_leave_bank_source_mutation()','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('routine_kind','public.preview_annual_leave_request(uuid, date, date, time without time zone, time without time zone, uuid)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111',null),
  ('trigger','private.leave_bank_adoption_receipts:leave_bank_receipts_immutable','1d64bd5bc0ffbef50e55d050d5aa01503e6a5aadbddca5b714a7f860cac827e6',null),
  ('trigger','private.leave_bank_adoption_receipts:reject_retired_test_identity_reference','6200a381c1e02eca11e461421070fdb7cccfe443a8a9fdb01dc76be962dbe1cc',null),
  ('trigger','private.leave_bank_sources:leave_bank_sources_immutable','1c160191c888cb5ddc12193c0c478369305f84ad4bfc456f097f1b1d8bfa835c',null),
  ('trigger','private.leave_bank_sources:reject_retired_test_identity_reference','3fd76dc27b3ef8e9f4ae78a086891c83049584521cd6cf799e9ed402377eda91',null),
  ('trigger','private.leave_payroll_calendars:reject_retired_test_identity_reference','020c31f6e606f3b58287e829f6358c123c9473f6c920b27c2ee654ca12239a77',null),
  ('type','private._leave_bank_adoption_receipts','2b870c9d7f184598906052c63c40b1ed333e4ce79754d79c23a24e330caaeb31',null),
  ('type','private._leave_bank_sources','eea23441df98ba33bd33262e29fbe255d213a103722327935f6ac7360a113199',null),
  ('type','private._leave_payroll_calendars','3ad0cea72eef0e32add3e3f1f2471193be1eb6141e9f5ccd918a966cc1830775',null),
  ('type','private.leave_bank_adoption_receipts','becd7fceb13c73edd3b209075086b618c202f6eea3a04b543bd125a9174b984f',null),
  ('type','private.leave_bank_sources','299e4c22b4f4df6541540bfdaedf8c7dc4a57f276509dc9fbc678936e53f2d54',null),
  ('type','private.leave_payroll_calendars','e9bbb26e304c92977ed166ec00f96f8169adf2e7236e3cca861152702b9891cc',null);

create function pg_temp.sr_capture_catalog() returns table(kind text,object_identity text,definition text)
language plpgsql stable set search_path='' as $sr_capture$
declare inventory jsonb; observed text; expected text; begin
  select coalesce(jsonb_agg(to_jsonb(c) order by c.kind collate "C",c.object_identity collate "C"),'[]'::jsonb)
    into inventory from pg_temp.sr_inventory() c;
  if exists(select 1 from pg_temp.sr_published_predecessor d
    left join jsonb_to_recordset(inventory) as c(kind text,object_identity text,definition text)
      on c.kind=d.kind and c.object_identity=d.object_identity
    where c.kind is null or encode(extensions.digest(c.definition,'sha256'),'hex') is distinct from d.after_hash) then
    raise exception 'Published Team Manager predecessor metadata differs.' using errcode='55000';
  end if;
  select encode(extensions.digest(jsonb_agg(jsonb_build_object('kind',c.kind,'object_identity',c.object_identity,
    'definition',case when c.kind='role' then (c.definition::jsonb-'oid')::text else coalesce(d.before_definition,c.definition) end)
    order by c.kind collate "C",c.object_identity collate "C")::text,'sha256'),'hex') into observed
    from jsonb_to_recordset(inventory) as c(kind text,object_identity text,definition text)
    left join pg_temp.sr_published_predecessor d on d.kind=c.kind and d.object_identity=c.object_identity
    where d.kind is null or d.before_definition is not null;
  expected:=case current_setting('server_version_num')::integer/10000
    when 16 then 'be3468ce0d699999a758d75e9176667b6a862f980056bf55c37136f0f2646de1'
    when 17 then '9db98709473bcc37a3af5689d1e890c945d31b8953dc5db8091164e2b51cd17c' end;
  if observed is distinct from expected and not coalesce(
    current_setting('server_version_num')::integer/10000=17
    and current_user='postgres'
    and not (select r.rolsuper from pg_catalog.pg_roles r where r.rolname=current_user)
    and (observed='bce85bd12dba8274c0a488074b2c18d0ed1fc55b09590b4119ec85981232c53f'
      or observed='6d36df0f3fc60ccefc847c8af667e0f43f3d43018500cd6996b75f383b8d720c'),false) then
    raise exception 'Initial expanded catalog is not reviewed for this platform.' using errcode='55000';
  end if;
  return query select c.kind,c.object_identity,c.definition
    from jsonb_to_recordset(inventory) as c(kind text,object_identity text,definition text);
end $sr_capture$;
create temporary table sr_catalog_before on commit drop as
  select kind,object_identity,encode(extensions.digest(definition,'sha256'),'hex') as definition_hash
  from pg_temp.sr_capture_catalog();
alter table sr_catalog_before add primary key(kind,object_identity);
create temporary table sr_catalog_delta(kind text not null,object_identity text not null,definition_hash text not null,
  primary key(kind,object_identity)) on commit drop;
insert into sr_catalog_delta values
  ('column','private.subscription_request_config.approver_person_id','9eb186c427a36fa6c6f151613ef41ebaca5cd36d39b5ab180091936248c54680'),
  ('column','private.subscription_request_config.approver_user_id','bc862bc491c79e380eb65cfdaa25df215cf53f6d6ea40d2cb92df347a637fc88'),
  ('column','private.subscription_request_config.enabled','44b08b16fe3bc10f551677ed1fa68e8772b605c30ec8318ce422db126f5d395a'),
  ('column','private.subscription_request_config.singleton','67bf656d795a24bc270cef1958c282da097cfc1e0554b165dfc510b8a4f61fd3'),
  ('column','private.subscription_request_config_pkey.singleton','91a153e4633f536691df4fbafb0b46485e5bcf8e72e55b7a59fca1da0f110a29'),
  ('column','private.subscription_request_events.actor','6869d647c1d5639b016c63d1e7c57acf78b7203afb35524ae096c1578001b449'),
  ('column','private.subscription_request_events.at','be398acfa5d9d0dcb83cec2fe9670a09c1ed2d5782fe8ecb34d16a2117ac8cb1'),
  ('column','private.subscription_request_events.evidence','b071fb1370a852df88ec89b6164990cf30f0c8abb86efc05f17f9057076efc94'),
  ('column','private.subscription_request_events.operation','01319dab08245aa2f08d254ed76a7744506792a3818b242e7ecfc2771ae88746'),
  ('column','private.subscription_request_events.payload','4e50fd06180815f9566579daef063c94f8c0e1e02896b850359fe2bff7f50ab2'),
  ('column','private.subscription_request_events.private_evidence','5719c8560c4527fde84b2ef428b508df06088df4745bd950c4b0dc89a74b91b9'),
  ('column','private.subscription_request_events.reason','3997a8c3c57fe69cf23f34e703d954ffe36bbccae0f15db0da7b5fa91e3841c2'),
  ('column','private.subscription_request_events.request_id','652219c5442a9aa75c9914348de1bb4f02c16fc10c41ace8445c2bb95a8ac76c'),
  ('column','private.subscription_request_events.version','43ee491a3352508276c4ae9228716a5201e1046652bf3dfcff61847b5c0ed879'),
  ('column','private.subscription_request_events_pkey.request_id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab'),
  ('column','private.subscription_request_events_pkey.version','306215ef05afb0c9cb80a27d899c5a62d0c7a158e1e53fd1c76b8cea59b4da97'),
  ('column','private.subscription_request_notifications.cc_user_ids','93da33c571cd0db1e6b1595a430962bfbe0aa7ff4c1b437e1102ac434787a752'),
  ('column','private.subscription_request_notifications.created_at','aa35f8a174889d900d10dba488396a003aa9bb332d610ef367001108a76bb495'),
  ('column','private.subscription_request_notifications.event','01319dab08245aa2f08d254ed76a7744506792a3818b242e7ecfc2771ae88746'),
  ('column','private.subscription_request_notifications.request_id','652219c5442a9aa75c9914348de1bb4f02c16fc10c41ace8445c2bb95a8ac76c'),
  ('column','private.subscription_request_notifications.to_user_id','6869d647c1d5639b016c63d1e7c57acf78b7203afb35524ae096c1578001b449'),
  ('column','private.subscription_request_notifications.version','43ee491a3352508276c4ae9228716a5201e1046652bf3dfcff61847b5c0ed879'),
  ('column','private.subscription_request_notifications_pkey.request_id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab'),
  ('column','private.subscription_request_notifications_pkey.version','306215ef05afb0c9cb80a27d899c5a62d0c7a158e1e53fd1c76b8cea59b4da97'),
  ('column','private.subscription_requests.applicant','bf71b2c32cd53e7cdd9e391222788131b8a4498ef022ebb8561afa4fc4fff578'),
  ('column','private.subscription_requests.created_at','2fec5fbbe6b00921a1b5a2df68b0cc0fe908214a7cd027b47b1a9f89299145b5'),
  ('column','private.subscription_requests.evidence','2d2e94b94a1b5b5d74cfa665a8a67e554519ec28b033a9975dd2ba391b007660'),
  ('column','private.subscription_requests.id','652219c5442a9aa75c9914348de1bb4f02c16fc10c41ace8445c2bb95a8ac76c'),
  ('column','private.subscription_requests.payload','4e50fd06180815f9566579daef063c94f8c0e1e02896b850359fe2bff7f50ab2'),
  ('column','private.subscription_requests.revision','37d6e6320703ba5284f4628577aab2a4c2c4cad8b64732045496ec31b1593014'),
  ('column','private.subscription_requests.status','01319dab08245aa2f08d254ed76a7744506792a3818b242e7ecfc2771ae88746'),
  ('column','private.subscription_requests.updated_at','005e35ea8237a37220693eac44278d4dc63372289e0d5af57cf678f372d1de70'),
  ('column','private.subscription_requests.version','42c4b715e9900e182df17a23548a3d3a482def54470098548cb387f2f8e881c2'),
  ('column','private.subscription_requests_pkey.id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab'),
  ('constraint','private.subscription_request_config:subscription_request_config_approver_person_id_fkey','b90d89e1ad82c8eca8787072b5f094a2a38d28aacb485a195116333deaab252d'),
  ('constraint','private.subscription_request_config:subscription_request_config_approver_user_id_fkey','e2e54319ccf8ec50b85ae81de7829a1b5dc2591de011dbbab024a9030e949010'),
  ('constraint','private.subscription_request_config:subscription_request_config_check','d313157dc2fce0f71134a1cb4db0754610fa7a167622631da177b4b7e665d692'),
  ('constraint','private.subscription_request_config:subscription_request_config_pkey','d0e3168bf7b49c4d29e42698bafc440b8abc861b901143d9e7768878f4e4b65a'),
  ('constraint','private.subscription_request_config:subscription_request_config_singleton_check','22b7e980bd326d40936ee07e385887c584feea06d44cada22e124619c40f2f77'),
  ('constraint','private.subscription_request_events:subscription_request_events_actor_fkey','e106f26007f6fc98ab2b44246301912ac051a3a08d115206a22b411e01786723'),
  ('constraint','private.subscription_request_events:subscription_request_events_pkey','fe3ec764ef915f5818ded535ba560081d661373a0af02eedaa6cf8eaf18eac97'),
  ('constraint','private.subscription_request_events:subscription_request_events_request_id_fkey','c7f613043914419461d320381ddfd287cfadc5db19bd6ae5d720bef1bbfd86b1'),
  ('constraint','private.subscription_request_notifications:subscription_request_notifications_cc_user_ids_check','b2452e3b6678ce204b20fdc439eee3cbb734df561cbbb73a96a1850a9bedcb3d'),
  ('constraint','private.subscription_request_notifications:subscription_request_notifications_pkey','fe3ec764ef915f5818ded535ba560081d661373a0af02eedaa6cf8eaf18eac97'),
  ('constraint','private.subscription_request_notifications:subscription_request_notifications_request_id_version_fkey','69c42f002b4d097debf56efc0b97996ab3b17d2429e709192a454b5a3afc3c1c'),
  ('constraint','private.subscription_request_notifications:subscription_request_notifications_to_user_id_fkey','5708730bac9a61413d11ffb4771e743ac7702d52ac586f600a2a308a6715894e'),
  ('constraint','private.subscription_requests:subscription_requests_applicant_fkey','57030c64a17f52bf1be5a1b19ec6952cc5e24b5de2d4feff5b091c7af4156239'),
  ('constraint','private.subscription_requests:subscription_requests_evidence_check','c75524ac9a01875c94bdf9b6f4efb56120adcfdbdd2cc8db83f9e1d09f1be24c'),
  ('constraint','private.subscription_requests:subscription_requests_payload_check','d558e6d6d596264d2cc7356f9879a6a43202d21c02b1360afe675fa40c21a872'),
  ('constraint','private.subscription_requests:subscription_requests_pkey','ceeed3e1b6b0f71197286468986349d099d90ea1af0bc7dc10eec8147ca0bd38'),
  ('constraint','private.subscription_requests:subscription_requests_revision_check','a7bdd0ee285c6617d46113dcac1d702abb0e434c965045a3a85c80c8ff786546'),
  ('constraint','private.subscription_requests:subscription_requests_status_check','38f25bbecfba1eff8d728a241abd78a3b9bf3ad5fdd97018e8ae1e33d1b49aba'),
  ('constraint','private.subscription_requests:subscription_requests_version_check','00d9a2d858138d9c8377b040fb3f07ff072cd3bb40a2a473934ff729d6ba78f0'),
  ('function','private.sr_approver()','c4397be8d6e836e63000120131bcc81c24c54ee40516b2a3ac07a32932bcc983'),
  ('function','private.sr_evidence(jsonb)','2d149e09b5b0a5316ccc08548c35723c80ebf323dab77f168147638d06c056f0'),
  ('function','private.sr_immutable()','324143847b465479d1e43d85fe29a189fce7ae80ef687da78f14036625062651'),
  ('function','private.sr_read(uuid)','3967c1bdcc609ef1a55f64545217e0a071c063f4239bfa1121e97aeb22dc4b49'),
  ('function','private.sr_register_gate()','b52f624e46e97611df25ea787b4e5e0c23ddd866758d62df0461b39ffae2b336'),
  ('function','private.sr_validate(jsonb, boolean)','624bda44dc234a8dfe9bd23b3e8724a865e586efce471ebae6586f063ea1483b'),
  ('function','private.sr_visible(uuid)','c82df0545e807a214e07e4891c09ce1d68332625d9b26f071baa98aff1d60459'),
  ('function','public.sr_download(uuid, bigint, integer)','361b3d2f966ae175b8d45c58bc46d7f47b7bbf33dc855a80ed9e3bd8f24e47d9'),
  ('function','public.sr_mutate(uuid, bigint, text, jsonb, text, jsonb)','407a2f9e3d4b3f7986f7d764219811d44e5a4c1e8058dde30f498592d16e4dfe'),
  ('function','public.sr_workspace()','165701353ebeee23a7b288159359d18ec09ab526bba784c8a0d5d774fea15394'),
  ('function_security','private.sr_approver()','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80'),
  ('function_security','private.sr_evidence(jsonb)','b222cdf5ff00d23de129118bc17a83fe1c3bcc69143f7587b67aef8a3ff38e36'),
  ('function_security','private.sr_immutable()','b222cdf5ff00d23de129118bc17a83fe1c3bcc69143f7587b67aef8a3ff38e36'),
  ('function_security','private.sr_read(uuid)','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80'),
  ('function_security','private.sr_register_gate()','67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
  ('function_security','private.sr_validate(jsonb, boolean)','b222cdf5ff00d23de129118bc17a83fe1c3bcc69143f7587b67aef8a3ff38e36'),
  ('function_security','private.sr_visible(uuid)','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80'),
  ('function_security','public.sr_download(uuid, bigint, integer)','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
  ('function_security','public.sr_mutate(uuid, bigint, text, jsonb, text, jsonb)','9854602ac8fba4e8fb0b56304eb3b5cbb4259a3189d7acd7e5d977127b3f3f1e'),
  ('function_security','public.sr_workspace()','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
  ('global_function_acl','private.sr_approver()','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','private.sr_evidence(jsonb)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','private.sr_immutable()','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','private.sr_read(uuid)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','private.sr_register_gate()','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','private.sr_validate(jsonb, boolean)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','private.sr_visible(uuid)','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
  ('global_function_acl','public.sr_download(uuid, bigint, integer)','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
  ('global_function_acl','public.sr_mutate(uuid, bigint, text, jsonb, text, jsonb)','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
  ('global_function_acl','public.sr_workspace()','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
  ('global_relation_acl','private.subscription_request_config',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end),
  ('global_relation_acl','private.subscription_request_events',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end),
  ('global_relation_acl','private.subscription_request_notifications',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end),
  ('global_relation_acl','private.subscription_requests',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end),
  ('index','private.subscription_request_config_pkey','edd44faaeebbbef8e4bf3059de755cd693cfcf9488023265ef3737c5bc9e5611'),
  ('index','private.subscription_request_events_pkey','3177f8aa9a2b966204f425473edae8a69bab3597ca0836d15a6d4f0493b297c4'),
  ('index','private.subscription_request_notifications_pkey','2fbe2954d4112fb623a42f1c9d00f6f4ee389ca4a8bc841096880ce12f1863bb'),
  ('index','private.subscription_requests_pkey','2a811e075910a02e8e4c14cdfeae5935172008f77184935c7663f779eaf80c56'),
  ('relation','private.subscription_request_config',case current_setting('server_version_num')::integer/10000 when 16 then '23004a5648ab8cfd403aca4079c055b0b556ecdd61e6f8fc787ccf8765642d19' when 17 then 'ee62aacc4551fcd30dfc8f51c25773931805de7d6aa6210d0466c5aa1be5b89b' end),
  ('relation','private.subscription_request_events',case current_setting('server_version_num')::integer/10000 when 16 then '23004a5648ab8cfd403aca4079c055b0b556ecdd61e6f8fc787ccf8765642d19' when 17 then 'ee62aacc4551fcd30dfc8f51c25773931805de7d6aa6210d0466c5aa1be5b89b' end),
  ('relation','private.subscription_request_notifications',case current_setting('server_version_num')::integer/10000 when 16 then '23004a5648ab8cfd403aca4079c055b0b556ecdd61e6f8fc787ccf8765642d19' when 17 then 'ee62aacc4551fcd30dfc8f51c25773931805de7d6aa6210d0466c5aa1be5b89b' end),
  ('relation','private.subscription_requests',case current_setting('server_version_num')::integer/10000 when 16 then '23004a5648ab8cfd403aca4079c055b0b556ecdd61e6f8fc787ccf8765642d19' when 17 then 'ee62aacc4551fcd30dfc8f51c25773931805de7d6aa6210d0466c5aa1be5b89b' end),
  ('routine_kind','private.sr_approver()','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','private.sr_evidence(jsonb)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','private.sr_immutable()','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','private.sr_read(uuid)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','private.sr_register_gate()','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','private.sr_validate(jsonb, boolean)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','private.sr_visible(uuid)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','public.sr_download(uuid, bigint, integer)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','public.sr_mutate(uuid, bigint, text, jsonb, text, jsonb)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('routine_kind','public.sr_workspace()','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
  ('trigger','private.subscription_register:subscription_request_register_gate','d7727c4458b77898b66939a2cf7951390bd678ebb550ddd52c19f16f17b00a73'),
  ('trigger','private.subscription_request_events:subscription_request_events_immutable','f2ea7a112469338d94b5ee3cd63b5a2e4f670cfd5d0b55569a37d198c22e9084'),
  ('trigger','private.subscription_request_notifications:subscription_request_notifications_immutable','d1614156a7eb462f2fb7a0f4207aa2e6875c1cca193e44983ba923cf8012df3b'),
  ('type','private._subscription_request_config','2e0e95a9b0c83a3963c8ba3f968af823002a9e2208915f72f77bdbc07e1bb516'),
  ('type','private._subscription_request_events','655a11f7c4eff2ef7bbc6978f4fbff2d5a494f213b4d41df2974c3a3ba0183b0'),
  ('type','private._subscription_request_notifications','0c04cdac5a624bfacc2b0a44c0fa840626783aecd3a97731086706f60e99ee7d'),
  ('type','private._subscription_requests','48265b723d776f3839cfee64083827d45880b45c33e36e6c8c98f4829e3f97c9'),
  ('type','private.subscription_request_config','2d1003ab3d77e5494198c0d3b86e436ab70eab9e99892dbc5bc48f51c4a1a236'),
  ('type','private.subscription_request_events','cec0c6dcf54b2ab6551941514bf53ddf56eb91e9b5ce68add176272b40746b29'),
  ('type','private.subscription_request_notifications','a4fddcd05df68c6b1db7be2a1d507cadacba87f05fa1ee5b6d5257a4b384e89b'),
  ('type','private.subscription_requests','0efc744a4923b138a841712d0750085b5444b6e6882a5961eeb1131ceb9c3084');
create function pg_temp.sr_existing_data() returns text language plpgsql stable set search_path='' as $sr_data$
declare relation_name text; rows jsonb; inventory jsonb:='{}'::jsonb; begin
  foreach relation_name in array array['auth.users','private.employee_team_manager_defaults','private.leave_bank_adoption_receipts','private.leave_bank_sources','private.leave_payroll_calendars','private.portal_account_admin_events','private.portal_account_admins','private.subscription_audit_events','private.subscription_credential_access_audit_events','private.subscription_credential_access_grants','private.subscription_credential_audit_events','private.subscription_credential_grant_changes','private.subscription_credential_vault','private.subscription_management_grant_events','private.subscription_management_grants','private.subscription_memberships','private.subscription_register','public.internal_org_people','public.profiles'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text collate "C"),''[]''::jsonb) from %s r',relation_name::regclass) into rows;
    inventory:=inventory||jsonb_build_object(relation_name,rows);
  end loop;
  return encode(extensions.digest(inventory::text,'sha256'),'hex');
end $sr_data$;
create temporary table sr_data_before on commit drop as select pg_temp.sr_existing_data() as data_hash;

create table private.subscription_request_config (
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  approver_user_id uuid references public.profiles(id) on delete restrict,
  approver_person_id uuid references public.internal_org_people(id) on delete restrict,
  check((approver_user_id is null)=(approver_person_id is null))
);
insert into private.subscription_request_config(singleton) values(true);
create table private.subscription_requests (
  id uuid primary key, applicant uuid not null references public.profiles(id) on delete restrict,
  status text not null check(status in ('draft','submitted','returned','approved','rejected','withdrawn')),
  version bigint not null check(version>0), revision integer not null default 0 check(revision>=0),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  evidence jsonb not null default '[]' check(jsonb_typeof(evidence)='array'),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table private.subscription_request_events (
  request_id uuid not null references private.subscription_requests(id) on delete restrict,
  version bigint not null, operation text not null, actor uuid not null references public.profiles(id) on delete restrict,
  at timestamptz not null default clock_timestamp(), payload jsonb not null, reason text not null,
  evidence jsonb not null, private_evidence jsonb not null, primary key(request_id,version)
);
create table private.subscription_request_notifications (
  request_id uuid not null, version bigint not null, event text not null,
  to_user_id uuid not null references public.profiles(id) on delete restrict,
  cc_user_ids jsonb not null default '[]' check(cc_user_ids='[]'::jsonb),
  created_at timestamptz not null default clock_timestamp(),
  primary key(request_id,version), foreign key(request_id,version) references private.subscription_request_events(request_id,version) on delete restrict
);
alter table private.subscription_request_config enable row level security;
alter table private.subscription_requests enable row level security;
alter table private.subscription_request_events enable row level security;
alter table private.subscription_request_notifications enable row level security;
revoke all on private.subscription_request_config,private.subscription_requests,private.subscription_request_events,private.subscription_request_notifications from public,anon,authenticated,service_role;

create function private.sr_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Request history is immutable.' using errcode='55000'; end $$;
create trigger subscription_request_events_immutable before update or delete on private.subscription_request_events for each row execute function private.sr_immutable();
create trigger subscription_request_notifications_immutable before update or delete on private.subscription_request_notifications for each row execute function private.sr_immutable();

create function private.sr_approver() returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from private.subscription_request_config c
  cross join lateral private.portal_role_policy() p
  where c.singleton and c.enabled and c.approver_user_id=(select auth.uid()) and c.approver_person_id=p.person_id
    and (select count(*) from public.internal_org_people person where person.auth_user_id=c.approver_user_id)=1);
$$;
create function private.sr_visible(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from private.subscription_requests r where r.id=p_id
  and exists(select 1 from private.portal_role_policy())
  and (r.applicant=(select auth.uid()) or (r.revision>0 and (public.can_manage_subscriptions() or private.sr_approver()))));
$$;
create function private.sr_validate(p jsonb, submitting boolean) returns void language plpgsql set search_path='' as $$
declare field text; value jsonb; begin
  if p is null or jsonb_typeof(p)<>'object' or pg_column_size(p)>100000 then raise exception 'Request fields are invalid.' using errcode='22023'; end if;
  for field,value in select * from jsonb_each(p) loop
    if field not in ('kind','service','plan','purpose','company','payer','duration','billing','currency','tax','quoteCents','noQuoteReason','audEstimateCents','payment','cardLabel','cardHolder','responsiblePersonId','intendedUsers') then raise exception 'Unsupported request field.' using errcode='22023'; end if;
    if field in ('quoteCents','audEstimateCents') then
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'number' or value::text !~ '^\d+$' or (value::text)::numeric>100000000) then raise exception 'Enter a valid amount in cents.' using errcode='22023'; end if;
    elsif field='responsiblePersonId' then
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'string' or p->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'Responsible person is invalid.' using errcode='22023'; end if;
    elsif jsonb_typeof(value)<>'string' or length(p->>field)>4000 then raise exception 'Request text is invalid.' using errcode='22023'; end if;
  end loop;
  if (p ? 'kind' and p->>'kind' not in ('new_purchase','renewal','added_seats','plan_change')) or
    (p ? 'company' and p->>'company' not in ('mam','equipsy','both')) or
    (p ? 'billing' and p->>'billing' not in ('monthly','annual','one_off','other')) or
    (p ? 'payment' and p->>'payment' not in ('card','non_card')) or
    (p ? 'currency' and p->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Request selection is invalid.' using errcode='22023'; end if;
  if submitting then
    foreach field in array array['kind','service','purpose','company','payer','duration','billing','currency','tax','payment','intendedUsers'] loop
      if nullif(btrim(p->>field),'') is null then raise exception 'Complete the required request fields.' using errcode='22023'; end if;
    end loop;
    if (p->>'quoteCents') is null and nullif(btrim(p->>'noQuoteReason'),'') is null then raise exception 'Provide a quote or explain why it is missing.' using errcode='22023'; end if;
    if (p->>'audEstimateCents') is null then raise exception 'Provide the AUD estimate.' using errcode='22023'; end if;
    if p->>'payment'='card' and (nullif(btrim(p->>'cardLabel'),'') is null or nullif(btrim(p->>'cardHolder'),'') is null) then raise exception 'Provide the card label and holder, not card numbers.' using errcode='22023'; end if;
  end if;
end $$;
create function private.sr_evidence(p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare item jsonb; bytes bytea; output jsonb:='[]'; total integer:=0; begin
  if p is null or jsonb_typeof(p)<>'array' or jsonb_array_length(p)>3 then raise exception 'Evidence is invalid.' using errcode='22023'; end if;
  for item in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(item)<>'object' or (select count(*) from jsonb_object_keys(item))<>3 or
      jsonb_typeof(item->'name') is distinct from 'string' or jsonb_typeof(item->'mime') is distinct from 'string' or jsonb_typeof(item->'base64') is distinct from 'string' or
      length(item->>'name') not between 1 and 150 or item->>'name' ~ '[\\/[:cntrl:]]' or length(item->>'base64')>700000 then raise exception 'Evidence is invalid.' using errcode='22023'; end if;
    bytes:=decode(item->>'base64','base64'); total:=total+octet_length(bytes);
    if octet_length(bytes)<4 or total>500000 or not (
      (item->>'mime'='application/pdf' and substring(bytes from 1 for 4)=decode('25504446','hex')) or
      (item->>'mime'='image/png' and substring(bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')) or
      (item->>'mime'='image/jpeg' and substring(bytes from 1 for 3)=decode('ffd8ff','hex'))
    ) then raise exception 'Use PDF, PNG or JPEG evidence, at most 500 KB total.' using errcode='22023'; end if;
    output:=output||jsonb_build_array(item||jsonb_build_object('bytes',octet_length(bytes)));
  end loop;
  return output;
end $$;
create function private.sr_read(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object('id',r.id,'applicant',r.applicant,'status',r.status,'version',r.version,'revision',r.revision,'payload',chosen.payload,
  'evidence',chosen.evidence,'evidenceVersion',chosen.version,
  'events',(select coalesce(jsonb_agg(to_jsonb(e)-array['request_id','private_evidence'] order by e.version),'[]') from private.subscription_request_events e where e.request_id=r.id and (e.operation<>'save' or r.applicant=(select auth.uid()))),
  'canEdit',r.applicant=(select auth.uid()) and public.can_manage_subscriptions() and r.status in ('draft','returned'),
  'canDecide',private.sr_approver() and r.status='submitted',
  'canWithdraw',r.applicant=(select auth.uid()) and public.can_manage_subscriptions() and r.status in ('draft','submitted','returned','approved'))
from private.subscription_requests r cross join lateral (
  select e.payload,e.evidence,e.version from private.subscription_request_events e where e.request_id=r.id
    and (r.applicant=(select auth.uid()) or e.operation<>'save') order by e.version desc limit 1
) chosen where r.id=p_id and private.sr_visible(r.id);
$$;
create function public.sr_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from private.portal_role_policy()) then raise exception 'An active portal account is required.' using errcode='42501'; end if;
  return jsonb_build_object('enabled',(select enabled from private.subscription_request_config where singleton),
    'canApply',public.can_manage_subscriptions(),
    'requests',(select coalesce(jsonb_agg(private.sr_read(r.id) order by r.updated_at desc,r.id),'[]') from private.subscription_requests r where private.sr_visible(r.id)),
    'people',case when public.can_manage_subscriptions() then (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) order by p.full_name,p.id),'[]') from public.internal_org_people p where p.node_kind='person' and p.is_active) else '[]'::jsonb end);
end $$;
create function public.sr_mutate(p_id uuid,p_version bigint,p_operation text,p_payload jsonb default null,p_reason text default '',p_evidence jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r private.subscription_requests%rowtype; config private.subscription_request_config%rowtype;
  manager boolean; approver boolean; recipient uuid; owner uuid; contents jsonb; attachments jsonb; meta jsonb; next_status text;
begin
  if actor is null or not exists(select 1 from private.portal_role_policy()) or not(public.can_manage_subscriptions() or private.sr_approver()) then raise exception 'Request permission is required.' using errcode='42501'; end if;
  if p_id is null or p_version is null or p_version<0 or p_operation is null or p_operation not in ('save','submit','approve','return','reject','withdraw') or p_reason is null or length(p_reason)>4000 then raise exception 'Request operation is invalid.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform 1 from public.profiles where id=actor for share;
  select * into strict config from private.subscription_request_config where singleton for share;
  manager:=public.can_manage_subscriptions(); approver:=private.sr_approver();
  if not config.enabled then raise exception 'Subscription requests are not enabled.' using errcode='55000'; end if;
  if not(manager or approver) or not exists(select 1 from private.portal_role_policy()) then raise exception 'Request permission is required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-request:'||p_id::text,0));
  select * into r from private.subscription_requests where id=p_id for update;
  manager:=public.can_manage_subscriptions(); approver:=private.sr_approver();
  if not(manager or approver) or not exists(select 1 from private.portal_role_policy()) then raise exception 'Request permission is required.' using errcode='42501'; end if;
  if not found then
    if p_version<>0 then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
    if not manager or p_operation not in ('save','submit') then raise exception 'Only applicants may create requests.' using errcode='42501'; end if;
    r.id:=p_id; r.applicant:=actor; r.version:=0; r.revision:=0; r.status:='draft'; r.payload:='{}'; r.evidence:='[]';
  elsif r.version<>p_version then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
  if p_operation in ('save','submit','withdraw') and (not manager or r.applicant<>actor) then raise exception 'Only the authorized applicant may change this request.' using errcode='42501'; end if;
  if p_operation in ('approve','return','reject') and not approver then raise exception 'Only the designated approver may decide.' using errcode='42501'; end if;
  if (p_operation in ('save','submit') and r.status not in ('draft','returned')) or
    (p_operation in ('approve','return','reject') and r.status<>'submitted') or
    (p_operation='withdraw' and r.status not in ('draft','submitted','returned','approved')) then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
  if p_operation in ('return','reject') and nullif(btrim(p_reason),'') is null then raise exception 'Provide a decision reason.' using errcode='22023'; end if;
  contents:=r.payload; attachments:=r.evidence;
  if p_operation in ('save','submit') then
    perform private.sr_validate(p_payload,p_operation='submit'); contents:=p_payload;
    select policy.person_id into owner from private.portal_role_policy() policy;
    if contents->>'responsiblePersonId' is null and owner is not null then contents:=contents||jsonb_build_object('responsiblePersonId',owner); end if;
    if contents->>'responsiblePersonId' is not null then
      perform 1 from public.internal_org_people where id=(contents->>'responsiblePersonId')::uuid and node_kind='person' and is_active for share;
      if not found then raise exception 'Responsible person is unavailable.' using errcode='22023'; end if;
    end if;
    if p_evidence is not null then attachments:=private.sr_evidence(p_evidence); end if;
  end if;
  if p_operation in ('submit','withdraw') then
    perform 1 from public.profiles where id=config.approver_user_id for share;
    if not exists(select 1 from private.portal_role_policy(config.approver_user_id) p where p.person_id=config.approver_person_id)
      or (select count(*) from public.internal_org_people person where person.auth_user_id=config.approver_user_id)<>1 then raise exception 'The designated approver is unavailable.' using errcode='55000'; end if;
    recipient:=config.approver_user_id;
  elsif p_operation in ('approve','return','reject') then recipient:=r.applicant; end if;
  next_status:=case p_operation when 'save' then r.status when 'submit' then 'submitted' when 'approve' then 'approved' when 'return' then 'returned' when 'reject' then 'rejected' when 'withdraw' then 'withdrawn' end;
  if p_operation='withdraw' and r.status='returned' then
    select e.payload,e.private_evidence into contents,attachments from private.subscription_request_events e
      where e.request_id=r.id and e.operation='submit' order by e.version desc limit 1;
  end if;
  insert into private.subscription_requests(id,applicant,status,version,revision,payload,evidence)
  values(r.id,r.applicant,next_status,r.version+1,r.revision+case when p_operation='submit' then 1 else 0 end,contents,attachments)
  on conflict(id) do update set status=excluded.status,version=excluded.version,revision=excluded.revision,payload=excluded.payload,evidence=excluded.evidence,updated_at=clock_timestamp();
  select coalesce(jsonb_agg(e-'base64'),'[]') into meta from jsonb_array_elements(attachments) e;
  insert into private.subscription_request_events(request_id,version,operation,actor,payload,reason,evidence,private_evidence)
    values(r.id,r.version+1,p_operation,actor,contents,p_reason,meta,attachments);
  if recipient is not null then
    insert into private.subscription_request_notifications(request_id,version,event,to_user_id) values(r.id,r.version+1,p_operation,recipient);
  end if;
  return private.sr_read(r.id);
end $$;
create function public.sr_download(p_id uuid,p_version bigint,p_index integer) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
  if not private.sr_visible(p_id) then raise exception 'Evidence permission is required.' using errcode='42501'; end if;
  if p_index is null or p_index<0 then raise exception 'Evidence is unavailable.' using errcode='22023'; end if;
  if exists(select 1 from private.subscription_request_events e join private.subscription_requests r on r.id=e.request_id
    where e.request_id=p_id and e.version=p_version and e.operation='save' and r.applicant<>(select auth.uid())) then
    raise exception 'Evidence permission is required.' using errcode='42501';
  end if;
  select e.private_evidence->p_index into result from private.subscription_request_events e where e.request_id=p_id and e.version=p_version;
  if result is null then raise exception 'Evidence changed. Reload before retrying.' using errcode='PT409'; end if;
  return result;
end $$;

create function private.sr_register_gate() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (select enabled from private.subscription_request_config where singleton) and new.pricing_model='paid' and
    (tg_op='INSERT' or old.pricing_model is distinct from new.pricing_model or old.service_name is distinct from new.service_name or old.billing_anchor_date is distinct from new.billing_anchor_date or old.plan_name is distinct from new.plan_name or old.seat_count is distinct from new.seat_count or old.renewal_date is distinct from new.renewal_date or old.billing_cycle is distinct from new.billing_cycle or old.amount_cents is distinct from new.amount_cents
      or (old.subscription_status='cancelled' and new.subscription_status in ('active','paused'))) then
    raise exception 'Paid procurement and activation are not available in this milestone.' using errcode='55000';
  end if;
  return new;
end $$;
create trigger subscription_request_register_gate before insert or update on private.subscription_register for each row execute function private.sr_register_gate();

revoke all on function private.sr_immutable(),private.sr_approver(),private.sr_visible(uuid),private.sr_validate(jsonb,boolean),private.sr_evidence(jsonb),private.sr_read(uuid),private.sr_register_gate() from public,anon,authenticated,service_role;
revoke all on function public.sr_workspace(),public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb),public.sr_download(uuid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.sr_workspace(),public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb),public.sr_download(uuid,bigint,integer) to authenticated;

create function pg_temp.sr_assert_catalog() returns void language plpgsql set search_path='' as $sr_assert$
begin
  if exists(
    with actual_catalog as materialized (
      select kind,object_identity,encode(extensions.digest(definition,'sha256'),'hex') as definition_hash
      from pg_temp.sr_inventory()
    ), expected_catalog as materialized (
      select * from pg_temp.sr_catalog_before union all select * from pg_temp.sr_catalog_delta
    ) select 1 from (
      (select * from actual_catalog except all select * from expected_catalog)
      union all (select * from expected_catalog except all select * from actual_catalog)
    ) drift
  ) then raise exception 'Request migration catalog delta is not exactly reviewed.' using errcode='55000'; end if;
  if pg_temp.sr_existing_data() is distinct from (select data_hash from pg_temp.sr_data_before) then
    raise exception 'Request migration changed protected existing data.' using errcode='55000';
  end if;
  if (select count(*) from private.subscription_request_config) <> 1
    or exists(select 1 from private.subscription_request_config where not singleton or enabled or approver_user_id is not null or approver_person_id is not null)
    or exists(select 1 from private.subscription_requests)
    or exists(select 1 from private.subscription_request_events)
    or exists(select 1 from private.subscription_request_notifications) then
    raise exception 'Request migration seeded unreviewed state.' using errcode='55000';
  end if;
end $sr_assert$;
set constraints all immediate;
select pg_temp.sr_assert_catalog();
do $sr_refresh$ declare candidate_hash text; changed integer; begin
  candidate_hash:=private.confirmed_test_purge_schema_hash();
  update private.confirmed_test_purge_schema set schema_hash=candidate_hash
    where singleton and schema_hash=current_setting('mam.sr_predecessor_hash');
  get diagnostics changed=row_count;
  if changed <> 1 then
    raise exception 'Request migration predecessor ledger changed.' using errcode='55000';
  end if;
  perform set_config('mam.sr_candidate_hash',candidate_hash,true);
end $sr_refresh$;
set constraints all immediate;
select pg_temp.sr_assert_catalog();
do $sr_final$ declare candidate_hash text; begin
  perform pg_temp.sr_assert_catalog();
  candidate_hash:=current_setting('mam.sr_candidate_hash');
  if (select count(*) from private.confirmed_test_purge_schema) <> 1
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from candidate_hash
    or private.confirmed_test_purge_schema_hash() is distinct from candidate_hash then
    raise exception 'Request migration final ledger differs from the retained candidate.' using errcode='55000';
  end if;
end $sr_final$;
commit;
