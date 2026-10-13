\set ON_ERROR_STOP on
begin;
\ir reporting-splice-fixture.sql
create temporary table preflight_before as select pg_temp_value from (select jsonb_build_object('people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),'details',(select jsonb_agg(to_jsonb(d) order by person_id) from private.employee_directory_details d),'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),'audit',(select jsonb_agg(to_jsonb(a) order by id) from private.employee_directory_audit_events a)) pg_temp_value) snapshot;
select pg_temp.set_test_actor(pg_temp.splice_id(2));
set local role authenticated;
do $$ begin
 assert public.preflight_employee_removal_reporting_splice(pg_temp.splice_id(20),(select person_version from splice_versions where id=pg_temp.splice_id(20)),(select detail_version from splice_versions where id=pg_temp.splice_id(20)),date '2026-10-12','Resigned') is true, 'Admin preflight returns exact true for safe reporting splice';
end $$;
reset role;
do $$ begin
 assert (select pg_temp_value from preflight_before)=(select jsonb_build_object('people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),'details',(select jsonb_agg(to_jsonb(d) order by person_id) from private.employee_directory_details d),'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),'audit',(select jsonb_agg(to_jsonb(a) order by id) from private.employee_directory_audit_events a))), 'Preflight has zero business DML';
 assert has_function_privilege('authenticated','public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)','execute'), 'Authenticated scoped API';
 assert not has_function_privilege('anon','public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)','execute') and not has_function_privilege('service_role','public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)','execute'), 'No public or service preflight';
 assert not has_function_privilege('authenticated','private.plan_employee_removal_reporting_splice(uuid)','execute') and not has_function_privilege('service_role','private.apply_employee_removal_reporting_splice(uuid,uuid)','execute'), 'Planner and writer owner only';
end $$;
rollback;
\echo PASS: authenticated Admin point-in-time no-DML reporting preflight
