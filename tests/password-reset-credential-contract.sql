begin;
\ir password-reset-credential-setup.sql
select pg_temp.set_test_actor('95000000-0000-4000-8000-000000000001');
do $$
declare
  v_user uuid := '95000000-0000-4000-8000-000000000002';
  v_claim record;
  v_result record;
  v_version bigint;
  v_status text;
  v_events bigint;
begin
  if has_function_privilege('anon','public.begin_portal_password_reset(uuid,uuid,bigint)','execute')
    or not has_function_privilege('authenticated','public.begin_portal_password_reset(uuid,uuid,bigint)','execute')
    or not has_function_privilege('service_role','public.begin_portal_password_reset(uuid,uuid,bigint)','execute')
    or has_function_privilege('authenticated','public.claim_due_onboarding_credentials(integer)','execute')
    or has_function_privilege('anon','public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text)','execute')
    or has_function_privilege('authenticated','public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text)','execute')
    or not has_function_privilege('service_role','public.claim_due_onboarding_credentials(integer)','execute')
    or not has_function_privilege('service_role','public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text)','execute') then
    raise exception 'Password reset / credential ACL drift';
  end if;
  select account_version into v_version from public.profiles where id=v_user;
  begin
    perform public.begin_portal_password_reset(v_user,v_user,v_version+1);
    raise exception 'Stale version accepted';
  exception when serialization_failure then null; end;
  begin
    perform public.begin_portal_password_reset(v_user,'95000000-0000-4000-8000-000000000001',v_version);
    raise exception 'Wrong account identity accepted';
  exception when serialization_failure then null; end;
  perform pg_temp.set_test_actor(v_user);
  begin
    perform public.begin_portal_password_reset(v_user,v_user,v_version);
    raise exception 'Non-administrator accepted';
  exception when insufficient_privilege then null; end;
  perform pg_temp.set_test_actor('95000000-0000-4000-8000-000000000001');
  foreach v_status in array array['scheduled','delivered','cancelled','needs_review'] loop
    update private.employee_onboarding_credentials set status=v_status,claimed_login=null where auth_user_id=v_user;
    select * into v_claim from public.begin_portal_password_reset(v_user,v_user,v_version);
    if v_claim.auth_user_id <> v_user or v_claim.person_id <> v_user or v_claim.account_version <> v_version then
      raise exception 'Reset changed exact identity/version';
    end if;
    begin
      perform public.finalise_portal_password_reset(v_user,v_user,gen_random_uuid());
      raise exception 'Wrong reset token accepted';
    exception when serialization_failure then null; end;
    select count(*) into v_events from private.portal_account_admin_events where target_user_id=v_user and event_type='password_reset_recorded';
    select * into v_result from public.finalise_portal_password_reset(v_user,v_user,v_claim.reset_token);
    if v_result.account_version <> v_version+1 then raise exception 'Finalisation did not increment version once'; end if;
    perform public.finalise_portal_password_reset(v_user,v_user,v_claim.reset_token);
    if (select count(*) from private.portal_account_admin_events where target_user_id=v_user and event_type='password_reset_recorded') <> v_events+1
      or not exists(select 1 from private.portal_account_admin_events where target_user_id=v_user and event_type='password_reset_recorded' and actor_user_id='95000000-0000-4000-8000-000000000001') then
      raise exception 'Reset audit actor/idempotency drift';
    end if;
    v_version := v_result.account_version;
  end loop;
  update private.employee_onboarding_credentials set status='scheduled' where auth_user_id=v_user;
  select * into v_claim from public.begin_portal_password_reset(v_user,v_user,v_version);
  if not public.cancel_portal_password_reset(v_user,v_claim.reset_token) then raise exception 'Explicit cancellation failed'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  if not exists(select 1 from public.claim_due_onboarding_credentials(10) where auth_user_id=v_user) then
    raise exception 'Explicitly cancelled reset still blocks credentials';
  end if;
end $$;
rollback;
