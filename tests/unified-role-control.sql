\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.portal_account_admins(auth_user_id)
values ('a1000000-0000-4000-8000-000000000001');
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ begin
  assert public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','account','employee')='account', 'P0 assigns ordinary Account with expected-role CAS';
  assert public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','admin','account')='admin', 'P0 assigns ordinary Admin';
  begin perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','manager','employee');
    raise exception 'Stale expected role accepted'; exception when sqlstate 'PT409' then
      assert sqlerrm='Role has changed. Refresh and try again.', 'Role CAS is a nonretry semantic HTTP 409, not transactional serialization'; end;
  begin perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','system_admin','admin');
    raise exception 'P0 ordinary editor promoted another P0'; exception when check_violation then null; end;
  begin perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000005','employee','system_admin');
    raise exception 'Existing P0 role mutated'; exception when insufficient_privilege then null; end;
  begin perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000005','system_admin','system_admin');
    raise exception 'Existing P0 assignable'; exception when check_violation then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin
  begin perform public.update_employee_directory_role('a1000000-0000-4000-8000-000000000001','employee','admin');
    raise exception 'Admin edited roles'; exception when insufficient_privilege then null; end;
  begin perform public.set_portal_account_admin('a1000000-0000-4000-8000-000000000001',true);
    raise exception 'Admin configured privileged account allowlist'; exception when insufficient_privilege then null; end;
  begin perform public.create_portal_account('a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000005','relinked-synthetic','employee',1);
    raise exception 'Provisioning API demoted P0'; exception when insufficient_privilege then null; end;
  begin perform public.create_portal_account('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','relinked-synthetic','manager',1);
    raise exception 'Admin provisioning bypassed exclusive role editor'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ begin
  begin perform public.create_portal_account('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','p0-synthetic','system_admin',1);
    raise exception 'P0 assignable during provisioning'; exception when invalid_parameter_value then null; end;
  begin perform public.create_portal_account('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','role-bypass-synthetic','employee',1);
    raise exception 'P0 provisioning bypassed expected-role CAS'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select count(*)=2 from private.employee_directory_audit_events where person_id='a1000000-0000-4000-8000-000000000001' and changed_fields=array['app_role']::text[] and actor_user_id='a1000000-0000-4000-8000-000000000009'), 'Real P0 role actor audited';
  assert (select app_role='system_admin' from public.profiles where id='a1000000-0000-4000-8000-000000000005'), 'Existing P0 unchanged';
  assert (select app_role='system_admin' from public.profiles where id='a1000000-0000-4000-8000-000000000009'), 'Standalone P0 unchanged';
end $$;
rollback;
\echo PASS: four-role CAS/audit, immutable P0 and ordinary provisioning bypass fences
