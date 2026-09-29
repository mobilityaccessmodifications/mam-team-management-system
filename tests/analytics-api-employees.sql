begin;

do $$
declare
  v_employee_id constant uuid := 'ffffffff-0000-4000-8000-000000000001';
  v_employee_without_details_id constant uuid := 'ffffffff-0000-4000-8000-000000000002';
  v_actor_id constant uuid := 'eeeeeeee-0000-4000-8000-000000000001';
  v_payload jsonb;
  v_employee jsonb;
begin
  insert into auth.users (id, email)
  values (v_actor_id, 'analytics-fixture@example.test');
  insert into public.internal_org_people (
    id, node_kind, company_key, full_name, position_title, is_active
  ) values (
    v_employee_id, 'person', 'mam', 'Sandbox Example', 'Synthetic coordinator', true
  );
  insert into public.internal_org_people (
    id, node_kind, company_key, full_name, position_title, is_active
  ) values (
    v_employee_without_details_id, 'person', 'equipsy', 'Synthetic No Details', 'Synthetic analyst', true
  );
  insert into private.employee_directory_details (
    person_id, first_name, last_name, work_email, personal_email, phone,
    team_name, scheduled_employment_end_date, employment_type,
    working_weekdays, working_day_times
  ) values (
    v_employee_id, 'Sandbox', 'Example', 'sandbox@example.test', 'private@example.test', '0400000000',
    'Major', date '2027-12-31', 'casual', array[1, 3, 5]::smallint[],
    '[{"weekday":1,"start_time":"09:00","end_time":"17:00"}]'::jsonb
  );
  insert into private.employee_check_in_contract_classifications (
    person_id, contract_type, updated_by_user_id
  ) values (v_employee_id, 'fixed_term', v_actor_id);

  v_payload := public.analytics_dashboard_dataset('employees', null, null, 1000, 0);
  select row.value into v_employee
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'employee_id' = v_employee_id::text;

  if v_employee is null then
    raise exception 'Analytics employees dataset must include the synthetic employee row';
  end if;
  if v_employee ->> 'first_name' is distinct from 'Sandbox' then
    raise exception 'Analytics employees dataset must include the directory first_name';
  end if;
  if v_employee ->> 'last_name' is distinct from 'Example' then
    raise exception 'Analytics employees dataset must include the directory last_name';
  end if;
  if v_employee ->> 'team' is distinct from 'Major'
    or v_employee ->> 'scheduled_employment_end_date' is distinct from '2027-12-31'
    or v_employee ->> 'employment_type' is distinct from 'casual'
    or v_employee ->> 'contract_type' is distinct from 'fixed_term'
    or v_employee -> 'working_weekdays' is distinct from '[1,3,5]'::jsonb
    or v_employee -> 'working_day_times' is distinct from '[{"weekday":1,"start_time":"09:00","end_time":"17:00"}]'::jsonb then
    raise exception 'Analytics employees dataset must return the approved employment and work-schedule fields';
  end if;
  if v_employee ?| array['work_email', 'personal_email', 'phone', 'date_of_birth'] then
    raise exception 'Analytics employees dataset must exclude private employee contact fields';
  end if;
  if array(select jsonb_object_keys(v_employee) order by 1) is distinct from array[
    'company', 'contract_type', 'employee_id', 'employment_status', 'employment_type',
    'first_name', 'last_name', 'position_title', 'record_created_at', 'record_updated_at',
    'scheduled_employment_end_date', 'started_on', 'team', 'working_day_times', 'working_weekdays'
  ]::text[] then
    raise exception 'Analytics employees dataset must return only its documented projection fields';
  end if;
  select row.value into v_employee
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'employee_id' = v_employee_without_details_id::text;
  if v_employee is null
    or not (v_employee ?& array[
      'team', 'scheduled_employment_end_date', 'employment_type',
      'contract_type', 'working_weekdays', 'working_day_times'
    ])
    or v_employee -> 'team' <> 'null'::jsonb
    or v_employee -> 'scheduled_employment_end_date' <> 'null'::jsonb
    or v_employee -> 'employment_type' <> 'null'::jsonb
    or v_employee -> 'contract_type' <> 'null'::jsonb
    or v_employee -> 'working_weekdays' <> 'null'::jsonb
    or v_employee -> 'working_day_times' <> '[]'::jsonb then
    raise exception 'Unrecorded HR values must be returned as null, with unrecorded daily times as an empty array';
  end if;
  if not has_function_privilege('service_role', 'public.analytics_dashboard_dataset(text,date,date,integer,integer)', 'EXECUTE')
    or has_function_privilege('anon', 'public.analytics_dashboard_dataset(text,date,date,integer,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.analytics_dashboard_dataset(text,date,date,integer,integer)', 'EXECUTE')
    or exists (
      select 1
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
      where p.oid = 'public.analytics_dashboard_dataset(text,date,date,integer,integer)'::regprocedure
        and privilege.privilege_type = 'EXECUTE'
        and (privilege.is_grantable
          or privilege.grantee not in (p.proowner, 'service_role'::regrole::oid))
    ) then
    raise exception 'Analytics dataset RPC must remain service-role-only';
  end if;
end;
$$;

rollback;
