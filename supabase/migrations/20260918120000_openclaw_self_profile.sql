begin;

-- Minimal, read-only employee identity snapshot for the signed OpenClaw
-- bridge. The VPS never receives this complete snapshot: the Next.js contract
-- resolves the trusted WhatsApp sender first and returns only that employee's
-- name and employment type. No caller-selected phone or person ID is accepted.
create function private.openclaw_self_profile_people()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'personId', person.id,
    'userId', person.auth_user_id,
    'company', person.company_key,
    'active', person.is_active,
    'nodeKind', person.node_kind,
    'accountActive', case
      when person.auth_user_id is null then false
      else private.is_active_portal_account(person.auth_user_id)
    end,
    'phone', detail.phone,
    'country', detail.country,
    'fullName', person.full_name,
    'employmentType', detail.employment_type
  ) order by person.id), '[]'::jsonb)
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  where person.company_key = 'mam' and person.is_active;
$$;

revoke all on function private.openclaw_self_profile_people()
  from public, anon, authenticated, service_role;

create function public.openclaw_self_profile_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'complete', true,
    'rows', private.openclaw_self_profile_people()
  );
$$;

revoke all on function public.openclaw_self_profile_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.openclaw_self_profile_snapshot() to service_role;

commit;
