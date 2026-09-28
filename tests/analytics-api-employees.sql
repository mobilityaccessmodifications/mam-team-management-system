begin;

do $$
declare
  v_employee_id constant uuid := 'ffffffff-0000-4000-8000-000000000001';
  v_payload jsonb;
  v_employee jsonb;
begin
  insert into public.internal_org_people (
    id, node_kind, company_key, full_name, position_title, is_active
  ) values (
    v_employee_id, 'person', 'mam', 'Sandbox Example', 'Synthetic coordinator', true
  );
  insert into private.employee_directory_details (person_id, first_name, last_name, work_email, personal_email, phone)
  values (v_employee_id, 'Sandbox', 'Example', 'sandbox@example.test', 'private@example.test', '0400000000');

  v_payload := public.analytics_dashboard_dataset('employees', null, null, 1000, 0);
  select row.value into v_employee
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'employee_id' = v_employee_id::text;

  if v_employee ->> 'first_name' is distinct from 'Sandbox' then
    raise exception 'Analytics employees dataset must include the directory first_name';
  end if;
  if v_employee ->> 'last_name' is distinct from 'Example' then
    raise exception 'Analytics employees dataset must include the directory last_name';
  end if;
  if v_employee ?| array['work_email', 'personal_email', 'phone', 'date_of_birth'] then
    raise exception 'Analytics employees dataset must exclude private employee contact fields';
  end if;
  if not has_function_privilege('service_role', 'public.analytics_dashboard_dataset(text,date,date,integer,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.analytics_dashboard_dataset(text,date,date,integer,integer)', 'EXECUTE') then
    raise exception 'Analytics dataset RPC must remain service-role-only';
  end if;
end;
$$;

rollback;
