\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
do $$ begin assert to_regprocedure('public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb)') is not null, 'Request workflow RPC is not implemented'; end $$;
insert into private.subscription_request_config(singleton,enabled,approver_user_id,approver_person_id)
values(true,true,'a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000004')
on conflict(singleton) do update set enabled=true,approver_user_id=excluded.approver_user_id,approver_person_id=excluded.approver_person_id;
set local role authenticated;
do $$ declare id uuid:='b1000000-0000-4000-8000-000000000001'; result jsonb; input jsonb:='{"kind":"new_purchase","service":"Synthetic Service","plan":"Team","purpose":"Project work","company":"both","payer":"MAM","duration":"12 months","billing":"annual","currency":"USD","tax":"Exclusive","quoteCents":12000,"audEstimateCents":18000,"payment":"card","cardLabel":"Business card","cardHolder":"Synthetic holder","intendedUsers":"Project team"}'; begin
  result:=public.sr_mutate(id,0,'save','{}');
  assert result->>'status'='draft';
  result:=public.sr_mutate(id,1,'submit',input);
  assert result->>'status'='submitted';
  assert result->'payload'->>'responsiblePersonId'='a1000000-0000-4000-8000-000000000004';
  result:=public.sr_mutate(id,2,'approve');
  assert result->>'status'='approved', 'Designated approver may self-approve';
  begin perform public.sr_mutate(id,2,'reject',null,'Stale'); raise exception 'Duplicate decision succeeded'; exception when sqlstate 'PT409' then null; end;
  result:=public.sr_mutate(id,3,'withdraw');
  assert result->>'status'='withdrawn';
  assert jsonb_array_length(result->'events')=4, 'History must retain every operation';
end $$;
reset role;
do $$ begin
  assert (select count(*)=3 from private.subscription_request_notifications), 'Submit, approval and withdrawal contracts must be durable';
  assert not exists(select 1 from private.subscription_request_notifications where jsonb_array_length(cc_user_ids)<>0), 'No unconfirmed CC';
  assert (select count(*)=0 from private.subscription_register where service_name='Synthetic Service'), 'Approval must not activate register';
end $$;
rollback;
\echo PASS: request draft-submit-self-approval-withdraw, immutable snapshots and notification intents
begin;
\ir unified-role-fixture.sql
insert into private.subscription_request_config(singleton,enabled,approver_user_id,approver_person_id)
values(true,true,'a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000004')
on conflict(singleton) do update set enabled=true,approver_user_id=excluded.approver_user_id,approver_person_id=excluded.approver_person_id;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
select public.sr_mutate('b1000000-0000-4000-8000-000000000002',0,'save','{"service":"Private draft"}');
select public.sr_mutate('b1000000-0000-4000-8000-000000000002',1,'submit','{"kind":"renewal","service":"Submitted terms","purpose":"Work","company":"mam","payer":"MAM","duration":"1 year","billing":"annual","currency":"USD","tax":"Inclusive","quoteCents":1000,"audEstimateCents":1500,"payment":"non_card","intendedUsers":"Team"}','', '[{"name":"quote.pdf","mime":"application/pdf","base64":"JVBERi0x"}]');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare r jsonb; begin
  r:=public.sr_mutate('b1000000-0000-4000-8000-000000000002',2,'return',null,'Please revise');
  assert jsonb_array_length(r->'events')=2, 'Other request managers must never see private draft history';
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
select public.sr_mutate('b1000000-0000-4000-8000-000000000002',3,'save','{"service":"Private revised draft"}','','[]');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare r jsonb; begin
  select value into r from jsonb_array_elements(public.sr_workspace()->'requests');
  assert r->'payload'->>'service'='Submitted terms', 'Returned unsent edits must remain applicant-only';
  assert public.sr_download('b1000000-0000-4000-8000-000000000002',2,0)->>'base64'='JVBERi0x', 'Submitted evidence must survive returned edits';
  begin perform public.sr_download('b1000000-0000-4000-8000-000000000002',4,0); raise exception 'Other manager read private evidence'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
select public.sr_mutate('b1000000-0000-4000-8000-000000000002',4,'withdraw');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare r jsonb; begin
  select value into r from jsonb_array_elements(public.sr_workspace()->'requests');
  assert r->'payload'->>'service'='Submitted terms', 'Withdrawal must not publish a returned private draft';
end $$;
rollback;
\echo PASS: draft history privacy, returned edit isolation and immutable historical evidence
begin;
\ir unified-role-fixture.sql
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
select public.sr_mutate('b1000000-0000-4000-8000-000000000003',0,'save','{}');
select public.sr_mutate('b1000000-0000-4000-8000-000000000003',1,'withdraw');
reset role;
do $$ begin assert exists(select 1 from private.subscription_request_notifications where event='withdraw'), 'Every withdrawal notifies Penny without exposing draft contents'; end $$;
rollback;
