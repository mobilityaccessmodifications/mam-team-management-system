\set ON_ERROR_STOP on
begin;
\ir reporting-splice-fixture.sql
update public.internal_org_people set is_active=false where id=pg_temp.splice_id(60);
update public.internal_org_people set is_active=false where id in (pg_temp.splice_id(30),pg_temp.splice_id(40));
update public.internal_org_people set is_active=false where id=pg_temp.splice_id(20);
update splice_versions v set person_version=p.version from public.internal_org_people p where p.id=v.id;
set local role authenticated;
do $$ begin
 begin
  perform public.delete_employee_directory_record(pg_temp.splice_id(20),(select person_version from splice_versions where id=pg_temp.splice_id(20)));
  raise exception 'Check-in enrolment history accepted' using errcode='ZX001';
 exception when foreign_key_violation then null; end;
end $$;
reset role;
insert into public.internal_org_people(id,node_kind,company_key,position_title,is_active,parent_id) values(pg_temp.splice_id(71),'org_unit','mam','Synthetic Inactive Ancestor',false,pg_temp.splice_id(10));
insert into public.internal_org_people(id,full_name,company_key,position_title,is_active,parent_id) values(pg_temp.splice_id(70),'Synthetic History Free','mam','Synthetic role',false,pg_temp.splice_id(71));
update public.internal_org_people set parent_id=pg_temp.splice_id(70) where id in (pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50));
insert into splice_versions(id,person_version) select id,version from public.internal_org_people where id=pg_temp.splice_id(70);
do $$ begin
 assert not exists(select 1 from private.employee_check_in_reminders where person_id=pg_temp.splice_id(70)), 'Synthetic eligible target has no reminder history';
 assert not exists(select 1 from private.employee_onboarding_credentials where person_id=pg_temp.splice_id(70)), 'Synthetic eligible target has no credential history';
end $$;
delete from private.employee_check_in_enrolments where person_id=pg_temp.splice_id(70);
create temporary table delete_deep_before as select to_jsonb(p) value from public.internal_org_people p where id=pg_temp.splice_id(60);
create table private.synthetic_reporting_splice_retention(person_id uuid references public.internal_org_people(id));
insert into private.synthetic_reporting_splice_retention values(pg_temp.splice_id(70));
create temporary table delete_before as select jsonb_build_object('people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),'details',(select jsonb_agg(to_jsonb(d) order by person_id) from private.employee_directory_details d),'audit',(select jsonb_agg(to_jsonb(a) order by id) from private.employee_directory_audit_events a)) value;
set local role authenticated;
do $$ begin
 begin
  perform public.delete_employee_directory_record(pg_temp.splice_id(70),(select person_version from splice_versions where id=pg_temp.splice_id(70)));
  raise exception 'Late history FK accepted' using errcode='ZX001';
 exception when foreign_key_violation then null; end;
end $$;
reset role;
do $$ begin
 assert (select value from delete_before)=(select jsonb_build_object('people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),'details',(select jsonb_agg(to_jsonb(d) order by person_id) from private.employee_directory_details d),'audit',(select jsonb_agg(to_jsonb(a) order by id) from private.employee_directory_audit_events a))), 'Late FK rejection rolls back target, every edge and audit';
end $$;
drop table private.synthetic_reporting_splice_retention;
set local role authenticated;
select public.delete_employee_directory_record(pg_temp.splice_id(70),(select person_version from splice_versions where id=pg_temp.splice_id(70)));
reset role;
do $$ begin
 assert not exists(select 1 from public.internal_org_people where id=pg_temp.splice_id(70)), 'Eligible archived unlinked target deleted';
 assert (select count(*)=3 from public.internal_org_people where id in (pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50)) and parent_id=pg_temp.splice_id(10)), 'Inactive chain skipped to active structural ancestor for all inactive children';
 assert (select value from delete_deep_before)=(select to_jsonb(p) from public.internal_org_people p where id=pg_temp.splice_id(60)), 'Deeper inactive edge/history row unchanged';
 assert (select count(*)=3 from private.employee_directory_audit_events where person_id in (pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50)) and changed_fields=array['manager_id']::text[] and actor_user_id=pg_temp.splice_id(1)), 'One deletion-splice audit per moved child';
end $$;
rollback;
\echo PASS: eligible deletion skips inactive ancestors and late FK rolls back the whole splice
