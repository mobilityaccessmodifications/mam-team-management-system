begin;
set local search_path = '';

do $$ begin
  assert to_regprocedure('public.list_onboarding_credential_reviews()') is not null,
    'System Admin needs_review metadata RPC is missing';
  assert to_regprocedure('public.cancel_onboarding_credential_review(uuid,timestamp with time zone)') is not null,
    'System Admin CAS cancellation RPC is missing';
end $$;

insert into auth.users(id,email,email_confirmed_at)
select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic-review-'||n||'@example.test',now() from generate_series(1,6) n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic review actor '||n,
  case n when 1 then 'system_admin' when 2 then 'admin' when 3 then 'manager' when 4 then 'account' else 'employee' end,
  'synthetic-review-'||n,now()-interval '1 day' from generate_series(1,6) n;
insert into public.internal_org_people(id,full_name,node_kind,company_key,position_title,auth_user_id,started_date)
select ('72000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic review employee '||n,'person','mam','Synthetic tester',
  ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,timezone('Australia/Melbourne',clock_timestamp())::date+1 from generate_series(2,6) n;
update private.employee_onboarding_credentials set status='needs_review',review_code='delivery_uncertain',
  claimed_login='synthetic-private@example.test',claimed_work_email='synthetic-private@example.test',
  claimed_personal_email='synthetic-home@example.test',claim_token=gen_random_uuid(),
  claim_expires_at=clock_timestamp()+interval '10 minutes',updated_at='2026-10-01T05:00:00.123456+00:00'
where person_id='72000000-0000-4000-8000-000000000006';
insert into private.employee_onboarding_credential_events(delivery_id,event_type,code)
select id,'needs_review','delivery_uncertain' from private.employee_onboarding_credentials
where person_id='72000000-0000-4000-8000-000000000006';
insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc,provider_receipt)
select 'onboarding-credential:'||id,'processing',gen_random_uuid(),'synthetic-private@example.test','',null
from private.employee_onboarding_credentials where person_id='72000000-0000-4000-8000-000000000006';
create temp table review_before as select to_jsonb(c) as row from private.employee_onboarding_credentials c
where person_id='72000000-0000-4000-8000-000000000006';
create temp table review_events_before as select to_jsonb(e) as row from private.employee_onboarding_credential_events e;
create temp table review_receipts_before as select to_jsonb(r) as row from private.notification_delivery_receipts r;
create temp table review_accounts_before as select to_jsonb(p) as row from public.profiles p;
create temp table review_auth_before as select to_jsonb(u) as row from auth.users u;

do $$ declare signature text; caller text; begin
  foreach signature in array array['public.list_onboarding_credential_reviews()',
    'public.cancel_onboarding_credential_review(uuid,timestamp with time zone)'] loop
    assert has_function_privilege('authenticated',signature,'EXECUTE');
    foreach caller in array array['anon','service_role'] loop
      assert not has_function_privilege(caller,signature,'EXECUTE'),'Inherited application EXECUTE must be revoked';
    end loop;
    assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=signature::regprocedure and a.grantee=0),'PUBLIC EXECUTE must be revoked';
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"is_anonymous":false}',true);
do $$ begin
  begin perform public.list_onboarding_credential_reviews(); raise exception 'Unauthenticated list allowed';
  exception when insufficient_privilege then null; end;
  begin perform public.cancel_onboarding_credential_review(gen_random_uuid(),clock_timestamp()); raise exception 'Unauthenticated cancellation allowed';
  exception when insufficient_privilege then null; end;
end $$;
do $$ declare n integer; begin
  for n in 2..5 loop
    perform set_config('request.jwt.claim.sub','71000000-0000-4000-8000-'||lpad(n::text,12,'0'),true);
    perform set_config('request.jwt.claims',jsonb_build_object('iat',extract(epoch from clock_timestamp())::bigint,
      'is_anonymous',false,'user_metadata',jsonb_build_object('app_role','system_admin'))::text,true);
    begin perform public.list_onboarding_credential_reviews(); raise exception 'Non-P0 list allowed';
    exception when insufficient_privilege then null; end;
    begin perform public.cancel_onboarding_credential_review(gen_random_uuid(),clock_timestamp()); raise exception 'Non-P0 cancellation allowed';
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',jsonb_build_object('iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',true)::text,true);
do $$ begin
  begin perform public.list_onboarding_credential_reviews(); raise exception 'Anonymous P0 list allowed';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims',jsonb_build_object('iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
do $$ declare r record; begin
  select * into strict r from public.list_onboarding_credential_reviews() where employee_name='Synthetic review employee 6';
  assert r.employee_name='Synthetic review employee 6' and r.company_key='mam';
  assert r.status='needs_review' and r.review_code='delivery_uncertain' and r.has_claimed_login;
  assert r.updated_at='2026-10-01T05:00:00.123456+00:00'::timestamptz;
  assert (select array_agg(key order by key) from jsonb_object_keys(to_jsonb(r)) key)=
    array['company_key','created_at','delivery_id','due_date','employee_name','has_claimed_login','review_code','status','updated_at'];
  assert to_jsonb(r)::text not like '%@%' and to_jsonb(r)::text not like '%claim_token%';
  begin perform public.cancel_onboarding_credential_review(r.delivery_id,r.updated_at-interval '1 microsecond');
    raise exception 'Stale timestamp allowed'; exception when sqlstate '55000' then null; end;
  assert public.cancel_onboarding_credential_review(r.delivery_id,r.updated_at);
  begin perform public.cancel_onboarding_credential_review(r.delivery_id,r.updated_at);
    raise exception 'Cancellation repeated'; exception when sqlstate '55000' then null; end;
  assert not exists(select 1 from public.list_onboarding_credential_reviews() remaining where remaining.delivery_id=r.delivery_id);
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);

do $$ declare original jsonb; actual jsonb; n integer; delivery uuid; stamp timestamptz; begin
  select row into strict original from review_before;
  select to_jsonb(c) into strict actual from private.employee_onboarding_credentials c where c.id=(original->>'id')::uuid;
  assert actual->>'status'='cancelled' and (actual->>'updated_at')::timestamptz>(original->>'updated_at')::timestamptz;
  assert actual-array['status','updated_at']=original-array['status','updated_at'],'Cancellation modified preserved credential context';
  assert not exists((select row from review_events_before except all select to_jsonb(e) from private.employee_onboarding_credential_events e));
  assert (select count(*) from private.employee_onboarding_credential_events)-(select count(*) from review_events_before)=1;
  assert exists(select 1 from private.employee_onboarding_credential_events e where e.delivery_id=(original->>'id')::uuid
    and e.event_type='review_cancelled' and e.code='actor:71000000-0000-4000-8000-000000000001');
  assert not exists((select row from review_receipts_before except all select to_jsonb(r) from private.notification_delivery_receipts r)
    union all (select to_jsonb(r) from private.notification_delivery_receipts r except all select row from review_receipts_before));
  assert not exists((select row from review_accounts_before except all select to_jsonb(p) from public.profiles p)
    union all (select to_jsonb(p) from public.profiles p except all select row from review_accounts_before));
  assert not exists((select row from review_auth_before except all select to_jsonb(u) from auth.users u)
    union all (select to_jsonb(u) from auth.users u except all select row from review_auth_before));
  for n in 1..6 loop
    update private.employee_onboarding_credentials set status=(array['pending_account','scheduled','claimed','sending','delivered','cancelled'])[n],updated_at=clock_timestamp()
      where person_id='72000000-0000-4000-8000-000000000002' returning id,updated_at into delivery,stamp;
    perform set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
    begin perform public.cancel_onboarding_credential_review(delivery,stamp); raise exception 'Non-review state allowed';
    exception when sqlstate '55000' then null; end;
    perform set_config('request.jwt.claim.sub','',true);
  end loop;
end $$;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$ begin
  assert not exists(select 1 from public.claim_due_onboarding_credentials(10));
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
do $$ declare original jsonb; begin
  select row into original from review_before;
  update public.internal_org_people set started_date=timezone('Australia/Melbourne',clock_timestamp())::date-1 where id='72000000-0000-4000-8000-000000000006';
  assert (select status='cancelled' from private.employee_onboarding_credentials where id=(original->>'id')::uuid),
    'Ordinary scheduler must not requeue a cancelled credential';
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);
end $$;
rollback;
