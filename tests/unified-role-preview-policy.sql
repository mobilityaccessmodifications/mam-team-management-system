\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,last_name,date_of_birth)
select id,'Synthetic',right(id::text,2),date '1990-01-01' from public.internal_org_people where id::text like 'a1000000%';
insert into public.internal_org_people(id,full_name,position_title,company_key)
values('a1000000-0000-4000-8000-000000000017','Synthetic directory-only','Synthetic','mam');
update public.profiles set login_name=null where id='a1000000-0000-4000-8000-000000000013';
create temp table preview_entrypoints(name text primary key);
insert into preview_entrypoints values
('get_portal_role_capabilities'),('list_calendar_birthdays_for_preview'),
('list_employee_it_assets_for_preview'),('list_employee_subscriptions_for_preview'),
('list_employee_check_in_calendar_entries_for_preview'),('list_employee_check_in_workspace_for_preview'),
('list_employee_check_in_tasks_for_preview'),('list_leave_calendar_entries_for_preview'),
('list_leave_calendar_entries_with_teams_for_preview'),('list_staff_leave_calendar_entries_for_preview'),
('get_leave_workspace_for_preview'),('can_import_payroll_balances_for_preview'),
('get_payroll_balance_import_workspace_for_preview'),('can_view_subscription_review_calendar_for_preview'),
('list_subscription_review_calendar_entries_for_preview'),('get_selected_employee_profile_access_role_for_preview'),
('get_selected_employee_work_schedule_workspace'),('list_employee_team_directory'),
('list_managed_employee_directory_records_for_preview'),('get_leave_priority_workspace'),
('get_leave_priority_workspace_before_accrual'),('get_leave_priority_workspace_before_approved_deductions'),
('get_leave_priority_workspace_before_request_limit');
create temp table preview_results(entrypoint text,case_name text,denied boolean);
grant select on preview_entrypoints to authenticated;
grant insert,select on preview_results to authenticated;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select * from public.create_it_asset('mouse','a1000000-0000-4000-8000-000000000010');
select * from public.create_subscription('Synthetic invalid-preview resource',null,'free',null,null,null,
'a1000000-0000-4000-8000-000000000001',array['a1000000-0000-4000-8000-000000000010']::uuid[]);
do $$ declare item record; target uuid; denied boolean; code text; begin
  foreach target in array array[
    'a1000000-0000-4000-8000-000000000007','a1000000-0000-4000-8000-000000000010',
    'a1000000-0000-4000-8000-000000000011','a1000000-0000-4000-8000-000000000017',
    'a1000000-0000-4000-8000-000000000013','a1000000-0000-4000-8000-000000000999']::uuid[] loop
    for item in select name from preview_entrypoints order by name loop
      denied:=false;
      begin execute format('select * from public.%I(%L::uuid)',item.name,target);
      exception when insufficient_privilege or foreign_key_violation then denied:=true; end;
      insert into preview_results values(item.name,'invalid_target_'||right(target::text,3),denied);
    end loop;
  end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare item record; actor uuid; denied boolean; begin
  foreach actor in array array['a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000009']::uuid[] loop
    perform set_config('request.jwt.claim.sub',actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'iat',extract(epoch from clock_timestamp()-interval '2 days')::bigint,'is_anonymous',false)::text,true);
    for item in select name from preview_entrypoints order by name loop
      denied:=false;
      begin execute format('select * from public.%I(%L::uuid)',item.name,'a1000000-0000-4000-8000-000000000002');
      exception when insufficient_privilege then denied:=true; end;
      insert into preview_results values(item.name,'stale_actor_'||right(actor::text,3),denied);
    end loop;
  end loop;
end $$;
reset role;
do $$ declare failures text; begin
  select string_agg(r.entrypoint||':'||r.case_name,', ' order by r.entrypoint,r.case_name) into failures from preview_results r where not r.denied;
  assert failures is null, 'SQL-03 selected-target previews bypass canonical current policy: '||failures;
  assert (select count(*)=184 from preview_results), 'All 23 entrypoints and eight invalid-target/stale-actor cases must execute';
end $$;
rollback;
\echo PASS: 184 effective preview checks deny legacy/missing/disabled/inactive/unlinked targets and both stale P0 actors
