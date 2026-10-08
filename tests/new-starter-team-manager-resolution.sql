\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_team_manager_defaults(company_key,team_name,manager_person_id)
values ('mam','Warehouse','a1000000-0000-4000-8000-000000000002');
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $test$
declare result jsonb;
begin
  assert to_regprocedure('public.get_employee_team_manager_default(text,text)') is not null,
    'HR needs an authorized current Team Manager resolution RPC';
  result := public.get_employee_team_manager_default('mam','Warehouse');
  assert result->>'status'='valid' and result->>'managerId'='a1000000-0000-4000-8000-000000000002',
    'Default preview must resolve the configured identity, not names or reporting patterns';
end;
$test$;
rollback;
