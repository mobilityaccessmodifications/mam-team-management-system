begin;

-- Birthdays are intentionally a distinct, minimal calendar projection. The
-- date of birth remains HR-private in `private.employee_directory_details`;
-- this function exposes only a staff member's display name and recurring
-- month/day to authenticated internal users. It never returns a birth year,
-- person identifier, work contact, personal contact, company, or team.
create function public.list_calendar_birthdays()
returns table (
  employee_name text,
  birthday_month smallint,
  birthday_day smallint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  -- HR may be intentionally outside the employee roster (for example the
  -- system administrator). Every other caller must be an active linked
  -- internal employee; an unlinked portal account cannot enumerate birthdays.
  if not v_actor_is_hr and private.current_active_portal_employee_id() is null then
    raise exception 'An active linked employee account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  return query
  select
    person.full_name,
    extract(month from detail.date_of_birth)::smallint,
    extract(day from detail.date_of_birth)::smallint
  from public.internal_org_people person
  join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
    and person.full_name is not null
    and detail.date_of_birth is not null
  order by
    extract(month from detail.date_of_birth),
    extract(day from detail.date_of_birth),
    lower(person.full_name),
    person.id;
end;
$$;

comment on function public.list_calendar_birthdays() is
  'Returns active staff birthdays for the shared MAM and Equipsy calendar. It exposes only name and recurring month/day, never a birth year or private profile/contact data.';

revoke all on function public.list_calendar_birthdays()
  from public, anon, authenticated;
grant execute on function public.list_calendar_birthdays()
  to authenticated;

commit;
