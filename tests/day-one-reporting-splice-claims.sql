\set ON_ERROR_STOP on
begin;
\ir reporting-splice-fixture.sql
create function pg_temp.data_footprint() returns jsonb language plpgsql as $$
declare t record; rows jsonb; result jsonb:='{}';
begin
 for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and c.relkind in ('r','p') order by n.nspname,c.relname loop
  execute format('select jsonb_build_object(''count'',count(*),''sha256'',encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),''[]''::jsonb)::text,''sha256''),''hex'')) from %I.%I x',t.nspname,t.relname) into rows;
  result:=result||jsonb_build_object(t.nspname||'.'||t.relname,rows);
 end loop;
 return result;
end $$;
update public.internal_org_people set parent_id=pg_temp.splice_id(3) where id=pg_temp.splice_id(20);
update private.employee_directory_details set work_email='manager3@example.test' where person_id=pg_temp.splice_id(3);
update private.employee_directory_details set work_email='manager20@example.test' where person_id=pg_temp.splice_id(20);
update public.internal_org_people set started_date=(clock_timestamp() at time zone 'Australia/Melbourne')::date+1 where id in (pg_temp.splice_id(30),pg_temp.splice_id(60));
update private.employee_directory_details set work_email='starter'||case person_id when pg_temp.splice_id(30) then '30' else '60' end||'@example.test' where person_id in (pg_temp.splice_id(30),pg_temp.splice_id(60));
insert into public.internal_org_people(id,node_kind,full_name,company_key,position_title,parent_id,is_active,started_date) values(pg_temp.splice_id(61),'person','Synthetic Delivered Deep Child','mam','Synthetic role',pg_temp.splice_id(30),true,(clock_timestamp() at time zone 'Australia/Melbourne')::date+1);
insert into private.employee_directory_details(person_id,first_name,work_email) values(pg_temp.splice_id(61),'Synthetic','starter61@example.test');
update private.employee_new_starter_day_one_reminders set next_attempt_at=clock_timestamp()-interval '1 minute' where person_id in(pg_temp.splice_id(30),pg_temp.splice_id(60),pg_temp.splice_id(61));
do $$ begin assert (select count(*)=3 from private.employee_new_starter_day_one_reminders where person_id in(pg_temp.splice_id(30),pg_temp.splice_id(60),pg_temp.splice_id(61)) and notify_date<=(clock_timestamp() at time zone 'Australia/Melbourne')::date and notify_date=private.victorian_business_days_before(commencement_date,1)),'Three natural Day1 notify dates already due with no date override'; end $$;
create temporary table actual_claims as select * from public.claim_due_new_starter_day_one_reminders(3);
do $$ begin
 assert (select count(*)=3 from actual_claims),'All three owned due reminders claimed through real RPC';
 assert public.complete_new_starter_day_one_delivery((select r.id from private.employee_new_starter_day_one_reminders r where person_id=pg_temp.splice_id(61)),(select c.claim_token from actual_claims c join private.employee_new_starter_day_one_reminders r on r.id=c.reminder_id where r.person_id=pg_temp.splice_id(61))),'Real delivered positive control';
end $$;
create temporary table reminders_before as select id,person_id,to_jsonb(r) value from private.employee_new_starter_day_one_reminders r where person_id in(pg_temp.splice_id(30),pg_temp.splice_id(60),pg_temp.splice_id(61));
create temporary table contexts_before as select i.id,to_jsonb(c) value from (values(pg_temp.splice_id(30)),(pg_temp.splice_id(60))) i(id) cross join lateral private.employee_new_starter_day_one_context(i.id) c;
create temporary table prepared_before as select r.person_id,to_jsonb(p) value from private.employee_new_starter_day_one_reminders r join actual_claims c on c.reminder_id=r.id cross join lateral public.prepare_new_starter_day_one_delivery(r.id,c.claim_token) p;
insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc)
select 'new-starter:'||id::text||':day-one:live','processing',gen_random_uuid(),'starter'||case person_id when pg_temp.splice_id(30) then '30' else '60' end||'@example.test','' from private.employee_new_starter_day_one_reminders where person_id in(pg_temp.splice_id(30),pg_temp.splice_id(60));
create temporary table durable_before as select event_key,to_jsonb(r) value from private.notification_delivery_receipts r;
create temporary table events_before as select id,to_jsonb(e) value from private.employee_new_starter_day_one_events e;
create temporary table all_before as select pg_temp.data_footprint() value;
update splice_versions v set person_version=p.version,detail_version=d.version from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id=v.id;
do $$ declare mode text; direct_before jsonb; deep_before jsonb; prepared record; begin
 foreach mode in array array['archive','scheduled','delete'] loop
  begin
   if mode='archive' then
    execute 'set local role authenticated';
    perform public.archive_employee_directory_record(pg_temp.splice_id(20),(select person_version from splice_versions where id=pg_temp.splice_id(20)),(select detail_version from splice_versions where id=pg_temp.splice_id(20)),current_date,'Resigned');
    execute 'reset role';
   elsif mode='scheduled' then
    insert into private.scheduled_employee_offboarding(person_id,end_date,reason,scheduled_by) values(pg_temp.splice_id(20),current_date-1,'Resigned',pg_temp.splice_id(1));
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    perform set_config('request.jwt.claim.role','service_role',true);
    execute 'set local role service_role';
    assert public.run_scheduled_employee_offboarding(pg_temp.splice_id(20),clock_timestamp()),'Actual naturally due offboarding executes';
    execute 'reset role';
   else
    insert into public.internal_org_people(id,full_name,company_key,position_title,is_active,parent_id) values(pg_temp.splice_id(70),'Synthetic History Free Target','mam','Synthetic role',false,pg_temp.splice_id(3));
    delete from private.employee_check_in_enrolments where person_id=pg_temp.splice_id(70);
    update public.internal_org_people set parent_id=pg_temp.splice_id(70) where id in(pg_temp.splice_id(30),pg_temp.splice_id(40),pg_temp.splice_id(50));
    insert into splice_versions(id,person_version) select id,version from public.internal_org_people where id=pg_temp.splice_id(70);
    execute 'set local role authenticated';
    perform public.delete_employee_directory_record(pg_temp.splice_id(70),(select person_version from splice_versions where id=pg_temp.splice_id(70)));
    execute 'reset role';
    assert not exists(select 1 from public.internal_org_people where id=pg_temp.splice_id(70)),'Eligible archived target permanently deleted';
   end if;
 assert not exists(select 1 from reminders_before b full join (select id,to_jsonb(r) value from private.employee_new_starter_day_one_reminders r where person_id in(pg_temp.splice_id(30),pg_temp.splice_id(60),pg_temp.splice_id(61))) a using(id) where a.value is distinct from b.value),'Parent-only archive preserves direct and deep Day1 claims plus delivered history byte-for-byte';
 assert (select value from contexts_before where id=pg_temp.splice_id(60))=(select to_jsonb(c) from private.employee_new_starter_day_one_context(pg_temp.splice_id(60)) c),'Deep Day1 manager context unchanged';
 assert not exists(select 1 from durable_before b full join private.notification_delivery_receipts r using(event_key) where to_jsonb(r) is distinct from b.value),'All durable delivery receipts/tokens preserved';
 assert not exists(select 1 from events_before b full join private.employee_new_starter_day_one_events e using(id) where to_jsonb(e) is distinct from b.value),'Parent-only splice does not reschedule Day1 or rewrite events';
 select value into direct_before from reminders_before where person_id=pg_temp.splice_id(30);
 select value into deep_before from reminders_before where person_id=pg_temp.splice_id(60);
 select * into prepared from public.prepare_new_starter_day_one_delivery((direct_before->>'id')::uuid,(direct_before->>'claim_token')::uuid);
 assert found and prepared.manager_email='manager3@example.test','Preserved direct claim prepare rechecks and uses current active successor manager';
 select * into prepared from public.prepare_new_starter_day_one_delivery((deep_before->>'id')::uuid,(deep_before->>'claim_token')::uuid);
 assert found and prepared.manager_email='starter30@example.test','Preserved deep claim prepare uses unchanged direct manager';
 assert public.complete_new_starter_day_one_delivery((direct_before->>'id')::uuid,(direct_before->>'claim_token')::uuid),'Existing direct claimant can complete after archive';
 assert public.complete_new_starter_day_one_delivery((deep_before->>'id')::uuid,(deep_before->>'claim_token')::uuid),'Existing deep claimant can complete after archive';
 assert (select count(*)=2 from private.employee_new_starter_day_one_reminders where person_id in(pg_temp.splice_id(30),pg_temp.splice_id(60)) and status='delivered' and delivered_at is not null),'Both successful completions retain delivered state';
   raise exception 'Rollback positive Day1 splice case' using errcode='ZX002';
  exception when sqlstate 'ZX002' then null; end;
  assert (select value from all_before)=pg_temp.data_footprint(),'All table rows restored after each archive/due/delete case';
 end loop;
end $$;
rollback;
\echo PASS: natural direct/deep Day1 claims and completed history survive archive, due offboarding and eligible delete; old tokens prepare current manager and complete; all data rolls back
