begin;
\ir password-reset-credential-setup.sql
select pg_temp.set_test_actor('95000000-0000-4000-8000-000000000001');
do $$
declare
  v_user uuid := '95000000-0000-4000-8000-000000000002';
  v_before jsonb;
  v_delivery jsonb;
  v_status text;
  v_version bigint;
begin
  select account_version into v_version from public.profiles where id=v_user;
  foreach v_status in array array['claimed','sending','needs_review'] loop
    update private.employee_onboarding_credentials set status=v_status,claimed_login='reset-staff@example.test' where auth_user_id=v_user;
    select to_jsonb(p) into v_before from public.profiles p where id=v_user;
    select to_jsonb(c) into v_delivery from private.employee_onboarding_credentials c where auth_user_id=v_user;
    begin
      perform public.begin_portal_password_reset(v_user,v_user,v_version);
      raise exception 'Reset claim accepted during credential %',v_status;
    exception when sqlstate '55000' then null; end;
    if exists(select 1 from private.portal_password_reset_claims where auth_user_id=v_user)
      or v_before is distinct from (select to_jsonb(p) from public.profiles p where id=v_user)
      or v_delivery is distinct from (select to_jsonb(c) from private.employee_onboarding_credentials c where auth_user_id=v_user) then
      raise exception 'Rejected reset changed durable state';
    end if;
  end loop;
end $$;
rollback;
