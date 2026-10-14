\set ON_ERROR_STOP on
begin;
create temporary table review_fixture_baseline as select count(*) base_count from private.subscription_register where pricing_model='paid' and subscription_status in ('active','paused');
grant select on review_fixture_baseline to authenticated;
\ir unified-role-fixture.sql
insert into private.subscription_management_grants(person_id,employee_delegation_confirmed) values('a1000000-0000-4000-8000-000000000001',true);
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,responsible_person_id,subscription_status,next_review_on)
values ('a4000000-0000-4000-8000-000000000001','MAM-SUB-990001','Synthetic due service','paid','monthly',100,'a1000000-0000-4000-8000-000000000008','active',private.mam_local_calendar_date());
update private.subscription_register set next_review_on=private.mam_local_calendar_date()-1 where id='a4000000-0000-4000-8000-000000000001';
do $$ begin
 assert to_regprocedure('public.list_my_subscription_review_tasks()') is not null, 'Register managers need a subscription review task projection';
 assert to_regprocedure('public.complete_my_subscription_review_task(uuid,bigint)') is not null, 'Register managers need a Done operation';
end $$;
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,responsible_person_id,subscription_status,next_review_on)
values ('a4000000-0000-4000-8000-000000000002','MAM-SUB-990002','Synthetic future service','paid','monthly',100,'a1000000-0000-4000-8000-000000000008','active',private.mam_local_calendar_date()),
 ('a4000000-0000-4000-8000-000000000003','MAM-SUB-990003','Synthetic paused service','paid','monthly',100,'a1000000-0000-4000-8000-000000000008','paused',private.mam_local_calendar_date()),
 ('a4000000-0000-4000-8000-000000000004','MAM-SUB-990004','Synthetic free service','free',null,null,'a1000000-0000-4000-8000-000000000008','active',private.mam_local_calendar_date()),
 ('a4000000-0000-4000-8000-000000000005','MAM-SUB-990005','Synthetic cancelled service','paid','monthly',100,'a1000000-0000-4000-8000-000000000008','cancelled',private.mam_local_calendar_date());
update private.subscription_register set next_review_on=private.mam_local_calendar_date()+1 where id='a4000000-0000-4000-8000-000000000002';
update private.subscription_register set next_review_on=private.mam_local_calendar_date() where id='a4000000-0000-4000-8000-000000000003';
create function pg_temp.expect_review_state(command text,expected text) returns void language plpgsql as $$
declare actual text;
begin
 begin execute command;
 exception when others then get stacked diagnostics actual=returned_sqlstate;
 end;
 assert actual=expected, format('Expected %s, got %s',expected,coalesce(actual,'SUCCESS'));
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare item record; fields text[]; begin
 assert (select count(*)=(select base_count+3 from review_fixture_baseline) from public.list_my_subscription_review_tasks()), 'Register managers receive all live paid tasks regardless of owner';
 for item in select * from public.list_my_subscription_review_tasks() loop
  select array_agg(key order by key) into fields from jsonb_object_keys(to_jsonb(item)) key;
  assert fields=array['next_review_on','service_name','subscription_id','subscription_status','version'], 'Task projection excludes credential, vault, card and pricing fields';
 end loop;
end $$;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000002'',2)','42501');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',1)','40001');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000004'',1)','22023');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000005'',1)','22023');
select pg_temp.expect_review_state('select public.list_subscription_review_tasks_for_preview(''a1000000-0000-4000-8000-000000000001'')','42501');
reset role;
\echo PASS: safe five-field projection includes future and paused tasks, excludes free and cancelled
\echo PASS: future denied, stale version denied, non-paid and cancelled denied, employee preview denied
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000008');
set local role authenticated;
do $$ begin assert not exists(select 1 from public.list_my_subscription_review_tasks()), 'Non-delegated owners receive no register review tasks'; end $$;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
\echo PASS: another employee cannot see or complete the register managers' task
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000011');
set local role authenticated;
select pg_temp.expect_review_state('select public.list_my_subscription_review_tasks()','42501');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000010');
set local role authenticated;
select pg_temp.expect_review_state('select public.list_my_subscription_review_tasks()','42501');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000012');
set local role authenticated;
select pg_temp.expect_review_state('select public.list_my_subscription_review_tasks()','42501');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
\echo PASS: inactive, disabled and unlinked actors cannot list or complete
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000005');
set local role authenticated;
do $$ begin assert not exists(select 1 from public.list_my_subscription_review_tasks()), 'Admins do not receive unassigned tasks'; end $$;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ begin assert (select count(*)=(select base_count+3 from review_fixture_baseline) from public.list_subscription_review_tasks_for_preview('a1000000-0000-4000-8000-000000000001')); end $$;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
\echo PASS: privileged preview is delegate-scoped and does not impersonate task completion
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare task record; completed jsonb; begin
 select * into strict task from public.list_my_subscription_review_tasks() where subscription_id='a4000000-0000-4000-8000-000000000001';
 assert task.subscription_id='a4000000-0000-4000-8000-000000000001'::uuid;
 assert task.service_name='Synthetic due service';
 assert task.next_review_on<current_date+1;
 completed:=public.complete_my_subscription_review_task(task.subscription_id,task.version);
 assert (completed->>'version')::bigint=task.version+1, 'Done increments the subscription version';
 assert (completed->>'next_review_on')::date>task.next_review_on, 'Done advances quarterly review';
end $$;
reset role;
do $$ begin
 assert exists(select 1 from private.subscription_audit_events where subscription_id='a4000000-0000-4000-8000-000000000001' and actor_user_id='a1000000-0000-4000-8000-000000000001' and event_type='reviewed' and changed_fields=array['next_review_on']::text[]), 'Done writes the existing reviewed audit';
 assert (select next_review_on=private.next_paid_subscription_quarter_review_on(private.mam_local_calendar_date()) and updated_by='a1000000-0000-4000-8000-000000000001' from private.subscription_register where id='a4000000-0000-4000-8000-000000000001'), 'Done uses the existing quarterly scheduling rule';
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare result jsonb; begin
 result:=public.complete_my_subscription_review_task('a4000000-0000-4000-8000-000000000003',2);
 assert (select array_agg(key order by key) from jsonb_object_keys(result) key)=array['next_review_on','service_name','subscription_id','subscription_status','version'];
end $$;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','40001');
reset role;
\echo PASS: paused due completion returns only safe fields and replay is rejected
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare result jsonb; begin
 result:=public.mark_subscription_reviewed_v2('a4000000-0000-4000-8000-000000000002',2);
 assert (result->>'version')::bigint=3 and (result->>'next_review_on')::date>current_date+1;
 assert result->>'last_reviewed_on' is not null, 'Existing register Last Reviewed Date still derives from audit';
end $$;
reset role;
\echo PASS: existing admin register review keeps its authority, early-review semantics and audit projection
set local role anon;
select pg_temp.expect_review_state('select public.list_my_subscription_review_tasks()','42501');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
set local role service_role;
select pg_temp.expect_review_state('select public.list_my_subscription_review_tasks()','42501');
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','42501');
reset role;
do $$ begin
 assert not has_function_privilege('authenticated','private.record_subscription_review(uuid,bigint)','EXECUTE');
 assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton), 'Additive RPCs preserve the destructive-operation fingerprint';
end $$;
\echo PASS: anonymous, service-role and direct private-core execution remain denied; purge fingerprint remains current
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000015');
set local role authenticated;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',2)','40001');
do $$ begin assert (select count(*)=(select base_count+3 from review_fixture_baseline) from public.list_my_subscription_review_tasks()), 'Another register manager receives the same register tasks'; end $$;
reset role;
delete from private.subscription_management_grants where person_id='a1000000-0000-4000-8000-000000000001';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin assert not exists(select 1 from public.list_my_subscription_review_tasks()), 'Revocation removes review tasks'; end $$;
select pg_temp.expect_review_state('select public.complete_my_subscription_review_task(''a4000000-0000-4000-8000-000000000001'',3)','42501');
reset role;
rollback;
\echo PASS: register manager lists and completes a due quarterly subscription review
