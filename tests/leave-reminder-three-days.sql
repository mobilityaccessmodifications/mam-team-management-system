-- Synthetic integration test. Run only against the isolated schema test database.
\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^priority_v[0-9]+$', 'Never run fixtures in production'; end$$;
begin;
\ir sql-test-auth.sql
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
values ('10000000-0000-4000-8000-000000000001','Test Admin','system_admin','testadmin',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000002','Test Manager','manager','testmanager',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000003','Test Employee','employee','testemployee',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000004','Test Outsider','manager','testoutsider',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Test role',id,case when app_role='employee' then '10000000-0000-4000-8000-000000000002'::uuid else null end from public.profiles;
insert into private.employee_directory_details(person_id,first_name,last_name,work_email,employment_type)
select id,'Test','Employee',login_name||'@example.test','full_time' from public.profiles;
do $$begin
  assert (select count(*)=1 from private.leave_approval_grants
    where reviewer_user_id='10000000-0000-4000-8000-000000000002'
      and scope_kind='subtree'
      and scope_root_person_id='10000000-0000-4000-8000-000000000002'
      and revoked_at is null), 'Manager fixture receives one automatic subtree approval grant';
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
do $$begin
  assert private.can_submit_team_leave('10000000-0000-4000-8000-000000000003');
  assert not private.can_submit_team_leave('10000000-0000-4000-8000-000000000004');
end$$;
select * from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000003','Sick leave','2026-10-09','2026-10-12',null,null,'Synthetic test');

do $$
declare definition text; request_id uuid; result_count integer;
begin
 select id into strict request_id from public.leave_requests;
 update public.leave_requests set submitted_at=timestamptz '2030-09-06 10:00:00+10' where id=request_id;
 select pg_get_functiondef('public.claim_leave_priority_reminders(integer)'::regprocedure) into definition;
 execute replace(definition, 'now() at time zone ''Australia/Melbourne''', 'timestamp ''2030-09-10 08:00:00''');
 -- Existing two-day queue rows also must not bypass the new threshold.
 insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
 values('leave-reminder',request_id,date '2030-09-10');
 select count(*) into result_count from public.claim_leave_priority_reminders(100);
 assert result_count=0, 'Two business days must not send';
 assert (select claim_token is null from private.leave_priority_reminder_deliveries where source_id=request_id);
 execute replace(definition, 'now() at time zone ''Australia/Melbourne''', 'timestamp ''2030-09-11 07:00:00''');
 assert (select count(*)=0 from public.claim_leave_priority_reminders(100)), 'No leave reminders at 07:00';
 execute replace(definition, 'now() at time zone ''Australia/Melbourne''', 'timestamp ''2030-09-11 08:00:00''');
 assert (select count(*)=1 from public.claim_leave_priority_reminders(100)), 'Three business days sends at 08:00';
 assert (select count(*)=0 from public.claim_leave_priority_reminders(100)), 'Active lease must deduplicate';
end $$;
rollback;
