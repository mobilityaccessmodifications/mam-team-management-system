create function pg_temp.assert_true(value boolean,label text) returns void language plpgsql as $$ begin
  if value is distinct from true then raise exception 'FAIL: %',label; end if;
end $$;
select pg_temp.assert_true((select not enabled and activated_at is null from private.employee_lifecycle_mail_control),'disabled installation');
select pg_temp.assert_true((select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema),'catalog accurate');
insert into public.profiles(id,account_status,app_role)
select ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'active',case when i>4 then 'manager' else 'employee' end from generate_series(1,8) i;
insert into public.internal_org_people(id,full_name,auth_user_id,company_key,started_date)
select ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Synthetic Contact '||i,('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,case when i=8 then 'equipsy' else 'mam' end,current_date from generate_series(1,8) i;
insert into private.employee_directory_details(person_id,work_email)
select id,'contact'||right(id::text,1)||'@example.test' from public.internal_org_people;
insert into private.employee_lifecycle_mail_recipients(slot,person_id,approved_email,company_key,team_name)
select slot,('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'contact'||i||'@example.test',company,team
from (values(1,'hr',null,null),(2,'accounts',null,null),(3,'bookkeeper',null,null),(4,'reporting',null,null),(5,'minor','mam','Minor'),(6,'major','mam','Major'),(7,'warehouse','mam','Warehouse'),(8,'equipsy','equipsy','Equipsy')) c(i,slot,company,team);
insert into private.employee_lifecycle_mail_recipients(slot,approved_email) values('it','external.it@example.test');
insert into public.internal_org_people(id,full_name,started_date,is_active) values
('30000000-0000-4000-8000-000000000001','Historical Active',current_date,true),
('30000000-0000-4000-8000-000000000002','Existing Future',current_date,true),
('30000000-0000-4000-8000-000000000003','Existing Today',current_date,true),
('30000000-0000-4000-8000-000000000004','Historical Archive',current_date-10,false);
insert into private.employee_directory_details(person_id,team_name,scheduled_employment_end_date) values
('30000000-0000-4000-8000-000000000001','Management',null),
('30000000-0000-4000-8000-000000000002','Minor',current_date+10),
('30000000-0000-4000-8000-000000000003','Minor',(clock_timestamp() at time zone 'Australia/Melbourne')::date),
('30000000-0000-4000-8000-000000000004','Minor',current_date-1);
insert into private.scheduled_employee_offboarding(person_id,end_date)
select person_id,scheduled_employment_end_date from private.employee_directory_details where scheduled_employment_end_date is not null;
select pg_temp.assert_true((select count(*)=0 from private.employee_lifecycle_mail_outbox),'disabled does not queue');
update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();
select private.set_notification_delivery_ready(true);
select pg_temp.assert_true((public.set_employee_lifecycle_mail_enabled(true)->>'futureSchedulesSeeded')::integer=1,'activate seeds future only');
select pg_temp.assert_true((public.set_employee_lifecycle_mail_enabled(true)->>'futureSchedulesSeeded')::integer=0,'activation idempotent');
select pg_temp.assert_true((select count(*)=1 from private.employee_lifecycle_mail_outbox),'no historical backfill');
update public.internal_org_people set position_title='Updated' where id='30000000-0000-4000-8000-000000000001';
update public.internal_org_people set position_title='Updated' where id='30000000-0000-4000-8000-000000000004';
select pg_temp.assert_true((select count(*)=1 from private.employee_lifecycle_mail_outbox),'updates never replay onboarding/archive');

begin;
insert into public.internal_org_people(id,full_name,position_title,started_date,parent_id) values('40000000-0000-4000-8000-000000000001','New Synthetic','Synthetic worker',current_date,'20000000-0000-4000-8000-000000000007');
select pg_temp.assert_true(not exists(select 1 from private.employee_lifecycle_mail_outbox where person_id='40000000-0000-4000-8000-000000000001'),'creation is deferred until details complete');
insert into private.employee_directory_details(person_id,team_name,country,employment_type,personal_email,archive_reason) values('40000000-0000-4000-8000-000000000001','Warehouse','Australia','Full Time','private@example.test','Synthetic private reason');
commit;
do $$ declare c record; r jsonb; t uuid; begin
  select * into strict c from public.claim_employee_lifecycle_mail('40000000-0000-4000-8000-000000000001');
  assert c.payload->>'recipient'='contact1@example.test,contact2@example.test,contact3@example.test,contact4@example.test,contact7@example.test,external.it@example.test','warehouse manager included';
  assert (select array_agg(k order by k) from jsonb_object_keys(c.payload) k)=array['employee','event','eventKey','personId','recipient'];
  assert c.payload->'employee'=('{"name":"New Synthetic","company":"MAM","role":"Synthetic worker","department":"Warehouse","location":"Australia","employmentType":"Full Time","startDate":"'||to_char(current_date,'YYYY-MM-DD')||'","endDate":null}')::jsonb;
  assert not (c.payload::text like '%private@example%' or c.payload::text like '%private reason%');
  assert not exists(select 1 from public.claim_employee_lifecycle_mail(c.person_id)),'cannot double claim';
  assert not public.finish_employee_lifecycle_mail(c.delivery_id,c.claim_token,true),'finish requires actual receipt';
  assert public.finish_employee_lifecycle_mail(c.delivery_id,c.claim_token,false),'pre-send retry is safe';
  select * into strict c from public.claim_employee_lifecycle_mail(c.person_id);
  r:=public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token);
  assert r->>'outcome'='send';t:=(r->>'deliveryToken')::uuid;
  assert public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token)->>'rejectionCode'='delivery-in-flight';
  assert public.finish_employee_lifecycle_mail(c.delivery_id,c.claim_token,false);
  assert (select state='needs_review' from private.employee_lifecycle_mail_outbox where delivery_id=c.delivery_id);
  assert not exists(select 1 from public.claim_employee_lifecycle_mail(c.person_id)),'ambiguous send not reclaimed';
  perform public.confirm_notification_delivery(c.payload->>'eventKey',t,c.payload->>'recipient','',jsonb_build_object('accepted',true,'messageId','synthetic','requestId',null,'statusCode',202));
  assert public.finish_employee_lifecycle_mail(c.delivery_id,c.claim_token,true),'late confirmed delivery recovers';
  assert public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token)->>'outcome'='duplicate';
end $$;

begin;
insert into public.internal_org_people(id,full_name,started_date) values('40000000-0000-4000-8000-000000000002','Rollback Synthetic',current_date);
insert into private.employee_directory_details(person_id) values('40000000-0000-4000-8000-000000000002');
rollback;
select pg_temp.assert_true(not exists(select 1 from private.employee_lifecycle_mail_outbox where person_id='40000000-0000-4000-8000-000000000002'),'rolled back creation never queues');

begin;
update public.internal_org_people set is_active=false where id='30000000-0000-4000-8000-000000000001';
update private.employee_directory_details set scheduled_employment_end_date=current_date-1,archive_reason='Private exit reason' where person_id='30000000-0000-4000-8000-000000000001';
commit;
select pg_temp.assert_true((select due_at between clock_timestamp()-interval '1 minute' and clock_timestamp() from private.employee_lifecycle_mail_outbox where person_id='30000000-0000-4000-8000-000000000001' and event='offboarding'),'overdue archive immediate');
do $$ declare c record; begin
 select * into strict c from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000001');
 assert c.payload->>'event'='offboarding';
 assert c.payload->'employee'->>'endDate'=to_char(current_date-1,'YYYY-MM-DD');
 assert c.payload->>'recipient'='contact1@example.test,contact2@example.test,contact3@example.test,contact4@example.test,external.it@example.test','unmapped gets core only';
end $$;

begin;
update private.employee_directory_details set scheduled_employment_end_date='2027-01-15' where person_id='30000000-0000-4000-8000-000000000002';
update private.scheduled_employee_offboarding set end_date='2027-01-15' where person_id='30000000-0000-4000-8000-000000000002';
commit;
select pg_temp.assert_true((select due_at='2027-01-14 22:00:00+00'::timestamptz from private.employee_lifecycle_mail_outbox where person_id='30000000-0000-4000-8000-000000000002'),'09:00 summer DST');
begin;
update private.employee_directory_details set scheduled_employment_end_date='2027-07-15' where person_id='30000000-0000-4000-8000-000000000002';
update private.scheduled_employee_offboarding set end_date='2027-07-15' where person_id='30000000-0000-4000-8000-000000000002';
commit;
select pg_temp.assert_true((select due_at='2027-07-14 23:00:00+00'::timestamptz from private.employee_lifecycle_mail_outbox where person_id='30000000-0000-4000-8000-000000000002'),'09:00 winter DST');
select pg_temp.assert_true(not exists(select 1 from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000002')),'cannot claim before due');
begin;
delete from private.scheduled_employee_offboarding where person_id='30000000-0000-4000-8000-000000000002';
update private.employee_directory_details set scheduled_employment_end_date=null where person_id='30000000-0000-4000-8000-000000000002';
commit;
select pg_temp.assert_true((select state='cancelled' from private.employee_lifecycle_mail_outbox where person_id='30000000-0000-4000-8000-000000000002'),'schedule cancellation');

begin;
update private.employee_directory_details set scheduled_employment_end_date=current_date-1 where person_id='30000000-0000-4000-8000-000000000002';
insert into private.scheduled_employee_offboarding(person_id,end_date) values('30000000-0000-4000-8000-000000000002',current_date-1);
commit;
create temporary table stale_claim as select * from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000002');
begin;
update private.employee_directory_details set scheduled_employment_end_date=current_date+30 where person_id='30000000-0000-4000-8000-000000000002';
update private.scheduled_employee_offboarding set end_date=current_date+30 where person_id='30000000-0000-4000-8000-000000000002';
commit;
select pg_temp.assert_true(public.reserve_employee_lifecycle_mail(payload->>'eventKey',payload->>'recipient','',claim_token)->>'outcome'='rejected','date change invalidates prior claim') from stale_claim;
select pg_temp.assert_true(not exists(select 1 from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000002')),'rescheduled not yet due');
begin;
update private.employee_directory_details set scheduled_employment_end_date=current_date-1 where person_id='30000000-0000-4000-8000-000000000002';
update private.scheduled_employee_offboarding set end_date=current_date-1 where person_id='30000000-0000-4000-8000-000000000002';
commit;
truncate stale_claim;
insert into stale_claim select * from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000002');
begin;
delete from private.scheduled_employee_offboarding where person_id='30000000-0000-4000-8000-000000000002';
update private.employee_directory_details set scheduled_employment_end_date=null where person_id='30000000-0000-4000-8000-000000000002';
commit;
select pg_temp.assert_true(public.reserve_employee_lifecycle_mail(payload->>'eventKey',payload->>'recipient','',claim_token)->>'outcome'='rejected','cancellation invalidates prior claim') from stale_claim;

begin;
insert into public.internal_org_people(id,full_name,started_date,parent_id) values('50000000-0000-4000-8000-000000000001','Ancestor Synthetic',current_date,'20000000-0000-4000-8000-000000000006');
insert into private.employee_directory_details(person_id,team_name) values('50000000-0000-4000-8000-000000000001','Minor');
commit;
do $$ declare c record; r jsonb; begin
  select * into strict c from public.claim_employee_lifecycle_mail('50000000-0000-4000-8000-000000000001');
  assert position('contact6@' in c.payload->>'recipient')>0 and position('contact5@' in c.payload->>'recipient')=0,'nearest approved ancestor preferred';
  update private.employee_directory_details set work_email='changed@example.test' where person_id='20000000-0000-4000-8000-000000000006';
  r:=public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token);
  assert r->>'outcome'='rejected','approved manager email revalidated';
  update private.employee_directory_details set work_email='contact6@example.test' where person_id='20000000-0000-4000-8000-000000000006';
  update public.profiles set app_role='employee' where id='10000000-0000-4000-8000-000000000006';
  assert public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token)->>'outcome'='rejected','manager role revalidated';
  update public.profiles set app_role='manager' where id='10000000-0000-4000-8000-000000000006';
  update public.internal_org_people set position_title='Changed role' where id=c.person_id;
  assert public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token)->>'outcome'='rejected','employee snapshot revalidated';
  assert public.finish_employee_lifecycle_mail(c.delivery_id,c.claim_token,false);
end $$;

begin;
update public.internal_org_people set is_active=false,parent_id=null where id='50000000-0000-4000-8000-000000000001';
update private.employee_directory_details set scheduled_employment_end_date=(clock_timestamp() at time zone 'Australia/Melbourne')::date where person_id='50000000-0000-4000-8000-000000000001';
commit;
do $$ declare c record; begin
  select * into strict c from public.claim_employee_lifecycle_mail('50000000-0000-4000-8000-000000000001');
  assert c.payload->>'event'='offboarding';
  assert position('contact5@' in c.payload->>'recipient')>0,'archive after reparent uses team fallback';
end $$;

begin;
update public.internal_org_people set is_active=false where id='30000000-0000-4000-8000-000000000003';
commit;
select pg_temp.assert_true(not exists(select 1 from private.employee_lifecycle_mail_outbox where person_id='30000000-0000-4000-8000-000000000003'),'historical scheduled autoarchive never creates first email');

do $$ declare role text; signature text; begin
 foreach role in array array['anon','authenticated','service_role'] loop
  foreach signature in array array['public.claim_employee_lifecycle_mail(uuid,integer)','public.reserve_employee_lifecycle_mail(text,text,text,uuid,text)','public.finish_employee_lifecycle_mail(uuid,uuid,boolean)','public.set_employee_lifecycle_mail_enabled(boolean)'] loop
   assert has_function_privilege(role,signature,'EXECUTE')=(role='service_role'),'RPC ACL';
  end loop;
  assert not has_table_privilege(role,'private.employee_lifecycle_mail_outbox','SELECT');
  assert not has_table_privilege(role,'private.employee_lifecycle_mail_recipients','SELECT');
  assert not has_function_privilege(role,'private.queue_employee_lifecycle_mail_person()','EXECUTE');
 end loop;
 assert (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('private.employee_lifecycle_mail_outbox'::regclass,'private.employee_lifecycle_mail_recipients'::regclass,'private.employee_lifecycle_mail_control'::regclass));
 assert private.notification_event_key_valid('performance-review:50000000-0000-4000-8000-000000000001:manager-invited');
 assert private.notification_event_key_valid('employee-lifecycle:50000000-0000-4000-8000-000000000001:offboarding');
 assert not private.notification_event_key_valid('employee-lifecycle:bad:offboarding');
end $$;

begin;
update public.internal_org_people set is_active=true where id='30000000-0000-4000-8000-000000000003';
commit;
begin;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
update public.internal_org_people set is_active=false where id='30000000-0000-4000-8000-000000000003';
commit;
select pg_temp.assert_true((select count(*)=1 and bool_and(due_at<=clock_timestamp()) from private.employee_lifecycle_mail_outbox where person_id='30000000-0000-4000-8000-000000000003' and event='offboarding'),'HR confirmation captures existing overdue schedule immediately');

begin;
update public.internal_org_people set is_active=true where id='50000000-0000-4000-8000-000000000001';
update private.employee_directory_details set scheduled_employment_end_date=current_date-1 where person_id='50000000-0000-4000-8000-000000000001';
insert into private.scheduled_employee_offboarding(person_id,end_date) values('50000000-0000-4000-8000-000000000001',current_date-1);
commit;
do $$ declare c record;r jsonb; begin
  select * into strict c from public.claim_employee_lifecycle_mail('50000000-0000-4000-8000-000000000001');
  r:=public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token);
  assert r->>'outcome'='send';
  perform public.confirm_notification_delivery(c.payload->>'eventKey',(r->>'deliveryToken')::uuid,c.payload->>'recipient','',jsonb_build_object('accepted',true,'messageId','scheduled-synthetic','requestId',null,'statusCode',202));
  assert public.finish_employee_lifecycle_mail(c.delivery_id,c.claim_token,true);
end $$;
update public.internal_org_people set is_active=false where id='50000000-0000-4000-8000-000000000001';
select pg_temp.assert_true((select count(*)=1 and bool_and(state='provider_accepted') from private.employee_lifecycle_mail_outbox where person_id='50000000-0000-4000-8000-000000000001' and event='offboarding'),'autoarchive after notification does not create a second delivery');

begin;
update private.employee_directory_details set team_name='Warehouse' where person_id='20000000-0000-4000-8000-000000000007';
select private.sync_employee_lifecycle_mail('20000000-0000-4000-8000-000000000007','onboarding',null,clock_timestamp());
select pg_temp.assert_true(position('contact7@' in payload->>'recipient')=0,'manager subject excluded') from public.claim_employee_lifecycle_mail('20000000-0000-4000-8000-000000000007');
rollback;

begin;
insert into public.internal_org_people(id,full_name,company_key,started_date) values('60000000-0000-4000-8000-000000000001','Equipsy Synthetic','equipsy',current_date);
insert into private.employee_directory_details(person_id,team_name) values('60000000-0000-4000-8000-000000000001','Equipsy');
set constraints all immediate;
update private.employee_directory_details set work_email='wrong@example.test' where person_id='20000000-0000-4000-8000-000000000001';
select pg_temp.assert_true(not exists(select 1 from public.claim_employee_lifecycle_mail('60000000-0000-4000-8000-000000000001')),'core email revalidation fails closed');
update private.employee_directory_details set work_email='contact1@example.test' where person_id='20000000-0000-4000-8000-000000000001';
update public.profiles set account_status='disabled' where id='10000000-0000-4000-8000-000000000001';
select pg_temp.assert_true(not exists(select 1 from public.claim_employee_lifecycle_mail('60000000-0000-4000-8000-000000000001')),'inactive core profile fails closed');
update public.profiles set account_status='active' where id='10000000-0000-4000-8000-000000000001';
update private.employee_lifecycle_mail_recipients set approved_email='contact1@example.test' where slot='reporting';
update private.employee_directory_details set work_email='contact1@example.test' where person_id='20000000-0000-4000-8000-000000000004';
select pg_temp.assert_true(payload->>'recipient'='contact1@example.test,contact2@example.test,contact3@example.test,contact8@example.test,external.it@example.test','Equipsy fallback and duplicate address removed') from public.claim_employee_lifecycle_mail('60000000-0000-4000-8000-000000000001');
rollback;

begin;
update private.employee_directory_details set scheduled_employment_end_date=current_date-1 where person_id='30000000-0000-4000-8000-000000000002';
insert into private.scheduled_employee_offboarding(person_id,end_date) values('30000000-0000-4000-8000-000000000002',current_date-1);
commit;
truncate stale_claim;
insert into stale_claim select * from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000002');
select pg_temp.assert_true(public.reserve_employee_lifecycle_mail(payload->>'eventKey',payload->>'recipient','',claim_token)->>'outcome'='send','reserve before cancellation') from stale_claim;
begin;
delete from private.scheduled_employee_offboarding where person_id='30000000-0000-4000-8000-000000000002';
update private.employee_directory_details set scheduled_employment_end_date=null where person_id='30000000-0000-4000-8000-000000000002';
commit;
select pg_temp.assert_true(public.finish_employee_lifecycle_mail(delivery_id,claim_token,false),'reserved cancellation held') from stale_claim;
update private.employee_lifecycle_mail_outbox set claimed_at=clock_timestamp()-interval '1 day' where person_id='30000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(not exists(select 1 from public.claim_employee_lifecycle_mail('30000000-0000-4000-8000-000000000002')),'ambiguous reservation never expires into resend');

begin;
select public.set_employee_lifecycle_mail_enabled(false);
delete from private.employee_lifecycle_mail_recipients where slot='warehouse';
do $$ begin
  begin
    perform public.set_employee_lifecycle_mail_enabled(true);
    raise exception 'FAIL: incomplete configuration activated';
  exception when sqlstate '55000' then null; end;
end $$;
rollback;

begin;
set constraints all immediate;
do $$ declare team text; person uuid; c record; begin
  foreach team in array array['Management','Operation & Accounts',null]::text[] loop
    person:=gen_random_uuid();
    insert into public.internal_org_people(id,full_name,started_date,parent_id)
      values(person,'Other Team Synthetic',current_date,'20000000-0000-4000-8000-000000000007');
    insert into private.employee_directory_details(person_id,team_name) values(person,team);
    select * into strict c from public.claim_employee_lifecycle_mail(person);
    assert c.payload->>'recipient'='contact1@example.test,contact2@example.test,contact3@example.test,contact4@example.test,contact7@example.test,external.it@example.test',
      'approved ancestor must be included regardless of employee team';
    update public.profiles set app_role='employee' where id='10000000-0000-4000-8000-000000000007';
    assert public.reserve_employee_lifecycle_mail(c.payload->>'eventKey',c.payload->>'recipient','',c.claim_token)->>'outcome'='rejected',
      'ancestor for an unmapped team must still pass reserve-time manager validation';
    update public.profiles set app_role='manager' where id='10000000-0000-4000-8000-000000000007';
    update private.employee_directory_details set scheduled_employment_end_date=current_date-1 where person_id=person;
    update public.internal_org_people set is_active=false where id=person;
    select * into strict c from public.claim_employee_lifecycle_mail(person);
    assert c.payload->>'event'='offboarding' and position('contact7@' in c.payload->>'recipient')>0,
      'offboarding also resolves approved ancestor for an unmapped team';
  end loop;
  person:=gen_random_uuid();
  insert into public.internal_org_people(id,full_name,started_date,parent_id)
    values(person,'Other Company Ancestor Synthetic',current_date,'20000000-0000-4000-8000-000000000008');
  insert into private.employee_directory_details(person_id,team_name) values(person,'Management');
  select * into strict c from public.claim_employee_lifecycle_mail(person);
  assert c.payload->>'recipient'='contact1@example.test,contact2@example.test,contact3@example.test,contact4@example.test,external.it@example.test',
    'unmapped team with no same-company approved ancestor stays core-only';
end $$;
rollback;
