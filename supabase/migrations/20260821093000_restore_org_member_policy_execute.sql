begin;

-- internal_org_people RLS policies call this helper as the authenticated
-- invoker. Keep the helper private, but restore the execute privilege that
-- the original directory migration granted to authenticated clients. Without
-- it PostgREST returns a generic directory query error before the policy can
-- evaluate the active-member check.
grant usage on schema private to authenticated;
grant execute on function private.is_internal_org_member() to authenticated;

commit;
