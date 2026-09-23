create function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_message; end if;
end;
$$;

insert into auth.users (id) values
  ('72000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000002');

insert into public.profiles (
  id, full_name, app_role, account_status, login_name, credentials_valid_after
) values
  ('72000000-0000-4000-8000-000000000001', 'Synthetic Manager', 'manager', 'active',
   'synthetic.manager@example.test', '-infinity'),
  ('72000000-0000-4000-8000-000000000002', 'Synthetic Starter', 'employee', 'active',
   'synthetic.employee@example.test', '-infinity');

insert into public.internal_org_people (
  id, auth_user_id, parent_id, node_kind, is_active, full_name, position_title, company_key, started_date
) values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', null,
   'person', true, 'Synthetic Manager', 'Team Leader', 'mam', null),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002',
   '73000000-0000-4000-8000-000000000001', 'person', true, 'Synthetic Starter', 'Coordinator', 'mam', date '2026-10-05');

insert into private.employee_directory_details (
  person_id, first_name, last_name, team_name, work_email, personal_email
) values
  ('73000000-0000-4000-8000-000000000001', 'Synthetic', 'Manager', 'MAM admin', 'manager@example.test', null),
  ('73000000-0000-4000-8000-000000000002', 'Synthetic', 'Starter', 'MAM admin', 'employee@example.test', 'personal@example.test');

select private.sync_employee_check_in_reminders('73000000-0000-4000-8000-000000000002', false, false);

select pg_temp.assert(
  exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '2_week'
      and reminder.reminder_sequence = 'initial'
      and reminder.due_date = date '2026-10-19'
      and reminder.notify_date = date '2026-10-14'
      and reminder.delivery_status = 'scheduled'
  ),
  '2-Week Check-In is scheduled three Victorian business days before the due date'
);

select pg_temp.assert(
  exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '1_month'
      and reminder.reminder_sequence = 'initial'
      and reminder.due_date = date '2026-11-04'
      and reminder.notify_date = date '2026-10-29'
      and reminder.delivery_status = 'scheduled'
  ),
  '1-Month Check-In is scheduled three Victorian business days before the due date'
);


select pg_temp.assert(
  exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '2_month'
      and reminder.reminder_sequence = 'initial'
      and reminder.due_date = date '2026-12-04'
      and reminder.notify_date = date '2026-12-01'
      and reminder.delivery_status = 'scheduled'
  ),
  '2-Month Stay Interview is scheduled three Victorian business days before the due date'
);

select pg_temp.assert(
  exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '3_month'
      and reminder.reminder_sequence = 'initial'
      and reminder.due_date = date '2027-01-04'
      and reminder.notify_date = date '2026-12-23'
      and reminder.delivery_status = 'scheduled'
  ),
  '3-Month Midpoint Review is scheduled five Victorian business days before the due date'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000002', false);
select set_config(
  'request.jwt.claims',
  '{"is_anonymous":false,"app_metadata":{"org_role":"employee"}}',
  false
);
select pg_temp.assert(
  exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
      and milestone = '2_week'
      and due_date = date '2026-10-19'
  ),
  'employee Calendar shows the employee own 2-Week Check-In'
);
select pg_temp.assert(
  exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
      and milestone = '1_month'
      and due_date = date '2026-11-04'
  ),
  'employee Calendar shows the employee own 1-Month Check-In'
);

select pg_temp.assert(
  exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
      and milestone = '2_month'
      and due_date = date '2026-12-04'
  ),
  'employee Calendar shows the employee own 2-Month Stay Interview'
);
select pg_temp.assert(
  exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
      and milestone = '3_month'
      and due_date = date '2027-01-04'
  ),
  'employee Calendar shows the employee own 3-Month Midpoint Review'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', false);
select set_config(
  'request.jwt.claims',
  '{"is_anonymous":false,"app_metadata":{"org_role":"manager"}}',
  false
);
select pg_temp.assert(
  exists (
    select 1 from public.list_my_employee_check_in_tasks() task
    cross join lateral jsonb_array_elements(task.reminders) reminder
    where task.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '2_week'
      and reminder ->> 'dueDate' = '2026-10-19'
  ),
  'direct manager Tasks shows the employee 2-Week Check-In'
);
select pg_temp.assert(
  exists (
    select 1 from public.list_my_employee_check_in_tasks() task
    cross join lateral jsonb_array_elements(task.reminders) reminder
    where task.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '1_month'
      and reminder ->> 'dueDate' = '2026-11-04'
  ),
  'direct manager Tasks shows the employee 1-Month Check-In'
);

select pg_temp.assert(
  exists (
    select 1 from public.list_my_employee_check_in_tasks() task
    cross join lateral jsonb_array_elements(task.reminders) reminder
    where task.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '2_month'
      and reminder ->> 'dueDate' = '2026-12-04'
  ),
  'direct manager Tasks shows the employee 2-Month Stay Interview'
);
select pg_temp.assert(
  exists (
    select 1 from public.list_my_employee_check_in_tasks() task
    cross join lateral jsonb_array_elements(task.reminders) reminder
    where task.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '3_month'
      and reminder ->> 'dueDate' = '2027-01-04'
  ),
  'direct manager Tasks shows the employee 3-Month Midpoint Review'
);
select pg_temp.assert(
  not exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
  ),
  'manager Calendar does not expose employee Check-In records'
);
reset role;

select '2-Week, 1-Month, 2-Month and 3-Month Check-In Calendar and Tasks scope passed' as result;
