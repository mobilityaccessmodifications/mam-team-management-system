\set ON_ERROR_STOP on

create function pg_temp.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Assertion failed: %', p_message;
  end if;
end;
$$;

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004');

insert into public.profiles (id, full_name, app_role, account_status, login_name) values
  ('10000000-0000-4000-8000-000000000001', 'Manager Example', 'manager', 'active', 'manager'),
  ('10000000-0000-4000-8000-000000000002', 'Employee Example', 'employee', 'active', 'employee'),
  ('10000000-0000-4000-8000-000000000003', 'System Admin', 'system_admin', 'active', 'admin'),
  ('10000000-0000-4000-8000-000000000004', 'New Employee', 'employee', 'active', 'new-employee');

insert into public.internal_org_people (id, auth_user_id, parent_id, full_name) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null, 'Manager Example'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', null, 'System Admin'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Employee Example'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'New Employee');

insert into private.employee_directory_details (person_id, working_weekdays) values
  ('20000000-0000-4000-8000-000000000001', array[1,2,3,4,5]::smallint[]),
  ('20000000-0000-4000-8000-000000000002', null),
  ('20000000-0000-4000-8000-000000000003', array[1,2,3,4,5]::smallint[]),
  ('20000000-0000-4000-8000-000000000004', null);

set role authenticated;
set request.jwt.claims = '{"is_anonymous":false}';
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);

create temp table first_result as
select public.submit_my_employee_work_schedule_change_v2(
  array[1,2,3,4,5]::smallint[],
  '[{"weekday":1,"start_time":"12:00","end_time":"16:00"}]'::jsonb,
  ''
) as payload;

reset role;
select pg_temp.assert(
  (select payload ->> 'outcome' = 'applied' from first_result),
  'the first self-service schedule applies immediately'
);
select pg_temp.assert(
  (select working_weekdays = array[1,2,3,4,5]::smallint[]
     and working_day_times = '[{"weekday":1,"start_time":"12:00","end_time":"16:00"}]'::jsonb
   from private.employee_directory_details
   where person_id = '20000000-0000-4000-8000-000000000002'),
  'the first schedule stores optional per-day times'
);
select pg_temp.assert(
  not exists (
    select 1 from private.employee_work_schedule_change_requests
    where person_id = '20000000-0000-4000-8000-000000000002'
  ),
  'the first schedule does not create an approval request'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
create temp table change_result as
select public.submit_my_employee_work_schedule_change_v2(
  array[1,2,3,4,5]::smallint[],
  '[{"weekday":1,"start_time":"13:00","end_time":"17:00"}]'::jsonb,
  'Later Monday hours'
) as payload;
reset role;

select pg_temp.assert(
  (select payload ->> 'outcome' = 'submitted' from change_result),
  'later time-only changes require approval'
);
select pg_temp.assert(
  (select requested_working_day_times = '[{"weekday":1,"start_time":"13:00","end_time":"17:00"}]'::jsonb
   from private.employee_work_schedule_change_requests
   where person_id = '20000000-0000-4000-8000-000000000002' and status = 'submitted'),
  'the request snapshots the proposed time'
);
select pg_temp.assert(
  (select working_day_times = '[{"weekday":1,"start_time":"12:00","end_time":"16:00"}]'::jsonb
   from private.employee_directory_details
   where person_id = '20000000-0000-4000-8000-000000000002'),
  'a pending request does not change the active schedule'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
select public.decide_employee_work_schedule_change_request(
  (select (payload ->> 'request_id')::uuid from change_result),
  'approved',
  'Hours confirmed'
);
reset role;

select pg_temp.assert(
  (select working_day_times = '[{"weekday":1,"start_time":"13:00","end_time":"17:00"}]'::jsonb
   from private.employee_directory_details
   where person_id = '20000000-0000-4000-8000-000000000002'),
  'manager approval applies the requested time'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
do $$
begin
  perform public.submit_my_employee_work_schedule_change_v2(
    array[1,2,3,4,5]::smallint[],
    '[{"weekday":1,"start_time":"13:15","end_time":"17:00"}]'::jsonb,
    ''
  );
  raise exception 'Expected an established schedule without a reason to fail.';
exception
  when invalid_parameter_value then null;
end;
$$;

do $$
begin
  perform public.submit_my_employee_work_schedule_change_v2(
    array[1,2,3,4,5]::smallint[],
    '[{"weekday":1,"start_time":"13:10","end_time":"17:00"}]'::jsonb,
    'Invalid interval'
  );
  raise exception 'Expected a non-quarter-hour time to fail.';
exception
  when invalid_parameter_value then null;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', false);
do $$
begin
  perform public.submit_selected_employee_work_schedule_change_v2(
    '20000000-0000-4000-8000-000000000004',
    array[1,2,3]::smallint[],
    '[]'::jsonb,
    ''
  );
  raise exception 'Expected Change profile to retain the approval reason requirement.';
exception
  when invalid_parameter_value then null;
end;
$$;
reset role;

select pg_temp.assert(
  (select working_weekdays is null from private.employee_directory_details
   where person_id = '20000000-0000-4000-8000-000000000004'),
  'Change profile cannot use the employee-only first-login shortcut'
);

select pg_temp.assert(
  not has_function_privilege(
    'authenticated',
    'private.submit_employee_work_schedule_change_v2(uuid,smallint[],jsonb,text,boolean,boolean)',
    'EXECUTE'
  ),
  'the target-aware mutation helper remains private'
);

update private.employee_directory_details
set working_weekdays = array[1,2,3]::smallint[]
where person_id = '20000000-0000-4000-8000-000000000004';

update private.employee_directory_details
set working_weekdays = null
where person_id = '20000000-0000-4000-8000-000000000004';

select pg_temp.assert(
  (select working_schedule_initial_setup_completed
   from private.employee_directory_details
   where person_id = '20000000-0000-4000-8000-000000000004'),
  'clearing a previously recorded schedule does not restore first-setup eligibility'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
do $$
begin
  perform public.submit_my_employee_work_schedule_change_v2(
    array[1,2,3]::smallint[],
    '[]'::jsonb,
    ''
  );
  raise exception 'Expected a cleared historical schedule to retain approval.';
exception
  when invalid_parameter_value then null;
end;
$$;
reset role;

select pg_temp.assert(
  not (public.get_my_employee_work_schedule_workspace() ->> 'initial_setup_available')::boolean,
  'a cleared historical schedule is not projected as first setup'
);
