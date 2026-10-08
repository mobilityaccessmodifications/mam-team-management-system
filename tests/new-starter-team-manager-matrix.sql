\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
update public.internal_org_people set company_key='equipsy' where id='a1000000-0000-4000-8000-000000000016';
insert into private.employee_team_manager_defaults(company_key,team_name,manager_person_id) values
 ('mam','Operation & Accounts','a1000000-0000-4000-8000-000000000002'),
 ('mam','Management','a1000000-0000-4000-8000-000000000002'),
 ('mam','Major','a1000000-0000-4000-8000-000000000014'),
 ('mam','Minor','a1000000-0000-4000-8000-000000000015'),
 ('mam','Warehouse','a1000000-0000-4000-8000-000000000002'),
 ('equipsy','Equipsy','a1000000-0000-4000-8000-000000000016');
create temporary table manager_expected(company text,team text,manager uuid);
insert into manager_expected select company_key,team_name,manager_person_id from private.employee_team_manager_defaults;
grant select on manager_expected to authenticated;
create temporary table manager_old_people as select id,to_jsonb(p) as raw from public.internal_org_people p;
grant select on manager_old_people to authenticated;
create temporary table manager_old_profiles as select id,to_jsonb(p) as raw from public.profiles p;
grant select on manager_old_profiles to authenticated;
create function pg_temp.manager_starter(team text,company text,manager uuid default null) returns uuid
language plpgsql set search_path='' as $helper$
declare person uuid;
begin
 select person_id into strict person from public.create_employee_directory_record_with_work_schedule_times(
  p_first_name=>'Synthetic new starter',p_last_name=>team,p_work_email=>'',p_personal_email=>'',p_phone=>'',
  p_position_title=>'Synthetic coordinator',p_team_name=>team,p_manager_id=>manager,p_country=>'',p_date_of_birth=>null,
  p_started_date=>current_date,p_scheduled_employment_end_date=>null,p_company_key=>company,p_is_active=>true,
  p_laptop_supplied=>'',p_laptop_id=>'',p_mouse_id=>'',p_keyboard_id=>'',p_asset_tags=>'{}'::text[],p_address=>'',
  p_employment_type=>'full_time',p_working_weekdays=>null::smallint[],p_working_day_times=>'[]'::jsonb,p_sort_order=>0);
 return person;
end;
$helper$;
create function pg_temp.manager_move(person uuid,parent uuid) returns uuid
language plpgsql set search_path='' as $helper$
declare node record;
begin
 select company_key,node_kind,position_title,full_name,sort_order,is_active,version
 into strict node from public.internal_org_people where id=person;
 return public.update_internal_org_node(
  p_node_id=>person,p_company_key=>node.company_key,p_node_kind=>node.node_kind,
  p_position_title=>node.position_title,p_full_name=>node.full_name,p_parent_id=>parent,
  p_started_date=>null,p_sort_order=>node.sort_order,p_is_active=>node.is_active,p_expected_version=>node.version);
end;
$helper$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $matrix$
declare mapping record; child uuid; explicit_child uuid; unassigned uuid; person_before bigint; person_after bigint;
begin
 for mapping in select * from manager_expected loop
  child := pg_temp.manager_starter(mapping.team,mapping.company);
  assert (select parent_id from public.internal_org_people where id=child)=mapping.manager,
   'Every company+Team mapping must persist its exact configured manager';
 end loop;
 explicit_child := pg_temp.manager_starter('Warehouse','mam','a1000000-0000-4000-8000-000000000014');
 assert (select parent_id from public.internal_org_people where id=explicit_child)='a1000000-0000-4000-8000-000000000014'::uuid,
  'Explicit valid manager must override the Team default';
 unassigned := pg_temp.manager_starter('Warehouse','equipsy');
 assert (select parent_id from public.internal_org_people where id=unassigned) is null,
  'Missing same-company mapping must stay unassigned, not borrow another company mapping';
 select count(*) into person_before from public.internal_org_people;
 begin
  perform pg_temp.manager_starter('Warehouse','mam','a1000000-0000-4000-8000-000000000016');
  raise exception 'Cross-company explicit manager was accepted';
 exception when foreign_key_violation then null; end;
 begin
  perform pg_temp.manager_starter('Warehouse','mam','a1000000-0000-4000-8000-000000000011');
  raise exception 'Inactive explicit manager was accepted';
 exception when foreign_key_violation then null; end;
 select count(*) into person_after from public.internal_org_people;
 assert person_before=person_after,'Rejected creates must not insert a person';
 perform pg_temp.manager_move(explicit_child,'a1000000-0000-4000-8000-000000000015');
 assert (select parent_id from public.internal_org_people where id=explicit_child)='a1000000-0000-4000-8000-000000000015'::uuid;
 begin
  perform pg_temp.manager_move(explicit_child,explicit_child);
  raise exception 'Self reporting link was accepted';
 exception when raise_exception then assert sqlerrm='An org node cannot report to itself.'; end;
 begin
  perform pg_temp.manager_move('a1000000-0000-4000-8000-000000000015',explicit_child);
  raise exception 'Cyclic reporting link was accepted';
 exception when raise_exception then assert sqlerrm='This reporting link would create a cycle.'; end;
end;
$matrix$;
reset role;
update private.employee_team_manager_defaults set manager_person_id='a1000000-0000-4000-8000-000000000011',version=version+1
where company_key='mam' and team_name='Warehouse';
set local role authenticated;
do $invalid$
declare before_count bigint; child uuid;
begin
 assert public.get_employee_team_manager_default('mam','Warehouse')->>'status'='invalid';
 select count(*) into before_count from public.internal_org_people;
 begin
  perform pg_temp.manager_starter('Warehouse','mam');
  raise exception 'Inactive configured default was accepted';
 exception when foreign_key_violation then null; end;
 assert before_count=(select count(*) from public.internal_org_people);
 child := pg_temp.manager_starter('Warehouse','mam','a1000000-0000-4000-8000-000000000014');
 assert (select parent_id from public.internal_org_people where id=child)='a1000000-0000-4000-8000-000000000014'::uuid;
end;
$invalid$;
reset role;
update private.employee_team_manager_defaults set manager_person_id='a1000000-0000-4000-8000-000000000016',version=version+1
where company_key='mam' and team_name='Warehouse';
set local role authenticated;
do $cross$
begin
 assert public.get_employee_team_manager_default('mam','Warehouse')->>'status'='invalid';
 begin
  perform pg_temp.manager_starter('Warehouse','mam');
  raise exception 'Cross-company configured default was accepted';
 exception when foreign_key_violation then null; end;
end;
$cross$;
reset role;
do $denials$
declare actor uuid;
begin
 foreach actor in array array[
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'a1000000-0000-4000-8000-000000000002'::uuid,
  'a1000000-0000-4000-8000-000000000003'::uuid,
  'a1000000-0000-4000-8000-000000000010'::uuid,
  'a1000000-0000-4000-8000-000000000011'::uuid,
  'a1000000-0000-4000-8000-000000000012'::uuid] loop
  perform pg_temp.set_test_actor(actor);
  set local role authenticated;
  begin
   perform public.get_employee_team_manager_default('mam','Major');
   raise exception 'Unauthorized default preview was accepted';
  exception when insufficient_privilege then null; end;
  begin
   perform pg_temp.manager_starter('Major','mam');
   raise exception 'Unauthorized default creation was accepted';
  exception when insufficient_privilege then null; end;
  reset role;
 end loop;
end;
$denials$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $p0$
begin
 assert public.get_employee_team_manager_default('mam','Major')->>'status'='valid';
 assert pg_temp.manager_starter('Major','mam') is not null;
end;
$p0$;
reset role;
do $configuration$
begin
 assert not exists(select 1 from manager_old_people b join public.internal_org_people p using(id) where b.raw<>to_jsonb(p)),
  'Changing Team defaults must not reparent historical employees';
 assert not exists(select 1 from manager_old_profiles b join public.profiles p using(id) where b.raw<>to_jsonb(p));
 assert not has_function_privilege('anon','public.get_employee_team_manager_default(text,text)','execute');
 assert not has_function_privilege('service_role','public.get_employee_team_manager_default(text,text)','execute');
 assert not has_table_privilege('authenticated','private.employee_team_manager_defaults','select');
 assert not has_table_privilege('authenticated','private.employee_team_manager_defaults','insert,update,delete');
end;
$configuration$;
rollback;
