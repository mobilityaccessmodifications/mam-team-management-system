create function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_message; end if;
end;
$$;

create function pg_temp.review_notification_count(
  p_status text default null,
  p_transition_version bigint default null
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)
  from private.employee_check_in_review_notifications notification
  where (p_status is null or notification.status = p_status)
    and (p_transition_version is null or notification.transition_version = p_transition_version);
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
  ('76000000-0000-4000-8000-000000000003', '75000000-0000-4000-8000-000000000002', '3_month', 'initial',
   (clock_timestamp() at time zone 'Australia/Melbourne')::date + 1,
   (clock_timestamp() at time zone 'Australia/Melbourne')::date - 4, 'delivered');

select pg_temp.assert(
  not has_table_privilege('authenticated', 'private.employee_check_in_reviews', 'select')
  and not has_table_privilege('authenticated', 'private.employee_check_in_reviews', 'insert')
  and has_function_privilege('authenticated', 'public.record_employee_check_in_review(uuid,text,date,text,bigint)', 'execute'),
  'reviews are reachable only through the scoped RPC'
);
select pg_temp.assert(
  not has_table_privilege('authenticated', 'private.employee_check_in_review_notifications', 'select')
  and not has_table_privilege('service_role', 'private.employee_check_in_review_notifications', 'select')
  and not has_function_privilege('authenticated', 'public.claim_due_employee_check_in_review_notifications(integer)', 'execute')
  and has_function_privilege('service_role', 'public.claim_due_employee_check_in_review_notifications(integer)', 'execute')
  and has_function_privilege('service_role', 'public.prepare_employee_check_in_review_notification_delivery(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.complete_employee_check_in_review_notification_delivery(uuid,uuid,text)', 'execute')
  and has_function_privilege('service_role', 'public.fail_employee_check_in_review_notification_delivery(uuid,uuid,text)', 'execute'),
  'People and Culture alerts are reachable only through service worker RPCs'
);
select pg_temp.assert(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'employee_check_in_review_notifications'
      and column_name in ('recipient', 'email', 'employee_name', 'manager_name', 'notes', 'body')
  ),
  'the durable alert outbox stores no recipient, message body or review notes'
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

insert into private.employee_check_in_reminders (
  id, person_id, milestone, reminder_sequence, due_date, notify_date,
  delivery_status, claim_token, claimed_at
) values (
  '76000000-0000-4000-8000-000000000002',
  '75000000-0000-4000-8000-000000000002',
  '5_month',
  'final',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date - 1,
  (clock_timestamp() at time zone 'Australia/Melbourne')::date - 4,
  'claimed',
  '76000000-0000-4000-8000-000000000099',
  clock_timestamp()
);

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
do $$
begin
  perform public.record_employee_check_in_review(
    '76000000-0000-4000-8000-000000000001', 'follow_up_required',
    (clock_timestamp() at time zone 'Australia/Melbourne')::date,
    'This must wait for the in-flight sibling.', null
  );
  raise exception 'A review unexpectedly completed while a legacy final reminder was claimed';
exception when object_not_in_prerequisite_state then null;
end;
$$;
reset role;

update private.employee_check_in_reminders
set delivery_status = 'superseded',
    claim_token = null,
    claimed_at = null
where id = '76000000-0000-4000-8000-000000000002';

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
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
select pg_temp.assert(
  pg_temp.review_notification_count() = 0,
  'a non-HR outcome does not queue a People and Culture alert'
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
select pg_temp.assert(
  pg_temp.review_notification_count() = 0,
  'a rejected stale HR edit does not queue an alert'
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
select pg_temp.assert(
  pg_temp.review_notification_count() = 1
  and pg_temp.review_notification_count('scheduled', 2) = 1,
  'entering the HR pathway transactionally queues one alert'
);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'hr_review_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Updated People and Culture notes.',
  2
);
select pg_temp.assert(
  pg_temp.review_notification_count() = 1
  and pg_temp.review_notification_count('scheduled', 2) = 1,
  'editing notes within the HR pathway preserves the original pending alert'
);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'follow_up_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Continue manager follow-up.',
  3
);
select pg_temp.assert(
  pg_temp.review_notification_count() = 1
  and pg_temp.review_notification_count('cancelled', 2) = 1,
  'leaving the HR pathway cancels its pending alert'
);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'hr_review_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Final People and Culture review notes.',
  4
);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'hr_review_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Final People and Culture review notes.',
  null
);
select pg_temp.assert(
  pg_temp.review_notification_count() = 2
  and pg_temp.review_notification_count('cancelled', 2) = 1
  and pg_temp.review_notification_count('scheduled', 5) = 1,
  're-entering the HR pathway queues one new version and an exact retry stays idempotent'
);
reset role;

update private.employee_check_in_review_notifications
set status = 'needs_review',
    failure_count = 8,
    last_error_code = 'retry_exhausted'
where transition_version = 5;

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'follow_up_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Manager follow-up replaces the exhausted HR alert.',
  5
);
select pg_temp.assert(
  pg_temp.review_notification_count('cancelled', 5) = 1,
  'leaving the HR pathway cancels an exhausted unsent alert'
);
select * from public.record_employee_check_in_review(
  '76000000-0000-4000-8000-000000000001',
  'hr_review_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Final People and Culture delivery notes.',
  6
);
reset role;

create temporary table claimed_review_notifications as
select * from public.claim_due_employee_check_in_review_notifications(10);
create temporary table prepared_review_notifications as
select prepared.*
from claimed_review_notifications claimed
cross join lateral public.prepare_employee_check_in_review_notification_delivery(
  claimed.notification_id,
  claimed.claim_token
) prepared;

select pg_temp.assert(
  (select count(*) = 1
   and max(review_version) = 7
   and max(employee_name) = 'Outcome Employee'
   and max(manager_name) = 'Outcome Manager'
   and max(milestone) = '5_month'
   and max(notes) = 'Final People and Culture delivery notes.'
   from prepared_review_notifications),
  'the claimed alert resolves current review context without exposing a recipient'
);
select pg_temp.assert(
  (select not public.complete_employee_check_in_review_notification_delivery(
    notification_id,
    gen_random_uuid(),
    'checkin-review:wrong'
  ) from claimed_review_notifications),
  'a wrong claim token cannot acknowledge the alert'
);
select pg_temp.assert(
  (select not public.fail_employee_check_in_review_notification_delivery(
    notification_id,
    gen_random_uuid(),
    'network_error'
  ) from claimed_review_notifications),
  'a wrong claim token cannot release the alert'
);
select pg_temp.assert(
  (select public.complete_employee_check_in_review_notification_delivery(
    notification_id,
    claim_token,
    'checkin-review:accepted'
  ) from claimed_review_notifications),
  'the matching claim token completes the alert'
);

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
     and review.version = 7),
  'the canonical reminder retains one versioned review'
);
select pg_temp.assert(
  (select count(*) = 1 from private.employee_check_in_reminders reminder
   where reminder.person_id = '75000000-0000-4000-8000-000000000002'
     and reminder.milestone = '5_month'
     and reminder.delivery_status = 'completed'),
  'recording an outcome completes the single 5-Month reminder'
);
select pg_temp.assert(
  (select count(*) = 1 from private.employee_check_in_reminder_events event
   where event.reminder_id = '76000000-0000-4000-8000-000000000001'
     and event.event_type = 'completed'),
  'only transitioned reminder rows receive completion events'
);

select 'Check-in review outcome scope, grouping, projection and optimistic edits passed' as result;
