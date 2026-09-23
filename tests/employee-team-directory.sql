\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at)
select ('91000000-0000-4000-8000-00000000000'||n)::uuid,'team'||n||'@example.test',now() from generate_series(1,6)n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select id,'Synthetic '||n,case n when 1 then 'system_admin' when 2 then 'manager' else 'employee' end,'directoryteam'||n,now()-interval '1 day'
from generate_series(1,6)n cross join lateral (select ('91000000-0000-4000-8000-00000000000'||n)::uuid as id) x;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,full_name,case when login_name='directoryteam6' then 'equipsy' else 'mam' end,'Synthetic position',id from public.profiles where login_name like 'directoryteam%';
update public.internal_org_people set parent_id='91000000-0000-4000-8000-000000000002' where id in ('91000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000005');
insert into private.employee_directory_details(person_id,first_name,team_name,work_email)
select id,'Synthetic',case when login_name in ('directoryteam2','directoryteam5') then 'Minor' else 'Major' end,login_name||'@example.test' from public.profiles where login_name like 'directoryteam%';
select pg_temp.set_test_actor('91000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
  assert (select count(*)=3 from public.list_employee_team_directory()), 'Same-team peers regardless of hierarchy';
  assert (select count(*)=3 from public.internal_org_people where id::text like '91000000%'), 'Direct RLS matches team';
  assert (select count(*)=0 from public.get_internal_org_work_email('91000000-0000-4000-8000-000000000005')), 'Shared manager must not grant cross-team email';
  assert (select count(*)=1 from public.get_internal_org_work_email('91000000-0000-4000-8000-000000000004')), 'Different manager same team is visible';
  begin
    perform * from public.list_employee_team_directory('91000000-0000-4000-8000-000000000005');
    raise exception 'Employee preview was accepted';
  exception when insufficient_privilege then null;end;
end$$;
reset role;
insert into private.approved_leave_calendar_grants(person_id) values('91000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
 assert (select count(*)=3 from public.list_employee_team_directory()), 'Payroll grant must not widen Directory';
end$$;
reset role;
select pg_temp.set_test_actor('91000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$begin
 assert (select count(*)=3 from public.list_employee_team_directory('91000000-0000-4000-8000-000000000003')), 'Admin preview matches employee';
end$$;
reset role;
select pg_temp.set_test_actor('91000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$begin
 assert (select count(*)=6 from public.internal_org_people where id::text like '91000000%'), 'Manager visibility preserved';
end$$;
reset role;
update private.employee_directory_details set team_name='Minor' where person_id='91000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('91000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
 assert (select count(*)=2 from public.list_employee_team_directory()), 'Reassignment immediately removes old peer';
end$$;
reset role;
update private.employee_directory_details set team_name=null where person_id='91000000-0000-4000-8000-000000000003';
set local role authenticated;
do $$begin
 assert (select count(*)=1 from public.list_employee_team_directory()), 'Unknown team exposes self only';
end$$;
reset role;
update public.profiles set account_status='disabled',disabled_at=now() where id='91000000-0000-4000-8000-000000000003';
set local role authenticated;
do $$begin
 begin
  perform * from public.list_employee_team_directory();raise exception 'Disabled account accepted';
 exception when insufficient_privilege then null;end;
end$$;
reset role;
rollback;
