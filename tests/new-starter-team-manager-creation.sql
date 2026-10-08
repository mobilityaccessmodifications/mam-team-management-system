\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_team_manager_defaults(company_key,team_name,manager_person_id)
values ('mam','Warehouse','a1000000-0000-4000-8000-000000000002');
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $test$
declare created record;
begin
  select * into strict created from public.create_employee_directory_record(
    'New Warehouse','Synthetic','','','','Synthetic coordinator','Warehouse',null,
    '',null,current_date,null,'mam',true,'','','','','{}'::text[],0);
  assert (select parent_id from public.internal_org_people where id=created.person_id)
    = 'a1000000-0000-4000-8000-000000000002'::uuid,
    'New employee must persist the authoritative company+Team Manager as its org parent';
end;
$test$;
rollback;
