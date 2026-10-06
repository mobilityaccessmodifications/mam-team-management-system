\set ON_ERROR_STOP on
begin;
do $$ begin
  assert current_database() ~ '^mam_test_';
  assert to_regprocedure('public.get_portal_role_capabilities(uuid)') is not null,
    'Canonical current/preview role capability RPC is missing';
end $$;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare c record; own jsonb; projected jsonb; n integer; expected_role text; begin
  for n in 1..6 loop
    expected_role := (array['employee','manager','account','admin','system_admin','account'])[n];
    select * into strict c from public.get_portal_role_capabilities(
      ('a1000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid);
    assert c.app_role=expected_role and c.account_status='active', 'Canonical role/identity projection';
    assert c.is_super_admin=(n=5), 'P0 is not an ordinary Admin';
    assert c.can_manage_accounts=(n in (4,5)), 'Operational account capability';
    assert c.can_view_employee_directory=(n in (2,4,5)), 'Directory capability';
    assert c.can_manage_employee_directory=(n in (4,5)), 'Full directory capability';
    assert c.can_view_organisation_chart=(n in (2,4,5)), 'Organisation capability';
    assert c.can_edit_organisation_chart=(n in (4,5)), 'Organisation mutation capability';
    assert c.can_view_check_in_workspace=(n in (2,4,5)), 'Check-in capability';
    assert c.can_manage_assets=(n in (4,5)), 'Asset capability';
    assert c.can_view_subscription_register=(n in (2,4,5)), 'Subscription register capability';
    assert c.can_manage_subscriptions=(n in (4,5)), 'Default subscription write capability';
    assert c.can_manage_subscription_credentials=(n in (4,5)), 'Default vault capability';
    assert c.can_change_employee_view=(n=5) and c.can_manage_roles=(n=5)
      and c.can_manage_analytics_api=(n=5) and c.can_manage_subscription_credential_grants=(n=5)
      and c.can_manage_subscription_management_grants=(n=5), 'Exclusive P0 capabilities';
    assert c.can_import_payroll_balances=(n in (3,4,5,6)), 'Payroll upload capability';
    assert c.payroll_comparison_only=(n in (3,6)), 'Account comparison projection';
    assert c.can_manage_leave_balances=(n in (4,5)), 'Balance administration capability';
    assert c.can_view_all_leave_requests=(n in (3,4,5,6)), 'All-status register capability';
    assert c.can_review_leave_workspace=(n in (2,4,5)), 'Role-derived empty leave workspace';
    assert c.can_approve_employment_decisions=(n in (4,5)), 'Employment decision capability';
  end loop;
  select to_jsonb(policy)-'person_id' into own from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000003') policy;
  select to_jsonb(policy)-'person_id' into projected from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000006') policy;
  assert own=projected, 'Same role with different names and legacy personal grants has identical policy';
  select * into strict c from public.get_portal_role_capabilities();
  assert c.is_super_admin and c.person_id is null, 'Standalone P0 current-session projection';
  begin
    perform public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000007');
    raise exception 'Legacy hr preview accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare n integer; target uuid; own jsonb; preview jsonb; begin
  for n in 1..6 loop
    target := ('a1000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
    perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
    select to_jsonb(c) into preview from public.get_portal_role_capabilities(target) c;
    perform pg_temp.set_test_actor(target);
    select to_jsonb(c) into own from public.get_portal_role_capabilities() c;
    assert own=preview, 'Current and target preview parity';
  end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$ begin
  begin perform public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000004');
    raise exception 'Account preview accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare signature text; role_name text; begin
  foreach signature in array array['public.get_portal_role_capabilities(uuid)','private.portal_role_policy(uuid)'] loop
    foreach role_name in array array['anon','service_role'] loop
      assert not has_function_privilege(role_name,signature,'execute'), 'Capability policy ACL: ' || signature || ' ' || role_name;
    end loop;
  end loop;
  assert not has_function_privilege('authenticated','private.portal_role_policy(uuid)','execute'), 'Private target policy is not a browser API';
end $$;
rollback;
\echo PASS: canonical role matrix, same-role parity, standalone P0 and capability ACLs
