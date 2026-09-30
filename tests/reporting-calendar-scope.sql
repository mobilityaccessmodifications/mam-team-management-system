\set ON_ERROR_STOP on
begin;
set local statement_timeout = '15s';
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at)
select ('92000000-0000-4000-8000-00000000000'||n)::uuid,'scope'||n||'@example.test',now() from generate_series(1,7)n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select id,'Synthetic '||n,case when n=1 then 'system_admin' when n=2 then 'manager' else 'employee' end,'scope'||n,now()-interval '1 day'
from generate_series(1,7)n cross join lateral (select ('92000000-0000-4000-8000-00000000000'||n)::uuid as id) x;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,full_name,case when login_name='scope6' then 'equipsy' else 'mam' end,'Synthetic position',id from public.profiles where login_name like 'scope%';
insert into private.employee_directory_details(person_id,employment_type,first_name,last_name,team_name,work_email)
select id,'full_time','Synthetic','Person',case when login_name='scope3' then 'Management' else 'Major' end,login_name||'@example.test'
from public.profiles where login_name like 'scope%';
update public.internal_org_people set parent_id='92000000-0000-4000-8000-000000000002'
where id in ('92000000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000004','92000000-0000-4000-8000-000000000006');
update public.internal_org_people set parent_id='92000000-0000-4000-8000-000000000004'
where id='92000000-0000-4000-8000-000000000005';
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
values ('92000000-0000-4000-8000-000000000001','global','Synthetic Admin',100);
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,business_days,status,submitted_at,reason)
select ('93000000-0000-4000-8000-00000000000'||n)::uuid,
 ('92000000-0000-4000-8000-00000000000'||n)::uuid,
 ('92000000-0000-4000-8000-00000000000'||n)::uuid,
 'unpaid','Unpaid leave',date '2030-12-09',date '2030-12-09',1,
 case when n=3 then 'submitted' else 'approved' end,now(),'Private synthetic reason'
from generate_series(3,7)n;
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,business_days,status,submitted_at,reason)
values ('93000000-0000-4000-8000-000000000008','92000000-0000-4000-8000-000000000006',
  '92000000-0000-4000-8000-000000000006','unpaid','Unpaid leave',date '2030-12-10',date '2030-12-10',1,
  'submitted',now(),'Private synthetic reason');
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
 assert (select count(*)=3 from public.list_leave_calendar_entries_with_teams()), 'Employee sees own submitted and approved peers under same nearest manager';
 assert (select count(*)=1 from public.list_leave_calendar_entries_with_teams() where person_id='92000000-0000-4000-8000-000000000004' and status='Approved' and leave_type_label='Approved leave'), 'Peer category minimised';
 assert exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='92000000-0000-4000-8000-000000000005' and leave_type_label='Approved leave'), 'Non-manager intermediary does not change nearest manager';
 assert not exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id in ('92000000-0000-4000-8000-000000000006','92000000-0000-4000-8000-000000000007')), 'No cross-company or unrelated leave';
 assert not exists(select 1 from jsonb_object_keys((select to_jsonb(entry) from public.list_leave_calendar_entries_with_teams() entry limit 1)) key where key in ('reason','notes','evidence')), 'No private reason projection';
end$$;
reset role;
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$begin
 assert (select count(*)=6 from public.list_leave_calendar_entries_with_teams()), 'Manager retains all-company approved and cross-company descendant pending';
 assert exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='92000000-0000-4000-8000-000000000003' and status='Pending'), 'Manager sees submitted descendant';
 assert exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='92000000-0000-4000-8000-000000000007' and status='Approved'), 'Manager sees unrelated same-company approved';
 assert (select count(*)=2 from public.list_leave_calendar_entries_with_teams() where person_id='92000000-0000-4000-8000-000000000006'), 'Manager retains cross-company approved and submitted reporting rows';
end$$;
reset role;
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$begin
 assert (select count(*)=6 from public.list_leave_calendar_entries_with_teams_for_preview('92000000-0000-4000-8000-000000000002')), 'Manager preview matches actual cross-company scope';
 assert (select count(*)=3 from public.list_leave_calendar_entries_with_teams_for_preview('92000000-0000-4000-8000-000000000003')), 'Employee preview matches actual peer scope';
end$$;
reset role;
update public.profiles set app_role='employee' where id='92000000-0000-4000-8000-000000000002';
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
 assert (select count(*)=1 from public.list_leave_calendar_entries()), 'Removing manager role removes peer grouping';
end$$;
reset role;
update public.profiles set app_role='manager' where id='92000000-0000-4000-8000-000000000002';
update public.internal_org_people set parent_id='92000000-0000-4000-8000-000000000001' where id in ('92000000-0000-4000-8000-000000000005','92000000-0000-4000-8000-000000000007');
do $$begin
 assert (select count(*)=0 from private.employee_calendar_peer_ids('92000000-0000-4000-8000-000000000007')), 'System Admin alone is not a peer-group manager';
end$$;
update public.internal_org_people set parent_id=null where id='92000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
 assert (select count(*)=1 from public.list_leave_calendar_entries()), 'Peer reporting reassignment immediately removes approved visibility';
end$$;
reset role;
rollback;
