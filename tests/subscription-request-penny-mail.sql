\set ON_ERROR_STOP on
begin;
do $$ begin assert current_database() ~ '^mam_test_', 'Disposable synthetic database required'; end $$;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,work_email) values
('a1000000-0000-4000-8000-000000000004','Synthetic','applicant@example.test'),
('a1000000-0000-4000-8000-000000000013','Synthetic','penny@example.test');
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000013',approver_person_id='a1000000-0000-4000-8000-000000000013';
update private.notification_delivery_control set ready=true,legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=now() where singleton;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare n integer; begin
 for n in 1..8 loop
  perform public.sr_mutate(('b2200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,0,'submit',
    '{"kind":"new_purchase","service":"Synthetic approval service","purpose":"Work","company":"mam","payer":"MAM","duration":"1 year","billing":"annual","currency":"AUD","tax":"Inclusive","quoteCents":1000,"audEstimateCents":1000,"payment":"card","cardLabel":"Synthetic corporate card","cardHolder":"Synthetic card holder","intendedUsers":"Team"}');
 end loop;
 begin perform public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000001:1','penny@example.test','applicant@example.test');raise exception 'Browser reserved mail';exception when insufficient_privilege then null;end;
 begin perform private.sr_mail_recipients('b2200000-0000-4000-8000-000000000001');raise exception 'Browser read private recipients';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role service_role;
do $$ declare item record; k text:='subscription-request:b2200000-0000-4000-8000-000000000001:1'; begin
 select * into strict item from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000001',1);
 assert item.payload->>'version'='2' and item.payload->>'approverWorkEmail'='penny@example.test';
 assert item.payload->>'applicantWorkEmail'='applicant@example.test';
 assert item.payload->'request'->>'cardLabel'='Synthetic corporate card' and item.payload->'request'->>'cardHolder'='Synthetic card holder';
 assert not (item.payload->'request' ? 'password') and not (item.payload->'request' ? 'evidence');
 assert public.reserve_subscription_request_mail(k,'marketing@example.test','applicant@example.test')->>'outcome'='rejected', 'Stale Marketing route cannot reserve';
 assert public.reserve_subscription_request_mail(k,'penny@example.test','other@example.test')->>'outcome'='rejected', 'Wrong CC cannot reserve';
 assert public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test,other@example.test')->>'outcome'='rejected', 'Extra CC cannot reserve';
 assert public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000001:2','penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Noncurrent version cannot reserve';
end $$;
reset role;
update private.employee_directory_details set work_email='new-penny@example.test' where person_id='a1000000-0000-4000-8000-000000000013';
set local role service_role;
do $$ declare k text:='subscription-request:b2200000-0000-4000-8000-000000000001:1'; begin
 assert public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Changed canonical recipient fences a stale claim';
end $$;
reset role;
update private.employee_directory_details set work_email='penny@example.test' where person_id='a1000000-0000-4000-8000-000000000013';
update public.profiles set account_status='disabled',disabled_at=now() where id='a1000000-0000-4000-8000-000000000013';
do $$ begin
 assert public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000001:1','penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Inactive approver cannot reserve';
 begin perform public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000008',1);raise exception 'Inactive approver silently claimed';exception when sqlstate '55000' then null;end;
end $$;
update public.profiles set account_status='active',disabled_at=null where id='a1000000-0000-4000-8000-000000000013';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin perform public.sr_mutate('b2200000-0000-4000-8000-000000000002',1,'withdraw'); end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
do $$ begin perform public.sr_mutate('b2200000-0000-4000-8000-000000000003',1,'approve'); end $$;
reset role;
set local role service_role;
do $$ begin
 assert public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000002:1','penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Withdrawal after selection fences send permission';
 assert public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000003:1','penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Approval after selection suppresses stale reminder';
 assert (select count(*)=0 from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000002',1));
end $$;
reset role;
update private.employee_directory_details set work_email=null where person_id='a1000000-0000-4000-8000-000000000004';
do $$ begin
 assert (select count(*)=0 from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000004',1));
 assert public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000004:1','penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Invalid canonical CC is never silently removed';
end $$;
update private.employee_directory_details set work_email='applicant@example.test' where person_id='a1000000-0000-4000-8000-000000000004';
insert into private.employee_directory_details(person_id,first_name,work_email) values('a1000000-0000-4000-8000-000000000006','Synthetic','penny@example.test');
do $$ begin
 assert public.reserve_subscription_request_mail('subscription-request:b2200000-0000-4000-8000-000000000004:1','penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Ambiguous recipient email cannot reserve';
end $$;
delete from private.employee_directory_details where person_id='a1000000-0000-4000-8000-000000000006';
do $$ declare response jsonb; k text; begin
 k:='subscription-request:b2200000-0000-4000-8000-000000000005:1';
 response:=public.reserve_notification_delivery(k,'marketing@example.test','applicant@example.test');
 assert response->>'outcome'='send';
 assert public.confirm_notification_delivery(k,(response->>'deliveryToken')::uuid,'marketing@example.test','applicant@example.test','{"accepted":true,"messageId":"synthetic-marketing-delivery","requestId":null,"statusCode":202}')->>'sent'='true';
 assert public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Old Marketing receipt never permits a second delivery';
 assert (select count(*)=0 from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000005',1));
 k:='subscription-request:b2200000-0000-4000-8000-000000000006:1';
 response:=public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test');assert response->>'outcome'='send';
 assert public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Unknown processing outcome never resends';
 assert (select count(*)=0 from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000006',1));
 k:='subscription-request:b2200000-0000-4000-8000-000000000007:1';
 response:=public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test');assert response->>'outcome'='send';
 assert public.confirm_notification_delivery(k,(response->>'deliveryToken')::uuid,'penny@example.test','applicant@example.test','{"accepted":true,"messageId":"synthetic-penny-delivery","requestId":null,"statusCode":202}')->>'sent'='true';
 assert public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test')->>'outcome'='duplicate', 'Matching confirmed receipt is read-only delivery proof';
end $$;
update private.subscription_request_config set approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
do $$ declare k text:='subscription-request:b2200000-0000-4000-8000-000000000008:1'; item record; begin
 assert public.reserve_subscription_request_mail(k,'penny@example.test','applicant@example.test')->>'outcome'='rejected', 'Changed approver configuration fences stale To/CC';
 select * into strict item from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000008',1);
 assert item.payload->>'approverWorkEmail'='applicant@example.test';
 assert public.reserve_subscription_request_mail(k,'applicant@example.test','')->>'outcome'='send', 'Applicant who is also approver is not duplicated in CC';
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin
 perform public.sr_mutate('b2200000-0000-4000-8000-000000000009',0,'submit',
   '{"formVersion":2,"kind":"new_purchase","service":"Synthetic simple request","purpose":"Work","company":"mam","duration":"ongoing","billing":"annual","currency":"AUD","quoteCents":10000,"audEstimateCents":10000,"monthlyCostCents":1000,"annualCostCents":10000,"payment":"non_card","intendedUsers":"Team"}');
end $$;
reset role;
set local role service_role;
do $$ declare item record; begin
 select * into strict item from public.claim_subscription_request_mail('b2200000-0000-4000-8000-000000000009',1);
 assert item.payload->'request'->>'formVersion'='2';
 assert item.payload->'request'->>'monthlyCostCents'='1000' and item.payload->'request'->>'annualCostCents'='10000', 'Monthly and annual quotes remain independent in the canonical email';
 assert item.payload->'request'->'cardLabel'='null'::jsonb and item.payload->'request'->'cardHolder'='null'::jsonb, 'Noncard mail omits unused card details';
end $$;
reset role;
rollback;
\echo PASS: canonical Penny approval mail, applicant CC, state revalidation, old Marketing receipts and uncertain-delivery fencing
