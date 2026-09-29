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
  v_anchor constant text := $anchor$          'last_name', (select employee_detail.last_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'company', person.company_key,$anchor$;
  v_replacement constant text := $replacement$          'last_name', (select employee_detail.last_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'team', (select employee_detail.team_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'scheduled_employment_end_date', (select employee_detail.scheduled_employment_end_date from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'employment_type', (select employee_detail.employment_type from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'contract_type', (select classification.contract_type from private.employee_check_in_contract_classifications classification where classification.person_id = person.id),
          'working_weekdays', (select employee_detail.working_weekdays from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'working_day_times', coalesce((select employee_detail.working_day_times from private.employee_directory_details employee_detail where employee_detail.person_id = person.id), '[]'::jsonb),
          'company', person.company_key,$replacement$;
  v_count integer;
begin
  if to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_check_in_contract_classifications') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'private'
        and table_name = 'employee_directory_details'
        and column_name in (
          'person_id', 'team_name', 'scheduled_employment_end_date',
          'employment_type', 'working_weekdays', 'working_day_times'
        )
      group by table_schema, table_name
      having count(*) = 6
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'private'
        and table_name = 'employee_check_in_contract_classifications'
        and column_name in ('person_id', 'contract_type')
      group by table_schema, table_name
      having count(*) = 2
    ) then
    raise exception 'Analytics employee field prerequisites are missing.' using errcode = '55000';
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
    or not (select relrowsecurity from pg_class where oid = 'private.employee_check_in_contract_classifications'::regclass)
    or has_table_privilege('anon', 'private.employee_directory_details', 'SELECT')
    or has_table_privilege('authenticated', 'private.employee_directory_details', 'SELECT')
    or has_table_privilege('service_role', 'private.employee_directory_details', 'SELECT')
    or has_table_privilege('anon', 'private.employee_check_in_contract_classifications', 'SELECT')
    or has_table_privilege('authenticated', 'private.employee_check_in_contract_classifications', 'SELECT')
    or has_table_privilege('service_role', 'private.employee_check_in_contract_classifications', 'SELECT') then
    raise exception 'Private employee projection source access changed; refusing to extend Analytics.' using errcode = '55000';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Analytics employee projection changed; review the employee-org-fields migration.' using errcode = '55000';
  end if;

  v_definition := replace(v_definition, v_anchor, v_replacement);
  execute v_definition;
  comment on function public.analytics_dashboard_dataset(text, date, date, integer, integer) is
    'Service-role-only analytics projection for the MAM dashboard API. The employees dataset contains approved identity, employment, team and work-schedule fields; it excludes contact data, leave notes/evidence and subscription credentials.';

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
