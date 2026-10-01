begin;
\ir password-reset-credential-setup.sql
select pg_temp.set_test_actor('95000000-0000-4000-8000-000000000001');
do $$
declare
  v_user uuid := '95000000-0000-4000-8000-000000000002';
  v_claim record;
  v_before jsonb;
begin
  select * into v_claim from public.begin_portal_password_reset(v_user,v_user,(select account_version from public.profiles where id=v_user));
  update private.portal_password_reset_claims set claimed_at=clock_timestamp()-interval '1 day' where auth_user_id=v_user;
  select to_jsonb(r) into v_before from private.portal_password_reset_claims r where auth_user_id=v_user;
  begin
    perform public.begin_portal_password_reset(v_user,v_user,v_claim.account_version);
    raise exception 'Ambiguous pending reset was automatically reclaimed';
  exception when serialization_failure then null; end;
  if v_before is distinct from (select to_jsonb(r) from private.portal_password_reset_claims r where auth_user_id=v_user) then
    raise exception 'Ambiguous pending reset was changed';
  end if;
end $$;
rollback;
