-- First run all existing personal, payroll and manager regressions.
\ir calendar-team-filters.sql
reset role;
update public.profiles set account_status='active',app_role='employee' where login_name in ('alice','jackie');
update public.internal_org_people set company_key='mam' where full_name='Bob Example';
update private.employee_directory_details set team_name='Minor' where team_name='Operations';
\ir ../supabase/migrations/20260923160000_employee_team_calendar.sql
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert((select count(*)=3 and count(distinct id)=3 from public.list_leave_calendar_entries_with_teams()),'employee sees own two entries and approved same-team entry exactly once');
select pg_temp.assert((select count(*)=1 and bool_and(status='Approved' and leave_type_label='Approved leave' and team_name='Minor') from public.list_leave_calendar_entries_with_teams() where person_id<>'20000000-0000-4000-8000-000000000002'),'peer categories minimised and pending/cancelled/cross-team absent');
select pg_temp.assert((select array_agg(key order by key)=array['business_days','company_key','employee_name','end_date','end_time','hours','id','leave_type_label','person_id','start_date','start_time','status','team_name'] from jsonb_object_keys((select to_jsonb(row) from public.list_leave_calendar_entries_with_teams() row limit 1)) key),'no private fields exposed');
do $$ begin
 perform * from public.list_leave_calendar_entries_with_teams_for_preview('20000000-0000-4000-8000-000000000003');
 raise exception 'employee must not preview';
exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
select pg_temp.assert((select count(*)=3 from public.list_leave_calendar_entries_with_teams_for_preview('20000000-0000-4000-8000-000000000002')),'preview matches employee scope');
reset role;
-- Verify all five canonical teams, independent of the reporting line.
do $$ declare t text; begin
 foreach t in array array['MAM admin','Major','Minor','Warehouse','Equipsy'] loop
  update private.employee_directory_details set team_name=t where person_id in ('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003');
  perform pg_temp.assert((select count(*)=1 from private.employee_calendar_peer_ids('20000000-0000-4000-8000-000000000002')), 'canonical team peer membership');
 end loop;
end $$;
update private.employee_directory_details set team_name='Minor' where person_id='20000000-0000-4000-8000-000000000003';
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
select pg_temp.assert((select count(*)=2 from public.list_leave_calendar_entries()),'team reassignment immediately removes peer');
reset role;
update private.employee_directory_details set team_name=null where person_id in ('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003');
select pg_temp.assert((select count(*)=0 from private.employee_calendar_peer_ids('20000000-0000-4000-8000-000000000002')),'missing teams cannot match');
update private.employee_directory_details set team_name='Minor' where person_id in ('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003');
update public.internal_org_people set company_key='equipsy' where full_name='Bob Example';
select pg_temp.assert((select count(*)=0 from private.employee_calendar_peer_ids('20000000-0000-4000-8000-000000000002')),'same label across companies is not same team');
update public.internal_org_people set company_key='mam',is_active=false where full_name='Bob Example';
select pg_temp.assert((select count(*)=0 from private.employee_calendar_peer_ids('20000000-0000-4000-8000-000000000002')),'archived peer absent');
update public.internal_org_people set is_active=true where full_name='Bob Example';
update public.profiles set app_role='manager' where login_name='alice';
set role authenticated;
select pg_temp.assert((select count(*)=count(distinct id) from public.list_leave_calendar_entries()),'overlapping peer and manager scopes deduplicate');
select pg_temp.assert(exists(select 1 from public.list_leave_calendar_entries() where person_id='20000000-0000-4000-8000-000000000005' and status='Approved'),'manager retains cross-team approved visibility');
reset role;
update public.profiles set account_status='disabled' where login_name='alice';
set role authenticated;
do $$ begin
 perform * from public.list_leave_calendar_entries();
 raise exception 'disabled employee must be denied';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.assert(not has_function_privilege('authenticated','private.employee_calendar_peer_ids(uuid)','EXECUTE'),'helper private');
select pg_temp.assert(not has_function_privilege('anon','public.list_leave_calendar_entries()','EXECUTE'),'anonymous denied');
