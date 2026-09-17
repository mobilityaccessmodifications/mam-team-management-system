begin;

-- Private definer bridges the confidential table without granting its columns
-- to browser roles. Service identity is enforced by EXECUTE grants rather than
-- auth.uid(): this integration has no human session.
create function private.openclaw_whatsapp_allowlist_snapshot()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'complete', true,
    'rowCount', count(*),
    'phones', coalesce(jsonb_agg(details.phone), '[]'::jsonb)
  )
  from public.internal_org_people person
  join private.employee_directory_details details on details.person_id = person.id
  where person.company_key = 'mam' and person.is_active = true;
$$;
revoke all on function private.openclaw_whatsapp_allowlist_snapshot() from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.openclaw_whatsapp_allowlist_snapshot() to service_role;

-- Scalar JSON aggregation avoids PostgREST's set-returning row/page limit.
create function public.openclaw_whatsapp_allowlist_snapshot()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$ select private.openclaw_whatsapp_allowlist_snapshot(); $$;
revoke all on function public.openclaw_whatsapp_allowlist_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.openclaw_whatsapp_allowlist_snapshot() to service_role;

commit;
