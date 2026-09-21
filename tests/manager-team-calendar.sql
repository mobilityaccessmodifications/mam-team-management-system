\ir personal-calendar-scope-bootstrap.sql
alter table public.internal_org_people add column parent_id uuid references public.internal_org_people(id);
\ir ../supabase/migrations/20260916130000_personal_calendar_scope.sql
\ir ../supabase/migrations/20260921160000_manager_team_leave_calendar.sql
-- Run the existing personal/payroll/privacy assertions against the new functions.
\ir personal-calendar-scope.sql

update public.profiles set app_role='manager' where login_name='alice';
insert into public.internal_org_people(id,node_kind,is_active,full_name,company_key,parent_id)
values ('20000000-0000-4000-8000-000000000010','org_unit',true,'Synthetic team','mam','20000000-0000-4000-8000-000000000002');
update public.internal_org_people set parent_id='20000000-0000-4000-8000-000000000010' where full_name='Bob Example';
update public.internal_org_people set parent_id='20000000-0000-4000-8000-000000000003' where full_name='Gerard Example';
-- Inactive reports must not become visible through manager scope.
update public.internal_org_people set parent_id='20000000-0000-4000-8000-000000000002' where full_name='Former Example';
insert into public.leave_requests(id,employee_person_id,user_id,request_type_label,start_date,end_date,business_days,status)
values ('30000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','Annual leave','2026-11-01','2026-11-01',1,'cancelled'),
('30000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005','Annual leave','2026-11-01','2026-11-01',1,'submitted');
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert((select count(*)=5 from public.list_leave_calendar_entries()),'manager sees own, nested through org unit, and indirect reports');
select pg_temp.assert((select count(*)=3 and bool_and(leave_type_label in ('Approved leave','Pending leave')) from public.list_leave_calendar_entries() where person_id <> '20000000-0000-4000-8000-000000000002'),'team labels do not expose categories');
select pg_temp.assert(not exists(select 1 from public.list_leave_calendar_entries() where person_id in ('20000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000006')),'unrelated and archived employee hidden');
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries() where employee_name='Bob Example' and hours=16 and start_time='10:00'),'team exact dates and duration retained');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
select pg_temp.assert((select count(*)=5 from public.list_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000002')),'admin preview matches manager scope');
reset role;
update public.profiles set app_role='employee' where login_name='alice';
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert((select count(*)=2 from public.list_leave_calendar_entries()),'role removal immediately removes team visibility');
reset role;
update public.profiles set app_role='manager' where login_name='alice';
-- Explicit payroll grant plus manager scope must not duplicate team rows.
insert into private.approved_leave_calendar_grants(person_id) values ('20000000-0000-4000-8000-000000000002');
set role authenticated;
select pg_temp.assert((select count(*)=6 and count(distinct id)=6 from public.list_leave_calendar_entries()),'combined payroll and manager grants are deduplicated');
reset role;
delete from private.approved_leave_calendar_grants where person_id='20000000-0000-4000-8000-000000000002';
update public.internal_org_people set parent_id=null where full_name='Bob Example';
set role authenticated;
select pg_temp.assert((select count(*)=2 from public.list_leave_calendar_entries()),'reporting reassignment immediately removes old manager access');
reset role;
select pg_temp.assert(not has_function_privilege('authenticated','private.manager_calendar_team_ids(uuid)','EXECUTE'),'helper cannot be called from browser');
-- A malformed reporting cycle must terminate and never duplicate requests.
update public.internal_org_people set parent_id='20000000-0000-4000-8000-000000000010' where full_name='Bob Example';
update public.internal_org_people set parent_id='20000000-0000-4000-8000-000000000003' where full_name='Alice Example';
set role authenticated;
select pg_temp.assert((select count(*)=5 from public.list_leave_calendar_entries()),'reporting cycle terminates without duplicate rows');
reset role;
update public.profiles set account_status='disabled' where login_name='alice';
set role authenticated;
do $$ begin
  perform * from public.list_leave_calendar_entries();
  raise exception 'Disabled manager must be denied';
exception when insufficient_privilege then null;
end $$;
reset role;
