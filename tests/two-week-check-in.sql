create function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_message; end if;
end;
$$;

insert into auth.users (id) values
  ('72000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000002'),
  ('72000000-0000-4000-8000-000000000003');

insert into public.profiles (
  id, full_name, app_role, account_status, login_name, credentials_valid_after
) values
  ('72000000-0000-4000-8000-000000000001', 'Synthetic Manager', 'manager', 'active',
   'synthetic.manager@example.test', '-infinity'),
  ('72000000-0000-4000-8000-000000000002', 'Synthetic Starter', 'employee', 'active',
   'synthetic.employee@example.test', '-infinity'),
  ('72000000-0000-4000-8000-000000000003', 'Legacy Starter', 'employee', 'active',
   'legacy.employee@example.test', '-infinity');

insert into public.internal_org_people (
  id, auth_user_id, parent_id, node_kind, is_active, full_name, position_title, company_key, started_date
) values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', null,
   'person', true, 'Synthetic Manager', 'Team Leader', 'mam', null),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002',
   '73000000-0000-4000-8000-000000000001', 'person', true, 'Synthetic Starter', 'Coordinator', 'mam', date '2026-10-05'),
  ('73000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000003',
   '73000000-0000-4000-8000-000000000001', 'person', true, 'Legacy Starter', 'Coordinator', 'mam', date '2026-10-05');

insert into private.employee_directory_details (
  person_id, first_name, last_name, team_name, work_email, personal_email
) values
  ('73000000-0000-4000-8000-000000000001', 'Synthetic', 'Manager', 'Operation & Accounts', 'manager@example.test', null),
  ('73000000-0000-4000-8000-000000000002', 'Synthetic', 'Starter', 'Operation & Accounts', 'employee@example.test', 'personal@example.test'),
  ('73000000-0000-4000-8000-000000000003', 'Legacy', 'Starter', 'Operation & Accounts', 'legacy@example.test', null);

select private.sync_employee_check_in_reminders('73000000-0000-4000-8000-000000000002', false, false);

select pg_temp.assert(
  not (select release.enabled
       from private.people_hub_release_flags release
       where release.feature = 'five_month_no_surprises_review')
  and not exists (
    select 1
    from private.employee_check_in_schedule(date '2026-10-05') schedule
    where schedule.milestone = '5_month'
  )
  and not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '5_month'
  ),
  'the staged migration keeps the 5-Month schedule durably disabled'
);

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

insert into private.employee_check_in_reminders (
  id, person_id, milestone, reminder_sequence, due_date, notify_date, delivery_status,
  manual_catch_up_requested_at
) values (
  '73000000-0000-4000-8000-000000000011',
  '73000000-0000-4000-8000-000000000003',
  '5_month',
  'initial',
  date '2027-03-04',
  date '2027-02-18',
  'scheduled',
  clock_timestamp()
);

select pg_temp.assert(
  not exists (
    select 1
    from public.claim_due_employee_check_in_reminders(25) claimed
    where claimed.reminder_id = '73000000-0000-4000-8000-000000000011'
  ),
  'the disabled 5-Month release cannot be claimed even when catch-up is requested'
);

update private.employee_check_in_reminders
set delivery_status = 'claimed',
    claim_token = '73000000-0000-4000-8000-000000000013',
    claimed_at = clock_timestamp()
where id = '73000000-0000-4000-8000-000000000011';

select pg_temp.assert(
  not exists (
    select 1
    from public.prepare_employee_check_in_reminder_delivery(
      '73000000-0000-4000-8000-000000000011',
      '73000000-0000-4000-8000-000000000013'
    )
  ),
  'preparation blocks a stale claim while the release is disabled'
);

select pg_temp.assert(
  exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.id = '73000000-0000-4000-8000-000000000011'
      and reminder.delivery_status = 'superseded'
  ),
  'preparation supersedes the blocked stale claim'
);

insert into private.employee_check_in_reminders (
  id, person_id, milestone, reminder_sequence, due_date, notify_date, delivery_status,
  delivered_at, provider_delivery_id
) values (
  '73000000-0000-4000-8000-000000000012',
  '73000000-0000-4000-8000-000000000003',
  '5_month',
  'final',
  date '2027-03-04',
  date '2027-02-25',
  'delivered',
  timestamptz '2026-09-24 01:00:00+00',
  'legacy-final-provider'
);

select private.activate_five_month_no_surprises_review();

update private.employee_check_in_reminders
set delivery_status = 'claimed',
    claim_token = '73000000-0000-4000-8000-000000000014',
    claimed_at = clock_timestamp()
where person_id = '73000000-0000-4000-8000-000000000002'
  and milestone = '5_month'
  and reminder_sequence = 'initial';

select private.activate_five_month_no_surprises_review();
select pg_temp.assert(
  exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '5_month'
      and reminder.delivery_status = 'claimed'
  ),
  'an activation retry is a no-op even when normal 5-Month delivery has begun'
);

update private.employee_check_in_reminders
set delivery_status = 'scheduled',
    claim_token = null,
    claimed_at = null
where person_id = '73000000-0000-4000-8000-000000000002'
  and milestone = '5_month'
  and reminder_sequence = 'initial';

select private.sync_employee_check_in_reminders('73000000-0000-4000-8000-000000000003', false, false);
select private.activate_five_month_no_surprises_review();

select pg_temp.assert(
  (select release.enabled
   from private.people_hub_release_flags release
   where release.feature = 'five_month_no_surprises_review'),
  'activation enables the reviewed 5-Month schedule'
);

select pg_temp.assert(
  (select count(*) = 1
   from private.employee_check_in_reminders reminder
   where reminder.person_id = '73000000-0000-4000-8000-000000000002'
     and reminder.milestone = '5_month'
     and reminder.reminder_sequence = 'initial'
     and reminder.due_date = date '2027-03-04'
     and reminder.notify_date = date '2027-02-25'
     and reminder.delivery_status = 'scheduled'),
  '5-Month No-Surprises Review has one reminder five Victorian business days before the due date'
);
select pg_temp.assert(
  exists (
    select 1
    from private.employee_check_in_reminders initial_reminder
    where initial_reminder.id = '73000000-0000-4000-8000-000000000011'
      and initial_reminder.delivery_status = 'superseded'
  )
  and exists (
    select 1
    from private.employee_check_in_reminders final_reminder
    where final_reminder.id = '73000000-0000-4000-8000-000000000012'
      and final_reminder.delivery_status = 'superseded'
      and final_reminder.delivered_at = timestamptz '2026-09-24 01:00:00+00'
      and final_reminder.provider_delivery_id = 'legacy-final-provider'
  )
  and not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000003'
      and reminder.milestone = '5_month'
      and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
  )
  and (
    select count(*) = 1
    from private.employee_check_in_reminder_events event
    where event.reminder_id = '73000000-0000-4000-8000-000000000012'
      and event.event_type = 'superseded'
  ),
  'activation and later resync retries preserve legacy final evidence without reactivating its initial sibling'
);
select pg_temp.assert(
  not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '5_month'
      and reminder.reminder_sequence = 'final'
  ),
  '5-Month No-Surprises Review has no duplicate final reminder'
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
select pg_temp.assert(
  exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
      and milestone = '5_month'
      and due_date = date '2027-03-04'
  ),
  'employee Calendar shows the employee own 5-Month No-Surprises Review'
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
  exists (
    select 1 from public.list_my_employee_check_in_tasks() task
    cross join lateral jsonb_array_elements(task.reminders) reminder
    where task.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '5_month'
      and reminder ->> 'dueDate' = '2027-03-04'
  ),
  'direct manager Tasks shows the employee 5-Month No-Surprises Review'
);
select pg_temp.assert(
  not exists (
    select 1 from public.list_employee_check_in_calendar_entries()
    where person_id = '73000000-0000-4000-8000-000000000002'
  ),
  'manager Calendar does not expose employee Check-In records'
);
reset role;

update private.employee_directory_details
set work_email = null,
    personal_email = null
where person_id = '73000000-0000-4000-8000-000000000002';

update private.employee_check_in_reminders
set delivery_status = 'needs_review',
    needs_review_reason = 'context_changed'
where person_id = '73000000-0000-4000-8000-000000000002'
  and milestone = '5_month'
  and reminder_sequence = 'initial';

update private.employee_directory_details
set personal_email = 'personal-only@example.test'
where person_id = '73000000-0000-4000-8000-000000000002';

select pg_temp.assert(
  exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = '73000000-0000-4000-8000-000000000002'
      and reminder.milestone = '5_month'
      and reminder.reminder_sequence = 'initial'
      and reminder.delivery_status = 'scheduled'
      and reminder.needs_review_reason is null
  ),
  'adding a personal-only email recovers a context-blocked Check-In reminder'
);

select '2-Week, 1-Month, 2-Month, 3-Month and 5-Month Check-In Calendar and Tasks scope passed' as result;
