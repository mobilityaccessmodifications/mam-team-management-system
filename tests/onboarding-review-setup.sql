begin;
insert into auth.users(id,email,email_confirmed_at)
select ('73000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic-review-race-'||n||'@example.test',now() from generate_series(1,8) n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select ('73000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic review race '||n,
  case when n in (1,2) then 'system_admin' when n=3 then 'admin' when n=4 then 'manager' when n=5 then 'account' else 'employee' end,
  'synthetic-review-race-'||n||case when n in (1,2) then '' else '@example.test' end,now()-interval '1 day' from generate_series(1,8) n;
insert into public.internal_org_people(id,full_name,node_kind,company_key,position_title,auth_user_id,started_date)
select ('74000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic review race employee '||n,'person','mam','Synthetic tester',
  ('73000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,current_date+1 from generate_series(3,8) n;
insert into private.employee_directory_details(person_id,first_name,work_email)
select ('74000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic','synthetic-review-race-'||n||'@example.test' from generate_series(3,8) n;
update private.employee_onboarding_credentials set status='needs_review',review_code='delivery_uncertain',
  claimed_login='synthetic-review-race-'||right(person_id::text,1)||'@example.test',
  claimed_work_email='synthetic-review-race-'||right(person_id::text,1)||'@example.test',
  claim_token=gen_random_uuid(),claim_expires_at=clock_timestamp()+interval '10 minutes',
  updated_at='2026-10-01T05:00:00.123456+00:00'
where person_id in ('74000000-0000-4000-8000-000000000006','74000000-0000-4000-8000-000000000008');
insert into private.employee_onboarding_credential_events(delivery_id,event_type,code)
select id,'needs_review','delivery_uncertain' from private.employee_onboarding_credentials
where person_id in ('74000000-0000-4000-8000-000000000006','74000000-0000-4000-8000-000000000008');
insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc,provider_receipt,sent_at)
select 'onboarding-credential:'||id,case when right(person_id::text,1)='6' then 'processing' else 'sent' end,
  gen_random_uuid(),'synthetic-private@example.test','',
  case when right(person_id::text,1)='6' then null else '{"accepted":true,"messageId":"synthetic-receipt","requestId":null,"statusCode":202}'::jsonb end,
  case when right(person_id::text,1)='6' then null else clock_timestamp() end
from private.employee_onboarding_credentials
where person_id in ('74000000-0000-4000-8000-000000000006','74000000-0000-4000-8000-000000000008');
commit;
