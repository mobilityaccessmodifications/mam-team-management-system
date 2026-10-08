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
lock table auth.users,private.employee_team_manager_defaults,private.portal_account_admin_events,private.portal_account_admins,private.subscription_audit_events,private.subscription_credential_access_audit_events,private.subscription_credential_access_grants,private.subscription_credential_audit_events,private.subscription_credential_grant_changes,private.subscription_credential_vault,private.subscription_management_grant_events,private.subscription_management_grants,private.subscription_memberships,private.subscription_register,public.internal_org_people,public.profiles in share row exclusive mode nowait;
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
  if observed is distinct from expected then
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
  foreach relation_name in array array['auth.users','private.employee_team_manager_defaults','private.portal_account_admin_events','private.portal_account_admins','private.subscription_audit_events','private.subscription_credential_access_audit_events','private.subscription_credential_access_grants','private.subscription_credential_audit_events','private.subscription_credential_grant_changes','private.subscription_credential_vault','private.subscription_management_grant_events','private.subscription_management_grants','private.subscription_memberships','private.subscription_register','public.internal_org_people','public.profiles'] loop
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
