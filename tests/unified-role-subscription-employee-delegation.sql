\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare p record; expected record; register_ids uuid[]; vault_ids uuid[]; target uuid:='a1000000-0000-4000-8000-000000000001'; begin
  assert exists(select 1 from public.list_subscription_credential_grant_candidates() where person_id=target),
    'Active ordinary Employee must be a subscription delegate candidate';
  assert not exists(select 1 from public.list_subscription_credential_grant_candidates()
    where person_id in ('a1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000011')),
    'Account and inactive person must not be candidates';
  select * into strict p from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000008');
  assert not p.can_manage_subscriptions and not p.can_manage_subscription_credentials,
    'Historical Employee rows must not acquire access automatically';
  for expected in select * from (values(false,false),(true,false),(false,true),(true,true),(false,false)) v(management,vault) loop
    register_ids:=case when expected.management then array[target] else '{}'::uuid[] end;
    vault_ids:=case when expected.vault then array[target] else '{}'::uuid[] end;
    perform public.replace_subscription_management_delegates(register_ids);
    perform public.replace_subscription_credential_access_grants(vault_ids);
    assert exists(select 1 from public.list_subscription_management_delegates() where person_id=target)=expected.management,
      'Employee register selection must persist and reload independently';
    assert exists(select 1 from public.list_subscription_credential_access_grants() where person_id=target)=expected.vault,
      'Employee vault selection must persist and reload independently';
    select * into strict p from public.get_portal_role_capabilities(target);
    assert p.app_role='employee' and p.can_manage_subscriptions=expected.management
      and p.can_view_subscription_register=expected.management and p.can_manage_subscription_credentials=expected.vault,
      'Selected Employee must have exactly the explicitly saved grants';
    assert not p.can_manage_subscription_credential_grants and not p.can_manage_subscription_management_grants
      and not p.can_manage_roles and not p.can_manage_employee_directory and not p.can_manage_accounts
      and not p.can_manage_leave_balances and not p.can_review_leave_workspace,
      'Subscription delegation must not elevate other modules or assignment authority';
    perform set_config('request.jwt.claim.sub',target::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',target,'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    select * into strict p from public.get_portal_role_capabilities();
    assert p.can_manage_subscriptions=expected.management and p.can_manage_subscription_credentials=expected.vault,
      'Actual Employee database actor and P0 selected profile must agree';
    if expected.management then
      assert public.create_subscription_v4('Synthetic Employee subscription',null,'free',null,null,null,null,false,null,null,
        target,'mam','{}'::uuid[])->>'subscription_id' is not null,
        'Register Employee must use the actual current register mutation chain';
    else
      begin
        perform public.create_subscription_v4('Synthetic rejected subscription',null,'free',null,null,null,null,false,null,null,
          target,'mam','{}'::uuid[]);
        raise exception 'Employee without register grant mutated register';
      exception when insufficient_privilege then null; end;
    end if;
    if expected.vault then
      perform public.list_subscription_credential_catalogue();
    else
      begin perform public.list_subscription_credential_catalogue(); raise exception 'Employee without vault grant read vault';
      exception when insufficient_privilege then null; end;
    end if;
    begin perform public.replace_subscription_management_delegates(array[target]); raise exception 'Delegated Employee reassigned register access';
    exception when insufficient_privilege then null; end;
    begin perform public.replace_subscription_credential_access_grants(array[target]); raise exception 'Delegated Employee reassigned vault access';
    exception when insufficient_privilege then null; end;
    perform set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000009',true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub','a1000000-0000-4000-8000-000000000009','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
  end loop;
  begin perform public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000011']::uuid[]);
    raise exception 'Inactive person received register access'; exception when invalid_parameter_value then null; end;
  begin perform public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000011']::uuid[]);
    raise exception 'Inactive person received vault access'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
do $$ begin
  assert (select app_role='employee' from public.profiles where id='a1000000-0000-4000-8000-000000000001'),
    'Explicit delegation must not change the base role';
  assert (select count(*)=5 from private.subscription_management_grant_events
    where actor_user_id='a1000000-0000-4000-8000-000000000009'), 'Every register replacement must retain real P0 attribution';
  assert (select count(*)=5 from private.subscription_credential_access_audit_events
    where actor_user_id='a1000000-0000-4000-8000-000000000009'), 'Every vault replacement must retain real P0 attribution';
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton),
    'Feature must preserve the destructive-operation protection baseline';
end $$;
rollback;
\echo PASS: Employee candidate, four independent combinations, save/reload, revocation, real register/vault authorization, P0-only delegation and retained role/audit boundaries
begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
update public.internal_org_people set is_active=false where id='a1000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  assert not exists(select 1 from public.list_subscription_credential_grant_candidates()
    where person_id='a1000000-0000-4000-8000-000000000001'), 'Archived/inactive Employee must leave the candidate list';
  begin perform public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000001']::uuid[]);
    raise exception 'Archived Employee received register delegation'; exception when invalid_parameter_value then null; end;
  begin perform public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000001']::uuid[]);
    raise exception 'Archived Employee received vault delegation'; exception when invalid_parameter_value then null; end;
end $$;
rollback;
\echo PASS: Archived/inactive Employee candidate exclusion and both assignment denials
begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000002']::uuid[]);
select public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000002']::uuid[]);
reset role;
do $$ begin
  assert not (select employee_delegation_confirmed from private.subscription_management_grants
    where person_id='a1000000-0000-4000-8000-000000000002'), 'Manager selection must not pre-authorize a future Employee demotion';
  assert not (select employee_delegation_confirmed from private.subscription_credential_access_grants
    where person_id='a1000000-0000-4000-8000-000000000002'), 'Manager vault selection must not pre-authorize Employee access';
end $$;
rollback;
\echo PASS: Manager delegation does not implicitly confirm Employee delegation
