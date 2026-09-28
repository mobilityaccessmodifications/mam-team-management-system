begin;

do $$
declare
  v_signature constant text := 'public.analytics_dashboard_dataset(text,date,date,integer,integer)';
  v_definition text;
  v_anchor constant text := $anchor$          'employee_id', person.id,
          'company', person.company_key,$anchor$;
  v_replacement constant text := $replacement$          'employee_id', person.id,
          'first_name', (select employee_detail.first_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'last_name', (select employee_detail.last_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'company', person.company_key,$replacement$;
  v_count integer;
  v_function_oid oid;
  v_owner_oid oid;
  v_owner_name text;
  v_owner_is_trusted boolean;
  v_prosecdef boolean;
  v_provolatile "char";
  v_proconfig text[];
  v_proacl aclitem[];
begin
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

  v_definition := pg_get_functiondef(v_signature::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Analytics employee projection changed; review the name-field migration.' using errcode = '55000';
  end if;

  v_definition := replace(v_definition, v_anchor, v_replacement);
  execute v_definition;

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
