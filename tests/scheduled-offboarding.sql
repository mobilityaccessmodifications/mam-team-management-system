\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) select ('92000000-0000-4000-8000-00000000000'||n)::uuid,'exit'||n||'@example.test',now() from generate_series(1,5)n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select id,'Synthetic '||n,case when n=1 then 'system_admin' else 'employee' end,'exit'||n,now()-interval '1 day'
from generate_series(1,5)n cross join lateral (select ('92000000-0000-4000-8000-00000000000'||n)::uuid id)x;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,full_name,'mam','Synthetic role',id from public.profiles where login_name like 'exit%';
insert into private.employee_directory_details(person_id,first_name,scheduled_employment_end_date)
select id,'Synthetic',case when login_name='exit3' then date '2020-01-03' end from public.profiles where login_name like 'exit%';
create temp table offboarding_versions as select person.version person_version,detail.version detail_version from public.internal_org_people person join private.employee_directory_details detail on detail.person_id=person.id where person.id='92000000-0000-4000-8000-000000000002';
grant select on offboarding_versions to authenticated;
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
 begin
  perform public.schedule_employee_offboarding('92000000-0000-4000-8000-000000000001',
    (select version from public.internal_org_people where id='92000000-0000-4000-8000-000000000001'), 1, '2099-01-09','Resigned');
  raise exception 'Self-offboarding accepted' using errcode='ZX001';
 exception when insufficient_privilege then null; end;
end $$;
select public.schedule_employee_offboarding('92000000-0000-4000-8000-000000000002', (select person_version from offboarding_versions), (select detail_version from offboarding_versions), '2099-01-09', 'Resigned');
reset role;
do $$ begin
 assert (select is_active from public.internal_org_people where id='92000000-0000-4000-8000-000000000002'), 'Future exit must stay active';
 assert (select account_status='active' from public.profiles where id='92000000-0000-4000-8000-000000000002'), 'Future login must stay active';
 assert (select count(*)=1 from private.scheduled_employee_offboarding where person_id='92000000-0000-4000-8000-000000000002'), 'Explicit schedule marker';
 assert (select count(*)=0 from private.scheduled_employee_offboarding where person_id='92000000-0000-4000-8000-000000000003'), 'Historical overdue date not enrolled';
 assert not has_function_privilege('authenticated','public.run_scheduled_employee_offboarding(uuid,timestamptz)','execute'), 'Cron only';
 assert not has_function_privilege('authenticated','public.list_scheduled_employee_offboarding()','execute'), 'Candidate list is private';
end $$;
update private.employee_directory_details set scheduled_employment_end_date='2099-01-10' where person_id='92000000-0000-4000-8000-000000000002';
do $$ begin
 assert (select end_date='2099-01-10' from private.scheduled_employee_offboarding where person_id='92000000-0000-4000-8000-000000000002'), 'HR date edit reschedules';
end $$;
update private.employee_directory_details set scheduled_employment_end_date='2099-01-09' where person_id='92000000-0000-4000-8000-000000000002';
update public.internal_org_people set parent_id='92000000-0000-4000-8000-000000000002' where id='92000000-0000-4000-8000-000000000004';
set local role service_role;
do $$ begin
 begin
  perform public.run_scheduled_employee_offboarding('92000000-0000-4000-8000-000000000002','2099-01-09 13:00:00+00');
  raise exception 'Active direct reports were ignored' using errcode='ZX001';
 exception when foreign_key_violation then null; end;
end $$;
reset role;
update public.internal_org_people set parent_id=null where id='92000000-0000-4000-8000-000000000004';
set local role service_role;
do $$ begin
 assert not public.run_scheduled_employee_offboarding('92000000-0000-4000-8000-000000000002','2099-01-09 12:59:59+00'), 'Friday 23:59:59 AEDT remains employed';
 assert public.run_scheduled_employee_offboarding('92000000-0000-4000-8000-000000000002','2099-01-09 13:00:00+00'), 'Saturday midnight AEDT closes employment';
 assert not public.run_scheduled_employee_offboarding('92000000-0000-4000-8000-000000000002','2099-01-09 13:00:00+00'), 'Repeated run is idempotent';
 assert not public.run_scheduled_employee_offboarding('92000000-0000-4000-8000-000000000003','2099-01-09 13:00:00+00'), 'Historical overdue is HR review only';
end $$;
reset role;
do $$ begin
 assert (select account_status='disabled' and disabled_at is not null from public.profiles where id='92000000-0000-4000-8000-000000000002'), 'Linked account disabled';
 assert (select not is_active from public.internal_org_people where id='92000000-0000-4000-8000-000000000002'), 'Archived';
 assert (select archive_reason='Resigned' from private.employee_directory_details where person_id='92000000-0000-4000-8000-000000000002'), 'Reason retained';
end $$;
update private.employee_directory_details set first_name='Edited synthetic' where person_id='92000000-0000-4000-8000-000000000002';
do $$ begin
 assert (select first_name='Edited synthetic' and archive_reason='Resigned' from private.employee_directory_details where person_id='92000000-0000-4000-8000-000000000002'), 'Archived HR details remain editable';
 assert (select account_status='disabled' from public.profiles where id='92000000-0000-4000-8000-000000000002'), 'Editing archived data never re-enables login';
end $$;
rollback;
