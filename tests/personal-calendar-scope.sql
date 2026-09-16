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

select pg_temp.assert(
  pg_get_function_result('public.list_leave_calendar_entries()'::regprocedure)
    like 'TABLE(id uuid, person_id uuid,%',
  'Calendar migration recreates the live projection with a stable person ID'
);
select pg_temp.assert(
  pg_get_function_result('public.list_leave_calendar_entries_for_preview(uuid)'::regprocedure)
    like 'TABLE(id uuid, person_id uuid,%',
  'Calendar preview projection exposes the same stable person ID contract'
);

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000006');

insert into public.profiles (id, app_role, account_status, login_name) values
  ('10000000-0000-4000-8000-000000000001', 'system_admin', 'active', 'admin'),
  ('10000000-0000-4000-8000-000000000002', 'employee', 'active', 'alice'),
  ('10000000-0000-4000-8000-000000000003', 'employee', 'active', 'bob'),
  ('10000000-0000-4000-8000-000000000004', 'employee', 'active', 'gerard'),
  ('10000000-0000-4000-8000-000000000005', 'employee', 'active', 'jackie'),
  ('10000000-0000-4000-8000-000000000006', 'employee', 'disabled', 'former');

insert into public.internal_org_people (id, auth_user_id, node_kind, is_active, full_name, company_key) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'person', true, 'System Admin', 'mam'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'person', true, 'Alice Example', 'mam'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'person', true, 'Bob Example', 'equipsy'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'person', true, 'Gerard Example', 'mam'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005', 'person', true, 'Jackie Example', 'mam'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006', 'person', false, 'Former Example', 'mam');

insert into public.leave_requests (
  id, employee_person_id, user_id, request_type_label, start_date, end_date,
  start_time, end_time, business_days, hours, status, created_at
) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Annual leave', '2026-10-01', '2026-10-01', '09:00', '10:00', 1, 1, 'submitted', '2026-09-01'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Sick leave', '2026-10-02', '2026-10-02', '13:00', '15:00', 1, 2, 'approved', '2026-09-02'),
  -- Gerard submitted these two requests on Bob's behalf. That must not make
  -- Bob's pending request Gerard's personal record or reveal Bob's category
  -- through Gerard's payroll-only approved-leave capability.
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 'Annual leave', '2026-10-03', '2026-10-03', '09:00', '12:00', 1, 3, 'submitted', '2026-09-03'),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 'Carer''s leave', '2026-10-05', '2026-10-06', '10:00', '14:00', 2, 16, 'approved', '2026-09-04'),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'Annual leave', '2026-10-07', '2026-10-07', '08:00', '12:00', 1, 4, 'submitted', '2026-09-05'),
  ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006', 'Annual leave', '2026-10-08', '2026-10-08', '09:00', '17:00', 1, 8, 'approved', '2026-09-06');

insert into private.employee_check_in_reminders (
  id, person_id, milestone, reminder_sequence, due_date, delivery_status
) values
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '1_month', 'initial', '2026-10-10', 'scheduled'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003', '3_month', 'initial', '2026-10-11', 'completed'),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004', '5_month', 'initial', '2026-10-12', 'scheduled');

insert into private.payroll_balance_import_grants (person_id)
values ('20000000-0000-4000-8000-000000000004');

insert into private.approved_leave_calendar_grants (person_id, granted_by) values
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001');

set role authenticated;
set request.jwt.claims = '{"is_anonymous":false}';

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
select pg_temp.assert(
  (select count(*) = 2 from public.list_leave_calendar_entries()),
  'ordinary employee sees only their own pending and approved leave'
);
select pg_temp.assert(
  not exists (
    select 1 from public.list_leave_calendar_entries()
    where employee_name <> 'Alice Example'
  ),
  'other employees are omitted instead of shown as Away'
);
select pg_temp.assert(
  (select bool_and(person_id = '20000000-0000-4000-8000-000000000002')
   from public.list_leave_calendar_entries()),
  'ordinary employee Calendar rows retain the stable employee person ID'
);
select pg_temp.assert(
  (select count(*) = 1 and bool_and(employee_name = 'Alice Example')
   from public.list_employee_check_in_calendar_entries()),
  'ordinary employee sees only their own Check-in'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
select pg_temp.assert(
  (select count(*) = 4 from public.list_leave_calendar_entries()),
  'Gerard sees every active and archived approved leave plus his own pending leave'
);
select pg_temp.assert(
  not exists (
    select 1 from public.list_leave_calendar_entries()
    where employee_name <> 'Gerard Example' and status <> 'Approved'
  ),
  'Gerard never sees another employee pending leave, including one he submitted on their behalf'
);
select pg_temp.assert(
  not exists (
    select 1 from public.list_leave_calendar_entries()
    where employee_name <> 'Gerard Example' and leave_type_label <> 'Approved leave'
  ),
  'other employees approved leave categories remain private even when Gerard submitted the request'
);
select pg_temp.assert(
  exists (
    select 1 from public.list_leave_calendar_entries()
    where employee_name = 'Former Example (archived)'
      and person_id = '20000000-0000-4000-8000-000000000006'
      and leave_type_label = 'Approved leave'
      and status = 'Approved'
      and start_time = time '09:00'
      and end_time = time '17:00'
      and hours = 8
  ),
  'Gerard payroll Calendar retains approved history with an archived employee label'
);
select pg_temp.assert(
  (select start_time = time '10:00'
      and end_time = time '14:00'
      and business_days = 2
      and hours = 16
   from public.list_leave_calendar_entries()
   where employee_name = 'Bob Example'),
  'Gerard receives exact approved schedule and duration for payroll processing'
);
select pg_temp.assert(
  (select start_time = time '08:00' and end_time = time '12:00' and hours = 4
   from public.list_leave_calendar_entries()
   where employee_name = 'Gerard Example'),
  'Gerard retains exact detail for his own leave'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', false);
select pg_temp.assert(
  (select count(*) = 3 and bool_and(status = 'Approved')
   from public.list_leave_calendar_entries()),
  'Jackie sees every active and archived approved leave and no pending leave from others'
);
select pg_temp.assert(
  exists (
    select 1 from public.list_leave_calendar_entries()
    where employee_name = 'Former Example (archived)'
      and leave_type_label = 'Approved leave'
      and status = 'Approved'
  ),
  'Jackie payroll Calendar retains approved history with an archived employee label'
);
select pg_temp.assert(
  (select start_time = time '10:00'
      and end_time = time '14:00'
      and business_days = 2
      and hours = 16
   from public.list_leave_calendar_entries()
   where employee_name = 'Bob Example'),
  'Jackie receives exact approved schedule and duration for payroll processing'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
select pg_temp.assert(
  (select count(*) = 3 and bool_and(status = 'Approved')
   from public.list_leave_calendar_entries()),
  'System Admin sees active and archived approved leave without unrelated pending leave'
);
select pg_temp.assert(
  (select count(*) = 3 from public.list_employee_check_in_calendar_entries()),
  'System Admin retains all Check-in Calendar entries'
);
select pg_temp.assert(
  (select count(*) = 2 from public.list_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000002')),
  'ordinary employee preview contains only that employee leave'
);
select pg_temp.assert(
  (select count(*) = 4 from public.list_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000004')),
  'Gerard preview includes his explicit approved-leave Calendar capability'
);
select pg_temp.assert(
  (select start_time = time '10:00'
      and end_time = time '14:00'
      and business_days = 2
      and hours = 16
    from public.list_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000004')
    where employee_name = 'Bob Example'),
  'Gerard preview preserves the approved payroll-processing detail scope'
);
select pg_temp.assert(
  not exists (
    select 1
    from public.list_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000004')
    where employee_name = 'Bob Example'
      and (status <> 'Approved' or leave_type_label <> 'Approved leave')
  ),
  'Gerard preview excludes delegated pending leave and minimises delegated approved leave'
);
select pg_temp.assert(
  exists (
    select 1
    from public.list_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000004')
    where employee_name = 'Former Example (archived)'
      and person_id = '20000000-0000-4000-8000-000000000006'
      and leave_type_label = 'Approved leave'
      and status = 'Approved'
  ),
  'Gerard preview retains approved history with an archived employee label'
);
select pg_temp.assert(
  (select count(*) = 1 and bool_and(person_id = '20000000-0000-4000-8000-000000000002')
   from public.list_employee_check_in_calendar_entries_for_preview('20000000-0000-4000-8000-000000000002')),
  'preview Check-ins remain owner scoped'
);
select pg_temp.assert(
  public.can_import_payroll_balances_for_preview('20000000-0000-4000-8000-000000000004'),
  'Gerard preview exposes his payroll upload capability'
);
select pg_temp.assert(
  not public.can_import_payroll_balances_for_preview('20000000-0000-4000-8000-000000000005'),
  'Jackie preview does not inherit payroll upload access'
);

reset role;

select pg_temp.assert(
  not has_table_privilege('authenticated', 'private.approved_leave_calendar_grants', 'SELECT'),
  'Calendar grants are not browser-readable'
);
select pg_temp.assert(
  not has_function_privilege('authenticated', 'private.can_view_all_approved_leave_calendar_for(uuid)', 'EXECUTE'),
  'target-aware Calendar capability remains private'
);
