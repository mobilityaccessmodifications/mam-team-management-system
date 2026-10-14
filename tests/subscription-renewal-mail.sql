\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
create or replace function private.mam_local_calendar_date() returns date language sql stable set search_path='' as $$ select date '2026-10-14' $$;
insert into private.subscription_management_grants(person_id,employee_delegation_confirmed) values
 ('a1000000-0000-4000-8000-000000000001',true),('a1000000-0000-4000-8000-000000000004',false);
insert into private.employee_directory_details(person_id,first_name,work_email) values
 ('a1000000-0000-4000-8000-000000000001','Synthetic','register@example.test'),
 ('a1000000-0000-4000-8000-000000000004','Synthetic','penny@example.test'),
 ('a1000000-0000-4000-8000-000000000015','Synthetic','review-manager@example.test'),
 ('a1000000-0000-4000-8000-000000000008','Synthetic','owner@example.test'),
 ('a1000000-0000-4000-8000-000000000016','Synthetic','vault@example.test');
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,responsible_person_id,subscription_status,renewal_date,next_review_on)
select ('c7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'MAM-SUB-99100'||n,'Synthetic renewal '||n,
 case when n=5 then 'free' else 'paid' end,case when n<>5 then 'monthly' end,case when n<>5 then 100 end,
 'a1000000-0000-4000-8000-000000000008',case when n=6 then 'cancelled' when n=8 then 'paused' else 'active' end,
 case n when 1 then date '2026-10-21' when 2 then date '2026-10-14' when 3 then date '2026-10-22'
 when 4 then date '2026-10-13' when 7 then null when 8 then date '2026-10-21' else date '2026-10-21' end,
 date '2027-01-04' from generate_series(1,8)n;
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
update private.notification_delivery_control set ready=true,legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=now() where singleton;
set local role service_role;
do $$ declare row record; response jsonb; begin
 assert (select count(*)=3 from public.list_subscription_renewal_mail('2026-10-14')), 'Seven-day upcoming, newly due and paused recurring renewals selected';
 for row in select payload from public.list_subscription_renewal_mail('2026-10-14') loop
  assert row.payload->>'toRecipients'='penny@example.test,register@example.test,review-manager@example.test', 'Current global Register managers and Penny only';
  assert (select array_agg(key order by key) from jsonb_object_keys(row.payload)key)=array['deliveryId','event','nextRenewalOn','phase','serviceName','toRecipients','version'], 'Minimal credential-free renewal envelope';
  response:=public.reserve_subscription_renewal_mail(row.payload->>'deliveryId',row.payload->>'toRecipients','');
  assert response->>'outcome'='send', 'Each renewal phase reserves once';
  assert public.reserve_subscription_renewal_mail(row.payload->>'deliveryId',row.payload->>'toRecipients','')->>'outcome'<>'send', 'No duplicate send permission';
 end loop;
 assert (select count(*)=0 from public.list_subscription_renewal_mail('2026-10-14')), 'Processing/unknown receipts never become automatic resend permission';
 begin perform public.list_subscription_renewal_calendar_entries();raise exception 'Server role opened employee Calendar';exception when insufficient_privilege then null;end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000008');
set local role authenticated;
do $$ begin
 assert not public.can_view_subscription_renewal_calendar(), 'Responsible person without management delegation cannot read company renewals';
 assert (select count(*)=0 from public.list_subscription_renewal_calendar_entries());
 begin perform public.list_subscription_renewal_mail('2026-10-14');raise exception 'Employee accessed mail';exception when insufficient_privilege then null;end;
 begin perform public.list_subscription_renewal_calendar_entries_for_preview('a1000000-0000-4000-8000-000000000015');raise exception 'Employee impersonated manager';exception when insufficient_privilege then null;end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
 assert public.can_view_subscription_renewal_calendar(), 'Explicit global employee delegate may open renewal Calendar';
 assert (select count(*)=5 from public.list_subscription_renewal_calendar_entries()), 'Paid active/paused dates only, including overdue, separate from review date';
 assert (select due_date=date '2026-10-21' from public.list_subscription_renewal_calendar_entries() where subscription_id='c7000000-0000-4000-8000-000000000001');
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000005');
set local role authenticated;
do $$ begin
 assert (select count(*)=5 from public.list_subscription_renewal_calendar_entries_for_preview('a1000000-0000-4000-8000-000000000001'));
 assert (select count(*)=0 from public.list_subscription_renewal_calendar_entries_for_preview('a1000000-0000-4000-8000-000000000008'));
end $$;
reset role;
create or replace function private.mam_local_calendar_date() returns date language sql stable set search_path='' as $$ select date '2026-10-21' $$;
set local role service_role;
do $$ declare item jsonb; begin
 select payload into strict item from public.list_subscription_renewal_mail('2026-10-14') where payload->>'serviceName'='Synthetic renewal 1';
 assert item->>'phase'='due' and item->>'nextRenewalOn'='2026-10-21', 'Separate due phase while renewal date remains unchanged';
end $$;
reset role;
update private.subscription_request_config set enabled=false;
update private.subscription_register set renewal_date='2027-10-21' where id='c7000000-0000-4000-8000-000000000001';
update private.subscription_request_config set enabled=true;
update private.subscription_register set subscription_status='cancelled' where id='c7000000-0000-4000-8000-000000000008';
set local role service_role;
do $$ begin
 assert public.reserve_subscription_renewal_mail('subscription-renewal:c7000000-0000-4000-8000-000000000001:2026-10-21:due','penny@example.test,register@example.test,review-manager@example.test','')->>'outcome'='rejected', 'Renewal date changed after selection blocks stale send';
 assert public.reserve_subscription_renewal_mail('subscription-renewal:c7000000-0000-4000-8000-000000000008:2026-10-21:due','penny@example.test,register@example.test,review-manager@example.test','')->>'outcome'='rejected', 'Cancellation after selection blocks send';
end $$;
reset role;
update private.employee_directory_details set work_email=null where person_id='a1000000-0000-4000-8000-000000000015';
do $$ begin
 begin perform public.list_subscription_renewal_mail('2026-10-14');raise exception 'Missing manager email silently dropped';exception when sqlstate '55000' then null;end;
end $$;
update private.employee_directory_details set work_email='review-manager@example.test' where person_id='a1000000-0000-4000-8000-000000000015';
delete from private.subscription_management_grants where person_id='a1000000-0000-4000-8000-000000000015';
set local role service_role;
do $$ declare item jsonb; begin
 select payload into strict item from public.list_subscription_renewal_mail('2026-10-14') where payload->>'serviceName'='Synthetic renewal 3';
 assert public.reserve_subscription_renewal_mail(item->>'deliveryId','penny@example.test,register@example.test,review-manager@example.test','')->>'outcome'='rejected', 'Stale recipients after delegation revocation denied';
 assert item->>'toRecipients'='penny@example.test,register@example.test';
 assert public.reserve_subscription_renewal_mail(item->>'deliveryId',item->>'toRecipients','')->>'outcome'='send', 'Current recipients may reserve the new date';
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform public.list_subscription_renewal_mail('2026-10-14');raise exception 'Anonymous accessed mail';exception when insufficient_privilege then null;end;
 begin perform public.list_subscription_renewal_calendar_entries();raise exception 'Anonymous accessed Calendar';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
\echo PASS: distinct renewal dates, seven-day/due once, no history/free/cancelled/one-off sends, canonical global delegates/Penny, permanent receipts, stale-date/cancellation/recipient denial and scoped Calendar
