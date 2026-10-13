\set ON_ERROR_STOP on
begin;
set local statement_timeout = '10s';
\ir sql-test-auth.sql
insert into auth.users(id, email, email_confirmed_at) values
  ('e1000000-0000-4000-8000-000000000001', 'full-time@example.test', now()),
  ('e1000000-0000-4000-8000-000000000002', 'part-time@example.test', now()),
  ('e1000000-0000-4000-8000-000000000003', 'unclassified@example.test', now()),
  ('e1000000-0000-4000-8000-000000000004', 'reviewer@example.test', now());
insert into public.profiles(id, full_name, app_role, login_name, credentials_valid_after) values
  ('e1000000-0000-4000-8000-000000000001', 'Synthetic Full Time', 'employee', 'synthetic_full_time', now() - interval '1 day'),
  ('e1000000-0000-4000-8000-000000000002', 'Synthetic Part Time', 'employee', 'synthetic_part_time', now() - interval '1 day'),
  ('e1000000-0000-4000-8000-000000000003', 'Synthetic Unclassified', 'employee', 'synthetic_unclassified', now() - interval '1 day'),
  ('e1000000-0000-4000-8000-000000000004', 'Synthetic Reviewer', 'system_admin', 'synthetic_reviewer', now() - interval '1 day');
insert into private.leave_approval_grants(reviewer_user_id, scope_kind, reviewer_label, priority)
values ('e1000000-0000-4000-8000-000000000004', 'global', 'Synthetic Reviewer', 100);
insert into public.internal_org_people(id, node_kind, company_key, full_name, position_title, auth_user_id) values
  ('f1000000-0000-4000-8000-000000000001', 'person', 'mam', 'Synthetic Full Time', 'Synthetic coordinator', 'e1000000-0000-4000-8000-000000000001'),
  ('f1000000-0000-4000-8000-000000000002', 'person', 'equipsy', 'Synthetic Part Time', 'Synthetic analyst', 'e1000000-0000-4000-8000-000000000002'),
  ('f1000000-0000-4000-8000-000000000003', 'person', 'mam', 'Synthetic Unclassified', 'Synthetic administrator', 'e1000000-0000-4000-8000-000000000003');
insert into private.employee_directory_details(
  person_id, first_name, last_name, work_email, employment_type, working_weekdays, working_day_times
) values
  ('f1000000-0000-4000-8000-000000000001', 'Synthetic', 'Full Time', 'full-time@example.test', 'full_time', array[1,2,3,4,5]::smallint[], '[]'::jsonb),
  ('f1000000-0000-4000-8000-000000000002', 'Synthetic', 'Part Time', 'part-time@example.test', 'part_time', array[1,3]::smallint[], '[{"weekday":1,"start_time":"09:00","end_time":"17:00"}]'::jsonb);
select pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000001');
create temp table full_time_request on commit drop as
  select id from public.submit_my_leave_request('Unpaid leave', date '2026-11-09', date '2026-11-10', null, null, 'Synthetic employee note');
create temp table explicit_time_request on commit drop as
  select id from public.submit_my_leave_request('Unpaid leave', date '2026-11-23', date '2026-11-23', time '09:15', time '11:00', 'Synthetic employee note');
select pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000002');
create temp table part_time_request on commit drop as
  select id from public.submit_my_leave_request('Unpaid leave', date '2026-11-02', date '2026-11-03', null, null, 'Synthetic employee note');
select pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000003');
create temp table unclassified_request on commit drop as
  select id from public.submit_my_leave_request('Unpaid leave', date '2026-11-16', date '2026-11-16', null, null, 'Synthetic employee note');
insert into public.leave_requests(
  id, employee_person_id, user_id, leave_type, request_type_label,
  start_date, end_date, business_days, hours, employment_type_snapshot,
  pay_treatment, record_origin, source_record_sha256, status, submitted_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000002',
  'unpaid', 'Unpaid leave', date '2026-11-30', date '2026-12-01',
  2, null, 'full_time', 'unpaid', 'historical_import', repeat('a', 64), 'approved', now()
);
do $$
declare
  v_payload jsonb;
  v_full_time jsonb;
  v_explicit_time jsonb;
  v_part_time jsonb;
  v_unclassified jsonb;
  v_snapshot jsonb;
begin
  v_payload := public.analytics_dashboard_dataset('leave_requests', null, null, 1000, 0);
  select row.value into v_full_time
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'request_id' = (select id::text from full_time_request);
  select row.value into v_explicit_time
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'request_id' = (select id::text from explicit_time_request);
  select row.value into v_part_time
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'request_id' = (select id::text from part_time_request);
  select row.value into v_unclassified
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'request_id' = (select id::text from unclassified_request);
  select row.value into v_snapshot
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'request_id' = 'a1000000-0000-4000-8000-000000000001';

  if v_full_time ->> 'business_days' is distinct from '2'
    or v_full_time ->> 'business_hours' is distinct from '15.2'
    or v_full_time -> 'hours' is distinct from 'null'::jsonb then
    raise exception 'Full-time full-day leave must report 7.6 business hours per stored business day while preserving raw hours';
  end if;
  if v_part_time ->> 'business_days' is distinct from '2'
    or v_part_time ->> 'business_hours' is distinct from '15.0' then
    raise exception 'Other full-day leave must report 7.5 business hours per stored business day';
  end if;
  if v_explicit_time ->> 'hours' is distinct from '1.75'
    or v_explicit_time ->> 'business_hours' is distinct from '1.75' then
    raise exception 'Explicit timed leave must report its recorded hours';
  end if;
  if v_unclassified ->> 'business_hours' is distinct from '7.5' then
    raise exception 'Unclassified leave must use the existing 7.5-hour fallback';
  end if;
  if v_snapshot ->> 'business_hours' is distinct from '15.2' then
    raise exception 'The submitted employment snapshot must take precedence over the current employee classification';
  end if;
  update public.leave_requests
  set employment_type_snapshot = null
  where id = 'a1000000-0000-4000-8000-000000000001';
  v_payload := public.analytics_dashboard_dataset('leave_requests', null, null, 1000, 0);
  select row.value into v_snapshot
  from jsonb_array_elements(v_payload -> 'data') as row(value)
  where row.value ->> 'request_id' = 'a1000000-0000-4000-8000-000000000001';
  if v_snapshot ->> 'business_hours' is distinct from '15.0' then
    raise exception 'When a snapshot is absent, business_hours must use the current private employment classification';
  end if;
  if array(select jsonb_object_keys(v_full_time) order by 1) is distinct from array[
    'business_days', 'business_hours', 'company', 'created_at', 'decided_at',
    'employee_id', 'end_date', 'hours', 'request_id', 'start_date', 'status',
    'submitted_at', 'updated_at'
  ]::text[] then
    raise exception 'Analytics leave_requests must add business_hours without exposing category, reason, notes or other private fields';
  end if;
end;
$$;
rollback;
