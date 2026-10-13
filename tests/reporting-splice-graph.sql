\set ON_ERROR_STOP on
begin;
\ir reporting-splice-fixture.sql
update public.internal_org_people set parent_id=null where id=pg_temp.splice_id(20);
update splice_versions v set person_version=p.version from public.internal_org_people p where p.id=v.id;
set local role authenticated;
select * from public.archive_employee_directory_record(pg_temp.splice_id(20),(select person_version from splice_versions where id=pg_temp.splice_id(20)),(select detail_version from splice_versions where id=pg_temp.splice_id(20)),'2026-10-12','Resigned');
reset role;
do $$ begin
 assert (select count(*)=3 from public.internal_org_people where id in (pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50)) and parent_id is null), 'Immediate root fallback reconnects every direct child';
 assert (select parent_id=pg_temp.splice_id(30) from public.internal_org_people where id=pg_temp.splice_id(60)), 'Root fallback preserves deeper link';
end $$;
rollback;
\echo PASS: immediate root fallback
begin;
\ir reporting-splice-fixture.sql
insert into public.internal_org_people(id,node_kind,company_key,position_title,is_active,parent_id) values
(pg_temp.splice_id(80),'org_unit','mam','Synthetic Root Inactive',false,null),
(pg_temp.splice_id(81),'org_unit','mam','Synthetic Middle Inactive',false,pg_temp.splice_id(80));
insert into public.internal_org_people(id,full_name,company_key,position_title,is_active,parent_id) values(pg_temp.splice_id(82),'Synthetic Archived Target','mam','Synthetic role',false,pg_temp.splice_id(81));
insert into public.internal_org_people(id,node_kind,company_key,position_title,is_active,parent_id) values(pg_temp.splice_id(84),'org_unit','mam','Synthetic Child Inactive',false,pg_temp.splice_id(82));
delete from private.employee_check_in_enrolments where person_id=pg_temp.splice_id(82);
insert into splice_versions(id,person_version) select id,version from public.internal_org_people where id=pg_temp.splice_id(82);
set local role authenticated;
select public.delete_employee_directory_record(pg_temp.splice_id(82),(select person_version from splice_versions where id=pg_temp.splice_id(82)));
reset role;
do $$ begin
 assert (select parent_id is null from public.internal_org_people where id=pg_temp.splice_id(84)), 'Well-formed all-inactive chain falls back to root on eligible deletion';
 assert (select parent_id=pg_temp.splice_id(80) from public.internal_org_people where id=pg_temp.splice_id(81)), 'Inactive ancestor links retained';
end $$;
rollback;
\echo PASS: all-inactive original chain uses root, not an arbitrary manager
begin;
\ir reporting-splice-fixture.sql
set local role authenticated;
select public.schedule_employee_offboarding(pg_temp.splice_id(20),(select person_version from splice_versions where id=pg_temp.splice_id(20)),(select detail_version from splice_versions where id=pg_temp.splice_id(20)),'2099-07-14','Resigned');
reset role;
do $$ begin
 assert (select parent_id=pg_temp.splice_id(20) from public.internal_org_people where id=pg_temp.splice_id(30)), 'Scheduling never splices children';
 assert (select is_active from public.internal_org_people where id=pg_temp.splice_id(20)), 'Scheduling preserves employment';
end $$;
update public.internal_org_people set parent_id=pg_temp.splice_id(3) where id=pg_temp.splice_id(20);
insert into public.internal_org_people(id,node_kind,company_key,position_title,parent_id,is_active) values(pg_temp.splice_id(70),'org_unit','equipsy','Synthetic Added Later',pg_temp.splice_id(20),true);
select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{"role":"service_role"}',true),set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
do $$ begin
 assert not public.run_scheduled_employee_offboarding(pg_temp.splice_id(20),'2099-07-14 13:59:59+00'), 'AEST last end-date second remains active';
 assert public.run_scheduled_employee_offboarding(pg_temp.splice_id(20),'2099-07-14 14:00:00+00'), 'AEST next Melbourne midnight executes';
 assert not public.run_scheduled_employee_offboarding(pg_temp.splice_id(20),'2099-07-14 14:00:00+00'), 'Repeated due execution does not replay';
end $$;
reset role;
do $$ begin
 assert (select count(*)=4 from public.internal_org_people where id in (pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50),pg_temp.splice_id(70)) and parent_id=pg_temp.splice_id(3)), 'Due execution recomputes changed original chain and added direct child';
 assert (select count(*)=4 from private.employee_directory_audit_events where person_id in (pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50),pg_temp.splice_id(70)) and changed_fields=array['manager_id']::text[] and actor_user_id=pg_temp.splice_id(1)), 'Service audit actor is scheduler, not impersonated Auth';
end $$;
rollback;
\echo PASS: native AEST boundary, current-tree recomputation and idempotence
begin;
\ir reporting-splice-fixture.sql
create temporary table synthetic_reporting_graph (like public.internal_org_people including defaults);
insert into synthetic_reporting_graph select * from public.internal_org_people;
do $$ declare definition text; begin
 definition:=pg_get_functiondef('private.plan_employee_removal_reporting_splice(uuid)'::regprocedure);
 assert encode(extensions.digest(definition,'sha256'),'hex')='ed84b454c1f3b9bb790c569e9098a880f5228456400c67f4876e58f92d1fc292', 'Structural corruption probe binds the exact current planner';
 definition:=replace(definition,'private.plan_employee_removal_reporting_splice','pg_temp.synthetic_splice_plan');
 definition:=replace(definition,'public.internal_org_people','pg_temp.synthetic_reporting_graph');
 execute definition;
end $$;
do $$ declare scenario integer; before jsonb; begin
 for scenario in 1..4 loop
  delete from synthetic_reporting_graph;
  insert into synthetic_reporting_graph select * from public.internal_org_people;
  case scenario
   when 1 then update synthetic_reporting_graph set parent_id=id where id=pg_temp.splice_id(20);
   when 2 then update synthetic_reporting_graph set parent_id=pg_temp.splice_id(999) where id=pg_temp.splice_id(10);
   when 3 then update synthetic_reporting_graph set parent_id=pg_temp.splice_id(10) where id=pg_temp.splice_id(3);
   when 4 then update synthetic_reporting_graph set parent_id=pg_temp.splice_id(30) where id=pg_temp.splice_id(10);
  end case;
  select jsonb_agg(to_jsonb(g) order by id) into before from synthetic_reporting_graph g;
  begin
   perform pg_temp.synthetic_splice_plan(pg_temp.splice_id(20));
   raise exception 'Malformed reporting chain accepted' using errcode='ZX001';
  exception when object_not_in_prerequisite_state then
   assert sqlerrm='Reporting hierarchy is invalid.';
  end;
  assert before=(select jsonb_agg(to_jsonb(g) order by id) from synthetic_reporting_graph g), 'Corrupt-chain planner has no DML';
 end loop;
end $$;
rollback;
\echo PASS: source-bound native extracted planner rejects self/missing/ancestor-cycle/child-reentry without disabling production triggers
