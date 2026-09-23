-- Real effective-schema regressions. Requires the complete ordered replay.
\set ON_ERROR_STOP on
do $$ begin
  assert current_database() ~ '^mam_test_', 'Synthetic database only';
  assert inet_server_addr() is null and current_setting('listen_addresses') = '';
end $$;
begin;
set local statement_timeout = '5s';
\ir sql-test-auth.sql

insert into auth.users(id,email,email_confirmed_at) select
  ('10000000-0000-4000-8000-00000000000'||n)::uuid,'core'||n||'@example.test',now()
from generate_series(1,6) n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('10000000-0000-4000-8000-000000000001','Synthetic Admin','system_admin','coreadmin',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000002','Synthetic Ancestor','manager','coreancestor',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000003','Synthetic Manager','manager','coremanager',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000004','Synthetic Employee','employee','coreemployee',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000005','Synthetic Other Manager','manager','coreothermanager',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000006','Synthetic Other Employee','employee','coreotheremployee',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,full_name,'mam','Synthetic role',id from public.profiles where login_name in ('coreadmin','coreancestor','coreothermanager');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Synthetic role',id,'10000000-0000-4000-8000-000000000002'
from public.profiles where login_name='coremanager';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Synthetic role',id,
  case when login_name='coreemployee' then '10000000-0000-4000-8000-000000000003'::uuid
    else '10000000-0000-4000-8000-000000000005'::uuid end
from public.profiles where login_name in ('coreemployee','coreotheremployee');
insert into private.employee_directory_details(person_id,employment_type,work_email,first_name,last_name,team_name)
select id,'full_time',login_name||'@example.test','Synthetic','Person',case when login_name='coreotheremployee' then 'Minor' else 'Major' end from public.profiles;
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
values ('10000000-0000-4000-8000-000000000001','global','Synthetic Admin',100);
insert into private.manager_leave_reviewers values ('10000000-0000-4000-8000-000000000001',1);
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
create temp table core_request as select id from public.submit_my_leave_request('Unpaid leave','2030-12-09','2030-12-13');
do $$ declare r uuid:=(select id from core_request); begin
  assert (select count(*)=2 from private.leave_request_reviewer_assignments where leave_request_id=r), 'Nearest manager plus global only';
  assert private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000003');
  assert private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000001');
  assert not private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000002');
  -- Even an old snapshot cannot authorize an upstream manager today.
  insert into private.leave_request_reviewer_assignments(leave_request_id,reviewer_user_id,source_grant_id,assignment_kind,reviewer_label,is_primary)
  select r,g.reviewer_user_id,g.id,'subtree',g.reviewer_label,false from private.leave_approval_grants g
  where g.reviewer_user_id='10000000-0000-4000-8000-000000000002' and g.revoked_at is null;
  assert not private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000002'), 'Stale ancestor snapshot is denied';
  assert not private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000004'), 'No self approval';
end $$;

-- Manager-owned requests keep the configured group, not the reporting chain;
-- the selected-person delegation patch also survives the date guard update.
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000003');
create temp table delegated_request as select id from public.submit_selected_employee_leave_request(
  '10000000-0000-4000-8000-000000000004','Unpaid leave','2032-12-06','2032-12-10');
create temp table manager_request as select id from public.submit_my_leave_request('Unpaid leave','2031-12-08','2031-12-12');
do $$ begin
  assert (select count(*)=1 from private.leave_request_reviewer_assignments where leave_request_id=(select id from manager_request));
  assert private.is_current_leave_request_reviewer((select id from manager_request),'10000000-0000-4000-8000-000000000001');
  assert not private.is_current_leave_request_reviewer((select id from manager_request),'10000000-0000-4000-8000-000000000002');
  assert (select submitted_by='10000000-0000-4000-8000-000000000003'::uuid from public.leave_requests where id=(select id from delegated_request));
end $$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');

-- Real RPC entry points reject before unbounded duration calculation, even
-- when the caller bypasses the form and Server Action.
do $$ declare signature text; start_date date; end_date date; begin
  perform private.assert_leave_date_range('2028-01-01','2028-12-31');
  perform private.assert_leave_date_range('2026-01-01','2027-01-01');
  for start_date,end_date in values
    (date '2028-01-01',date '2029-01-01'),
    (date '0001-01-01',date '9999-12-31'),
    (date '-infinity',date 'infinity'),
    (date '2026-01-02',date '2026-01-01')
  loop
    begin
      perform public.submit_my_leave_request('Unpaid leave',start_date,end_date);
      raise exception 'Self-service accepted invalid span' using errcode='ZX001';
    exception when invalid_parameter_value then null; end;
    begin
      perform private.openclaw_submit_self('10000000-0000-4000-8000-000000000004','Unpaid leave',start_date,end_date);
      raise exception 'Bridge accepted invalid span' using errcode='ZX001';
    exception when invalid_parameter_value then null; end;
    perform pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
    begin
      perform public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000004','Unpaid leave',start_date,end_date);
      raise exception 'Selected-person accepted invalid span' using errcode='ZX001';
    exception when invalid_parameter_value then null; end;
    perform pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
  end loop;
  assert not has_function_privilege('authenticated','private.assert_leave_date_range(date,date)','execute');
end $$;

-- Exercise the old public work-email RPC under the actual authenticated role.
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin
  assert (select work_email='coreemployee@example.test' from public.get_internal_org_work_email('10000000-0000-4000-8000-000000000004'));
  assert (select count(*)=0 from public.get_internal_org_work_email('10000000-0000-4000-8000-000000000006')), 'Other-team email must remain private';
end $$;
reset role;

-- Find a real canonical notification window around today's Melbourne date.
-- No replacement scheduling/context/authorization functions are installed.
do $$ declare
  person constant uuid := '10000000-0000-4000-8000-000000000004';
  today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
  start_date date; reminder_id uuid; reason text;
begin
  select day::date into strict start_date
  from generate_series(today-25,today-1,interval '1 day') day
  cross join lateral private.employee_check_in_schedule(day::date) schedule
  where schedule.milestone='2_week' and schedule.notify_date<today and schedule.due_date>=today
  order by day desc limit 1;
  update public.internal_org_people set started_date=start_date where id=person;
  select id into strict reminder_id from private.employee_check_in_reminders
    where person_id=person and milestone='2_week' and delivery_status not in ('superseded','cancelled');
  foreach reason in array array['not_enrolled','missing_manager_email','context_changed'] loop
    update private.employee_check_in_reminders set delivery_status='needs_review',needs_review_reason=reason where id=reminder_id;
    perform private.sync_employee_check_in_reminders(person);
    assert (select delivery_status='scheduled' and needs_review_reason is null from private.employee_check_in_reminders where id=reminder_id), 'Repaired context must recover through due date';
  end loop;
  update private.employee_check_in_reminders set delivery_status='needs_review',needs_review_reason='historic_cutover' where id=reminder_id;
  perform private.sync_employee_check_in_reminders(person);
  assert (select delivery_status='needs_review' and needs_review_reason='historic_cutover' from private.employee_check_in_reminders where id=reminder_id), 'No automatic historic replay';
  update private.employee_directory_details set first_name=null where person_id=person;
  update private.employee_check_in_reminders set delivery_status='needs_review',needs_review_reason='context_changed' where id=reminder_id;
  perform private.sync_employee_check_in_reminders(person);
  assert (select delivery_status='needs_review' from private.employee_check_in_reminders where id=reminder_id), 'Incomplete context must stay blocked';
  update private.employee_directory_details set first_name='Synthetic' where person_id=person;
  -- Old canonical milestones retain the review state even after repair.
  update public.internal_org_people set started_date=today-40 where id=person;
  update private.employee_check_in_reminders set delivery_status='needs_review',needs_review_reason='missing_manager_email'
    where person_id=person and milestone='2_week' and delivery_status not in ('superseded','cancelled');
  perform private.sync_employee_check_in_reminders(person);
  assert exists(select 1 from private.employee_check_in_reminders where person_id=person and milestone='2_week'
    and due_date<today and delivery_status='needs_review' and needs_review_reason='missing_manager_email'), 'Past-due work requires explicit review';
end $$;
rollback;
