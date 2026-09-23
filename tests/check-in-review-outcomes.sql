create function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_message; end if;
end;
$$;

insert into auth.users (id) values
  ('74000000-0000-4000-8000-000000000001'),
  ('74000000-0000-4000-8000-000000000002'),
  ('74000000-0000-4000-8000-000000000003'),
  ('74000000-0000-4000-8000-000000000004');

insert into public.profiles (
  id, full_name, app_role, account_status, login_name, credentials_valid_after
) values
  ('74000000-0000-4000-8000-000000000001', 'Outcome Manager', 'manager', 'active', 'outcome.manager@example.test', '-infinity'),
  ('74000000-0000-4000-8000-000000000002', 'Outcome Employee', 'employee', 'active', 'outcome.employee@example.test', '-infinity'),
  ('74000000-0000-4000-8000-000000000003', 'Outside Manager', 'manager', 'active', 'outside.manager@example.test', '-infinity'),
  ('74000000-0000-4000-8000-000000000004', 'Outcome Admin', 'system_admin', 'active', 'outcome.admin@example.test', '-infinity');

insert into public.internal_org_people (
  id, auth_user_id, parent_id, node_kind, is_active, full_name, position_title, company_key, started_date
) values
  ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', null,
   'person', true, 'Outcome Manager', 'Team Leader', 'mam', null),
  ('75000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000002',
   '75000000-0000-4000-8000-000000000001', 'person', true, 'Outcome Employee', 'Coordinator', 'mam', null),
  ('75000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000003', null,
   'person', true, 'Outside Manager', 'Team Leader', 'mam', null),
  ('75000000-0000-4000-8000-000000000004', '74000000-0000-4000-8000-000000000004', null,
   'person', true, 'Outcome Admin', 'System Administrator', 'mam', null);

insert into private.employee_check_in_reminders (
  id, person_id, milestone, reminder_sequence, due_date, notify_date, delivery_status
) values
  ('76000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000002', '5_month', 'initial',
   (clock_timestamp() at time zone 'Australia/Melbourne')::date - 1,
   (clock_timestamp() at time zone 'Australia/Melbourne')::date - 8, 'delivered'),
  ('76000000-0000-4000-8000-000000000002', '75000000-0000-4000-8000-000000000002', '5_month', 'final',
   (clock_timestamp() at time zone 'Australia/Melbourne')::date - 1,
   (clock_timestamp() at time zone 'Australia/Melbourne')::date - 3, 'scheduled'),
  ('76000000-0000-4000-8000-000000000003', '75000000-0000-4000-8000-000000000002', '3_month', 'initial',
   (clock_timestamp() at time zone 'Australia/Melbourne')::date + 1,
   (clock_timestamp() at time zone 'Australia/Melbourne')::date - 4, 'delivered');

select pg_temp.assert(
  not has_table_privilege('authenticated', 'private.employee_check_in_reviews', 'select')
  and not has_table_privilege('authenticated', 'private.employee_check_in_reviews', 'insert')
  and has_function_privilege('authenticated', 'public.record_employee_check_in_review(uuid,text,date,text,bigint)', 'execute'),
  'reviews are reachable only through the scoped RPC'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000003', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
do $$
begin
  perform public.record_employee_check_in_review(
    '76000000-0000-4000-8000-000000000001', 'on_track',
    (clock_timestamp() at time zone 'Australia/Melbourne')::date, '', null
  );
  raise exception 'Out-of-scope manager unexpectedly recorded an outcome';
exception when insufficient_privilege then null;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000002', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
do $$
begin
  perform public.record_employee_check_in_review(
    '76000000-0000-4000-8000-000000000001', 'on_track',
    (clock_timestamp() at time zone 'Australia/Melbourne')::date, '', null
  );
  raise exception 'Employee unexpectedly recorded their own outcome';
exception when insufficient_privilege then null;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000002',
  'follow_up_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Schedule a refresher with the employee.',
  null
);
select pg_temp.assert(
  exists (
    select 1
    from public.list_employee_check_in_workspace() workspace
    cross join lateral jsonb_array_elements(workspace.reminders) reminder
    where workspace.person_id = '75000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '5_month'
      and reminder ->> 'reviewOutcome' = 'follow_up_required'
      and reminder ->> 'reviewNotes' = 'Schedule a refresher with the employee.'
      and (reminder ->> 'reviewVersion')::integer = 1
  ),
  'direct manager sees the saved outcome in the scoped workspace'
);

select pg_temp.assert(
  (select count(*) = 1 and max(version) = 1
   from public.record_employee_check_in_review(
     '76000000-0000-4000-8000-000000000001',
     'follow_up_required',
     (clock_timestamp() at time zone 'Australia/Melbourne')::date,
     'Schedule a refresher with the employee.',
     null
   )),
  'an identical retry is idempotent even when the first response was lost'
);

do $$
begin
  perform public.record_employee_check_in_review(
    '76000000-0000-4000-8000-000000000001', 'hr_review_required',
    (clock_timestamp() at time zone 'Australia/Melbourne')::date,
    'This stale change must not be stored.', 9
  );
  raise exception 'A stale review edit unexpectedly succeeded';
exception when serialization_failure then null;
end;
$$;
select pg_temp.assert(
  exists (
    select 1
    from public.list_employee_check_in_workspace() workspace
    cross join lateral jsonb_array_elements(workspace.reminders) reminder
    where workspace.person_id = '75000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '5_month'
      and reminder ->> 'reviewOutcome' = 'follow_up_required'
      and (reminder ->> 'reviewVersion')::integer = 1
  ),
  'a stale edit rolls back without changing the review'
);

do $$
begin
  perform public.record_employee_check_in_review(
    '76000000-0000-4000-8000-000000000003', 'on_track',
    (clock_timestamp() at time zone 'Australia/Melbourne')::date, '', null
  );
  raise exception 'Future Check-in unexpectedly accepted an outcome';
exception when invalid_parameter_value then null;
end;
$$;

select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'hr_review_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Attendance concern needs People and Culture review.',
  1
);
reset role;

update auth.users
set raw_app_meta_data = '{"org_role":"system_admin"}'::jsonb
where id = '74000000-0000-4000-8000-000000000003';
insert into private.employee_check_in_access_grants (reviewer_user_id, scope_kind)
values ('74000000-0000-4000-8000-000000000003', 'global');

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000004', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select pg_temp.assert(
  (select count(*) = 1
   from public.list_employee_check_in_workspace_for_preview('75000000-0000-4000-8000-000000000001') preview
   where preview.person_id = '75000000-0000-4000-8000-000000000002'),
  'manager preview contains only its active reporting subtree'
);
select pg_temp.assert(
  (select count(*) = 0
   from public.list_employee_check_in_workspace_for_preview('75000000-0000-4000-8000-000000000002')),
  'employee preview has no Check-in review workspace'
);
select pg_temp.assert(
  (select count(*) = 0
   from public.list_employee_check_in_workspace_for_preview('75000000-0000-4000-8000-000000000003')),
  'legacy Auth metadata and a stale global grant cannot widen manager preview scope'
);
select pg_temp.assert(
  (select count(distinct preview.person_id) = 4
   from public.list_employee_check_in_workspace_for_preview('75000000-0000-4000-8000-000000000004') preview
   where preview.person_id in (
     '75000000-0000-4000-8000-000000000001',
     '75000000-0000-4000-8000-000000000002',
     '75000000-0000-4000-8000-000000000003',
     '75000000-0000-4000-8000-000000000004'
   )),
  'active System Admin preview retains global scope'
);
reset role;

select pg_temp.assert(
  (select count(*) = 1 from private.employee_check_in_reviews review
   where review.reminder_id = '76000000-0000-4000-8000-000000000001'
     and review.outcome_code = 'hr_review_required'
     and review.version = 2),
  'initial and final reminders share one versioned review'
);
select pg_temp.assert(
  (select count(*) = 2 from private.employee_check_in_reminders reminder
   where reminder.person_id = '75000000-0000-4000-8000-000000000002'
     and reminder.milestone = '5_month'
     and reminder.delivery_status = 'completed'),
  'recording an outcome completes the full reminder milestone group'
);
select pg_temp.assert(
  (select count(*) = 2 from private.employee_check_in_reminder_events event
   where event.reminder_id in (
     '76000000-0000-4000-8000-000000000001',
     '76000000-0000-4000-8000-000000000002'
   ) and event.event_type = 'completed'),
  'only transitioned reminder rows receive completion events'
);

select 'Check-in review outcome scope, grouping, projection and optimistic edits passed' as result;
