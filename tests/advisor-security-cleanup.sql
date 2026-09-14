\set ON_ERROR_STOP on

do $$
begin
  assert not has_function_privilege(
    'anon',
    'public.redeem_portal_test_session_ticket(text)',
    'execute'
  ), 'anonymous role can still redeem an obsolete test-session ticket';
  assert not has_function_privilege(
    'authenticated',
    'public.redeem_portal_test_session_ticket(text)',
    'execute'
  ), 'authenticated role can still redeem an obsolete test-session ticket';
  assert has_function_privilege(
    'service_role',
    'public.redeem_portal_test_session_ticket(text)',
    'execute'
  ), 'service role lost the controlled legacy capability';
  assert (
    select count(*)=1
    from pg_policy policy
    join pg_class relation on relation.oid=policy.polrelid
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public'
      and relation.relname='leave_requests'
      and policy.polcmd='r'
      and policy.polroles @> array['authenticated'::regrole::oid]
  ), 'authenticated leave reads still have multiple permissive policies';
  assert exists (
    select 1
    from pg_policy policy
    join pg_class relation on relation.oid=policy.polrelid
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public'
      and relation.relname='leave_requests'
      and policy.polname='leave_requests_select_authorized'
  ), 'combined leave authorization policy is missing';
end;
$$;

set role authenticated;
select set_config('test.actor','10000000-0000-4000-8000-000000000001',false);
do $$
declare visible_ids uuid[];
begin
  select array_agg(id order by id) into visible_ids from public.leave_requests;
  assert visible_ids=array[
    '20000000-0000-4000-8000-000000000001'::uuid,
    '20000000-0000-4000-8000-000000000002'::uuid
  ], 'combined policy changed owner-or-reviewer visibility';
end;
$$;
reset role;
