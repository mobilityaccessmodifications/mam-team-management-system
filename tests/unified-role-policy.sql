\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
do $$ declare n integer; c record; begin
  for n in 1..9 loop
    perform pg_temp.set_test_actor(('a1000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid);
    if n=7 then
      assert not public.can_manage_portal_accounts() and not public.can_view_organisation_chart()
        and not public.can_review_leave_workspace(), 'Unknown hr fails closed despite JWT metadata';
      begin perform public.get_portal_role_capabilities(); raise exception 'Unknown hr has role capability';
        exception when insufficient_privilege then null; end;
      continue;
    end if;
    select * into strict c from public.get_portal_role_capabilities();
    assert public.can_manage_portal_accounts()=c.can_manage_accounts, 'Legacy accounts predicate matches canonical policy';
    assert public.can_manage_employee_directory()=c.can_manage_employee_directory, 'Directory predicate parity';
    assert public.can_view_employee_directory()=c.can_view_employee_directory, 'Directory reader parity';
    assert public.can_view_organisation_chart()=c.can_view_organisation_chart, 'Organisation reader parity';
    assert public.can_edit_internal_org()=c.can_edit_organisation_chart, 'Organisation mutation parity';
    assert public.can_manage_it_assets()=c.can_manage_assets, 'Asset predicate parity';
    assert public.can_view_employee_check_in_workspace()=c.can_view_check_in_workspace, 'Check-in workspace parity';
    assert public.can_manage_subscriptions()=c.can_manage_subscriptions, 'Subscription write parity';
    assert public.can_manage_subscription_credentials()=c.can_manage_subscription_credentials, 'Vault parity';
    assert public.can_view_subscription_register()=c.can_view_subscription_register, 'Register reader parity';
    assert public.can_import_payroll_balances()=c.can_import_payroll_balances, 'Payroll upload parity';
    assert public.can_review_leave_workspace()=c.can_review_leave_workspace, 'Leave reviewer parity';
    assert public.can_view_all_leave_requests()=c.can_view_all_leave_requests, 'All-leave reader parity';
    assert public.can_approve_employee_check_in_employment_decision()=c.can_approve_employment_decisions, 'Employment decision parity';
    assert private.is_system_portal_account_admin()=c.is_super_admin, 'P0 predicate remains P0-only';
    assert public.can_change_employee_view()=c.can_change_employee_view, 'P0 Change profile parity';
    assert public.can_manage_analytics_api()=c.can_manage_analytics_api, 'P0 analytics parity';
    assert private.is_internal_org_member(), 'Ordinary roles use DB membership rather than stale Auth role claims';
    assert private.can_view_all_approved_leave_calendar_for(auth.uid())=(n in (3,4,5,6,9)), 'Stale calendar grants cannot override role';
    assert private.payroll_comparison_only(auth.uid())=(n in (3,6)), 'Stale comparison-only grants cannot override role';
  end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
update public.profiles set credentials_valid_after=clock_timestamp()+interval '1 hour'
where id='a1000000-0000-4000-8000-000000000013';
set local role authenticated;
do $$ begin
  assert not public.can_manage_portal_accounts() and not public.can_import_payroll_balances()
    and not public.can_review_leave_workspace(), 'Stale credentials deny operational privileges';
  begin perform public.get_portal_role_capabilities(); raise exception 'Stale session returned policy';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare n integer; begin
  for n in 10..12 loop
    perform pg_temp.set_test_actor(('a1000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid);
    assert not public.can_manage_portal_accounts() and not public.can_review_leave_workspace()
      and not public.can_import_payroll_balances(), 'Disabled, archived or unlinked accounts have no role privileges';
    begin perform public.get_portal_role_capabilities(); raise exception 'Invalid current session returned capabilities';
      exception when insufficient_privilege then null; end;
  end loop;
  perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
  for n in 10..12 loop
    begin perform public.get_portal_role_capabilities(('a1000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid);
      raise exception 'Invalid target returned capabilities'; exception when insufficient_privilege then null; end;
  end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
select set_config('request.jwt.claims',jsonb_set(auth.jwt(),'{is_anonymous}','true')::text,true);
set local role authenticated;
do $$ begin
  assert not public.can_manage_portal_accounts() and not public.can_review_leave_workspace()
    and not public.can_import_payroll_balances(), 'Anonymous sessions fail closed';
  begin perform public.get_portal_role_capabilities(); raise exception 'Anonymous JWT returned role policy';
    exception when insufficient_privilege then null; end;
  begin update public.profiles set app_role='admin'; raise exception 'Direct role-column write accepted';
    exception when insufficient_privilege then null; end;
  begin perform public.stage_payroll_balance_import(auth.uid(),repeat('a',64),'[]','[]');
    raise exception 'Browser called machine-service payroll staging'; exception when insufficient_privilege then null; end;
  begin perform public.run_scheduled_employee_offboarding(gen_random_uuid(),now());
    raise exception 'Browser called offboarding service'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare n integer; c record; begin
  for n in 1..6 loop
    select * into strict c from public.get_portal_role_capabilities(('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid);
    assert public.get_selected_employee_profile_access_role_for_preview(c.person_id)=c.app_role,
      'Legacy preview role RPC must preserve canonical Account/Admin instead of default Employee';
  end loop;
  begin perform public.get_selected_employee_profile_access_role_for_preview('a1000000-0000-4000-8000-000000000007');
    raise exception 'Legacy preview silently treated unknown hr as Employee'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare n integer; u uuid; c record; begin
  update public.internal_org_people set parent_id=null where id='a1000000-0000-4000-8000-000000000001';
  for n in 1..5 loop
    u:=('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    perform pg_temp.set_test_actor(u);
    update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id=u;
    begin perform public.get_portal_role_capabilities(); raise exception 'Disabled role returned current policy'; exception when insufficient_privilege then null; end;
    perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
    begin perform public.get_portal_role_capabilities(u); raise exception 'Disabled target returned preview policy'; exception when insufficient_privilege then null; end;
    update public.profiles set account_status='active',disabled_at=null where id=u;
    perform pg_temp.set_test_actor(u);
    update public.profiles set credentials_valid_after=clock_timestamp()+interval '1 hour' where id=u;
    begin perform public.get_portal_role_capabilities(); raise exception 'Stale role session returned policy'; exception when insufficient_privilege then null; end;
    if n=5 then perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009'); end if;
    update public.profiles set credentials_valid_after=clock_timestamp()-interval '1 day' where id=u;
    perform pg_temp.set_test_actor(u);
    update public.internal_org_people set is_active=false where id=u;
    if n=5 then select * into strict c from public.get_portal_role_capabilities(); assert c.is_super_admin and c.person_id is null, 'P0 roster independence preserved';
    else begin perform public.get_portal_role_capabilities(); raise exception 'Archived ordinary role returned policy'; exception when insufficient_privilege then null; end; end if;
    perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
    begin perform public.get_portal_role_capabilities(u); raise exception 'Archived target returned preview policy'; exception when insufficient_privilege then null; end;
    update public.internal_org_people set is_active=true,auth_user_id=null where id=u;
    perform pg_temp.set_test_actor(u);
    if n=5 then select * into strict c from public.get_portal_role_capabilities(); assert c.is_super_admin, 'Standalone P0 independent of employee linkage';
    else begin perform public.get_portal_role_capabilities(); raise exception 'Unlinked ordinary role returned policy'; exception when insufficient_privilege then null; end; end if;
    update public.internal_org_people set auth_user_id=u where id=u;
    perform pg_temp.set_test_actor(u);
    perform set_config('request.jwt.claims',jsonb_set(auth.jwt(),'{is_anonymous}','true')::text,true);
    begin perform public.get_portal_role_capabilities(); raise exception 'Anonymous role session returned policy'; exception when insufficient_privilege then null; end;
  end loop;
end $$;
rollback;
\echo PASS: current legacy predicates, P0-only authority, stale grants and disabled/stale/archived/anonymous boundaries
