\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
create or replace function private.mam_local_calendar_date() returns date language sql stable set search_path='' as $$ select date '2026-10-14' $$;
insert into private.subscription_management_grants(person_id,employee_delegation_confirmed) values('a1000000-0000-4000-8000-000000000001',true),('a1000000-0000-4000-8000-000000000004',false);
insert into private.employee_directory_details(person_id,first_name,work_email) values
('a1000000-0000-4000-8000-000000000001','Synthetic','register@example.test'),
('a1000000-0000-4000-8000-000000000004','Synthetic','penny@example.test'),
('a1000000-0000-4000-8000-000000000015','Synthetic','review-manager@example.test'),
('a1000000-0000-4000-8000-000000000008','Synthetic','owner@example.test'),
('a1000000-0000-4000-8000-000000000016','Synthetic','vault@example.test');
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,responsible_person_id,subscription_status,next_review_on)
select ('c4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'MAM-SUB-99010'||n,'Synthetic mail review '||n,
case when n=5 then 'free' else 'paid' end,case when n<>5 then 'monthly' end,case when n<>5 then 100 end,
'a1000000-0000-4000-8000-000000000008',case when n=6 then 'cancelled' else 'active' end,date '2026-10-14'
from generate_series(1,6)n;
update private.subscription_register set next_review_on=case right(id::text,1)::int when 1 then date '2026-10-21' when 2 then date '2026-10-14' when 3 then date '2026-10-22' when 4 then date '2026-10-13' else date '2026-10-21' end where id::text like 'c4000000%';
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
update private.notification_delivery_control set ready=true,legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=now() where singleton;
set local role service_role;
do $$ declare row record; response jsonb; begin
 assert (select count(*)=2 from public.list_subscription_review_mail('2026-10-14')), 'Only seven-day upcoming and newly due reviews are selected';
 for row in select payload from public.list_subscription_review_mail('2026-10-14') loop
  assert row.payload->>'toRecipients'='penny@example.test,register@example.test,review-manager@example.test', 'Penny and global register managers are canonical To; owner and vault delegates are excluded';
  assert (select array_agg(key order by key) from jsonb_object_keys(row.payload)key)=array['deliveryId','event','nextReviewOn','phase','serviceName','toRecipients','version'], 'No private financial or credential fields escape';
  response:=public.reserve_subscription_review_mail(row.payload->>'deliveryId',row.payload->>'toRecipients','');
  assert response->>'outcome'='send', 'New phase reserves once';
  assert public.reserve_subscription_review_mail(row.payload->>'deliveryId',row.payload->>'toRecipients','')->>'outcome'<>'send', 'Concurrent duplicate cannot reach sender';
 end loop;
 assert (select count(*)=0 from public.list_subscription_review_mail('2026-10-14')), 'Processing reservations never become automatic resend permission';
end $$;
reset role;
create or replace function private.mam_local_calendar_date() returns date language sql stable set search_path='' as $$ select date '2026-10-21' $$;
set local role service_role;
do $$ declare item jsonb; begin
 select payload into strict item from public.list_subscription_review_mail('2026-10-14') where payload->>'serviceName'='Synthetic mail review 1';
 assert item->>'phase'='due' and item->>'nextReviewOn'='2026-10-21', 'Upcoming review gets one distinct due reminder while incomplete';
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000015');
set local role authenticated;
select public.complete_my_subscription_review_task('c4000000-0000-4000-8000-000000000001',2);
do $$ begin
 begin perform public.list_subscription_review_mail('2026-10-14');raise exception 'Employee accessed server mail';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role service_role;
do $$ begin
 assert (select count(*)=0 from public.list_subscription_review_mail('2026-10-14') where payload->>'serviceName'='Synthetic mail review 1'), 'A completed review suppresses due mail for every manager';
 assert public.reserve_subscription_review_mail('subscription-review:c4000000-0000-4000-8000-000000000001:2026-10-21:due','penny@example.test,register@example.test,review-manager@example.test','')->>'outcome'='rejected', 'A review completed after selection cannot obtain send permission';
end $$;
reset role;
update private.employee_directory_details set work_email=null where person_id='a1000000-0000-4000-8000-000000000015';
do $$ begin
 begin perform public.list_subscription_review_mail('2026-10-14');raise exception 'Missing manager email was silently dropped';exception when sqlstate '55000' then null;end;
end $$;
update private.employee_directory_details set work_email='review-manager@example.test' where person_id='a1000000-0000-4000-8000-000000000015';
delete from private.subscription_management_grants where person_id='a1000000-0000-4000-8000-000000000015';
set local role service_role;
do $$ declare item jsonb; begin
 assert (select count(*)=0 from public.list_subscription_review_mail('2026-10-14') where payload->>'serviceName'='Synthetic mail review 1'), 'Revocation never reopens permanent receipt keys';
 select payload into strict item from public.list_subscription_review_mail('2026-10-14') where payload->>'serviceName'='Synthetic mail review 3';
 assert public.reserve_subscription_review_mail(item->>'deliveryId','penny@example.test,register@example.test,review-manager@example.test','')->>'outcome'='rejected', 'A revoked delegate in a stale recipient list cannot obtain send permission';
 assert not exists(select 1 from public.list_subscription_review_mail('2026-10-14') where payload->>'toRecipients' like '%review-manager@example.test%');
 assert public.reserve_subscription_review_mail(item->>'deliveryId',item->>'toRecipients','')->>'outcome'='send', 'Current canonical recipients can reserve the unsent review';
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform public.list_subscription_review_mail('2026-10-14');raise exception 'Anonymous accessed mail';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
\echo PASS: seven-day and due phases, canonical Penny/global-manager recipients, no historical/free/cancelled sends, permanent reservations, shared Done and missing-contact denial
