\ir employee-team-calendar.sql
reset role;
alter table public.leave_requests add column submitted_at timestamptz, add column decided_by uuid references public.profiles(id);
update public.leave_requests set submitted_at=created_at where status in ('submitted','approved');
update public.leave_requests set decided_by='10000000-0000-4000-8000-000000000001' where id='30000000-0000-4000-8000-000000000004';
create table public.leave_request_attachments(id uuid primary key, leave_request_id uuid references public.leave_requests(id));
insert into public.leave_request_attachments values
('50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004');
update public.profiles set account_status='active',app_role='employee' where login_name in ('alice','jackie');
update public.profiles set app_role='manager' where login_name='alice';
-- The forward migration is applied here after the established calendar contract.
\ir ../supabase/migrations/20260929120000_staff_leave_calendar_details.sql
set role authenticated;
select set_config('request.jwt.claims','{"is_anonymous":false}',false);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
select pg_temp.assert((select count(*)=8 and count(distinct id)=8 from public.list_staff_leave_calendar_entries()),'System Admin sees approved plus all active pending without duplicate IDs');
select pg_temp.assert((select leave_type_label='Carer''s leave' and approved_by='System Admin' and document_count=1 and requested_at is not null from public.list_staff_leave_calendar_entries() where id='30000000-0000-4000-8000-000000000004'),'approved type, reviewer, request date and evidence count');
select pg_temp.assert((select status='Pending' and leave_type_label='Annual leave' from public.list_staff_leave_calendar_entries() where id='30000000-0000-4000-8000-000000000003'),'admin can see pending from another team');
select pg_temp.assert((select count(*)=0 from public.list_staff_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000003')),'employee preview has no privileged details');
select pg_temp.assert((select count(*)=8 from public.list_staff_leave_calendar_entries_for_preview('20000000-0000-4000-8000-000000000004')),'Accounts preview matches explicit grant');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
select pg_temp.assert((select count(*)=8 and count(distinct id)=8 from public.list_staff_leave_calendar_entries()),'Accounts sees pending and approved, including archived approved');
select pg_temp.assert(exists(select 1 from public.list_staff_leave_calendar_entries() where employee_name='Former Example (archived)' and leave_type_label='Annual leave'),'Accounts sees classified archived approvals');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert(exists(select 1 from public.list_staff_leave_calendar_entries() where id='30000000-0000-4000-8000-000000000020' and leave_type_label='Sick leave'),'Manager sees other team approved category');
select pg_temp.assert(not exists(select 1 from public.list_staff_leave_calendar_entries() where id='30000000-0000-4000-8000-000000000003'),'Manager does not see other team pending');
select pg_temp.assert(not exists(select 1 from public.list_staff_leave_calendar_entries() where employee_name like '%archived%'),'Manager does not see archived approvals');
reset role;
update public.profiles set app_role='employee' where login_name='alice';
set role authenticated;
select pg_temp.assert((select count(*)=0 from public.list_staff_leave_calendar_entries()),'ordinary employee has no detailed projection');
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id='20000000-0000-4000-8000-000000000003' and leave_type_label='Approved leave'),'peer keeps existing minimised calendar');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000005',false);
select pg_temp.assert((select count(*)=8 from public.list_staff_leave_calendar_entries()),'second granted Accounts account receives the same scope');
reset role;
delete from private.approved_leave_calendar_grants where person_id='20000000-0000-4000-8000-000000000005';
set role authenticated;
select pg_temp.assert((select count(*)=0 from public.list_staff_leave_calendar_entries()),'revoked grant removes detailed projection immediately');
reset role;
update public.profiles set account_status='disabled' where login_name='gerard';
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
do $$ begin
  perform * from public.list_staff_leave_calendar_entries();
  raise exception 'disabled Accounts must be denied';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.assert(not has_function_privilege('anon','public.list_staff_leave_calendar_entries()','EXECUTE'),'anonymous cannot call staff calendar');
select pg_temp.assert(not has_function_privilege('authenticated','private.staff_leave_calendar_entries(uuid,uuid,boolean)','EXECUTE'),'private helper remains uncallable');
