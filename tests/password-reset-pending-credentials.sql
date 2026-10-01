begin;
\ir password-reset-credential-setup.sql
select pg_temp.set_test_actor('95000000-0000-4000-8000-000000000001');
do $$
declare
  v_user uuid := '95000000-0000-4000-8000-000000000002';
  v_claim record;
  v_before jsonb;
  v_token uuid := gen_random_uuid();
begin
  select * into v_claim from public.begin_portal_password_reset(v_user,v_user,(select account_version from public.profiles where id=v_user));
  perform set_config('request.jwt.claim.role','service_role',true);
  select to_jsonb(c) into v_before from private.employee_onboarding_credentials c where auth_user_id=v_user;
  if exists(select 1 from public.claim_due_onboarding_credentials(10)) then
    raise exception 'Credential worker claimed an account with pending password reset';
  end if;
  if v_before is distinct from (select to_jsonb(c) from private.employee_onboarding_credentials c where auth_user_id=v_user) then
    raise exception 'Blocked credential claim changed delivery';
  end if;
  update private.portal_password_reset_claims set claimed_at=clock_timestamp()-interval '1 day' where auth_user_id=v_user;
  if exists(select 1 from public.claim_due_onboarding_credentials(10)) then
    raise exception 'Expired ambiguous reset reopened credential sending';
  end if;
  update private.employee_onboarding_credentials set status='claimed',claim_token=v_token,claim_expires_at=clock_timestamp()+interval '5 minutes' where auth_user_id=v_user;
  select to_jsonb(c) into v_before from private.employee_onboarding_credentials c where auth_user_id=v_user;
  if public.begin_onboarding_credential_delivery((select id from private.employee_onboarding_credentials where auth_user_id=v_user),v_token,'reset-staff@example.test','reset-staff@example.test',null) then
    raise exception 'Credential sending began over a pending password reset';
  end if;
  if v_before is distinct from (select to_jsonb(c) from private.employee_onboarding_credentials c where auth_user_id=v_user) then
    raise exception 'Blocked credential begin changed delivery';
  end if;
end $$;
rollback;
