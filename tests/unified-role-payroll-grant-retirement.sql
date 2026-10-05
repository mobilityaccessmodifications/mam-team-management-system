\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
create temp table payroll_grants_before as select jsonb_build_object(
  'grants',(select coalesce(jsonb_agg(to_jsonb(g) order by g.person_id),'[]') from private.payroll_balance_import_grants g),
  'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') from private.payroll_balance_import_grant_events e),
  'comparison_importers',(select coalesce(jsonb_agg(to_jsonb(c) order by c.person_id),'[]') from private.payroll_comparison_only_importers c)
) state;
create temp table payroll_retirement_results(actor uuid,kind text,blocked boolean);
grant insert,select on payroll_retirement_results to authenticated;
set local role authenticated;
do $$ declare n integer; actor uuid; workspace jsonb; blocked boolean; begin
  foreach n in array array[1,2,3,4,5,8,9] loop
    actor:=('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    perform set_config('request.jwt.claim.sub',actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    workspace:=public.get_payroll_balance_import_workspace();
    insert into payroll_retirement_results values(actor,'workspace',not (workspace->>'canManageAccess')::boolean);
    insert into payroll_retirement_results values(actor,'grant_capability',not public.can_manage_payroll_balance_import_grants());
    if n in (3,4,5,9) then
      assert (workspace->>'canImport')::boolean, 'Retired legacy grants must retain role-derived payroll imports';
      assert (workspace->>'comparisonOnly')::boolean=(n=3), 'Only Account remains comparison-only';
      assert (workspace->>'canManageBalances')::boolean=(n<>3), 'Admin/P0 operational balances remain unchanged';
    else
      assert not (workspace->>'canImport')::boolean, 'Employee/Manager cannot acquire payroll import from old grant rows';
    end if;
    blocked:=false;
    begin perform public.replace_payroll_balance_import_grants('{}'::uuid[]);
    exception when insufficient_privilege then blocked:=true; end;
    insert into payroll_retirement_results values(actor,'replace_empty',blocked);
    blocked:=false;
    begin perform public.replace_payroll_balance_import_grants(array['a1000000-0000-4000-8000-000000000014']::uuid[]);
    exception when insufficient_privilege then blocked:=true; end;
    insert into payroll_retirement_results values(actor,'replace_person',blocked);
    blocked:=false;
    begin perform public.replace_payroll_balance_import_grants(null);
    exception when insufficient_privilege then blocked:=true; end;
    insert into payroll_retirement_results values(actor,'replace_null',blocked);
  end loop;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare target uuid; workspace jsonb; begin
  foreach target in array array['a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000005']::uuid[] loop
    workspace:=public.get_payroll_balance_import_workspace_for_preview(target);
    insert into payroll_retirement_results values(target,'preview_workspace',not (workspace->>'canManageAccess')::boolean);
  end loop;
end $$;
reset role;
do $$ declare failures text; after_state jsonb; begin
  select string_agg(r.kind||':'||right(r.actor::text,3),', ' order by r.kind,r.actor) into failures from payroll_retirement_results r where not r.blocked;
  assert failures is null, 'Retired payroll grants still advertise or accept per-person permission mutations: '||failures;
  assert (select count(*)=38 from payroll_retirement_results), 'All role, direct RPC and preview retirement checks executed';
  select jsonb_build_object(
    'grants',(select coalesce(jsonb_agg(to_jsonb(g) order by g.person_id),'[]') from private.payroll_balance_import_grants g),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') from private.payroll_balance_import_grant_events e),
    'comparison_importers',(select coalesce(jsonb_agg(to_jsonb(c) order by c.person_id),'[]') from private.payroll_comparison_only_importers c)
  ) into after_state;
  assert after_state=(select state from payroll_grants_before), 'Legacy payroll grant/configuration rows and full audit history must remain byte-identical';
end $$;
rollback;
\echo PASS: 38 payroll legacy-grant retirement checks; role-derived imports/comparisons and all historical grants/audits retained
