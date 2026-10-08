begin;
set local search_path='';

lock table private.confirmed_test_purge_schema in exclusive mode;
create temporary table team_manager_previous_catalog(definition text) on commit drop;
create temporary table team_manager_previous_routines(metadata jsonb) on commit drop;
create temporary table team_manager_previous_core(definition text,metadata jsonb) on commit drop;

do $guard$
declare collector text;
begin
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton)
    or encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or to_regclass('private.employee_team_manager_defaults') is not null
    or to_regprocedure('public.get_employee_team_manager_default(text,text)') is not null then
    raise exception 'Team Manager structure predecessor differs.' using errcode='55000';
  end if;
  if encode(extensions.digest(pg_get_functiondef('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure),'sha256'),'hex')
    is distinct from '555ee2cf046cbcc0da9c67d63254ee138a19737a959c048b581179840445272c' then
    raise exception 'Team Manager creation predecessor differs.' using errcode='55000';
  end if;
  select prosrc into collector from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  collector := replace(collector,$old$select encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex') from ($old$,'select definition from (');
  execute 'create function pg_temp.team_manager_catalog() returns table(definition text) language sql stable set search_path='''''
    ||' as '||quote_literal(collector);
  insert into team_manager_previous_catalog select definition from pg_temp.team_manager_catalog();
  insert into team_manager_previous_routines
    select (to_jsonb(p)-'proargdefaults')||jsonb_build_object('argument_defaults',pg_get_expr(p.proargdefaults,0))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and p.oid<>'public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure;
  insert into team_manager_previous_core
    select pg_get_functiondef(p.oid),(to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('argument_defaults',pg_get_expr(p.proargdefaults,0))
    from pg_proc p where p.oid='public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure;
end;
$guard$;

create table private.employee_team_manager_defaults (
  company_key text not null check (company_key in ('mam','equipsy')),
  team_name text not null check (team_name in ('Operation & Accounts','Management','Major','Minor','Warehouse','Equipsy')),
  manager_person_id uuid not null references public.internal_org_people(id) on delete restrict,
  version bigint not null default 1 check (version > 0),
  configured_at timestamptz not null default clock_timestamp(),
  configured_by_auth_user_id uuid references auth.users(id) on delete restrict,
  configured_by_database_role text not null default current_user,
  primary key (company_key,team_name)
);
alter table private.employee_team_manager_defaults enable row level security;
alter table private.employee_team_manager_defaults force row level security;
revoke all on private.employee_team_manager_defaults from public,anon,authenticated,service_role;

do $creation$
declare
  definition text;
  previous_manager_check text := $previous$  if p_manager_id is not null then
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

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));$previous$;
  replacement_manager_check text := $replacement$  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  if v_manager_id is null then
    select configured.manager_person_id into v_manager_id
    from private.employee_team_manager_defaults configured
    where configured.company_key = v_company_key and configured.team_name = v_team_name
    for share;
  end if;

  if v_manager_id is not null then
    perform 1 from public.internal_org_people manager
    where manager.id = v_manager_id and manager.node_kind = 'person'
      and manager.is_active and manager.company_key = v_company_key
    for share;
    if not found then
      raise exception 'Choose an active same-company employee as the manager.' using errcode = '23503';
    end if;
  end if;$replacement$;
begin
  definition := pg_get_functiondef('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure);
  if strpos(definition,previous_manager_check)=0 then
    raise exception 'Team Manager creation anchor differs.' using errcode='55000';
  end if;
  definition := replace(definition,'  v_actor uuid := (select auth.uid());',E'  v_actor uuid := (select auth.uid());\n  v_manager_id uuid := p_manager_id;');
  definition := replace(definition,previous_manager_check,replacement_manager_check);
  definition := replace(definition,E'    p_manager_id,\n    p_started_date,',E'    v_manager_id,\n    p_started_date,');
  execute definition;
end;
$creation$;

create function public.get_employee_team_manager_default(p_company_key text,p_team_name text)
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $resolution$
declare
  configured_manager uuid;
  manager_name text;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can resolve a new employee manager.' using errcode='42501';
  end if;
  if p_company_key not in ('mam','equipsy') or p_company_key is null
    or p_team_name not in ('Operation & Accounts','Management','Major','Minor','Warehouse','Equipsy') or p_team_name is null then
    raise exception 'Choose a valid company and team.' using errcode='22023';
  end if;
  select manager_person_id into configured_manager
  from private.employee_team_manager_defaults where company_key=p_company_key and team_name=p_team_name;
  if not found then
    return jsonb_build_object('status','missing','managerId',null,'managerName','');
  end if;
  select full_name into manager_name from public.internal_org_people
  where id=configured_manager and node_kind='person' and is_active and company_key=p_company_key;
  if not found then
    return jsonb_build_object('status','invalid','managerId',null,'managerName','');
  end if;
  return jsonb_build_object('status','valid','managerId',configured_manager,'managerName',manager_name);
end;
$resolution$;
revoke all on function public.get_employee_team_manager_default(text,text) from public,anon,service_role;
grant execute on function public.get_employee_team_manager_default(text,text) to authenticated;

set constraints all immediate;
do $transition$
declare current_core text; current_resolution text; normalized text[]; previous text[];
begin
  current_core := pg_get_functiondef('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure);
  current_resolution := pg_get_functiondef('public.get_employee_team_manager_default(text,text)'::regprocedure);
  if encode(extensions.digest(current_core,'sha256'),'hex') is distinct from 'd5f3f4cababd7e532df61c7a4fcec2410acbbeb8ebf32ac157ca3068760ea296'
    or encode(extensions.digest(current_resolution,'sha256'),'hex') is distinct from '3301244c4cbf06ae7e0ecfa1711c73d58a05bdac2e0cd2f914197d8f169a155a'
    or (select metadata from team_manager_previous_core) is distinct from
      (select (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('argument_defaults',pg_get_expr(p.proargdefaults,0))
       from pg_proc p where p.oid='public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure)
    or exists (
      (select metadata from team_manager_previous_routines except all
       select (to_jsonb(p)-'proargdefaults')||jsonb_build_object('argument_defaults',pg_get_expr(p.proargdefaults,0))
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
         and p.oid not in ('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure,'public.get_employee_team_manager_default(text,text)'::regprocedure))
      union all
      (select (to_jsonb(p)-'proargdefaults')||jsonb_build_object('argument_defaults',pg_get_expr(p.proargdefaults,0))
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
         and p.oid not in ('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure,'public.get_employee_team_manager_default(text,text)'::regprocedure)
       except all select metadata from team_manager_previous_routines)
    ) then
    raise exception 'Team Manager routine delta differs.' using errcode='55000';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.employee_team_manager_defaults'::regclass)
    or exists(select 1 from private.employee_team_manager_defaults)
    or exists(select 1 from pg_policy where polrelid='private.employee_team_manager_defaults'::regclass)
    or exists(select 1 from aclexplode((select relacl from pg_class where oid='private.employee_team_manager_defaults'::regclass)) a
      where a.grantee<>(select relowner from pg_class where oid='private.employee_team_manager_defaults'::regclass))
    or has_function_privilege('anon','public.get_employee_team_manager_default(text,text)','execute')
    or has_function_privilege('service_role','public.get_employee_team_manager_default(text,text)','execute')
    or not has_function_privilege('authenticated','public.get_employee_team_manager_default(text,text)','execute') then
    raise exception 'Team Manager structure permissions differ.' using errcode='55000';
  end if;
  if (select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attacl) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='private.employee_team_manager_defaults'::regclass and a.attnum>0)
    is distinct from '[
      ["company_key","text",true,null,"","",null],
      ["team_name","text",true,null,"","",null],
      ["manager_person_id","uuid",true,null,"","",null],
      ["version","bigint",true,"1","","",null],
      ["configured_at","timestamp with time zone",true,"clock_timestamp()","","",null],
      ["configured_by_auth_user_id","uuid",false,null,"","",null],
      ["configured_by_database_role","text",true,"CURRENT_USER","","",null]
    ]'::jsonb
    or (select array_agg(pg_get_constraintdef(c.oid,true) collate "C" order by pg_get_constraintdef(c.oid,true) collate "C")
      from pg_constraint c where c.conrelid='private.employee_team_manager_defaults'::regclass)
      is distinct from (select array_agg(definition collate "C" order by definition collate "C") from unnest(array[
        'CHECK (company_key = ANY (ARRAY[''mam''::text, ''equipsy''::text]))',
        'CHECK (team_name = ANY (ARRAY[''Operation & Accounts''::text, ''Management''::text, ''Major''::text, ''Minor''::text, ''Warehouse''::text, ''Equipsy''::text]))',
        'CHECK (version > 0)',
        'FOREIGN KEY (configured_by_auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT',
        'FOREIGN KEY (manager_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT',
        'PRIMARY KEY (company_key, team_name)'
      ]) definition)
    or exists(select 1 from pg_constraint where conrelid='private.employee_team_manager_defaults'::regclass
      and (not convalidated or condeferrable or condeferred or not conislocal or coninhcount<>0))
    or exists(select 1 from pg_trigger where tgrelid='private.employee_team_manager_defaults'::regclass
      and (not tgisinternal or tgenabled<>'O'))
    or exists(select 1 from pg_inherits where inhrelid='private.employee_team_manager_defaults'::regclass
      or inhparent='private.employee_team_manager_defaults'::regclass)
    or (select count(*) from pg_index where indrelid='private.employee_team_manager_defaults'::regclass)<>1
    or (select pg_get_indexdef(indexrelid) from pg_index where indrelid='private.employee_team_manager_defaults'::regclass)
      is distinct from 'CREATE UNIQUE INDEX employee_team_manager_defaults_pkey ON private.employee_team_manager_defaults USING btree (company_key, team_name)'
    or not (select relowner=(select proowner from pg_proc where oid='public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure)
      and relkind='r' and relpersistence='p' and not relispartition
      from pg_class where oid='private.employee_team_manager_defaults'::regclass)
    or (select proowner from pg_proc where oid='public.get_employee_team_manager_default(text,text)'::regprocedure)
      is distinct from (select proowner from pg_proc where oid='public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure)
    or (select count(*) from aclexplode((select proacl from pg_proc where oid='public.get_employee_team_manager_default(text,text)'::regprocedure)))<>2
    or exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.oid='public.get_employee_team_manager_default(text,text)'::regprocedure
        and (a.grantor<>p.proowner or a.grantee not in (p.proowner,'authenticated'::regrole::oid)
          or a.privilege_type<>'EXECUTE' or a.is_grantable)) then
    raise exception 'Team Manager exact structure delta differs.' using errcode='55000';
  end if;
  select array_agg(definition collate "C" order by definition collate "C") into previous from team_manager_previous_catalog;
  select array_agg(definition collate "C" order by definition collate "C") into normalized from (
    select case when definition=current_core then (select definition from team_manager_previous_core) else definition end as definition
    from pg_temp.team_manager_catalog()
    where left(definition,length('private.employee_team_manager_defaults:'))<>'private.employee_team_manager_defaults:'
      and left(definition,length('private.employee_team_manager_defaults_pkey:'))<>'private.employee_team_manager_defaults_pkey:'
      and definition<>current_resolution
      and definition<>(select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default')
        from pg_proc p where p.oid='public.get_employee_team_manager_default(text,text)'::regprocedure)
  ) definitions;
  if previous is distinct from normalized then
    raise exception 'Team Manager catalog delta differs.' using errcode='55000';
  end if;
  update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Team Manager final fingerprint differs.' using errcode='55000';
  end if;
end;
$transition$;

commit;
