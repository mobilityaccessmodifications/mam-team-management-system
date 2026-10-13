\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,work_email) values('a1000000-0000-4000-8000-000000000004','Synthetic','applicant@example.test');
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
select public.sr_mutate('b1000000-0000-4000-8000-000000000007',0,'submit','{"kind":"new_purchase","service":"Synthetic Mail Service","purpose":"Work","company":"mam","payer":"MAM","duration":"1 year","billing":"annual","currency":"AUD","tax":"Inclusive","quoteCents":1000,"audEstimateCents":1000,"payment":"non_card","intendedUsers":"Team"}');
do $$ begin
 begin perform public.claim_subscription_request_mail();raise exception 'Applicant claimed server mail';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ declare row record; saved uuid; begin
 select * into row from public.claim_subscription_request_mail();
 assert row.request_id='b1000000-0000-4000-8000-000000000007'::uuid and row.version=1;
 assert row.payload->>'applicantWorkEmail'='applicant@example.test';
 assert row.payload->'request'->>'service'='Synthetic Mail Service';
 assert not (row.payload->'request' ? 'cardHolder') and not (row.payload->'request' ? 'evidence');
 saved:=row.claim_token;
 assert (select count(*)=0 from public.claim_subscription_request_mail()),'Concurrent claim duplicated';
 assert not public.finish_subscription_request_mail(row.request_id,row.version,'b1000000-0000-4000-8000-000000000009',true),'Wrong token accepted';
 assert not public.finish_subscription_request_mail(row.request_id,row.version,saved,false),'Failed send marked delivered';
 update private.subscription_request_mail_deliveries set claimed_at=clock_timestamp()-interval '16 minutes';
 select * into row from public.claim_subscription_request_mail();
 assert row.claim_token<>saved,'Stale lease reused';
 assert not public.finish_subscription_request_mail(row.request_id,row.version,saved,true),'Stale token accepted';
 assert public.finish_subscription_request_mail(row.request_id,row.version,row.claim_token,true),'Current receipt rejected';
 assert (select count(*)=0 from public.claim_subscription_request_mail()),'Delivered request requeued';
 assert private.notification_event_key_valid('onboarding-credential:b1000000-0000-4000-8000-000000000007');
 assert private.notification_event_key_valid('subscription-request:b1000000-0000-4000-8000-000000000007:1');
 assert not private.notification_event_key_valid('subscription-request:b1000000-0000-4000-8000-000000000007:0');
 assert private.notification_event_key_valid('leave:b1000000-0000-4000-8000-000000000007:leave-submitted:000000000000000000000000');
 assert private.notification_event_key_valid('checkin:b1000000-0000-4000-8000-000000000007:6-month:initial:live');
end $$;
rollback;
\echo PASS: submission mail authoritative contact, private claims, duplicate suppression, stale-token fencing and receipt keys
