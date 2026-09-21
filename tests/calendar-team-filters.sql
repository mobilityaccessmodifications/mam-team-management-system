-- Preserve every pre-existing personal, payroll and reporting-team assertion first.
\ir manager-team-calendar.sql
create table private.employee_directory_details(person_id uuid primary key references public.internal_org_people(id), team_name text);
insert into private.employee_directory_details values
('20000000-0000-4000-8000-000000000002','Operations'),
('20000000-0000-4000-8000-000000000003','Operations'),
('20000000-0000-4000-8000-000000000005','Warehouse');
\ir ../supabase/migrations/20260921180000_calendar_team_filters.sql
update public.profiles set account_status='active' where login_name='alice';
update public.internal_org_people set company_key='equipsy' where id='20000000-0000-4000-8000-000000000005';
insert into public.leave_requests(id,employee_person_id,user_id,request_type_label,start_date,end_date,business_days,status)
values ('30000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005','Sick leave','2026-12-01','2026-12-01',1,'approved');
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert((select count(*)=6 and count(distinct id)=6 from public.list_leave_calendar_entries_with_teams()),'manager gets own/team plus cross-company approved without duplicates');
select pg_temp.assert((select count(*)=1 and bool_and(status='Approved' and leave_type_label='Approved leave' and team_name='Warehouse' and company_key='equipsy') from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000005'),'cross-team leave is approved-only with category minimised and canonical team');
select pg_temp.assert(not exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000006'),'manager cannot gain archived records');
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000003' and status='Pending'),'own reporting-team pending remains visible');
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000004' and team_name='Unassigned'),'missing team receives safe fallback');
-- The team projection contains no private reason, balance, notes or evidence fields.
select pg_temp.assert((select array_agg(key order by key)=array['business_days','company_key','employee_name','end_date','end_time','hours','id','leave_type_label','person_id','start_date','start_time','status','team_name'] from jsonb_object_keys((select to_jsonb(row) from public.list_leave_calendar_entries_with_teams() row limit 1)) key),'projection stays minimal');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
select pg_temp.assert((select count(*)=6 from public.list_leave_calendar_entries_with_teams_for_preview('20000000-0000-4000-8000-000000000002')),'admin manager preview matches real scope');
reset role;
update public.profiles set app_role='employee' where login_name='alice';
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert((select count(*)=2 and bool_and(person_id='20000000-0000-4000-8000-000000000002') from public.list_leave_calendar_entries_with_teams()),'ordinary employee sees only own leave after role removal');
do $$ begin
 perform * from public.list_leave_calendar_entries_with_teams_for_preview('20000000-0000-4000-8000-000000000005');
 raise exception 'employee must not preview another person';
exception when insufficient_privilege then null; end $$;
reset role;
update public.profiles set app_role='manager' where login_name='alice';
update public.internal_org_people set parent_id=null where full_name='Bob Example';
set role authenticated;
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000003' and status='Approved'),'reassigned team approved remains visible');
select pg_temp.assert(not exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000003' and status='Pending'),'reassigned team pending is immediately removed');
reset role;
-- A manager does not need reports to receive approved planning visibility.
update public.profiles set app_role='manager' where id='10000000-0000-4000-8000-000000000005';
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000005',false);
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000003' and status='Approved'),'manager without reports can see approved leave');
select pg_temp.assert(not exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id<>'20000000-0000-4000-8000-000000000005' and status='Pending'),'manager without reports cannot see unrelated pending');
reset role;
select pg_temp.assert(not has_function_privilege('authenticated','private.is_calendar_manager(uuid)','EXECUTE'),'private helper not exposed');
select pg_temp.assert(not has_function_privilege('anon','public.list_leave_calendar_entries_with_teams()','EXECUTE'),'anonymous cannot access calendar teams');
reset role;
update public.profiles set account_status='disabled' where id='10000000-0000-4000-8000-000000000005';
set role authenticated;
do $$ begin
 perform * from public.list_leave_calendar_entries_with_teams();
 raise exception 'disabled manager must be rejected';
exception when insufficient_privilege then null; end $$;
reset role;
