-- Synthetic disposable database only. Never a production session simulation.
begin;
do $proof_required$
begin
  assert current_database() ~ '^mam_test_', 'Owned synthetic database required';
  assert to_regprocedure('private.verify_payroll_operator_session(uuid)') is not null,
    'Full-contract session predicate is not implemented';
end $proof_required$;

-- All identities, claims and provider rows below are synthetic fixtures.
insert into auth.users(id,email,is_anonymous,email_confirmed_at) values
 ('97000000-0000-4000-8000-000000000001','operator-proof@example.test',false,now()),
 ('97000000-0000-4000-8000-000000000002','operator-other@example.test',false,now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
 ('97000000-0000-4000-8000-000000000001','Synthetic Proof Operator','system_admin','operator-proof@example.test',now()-interval '1 day'),
 ('97000000-0000-4000-8000-000000000002','Synthetic Fixture Writer','system_admin','operator-other@example.test',now()-interval '1 day');
insert into private.portal_account_admins(auth_user_id) values ('97000000-0000-4000-8000-000000000001'),('97000000-0000-4000-8000-000000000002');
insert into auth.sessions(id,user_id,created_at,not_after) values
 ('97000000-0000-4000-8000-000000000010','97000000-0000-4000-8000-000000000001',now()-interval '1 hour',null),
 ('97000000-0000-4000-8000-000000000011','97000000-0000-4000-8000-000000000002',now()-interval '1 hour',null);
create function pg_temp.proof_claims() returns jsonb language sql as $$
 select jsonb_build_object('sub','97000000-0000-4000-8000-000000000001','role','authenticated','is_anonymous',false,
   'session_id','97000000-0000-4000-8000-000000000010',
   'iat',floor(extract(epoch from clock_timestamp()))::bigint-60,
   'exp',floor(extract(epoch from clock_timestamp()))::bigint+3600);
$$;
create function pg_temp.proof_context(c jsonb) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',coalesce(c->>'sub',''),true);
 perform set_config('request.jwt.claim.role',coalesce(c->>'role',''),true);
 perform set_config('request.jwt.claims',c::text,true);
end;
$$;
do $proof_cases$
declare c jsonb:=pg_temp.proof_claims(); invalid jsonb; key text; value jsonb; issuer timestamptz; signatures text[];
begin
 perform pg_temp.proof_context(c);
 assert private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Complete valid synthetic tuple must pass';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000002'), 'Wrong expected actor denied';
 assert not public.verify_current_payroll_operator_session(), 'Public immutable original-actor binding denies this synthetic identity';
 for key in select unnest(array['sub','role','is_anonymous','session_id','iat','exp']) loop
   perform pg_temp.proof_context(c-key);
   assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Missing required claim denied: '||key;
 end loop;
 for key,value in select * from (values
   ('role','"service_role"'::jsonb),('is_anonymous','true'::jsonb),('is_anonymous','"false"'::jsonb),
   ('session_id','"97000000-0000-4000-8000-000000000011"'::jsonb),
   ('session_id','"97000000-0000-4000-8000-000000000099"'::jsonb),
   ('session_id','"NOT-A-UUID"'::jsonb),('session_id','null'::jsonb),
   ('iat','"123"'::jsonb),('iat','123.5'::jsonb),('iat','true'::jsonb),
   ('exp','"9999999999"'::jsonb),('exp','9999999999.5'::jsonb),('exp','null'::jsonb)
 ) changes(k,v) loop
   perform pg_temp.proof_context(jsonb_set(c,array[key],value));
   assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Invalid claim denied: '||key||'='||value;
 end loop;
 for invalid in select scenario.value from jsonb_array_elements(jsonb_build_array(
   jsonb_set(c,'{iat}',c->'exp'),jsonb_set(c,'{exp}',c->'iat'),
   jsonb_set(c,'{iat}',to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint+60)),
   jsonb_set(c,'{exp}',to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint-1))
 )) scenario loop
   perform pg_temp.proof_context(invalid);
   assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Invalid issued/expiry ordering denied';
 end loop;
 perform pg_temp.proof_context(c);
 issuer:=to_timestamp((c->>'iat')::double precision);
 update auth.sessions set created_at=issuer+interval '0.001 second' where id='97000000-0000-4000-8000-000000000010';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Creation after iat denied without truncation';
 update auth.sessions set created_at=issuer-interval '1 hour',not_after=clock_timestamp()-interval '1 second' where id='97000000-0000-4000-8000-000000000010';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Expired provider session denied';
 update auth.sessions set not_after=clock_timestamp()+interval '1 hour' where id='97000000-0000-4000-8000-000000000010';
 assert private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Future provider session deadline accepted';
 update public.profiles set credentials_valid_after=issuer+interval '0.001 second' where id='97000000-0000-4000-8000-000000000001';
 assert private.is_active_portal_account(), 'Native ordinary helper truncates the fractional cutoff';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Full contract rejects raw subsecond credential cutoff';
 update public.profiles set credentials_valid_after=issuer where id='97000000-0000-4000-8000-000000000001';
 assert private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Exact credential equality accepted';
 update private.portal_account_admins set revoked_at=clock_timestamp() where auth_user_id='97000000-0000-4000-8000-000000000001';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Revoked P0 denied';
 update private.portal_account_admins set revoked_at=null where auth_user_id='97000000-0000-4000-8000-000000000001';
 update public.profiles set app_role='employee' where id='97000000-0000-4000-8000-000000000001';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Native System Admin assertion retained';
 perform pg_temp.proof_context(jsonb_set(c,'{sub}','"97000000-0000-4000-8000-000000000002"'::jsonb));
 update public.profiles set app_role='system_admin',account_status='disabled',disabled_at=clock_timestamp() where id='97000000-0000-4000-8000-000000000001';
 perform pg_temp.proof_context(c);
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Disabled account denied';
 perform pg_temp.proof_context(jsonb_set(c,'{sub}','"97000000-0000-4000-8000-000000000002"'::jsonb));
 update public.profiles set account_status='active',disabled_at=null where id='97000000-0000-4000-8000-000000000001';
 perform pg_temp.proof_context(c);
 update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id='97000000-0000-4000-8000-000000000001';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Banned Auth user denied';
 update auth.users set banned_until=clock_timestamp()-interval '1 hour',deleted_at=clock_timestamp() where id='97000000-0000-4000-8000-000000000001';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Deleted Auth user denied';
 update auth.users set deleted_at=null,is_anonymous=true where id='97000000-0000-4000-8000-000000000001';
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Anonymous Auth row denied';
 update auth.users set is_anonymous=false where id='97000000-0000-4000-8000-000000000001';
 insert into private.portal_account_test_sessions(target_user_id,auth_session_id,activated_at,revoked_at,session_expires_at)
   values ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000010',now(),now(),now()+interval '1 hour');
 assert not private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Native revoked test-session assertion retained';
 update private.portal_account_test_sessions set revoked_at=null;
 assert private.verify_payroll_operator_session('97000000-0000-4000-8000-000000000001'), 'Complete tuple restored';
 assert has_function_privilege('authenticated','public.verify_current_payroll_operator_session()','EXECUTE');
 assert not has_function_privilege('anon','public.verify_current_payroll_operator_session()','EXECUTE');
 assert not has_function_privilege('service_role','public.verify_current_payroll_operator_session()','EXECUTE');
 assert not has_function_privilege('authenticated','private.verify_payroll_operator_session(uuid)','EXECUTE');
 assert not exists(select 1 from pg_proc p,lateral aclexplode(p.proacl) a
   where p.oid=any(array['private.verify_payroll_operator_session(uuid)'::regprocedure,'public.verify_current_payroll_operator_session()'::regprocedure]) and a.grantee=0);
end $proof_cases$;
rollback;
