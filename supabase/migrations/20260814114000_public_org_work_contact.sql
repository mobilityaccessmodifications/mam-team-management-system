begin;

-- A work email is intentionally the only contact field available from the
-- organisation tree. All other employee contact and employment data remains
-- in private.employee_directory_details and is available only to HR through
-- the HR directory RPCs.
create function public.get_internal_org_work_email(p_person_id uuid)
returns table (
  person_id uuid,
  work_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_person_id is null then
    raise exception 'An organisation person is required.' using errcode = '22004';
  end if;

  -- Do not rely on the client tree state for authorisation. This check also
  -- applies when the function is called directly through the Data API.
  if not private.is_internal_org_member() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    detail.work_email
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;
end;
$$;

comment on function public.get_internal_org_work_email(uuid) is
  'Returns the selected active person''s work email only to an authenticated internal member. It never returns private HR directory fields.';

revoke all on function public.get_internal_org_work_email(uuid)
  from public, anon, authenticated;

grant execute on function public.get_internal_org_work_email(uuid)
  to authenticated;

commit;
