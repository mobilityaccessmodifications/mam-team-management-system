\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
do $$ begin
  assert to_regprocedure('public.list_subscription_management_delegates()') is not null,
    'P0 subscription-management delegate list RPC is missing';
  assert to_regprocedure('public.replace_subscription_management_delegates(uuid[])') is not null,
    'P0 audited subscription-management delegate replacement RPC is missing';
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000015');
set local role authenticated;
do $$ declare subscription jsonb; begin
  subscription:=public.create_subscription_v4('Synthetic delegated subscription',null,'free',null,null,null,null,false,null,null,
    'a1000000-0000-4000-8000-000000000001','mam','{}'::uuid[]);
  assert subscription->>'subscription_id' is not null, 'Granted Manager can use real current register mutation chain';
  begin perform public.list_subscription_credential_catalogue();
    raise exception 'Register-only Manager accessed vault records'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000016');
set local role authenticated;
do $$ begin
  perform public.list_subscription_credential_catalogue();
  begin perform public.create_subscription_v4('Synthetic forbidden subscription',null,'free',null,null,null,null,false,null,null,
    'a1000000-0000-4000-8000-000000000001','mam','{}'::uuid[]);
    raise exception 'Vault-only Manager mutated register'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000006');
set local role authenticated;
do $$ begin
  begin perform public.list_subscription_credential_catalogue();
    raise exception 'Stale Account vault grant exposed records'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare p record; begin
  assert (select count(*)=1 from public.list_subscription_management_delegates() where person_id='a1000000-0000-4000-8000-000000000015'), 'Existing independent Manager register delegation remains';
  assert not exists(select 1 from public.list_subscription_management_delegates() where person_id in ('a1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000008')), 'Stale non-Manager delegates are not effective';
  assert not exists(select 1 from public.list_subscription_credential_grant_candidates() where person_id='a1000000-0000-4000-8000-000000000006'), 'Account remains excluded from subscription delegation';
  assert exists(select 1 from public.list_subscription_credential_grant_candidates() where person_id='a1000000-0000-4000-8000-000000000008'), 'Active linked Employee is eligible without activating historical grants';
  select * into strict p from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000015');
  assert p.can_manage_subscriptions and not p.can_manage_subscription_credentials, 'Register grant never implies vault';
  select * into strict p from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000016');
  assert not p.can_manage_subscriptions and p.can_manage_subscription_credentials, 'Vault grant never implies register write';
  perform public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000014']::uuid[]);
  select * into strict p from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000015');
  assert not p.can_manage_subscriptions and p.can_view_subscription_register, 'Revoked Manager keeps read-only register';
  select * into strict p from public.get_portal_role_capabilities('a1000000-0000-4000-8000-000000000014');
  assert p.can_manage_subscriptions and not p.can_manage_subscription_credentials, 'Replacement grants management only';
  begin perform public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000006']::uuid[]);
    raise exception 'Account received a new management delegation'; exception when invalid_parameter_value then null; end;
  begin perform public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000006']::uuid[]);
    raise exception 'Account received new vault delegation'; exception when invalid_parameter_value then null; end;
  begin perform public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000014','a1000000-0000-4000-8000-000000000014']::uuid[]);
    raise exception 'Duplicate management delegates accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.replace_subscription_management_delegates(array[null]::uuid[]);
    raise exception 'NULL management delegate accepted'; exception when invalid_parameter_value then null; end;
  perform public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000016']::uuid[]);
end $$;
reset role;
do $$ declare n integer; begin
  for n in 1..4 loop
    perform pg_temp.set_test_actor(('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid);
    begin perform public.replace_subscription_management_delegates('{}'::uuid[]);
      raise exception 'Ordinary role configured subscription delegates'; exception when insufficient_privilege then null; end;
    begin perform public.list_subscription_management_delegates();
      raise exception 'Ordinary role listed delegate configuration'; exception when insufficient_privilege then null; end;
    begin perform public.replace_subscription_credential_access_grants('{}'::uuid[]);
      raise exception 'Ordinary role configured credential delegates'; exception when insufficient_privilege then null; end;
  end loop;
  assert exists(select 1 from private.subscription_management_grant_events
    where actor_user_id='a1000000-0000-4000-8000-000000000009'
      and after_person_ids=array['a1000000-0000-4000-8000-000000000014']::uuid[]), 'Real P0 and deterministic replacement audited';
  assert exists(select 1 from private.subscription_credential_access_grants where person_id='a1000000-0000-4000-8000-000000000016'), 'Register replacement does not remove independent vault grant';
  assert not has_function_privilege('service_role','public.list_subscription_management_delegates()','execute');
  assert not has_function_privilege('service_role','public.replace_subscription_management_delegates(uuid[])','execute');
  assert not has_table_privilege('authenticated','private.subscription_management_grant_events','select,insert,update,delete');
end $$;
rollback;
\echo PASS: independent Manager delegation, P0-only audited replacement, revocation and role-gated candidates
