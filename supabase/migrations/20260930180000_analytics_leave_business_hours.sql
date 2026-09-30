begin;

do $$
declare
  v_signature constant text := 'public.analytics_dashboard_dataset(text,date,date,integer,integer)';
  v_function_oid oid;
  v_owner_oid oid;
  v_owner_name text;
  v_owner_is_trusted boolean;
  v_prosecdef boolean;
  v_provolatile "char";
  v_proconfig text[];
  v_proacl aclitem[];
  v_definition text;
  v_definition_normalized text;
  v_anchor constant text := $anchor$          'hours', request.hours,
          'status', request.status,$anchor$;
  v_replacement constant text := $replacement$          'hours', request.hours,
          'business_hours', coalesce(
            request.hours,
            request.business_days::numeric * case
              when coalesce(
                request.employment_type_snapshot,
                (select employee_detail.employment_type
                 from private.employee_directory_details employee_detail
                 where employee_detail.person_id = request.employee_person_id)
              ) = 'full_time' then 7.6::numeric
              else 7.5::numeric
            end
          ),
          'status', request.status,$replacement$;
  v_projection_marker constant text := $marker$'business_hours', coalesce( request.hours, request.business_days::numeric * case when coalesce( request.employment_type_snapshot, (select employee_detail.employment_type from private.employee_directory_details employee_detail where employee_detail.person_id = request.employee_person_id) ) = 'full_time' then 7.6::numeric else 7.5::numeric end ), 'status', request.status$marker$;
  v_count integer;
begin
  if to_regclass('public.leave_requests') is null
    or to_regclass('private.employee_directory_details') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'leave_requests'
        and column_name in ('employee_person_id', 'business_days', 'hours', 'employment_type_snapshot')
      group by table_schema, table_name
      having count(*) = 4
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'private'
        and table_name = 'employee_directory_details'
        and column_name in ('person_id', 'employment_type')
      group by table_schema, table_name
      having count(*) = 2
    ) then
    raise exception 'Analytics leave business-hours prerequisites are missing.' using errcode = '55000';
  end if;

  if to_regprocedure(v_signature) is null then
    raise exception 'Analytics dataset RPC is missing.' using errcode = '55000';
  end if;

  select p.oid, p.proowner, owner_role.rolname,
    (owner_role.rolsuper or owner_role.rolbypassrls),
    p.prosecdef, p.provolatile, p.proconfig, p.proacl
  into v_function_oid, v_owner_oid, v_owner_name, v_owner_is_trusted,
    v_prosecdef, v_provolatile, v_proconfig, v_proacl
  from pg_proc p
  join pg_roles owner_role on owner_role.oid = p.proowner
  where p.oid = v_signature::regprocedure;

  if not v_owner_is_trusted or v_owner_name in ('anon', 'authenticated', 'service_role')
    or not v_prosecdef or v_provolatile <> 's'
    or v_proconfig is distinct from array['search_path=""']::text[] then
    raise exception 'Analytics dataset RPC security attributes changed; review before extending it.' using errcode = '55000';
  end if;

  if not has_function_privilege('service_role', v_function_oid, 'EXECUTE')
    or has_function_privilege('anon', v_function_oid, 'EXECUTE')
    or has_function_privilege('authenticated', v_function_oid, 'EXECUTE')
    or exists (
      select 1
      from aclexplode(coalesce(v_proacl, acldefault('f', v_owner_oid))) privilege
      where privilege.privilege_type = 'EXECUTE'
        and (privilege.is_grantable
          or privilege.grantee not in (v_owner_oid, 'service_role'::regrole::oid))
    ) then
    raise exception 'Analytics dataset RPC execute grants changed; expected its owner and service_role only.' using errcode = '55000';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'private.employee_directory_details'::regclass)
    or has_table_privilege('anon', 'private.employee_directory_details', 'SELECT')
    or has_table_privilege('authenticated', 'private.employee_directory_details', 'SELECT')
    or has_table_privilege('service_role', 'private.employee_directory_details', 'SELECT') then
    raise exception 'Private employment classification access changed; refusing to extend Analytics.' using errcode = '55000';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);
  if position('business_hours' in v_definition) <> 0 then
    raise exception 'Analytics leave business_hours already exists; inspect the projection before applying.' using errcode = '55000';
  end if;

  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Analytics leave_requests projection changed; review the business-hours migration.' using errcode = '55000';
  end if;

  v_definition := replace(v_definition, v_anchor, v_replacement);
  execute v_definition;

  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  where p.oid = v_function_oid;
  v_definition_normalized := regexp_replace(v_definition, '\s+', ' ', 'g');
  v_count := (length(v_definition_normalized) - length(replace(v_definition_normalized, v_projection_marker, ''))) / length(v_projection_marker);
  if v_count <> 1 then
    raise exception 'Analytics leave business_hours projection failed its source verification.' using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_proc p
    where p.oid = v_function_oid
      and p.proowner = v_owner_oid
      and p.proacl is not distinct from v_proacl
      and p.prosecdef = v_prosecdef
      and p.provolatile = v_provolatile
      and p.proconfig is not distinct from v_proconfig
  ) then
    raise exception 'Analytics dataset RPC security properties changed during replacement.' using errcode = '55000';
  end if;
end;
$$;

commit;
