begin;

-- Country is a server-only parsing hint, never part of the OpenClaw response.
-- Add v2 instead of changing v1 so a rolling deployment remains compatible.
create function private.openclaw_whatsapp_allowlist_snapshot_v2()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 2,
    'complete', true,
    'rowCount', count(*),
    'contacts', coalesce(jsonb_agg(jsonb_build_object('phone', details.phone, 'country', details.country)), '[]'::jsonb)
  )
  from public.internal_org_people person
  join private.employee_directory_details details on details.person_id = person.id
  where person.company_key = 'mam' and person.is_active = true;
$$;
revoke all on function private.openclaw_whatsapp_allowlist_snapshot_v2() from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.openclaw_whatsapp_allowlist_snapshot_v2() to service_role;

create function public.openclaw_whatsapp_allowlist_snapshot_v2()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$ select private.openclaw_whatsapp_allowlist_snapshot_v2(); $$;
revoke all on function public.openclaw_whatsapp_allowlist_snapshot_v2() from public, anon, authenticated, service_role;
grant execute on function public.openclaw_whatsapp_allowlist_snapshot_v2() to service_role;

commit;
