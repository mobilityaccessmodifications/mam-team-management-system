\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
create temp table role_reset_receipt as select null::uuid as reset_token where false;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
insert into role_reset_receipt
select reset_token from public.begin_portal_password_reset('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',1);
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
do $$ declare age interval; before_profile jsonb; before_claim jsonb; before_delivery jsonb; begin
 select to_jsonb(p) into before_profile from public.profiles p where id='a1000000-0000-4000-8000-000000000001';
 select to_jsonb(c) into before_delivery from private.employee_onboarding_credentials c where person_id='a1000000-0000-4000-8000-000000000001';
 foreach age in array array[interval '0 seconds',interval '1 hour',interval '1 day'] loop
  update private.portal_password_reset_claims set claimed_at=clock_timestamp()-age where auth_user_id='a1000000-0000-4000-8000-000000000001';
  select to_jsonb(c) into before_claim from private.portal_password_reset_claims c where auth_user_id='a1000000-0000-4000-8000-000000000001';
  begin
   perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','account','employee');
   raise exception 'Unresolved durable pending reset accepted a role edit at age %',age;
  exception when sqlstate '55000' then
   assert sqlerrm='A password reset is in progress. Resolve it before changing this role.', 'Role reset fence has a stable actionable semantic rejection';
  end;
  assert (select to_jsonb(p)=before_profile from public.profiles p where id='a1000000-0000-4000-8000-000000000001'), 'Blocked role edit leaves complete target profile unchanged';
  assert (select to_jsonb(c)=before_claim from private.portal_password_reset_claims c where auth_user_id='a1000000-0000-4000-8000-000000000001'), 'Age cannot cancel/take over/reset a durable pending claim';
  assert (select to_jsonb(c)=before_delivery from private.employee_onboarding_credentials c where person_id='a1000000-0000-4000-8000-000000000001'), 'Role fence never modifies protected credential delivery';
  assert not exists(select 1 from private.employee_directory_audit_events where person_id='a1000000-0000-4000-8000-000000000001' and changed_fields=array['app_role']::text[]), 'Blocked role edit creates no role audit';
 end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
select public.cancel_portal_password_reset('a1000000-0000-4000-8000-000000000001',(select reset_token from role_reset_receipt));
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','account','employee');
reset role;
do $$ declare state text; begin
 assert (select app_role='account' from public.profiles where id='a1000000-0000-4000-8000-000000000001'), 'Explicitly cancelled reset permits a new role edit';
 foreach state in array array['claimed','sending','needs_review'] loop
  update private.employee_onboarding_credentials set status=state,claim_token=gen_random_uuid(),claim_expires_at=clock_timestamp()+interval '5 minutes',claimed_login='synthetic-protected-login' where person_id='a1000000-0000-4000-8000-000000000001';
  begin perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','admin','account');
   raise exception 'Onboarding gate accepted a role edit in %',state;
  exception when sqlstate '55000' then
   assert sqlerrm='Onboarding credential delivery in progress', 'Unchanged onboarding guard semantic rejection';
  end;
  assert (select app_role='account' from public.profiles where id='a1000000-0000-4000-8000-000000000001'), 'Credential onboarding gate keeps the exact target role';
 end loop;
 update private.employee_onboarding_credentials set status='needs_review',claimed_login=null,claim_token=null,claim_expires_at=null where person_id='a1000000-0000-4000-8000-000000000001';
 assert public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','admin','account')='admin', 'Unclaimed onboarding review retains original permitted edit behavior';
 assert (select count(*)=2 from private.employee_directory_audit_events where person_id='a1000000-0000-4000-8000-000000000001' and changed_fields=array['app_role']::text[] and actor_user_id='a1000000-0000-4000-8000-000000000009'), 'Only successful role edits have real P0 actor audits';
end $$;
rollback;
\echo PASS: fresh/aged durable pending-reset role fence, explicit resolution and unchanged onboarding gates
