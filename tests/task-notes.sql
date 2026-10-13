\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,working_weekdays)
values ('a1000000-0000-4000-8000-000000000001',array[1,2,3,4,5]::smallint[]);
insert into private.employee_check_in_reminders(id,person_id,milestone,reminder_sequence,due_date,notify_date)
values ('a6000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','2_week','initial',current_date,current_date),
 ('a6000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000008','2_week','initial',current_date,current_date),
 ('a6000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001','5_month','final',current_date,current_date);
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,responsible_person_id,subscription_status,next_review_on)
values ('a4000000-0000-4000-8000-000000000001','MAM-SUB-990001','Synthetic notes review','paid','monthly',100,'a1000000-0000-4000-8000-000000000001','active',private.mam_local_calendar_date());
insert into private.employee_work_schedule_change_requests(id,person_id,submitted_by_user_id,original_working_weekdays,requested_working_weekdays,request_reason)
values ('a7000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',array[1,2,3,4,5]::smallint[],array[1,2,3,4]::smallint[],'Synthetic schedule change');
create function pg_temp.expect_notes_state(command text,expected text) returns void language plpgsql as $$
declare actual text;
begin
 begin execute command; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
 assert actual=expected,format('Expected %s, got %s',expected,coalesce(actual,'SUCCESS'));
end $$;
do $$ declare role_name text; signature text; begin
 assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.task_follow_up_notes'::regclass);
 foreach role_name in array array['anon','authenticated','service_role'] loop
  assert not has_table_privilege(role_name,'private.task_follow_up_notes','SELECT,INSERT,UPDATE,DELETE');
  assert not has_function_privilege(role_name,'private.require_task_notes_scope(text,uuid,date,uuid)','EXECUTE');
 end loop;
 foreach signature in array array['public.get_visible_task_notes(text,uuid,date,uuid)','public.save_visible_task_notes(text,uuid,date,text,bigint)'] loop
  assert has_function_privilege('authenticated',signature,'EXECUTE');
  assert not has_function_privilege('anon',signature,'EXECUTE');
  assert not has_function_privilege('service_role',signature,'EXECUTE');
  assert (select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid=to_regprocedure(signature));
 end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin
 assert public.get_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001')='{"text":"","version":0}'::jsonb;
 assert public.save_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001',null,'Synthetic manager follow-up',0)='{"text":"Synthetic manager follow-up","version":1}'::jsonb;
 assert public.get_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001')->>'text'='Synthetic manager follow-up';
 assert public.save_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001',null,'',1)='{"text":"","version":2}'::jsonb;
 assert public.save_visible_task_notes('work_schedule','a7000000-0000-4000-8000-000000000001',null,'Synthetic reviewer follow-up',0)->>'version'='1';
end $$;
select pg_temp.expect_notes_state('select public.save_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'',null,''Stale overwrite'',1)','40001');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000002'')','42501');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000003'')','42501');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'',null,''a1000000-0000-4000-8000-000000000002'')','42501');
select pg_temp.expect_notes_state('select public.save_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'',null,repeat(''x'',5001),2)','22023');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'',current_date)','22023');
reset role;
\echo PASS: manager-scoped check-in notes round-trip, clear, CAS, final/other-team exclusions, preview and length rejection
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare task record; begin
 assert public.get_visible_task_notes('work_schedule','a7000000-0000-4000-8000-000000000001')->>'text'='Synthetic reviewer follow-up';
 assert public.save_visible_task_notes('work_schedule','a7000000-0000-4000-8000-000000000001',null,'Synthetic owner follow-up',1)->>'version'='2';
 select * into strict task from public.list_my_subscription_review_tasks() where subscription_id='a4000000-0000-4000-8000-000000000001';
 assert public.save_visible_task_notes('subscription_review',task.subscription_id,task.next_review_on,repeat('x',5000),0)->>'version'='1';
 assert (select version=task.version from public.list_my_subscription_review_tasks() where subscription_id=task.subscription_id);
end $$;
reset role;
update private.subscription_register set next_review_on=next_review_on+1 where id='a4000000-0000-4000-8000-000000000001';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare task record; begin
 select * into strict task from public.list_my_subscription_review_tasks() where subscription_id='a4000000-0000-4000-8000-000000000001';
 assert public.get_visible_task_notes('subscription_review',task.subscription_id,task.next_review_on)='{"text":"","version":0}'::jsonb;
 perform pg_temp.expect_notes_state(format('select public.get_visible_task_notes(''subscription_review'',%L,%L)',task.subscription_id,task.next_review_on-1),'42501');
 perform pg_temp.expect_notes_state(format('select public.save_visible_task_notes(''subscription_review'',%L,%L,''Old cycle'',1)',task.subscription_id,task.next_review_on-1),'42501');
end $$;
reset role;
\echo PASS: own/reviewer work-schedule scope, owner subscription notes, exact 5,000 boundary and review-cycle isolation
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ begin
 assert public.get_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001',null,'a1000000-0000-4000-8000-000000000002')->>'version'='2';
 assert public.get_visible_task_notes('work_schedule','a7000000-0000-4000-8000-000000000001',null,'a1000000-0000-4000-8000-000000000001')->>'version'='2';
 assert public.get_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001')->>'version'='2';
 assert public.save_visible_task_notes('check_in','a6000000-0000-4000-8000-000000000001',null,'',2)->>'version'='3';
 assert public.get_visible_task_notes('work_schedule','a7000000-0000-4000-8000-000000000001')->>'version'='2';
 assert public.save_visible_task_notes('work_schedule','a7000000-0000-4000-8000-000000000001',null,'Synthetic owner follow-up',2)->>'version'='3';
end $$;
select pg_temp.expect_notes_state('select public.save_visible_task_notes(''subscription_review'',''a4000000-0000-4000-8000-000000000001'',private.mam_local_calendar_date()+1,''Impersonated owner'',0)','42501');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000008');
set local role authenticated;
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'')','42501');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''work_schedule'',''a7000000-0000-4000-8000-000000000001'')','42501');
select pg_temp.expect_notes_state('select public.save_visible_task_notes(''work_schedule'',''a7000000-0000-4000-8000-000000000001'',null,''Other employee'',2)','42501');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''subscription_review'',''a4000000-0000-4000-8000-000000000001'',current_date)','42501');
reset role;
update public.internal_org_people set parent_id=null where id='a1000000-0000-4000-8000-000000000001';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.expect_notes_state('select public.save_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'',null,''Old team'',2)','42501');
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''work_schedule'',''a7000000-0000-4000-8000-000000000001'')','42501');
reset role;
do $$ declare actor uuid; begin
 foreach actor in array array['a1000000-0000-4000-8000-000000000010'::uuid,'a1000000-0000-4000-8000-000000000011'::uuid,'a1000000-0000-4000-8000-000000000012'::uuid] loop
  perform pg_temp.set_test_actor(actor);
  perform pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'')','42501');
  perform pg_temp.expect_notes_state('select public.save_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'',null,''Disabled overwrite'',2)','42501');
 end loop;
 assert (select count(*)=3 from private.task_follow_up_notes);
 assert (select notes='' and version=3 from private.task_follow_up_notes where kind='check_in');
 assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);
end $$;
\echo PASS: preview scope, unrelated/disabled/archived/unlinked actors and changed reporting scope denied; notes and purge guard preserved
update private.employee_check_in_reminders set delivery_status='completed',completed_at=clock_timestamp()
where id='a6000000-0000-4000-8000-000000000001';
update private.employee_work_schedule_change_requests set status='cancelled',decided_at=clock_timestamp(),
 decided_by_user_id='a1000000-0000-4000-8000-000000000009',reviewer_name='Synthetic P0',decision_reason='Synthetic cancellation'
where id='a7000000-0000-4000-8000-000000000001';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select pg_temp.expect_notes_state('select public.get_visible_task_notes(''check_in'',''a6000000-0000-4000-8000-000000000001'')','42501');
select pg_temp.expect_notes_state('select public.save_visible_task_notes(''work_schedule'',''a7000000-0000-4000-8000-000000000001'',null,''Closed task overwrite'',3)','42501');
reset role;
\echo PASS: standalone P0 operational notes retain current authority, and completed/cancelled tasks close note access
rollback;
