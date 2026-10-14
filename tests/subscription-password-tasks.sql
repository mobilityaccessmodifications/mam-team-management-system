\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name)
values('a1000000-0000-4000-8000-000000000008','Synthetic departure'),('a1000000-0000-4000-8000-000000000014','Synthetic scheduled departure');
insert into private.subscription_management_grants(person_id,employee_delegation_confirmed)
values('a1000000-0000-4000-8000-000000000001',true);
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,responsible_person_id,subscription_status,next_review_on)
values
('a5000000-0000-4000-8000-000000000001','MAM-SUB-980001','Synthetic shared paid service','paid','monthly',100,'a1000000-0000-4000-8000-000000000002','active',(clock_timestamp() at time zone 'Australia/Melbourne')::date),
('a5000000-0000-4000-8000-000000000002','MAM-SUB-980002','Synthetic free owner service','free',null,null,'a1000000-0000-4000-8000-000000000008','paused',(clock_timestamp() at time zone 'Australia/Melbourne')::date),
('a5000000-0000-4000-8000-000000000003','MAM-SUB-980003','Synthetic cancelled service','paid','annual',100,'a1000000-0000-4000-8000-000000000002','cancelled',(clock_timestamp() at time zone 'Australia/Melbourne')::date),
('a5000000-0000-4000-8000-000000000004','MAM-SUB-980004','Synthetic unrelated service','free',null,null,'a1000000-0000-4000-8000-000000000002','active',(clock_timestamp() at time zone 'Australia/Melbourne')::date);
insert into private.subscription_memberships(subscription_id,person_id) values
('a5000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000008'),
('a5000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000008'),
('a5000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000014');
do $$ begin assert not exists(select 1 from private.subscription_password_tasks),'Migration did not backfill inactive people'; end $$;
create function pg_temp.expect_password_state(command text,expected text) returns void language plpgsql as $$
declare actual text;
begin
  begin execute command; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
  assert actual=expected,format('Expected %s, got %s',expected,coalesce(actual,'SUCCESS'));
end $$;

select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select public.schedule_employee_offboarding('a1000000-0000-4000-8000-000000000014',
  (select person_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000014')),
  (select detail_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000014')),
  (clock_timestamp() at time zone 'Australia/Melbourne')::date+2,'Resigned');
reset role;
set constraints all immediate;
do $$ begin
  assert not exists(select 1 from private.subscription_password_tasks),'Scheduling a future departure cannot queue a password change';
  assert not public.run_scheduled_employee_offboarding('a1000000-0000-4000-8000-000000000014',clock_timestamp()),'Future departure has not occurred';
end $$;
set constraints all deferred;
savepoint archive_rollback;
set local role authenticated;
select * from public.archive_employee_directory_record('a1000000-0000-4000-8000-000000000008',
  (select person_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000008')),
  (select detail_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000008')),
  current_date,'Resigned');
reset role;
set constraints all immediate;
do $$ begin assert (select count(*)=2 from private.subscription_password_tasks),'Actual member and owner departure queues free and paid password tasks'; end $$;
rollback to savepoint archive_rollback;
do $$ begin assert not exists(select 1 from private.subscription_password_tasks),'Failed or rolled-back archive leaves no task'; end $$;
set local role authenticated;
select * from public.archive_employee_directory_record('a1000000-0000-4000-8000-000000000008',
  (select person_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000008')),
  (select detail_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000008')),
  current_date,'Resigned');
reset role;
set constraints all immediate;
do $$ begin
  assert (select count(*)=2 from private.subscription_password_tasks),'Deferred trigger sees archive reason written after inactivity';
  assert not exists(select 1 from private.subscription_password_tasks where subscription_id in('a5000000-0000-4000-8000-000000000003','a5000000-0000-4000-8000-000000000004')),'Cancelled and unrelated services do not create tasks';
end $$;
set constraints all deferred;
update private.scheduled_employee_offboarding set end_date=(clock_timestamp() at time zone 'Australia/Melbourne')::date-1 where person_id='a1000000-0000-4000-8000-000000000014';
update private.employee_directory_details set scheduled_employment_end_date=(clock_timestamp() at time zone 'Australia/Melbourne')::date-1 where person_id='a1000000-0000-4000-8000-000000000014';
select public.run_scheduled_employee_offboarding('a1000000-0000-4000-8000-000000000014',clock_timestamp());
set constraints all immediate;
do $$ begin assert (select count(*)=3 from private.subscription_password_tasks),'Naturally due scheduled offboarding creates the member password task'; end $$;
create temporary table password_ids as select subscription_id,departed_person_id,id,version from private.subscription_password_tasks;
grant select on password_ids to authenticated;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare item record; begin
  assert (select count(*)=3 from public.list_my_subscription_password_tasks()),'Explicit employee register delegate sees all shared password tasks';
  for item in select * from public.list_my_subscription_password_tasks() loop
    assert (select array_agg(key order by key) from jsonb_object_keys(to_jsonb(item)) key)=array['due_on','service_name','subscription_id','task_id','version'],'Service-only DTO excludes departed identity, reason, cost and secrets';
  end loop;
end $$;
select pg_temp.expect_password_state(format('select public.complete_my_subscription_password_task(%L,1,false)',(select id from password_ids where subscription_id='a5000000-0000-4000-8000-000000000002')),'22023');
select pg_temp.expect_password_state(format('select public.complete_my_subscription_password_task(%L,2,true)',(select id from password_ids where subscription_id='a5000000-0000-4000-8000-000000000002')),'40001');
do $$ declare id uuid; result jsonb; begin
  select task_id into id from public.list_my_subscription_password_tasks() where subscription_id='a5000000-0000-4000-8000-000000000002';
  result:=public.complete_my_subscription_password_task(id,1,true);
  assert result=jsonb_build_object('task_id',id,'version',2,'completed',true),'Manual confirmation has a safe exact commit result';
end $$;
select pg_temp.expect_password_state(format('select public.complete_my_subscription_password_task(%L,1,true)',(select id from password_ids where subscription_id='a5000000-0000-4000-8000-000000000002')),'40001');
select pg_temp.expect_password_state('select * from private.subscription_password_tasks','42501');
select pg_temp.expect_password_state('select public.list_subscription_password_tasks_for_preview(''a1000000-0000-4000-8000-000000000015'')','42501');
reset role;
do $$ begin
  assert (select count(*)=1 from private.subscription_password_task_completions),'Repeated completion cannot duplicate audit';
  assert exists(select 1 from private.subscription_password_task_completions where actor_user_id='a1000000-0000-4000-8000-000000000001' and task_version=2),'Completion audits the real authenticated actor';
end $$;
delete from private.subscription_management_grants where person_id='a1000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin assert not exists(select 1 from public.list_my_subscription_password_tasks()),'Revoking global register grant immediately clears assignment'; end $$;
select pg_temp.expect_password_state(format('select public.complete_my_subscription_password_task(%L,1,true)',(select id from password_ids where departed_person_id='a1000000-0000-4000-8000-000000000008' and subscription_id='a5000000-0000-4000-8000-000000000001')),'42501');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000015');
set local role authenticated;
do $$ begin assert (select count(*)=2 from public.list_my_subscription_password_tasks()),'Shared completion disappears for another current delegate'; end $$;
select public.complete_my_subscription_password_task((select id from password_ids where departed_person_id='a1000000-0000-4000-8000-000000000008' and subscription_id='a5000000-0000-4000-8000-000000000001'),1,true);
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000006');
set local role authenticated;
do $$ begin assert not exists(select 1 from public.list_my_subscription_password_tasks()),'Account role never inherits password tasks from stale grants'; end $$;
select pg_temp.expect_password_state(format('select public.complete_my_subscription_password_task(%L,1,true)',(select id from password_ids where departed_person_id='a1000000-0000-4000-8000-000000000014')),'42501');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ begin assert (select count(*)=1 from public.list_subscription_password_tasks_for_preview('a1000000-0000-4000-8000-000000000015')),'P0 preview uses selected delegate scope'; end $$;
select pg_temp.expect_password_state(format('select public.complete_my_subscription_password_task(%L,1,true)',(select id from password_ids where departed_person_id='a1000000-0000-4000-8000-000000000014')),'42501');
reset role;
set local role service_role;
select pg_temp.expect_password_state('select public.list_my_subscription_password_tasks()','42501');
select pg_temp.expect_password_state('select * from private.subscription_password_task_completions','42501');
reset role;
rollback;
\echo PASS: actual and scheduled archive, free/paid owner/member provenance, no historical/future backfill, safe projection, dynamic delegates, manual CAS, shared completion and real-actor audit
