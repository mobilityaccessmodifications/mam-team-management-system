begin;

-- A legacy roster person can have a linked portal account before HR has
-- completed a full private-directory record. Keep public.full_name canonical
-- for those people rather than attempting to derive a first/last name from it.
-- The only incomplete detail rows this migration creates are contact-only
-- self-service records; HR can complete the optional first/last-name fields
-- through the existing HR-only directory workflow later.
alter table private.employee_directory_details
  alter column first_name drop not null;

comment on column private.employee_directory_details.first_name is
  'HR-maintained first name. It may be null only for a contact-only self-service detail row; public.internal_org_people.full_name remains the canonical work identity.';

-- Keep self-service changes distinguishable from HR changes without ever
-- retaining private values in the audit log. The existing changed_fields
-- allowlist already limits this event to approved field labels.
alter table private.employee_directory_audit_events
  drop constraint employee_directory_audit_events_event_type_check;

alter table private.employee_directory_audit_events
  add constraint employee_directory_audit_events_event_type_check
  check (event_type in ('created', 'updated', 'self_service_updated'));

comment on table private.employee_directory_audit_events is
  'Append-only HR and self-service employee-directory audit. It stores actor and changed field labels only, never HR data values.';

-- This private helper intentionally derives the person only from the current
-- Auth session. It never accepts a person or account identifier from the
-- browser, so it cannot be used to select another employee's details.
create function private.current_active_portal_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select person.id
  from public.internal_org_people person
  where (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.is_active_portal_account()
    and private.is_internal_org_member()
    and person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
  limit 1;
$$;

comment on function private.current_active_portal_employee_id() is
  'Returns the current Auth user''s linked active organisation person, or null. It requires a current active managed portal account plus internal-membership authorization and never accepts a client-supplied identity.';

-- This is the sole self-service read projection. It deliberately excludes
-- country, employment dates, account/login details, other employees' contact
-- fields, and all HR-only directory information. `detail_version = 0` and
-- `has_detail = false` identify a legacy linked person with no detail row.
create function public.get_my_employee_profile()
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  has_detail boolean,
  full_name text,
  position_title text,
  company_key text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  date_of_birth date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid := private.current_active_portal_employee_id();
begin
  if v_person_id is null then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    detail.person_id is not null,
    person.full_name,
    person.position_title,
    person.company_key,
    detail.team_name,
    manager.id,
    manager.full_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.date_of_birth
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral (
    with recursive ancestors as (
      select
        parent.id,
        parent.full_name,
        parent.parent_id,
        parent.node_kind,
        parent.is_active,
        1 as depth
      from public.internal_org_people parent
      where parent.id = person.parent_id

      union all

      select
        parent.id,
        parent.full_name,
        parent.parent_id,
        parent.node_kind,
        parent.is_active,
        ancestors.depth + 1
      from public.internal_org_people parent
      join ancestors on parent.id = ancestors.parent_id
    )
    select ancestor.id, ancestor.full_name
    from ancestors ancestor
    where ancestor.node_kind = 'person'
      and ancestor.is_active
    order by ancestor.depth
    limit 1
  ) manager on true
  where person.id = v_person_id
    -- Reassert the self binding in the final data query in case an account
    -- link is changed concurrently after the helper's authorization check.
    and person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
    and private.is_active_portal_account()
    and private.is_internal_org_member();
end;
$$;

comment on function public.get_my_employee_profile() is
  'Returns only the current active portal account''s safe work identity plus own phone, personal email, date of birth, and read-only work email. It never accepts an employee identifier.';

-- This is the sole self-service write path. It does not accept an employee
-- identifier and does not write work identity, work email, account data, or
-- any other HR-only field. A contact-only detail row may be created for a
-- legacy linked person, without manufacturing a first or last name.
create function public.update_my_employee_profile(
  p_phone text,
  p_personal_email text,
  p_date_of_birth date,
  p_expected_detail_version bigint
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  has_detail boolean,
  full_name text,
  position_title text,
  company_key text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  date_of_birth date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_has_detail boolean;
  v_phone text;
  v_personal_email text;
  v_detail_changed boolean;
  v_changed_fields text[];
begin
  if v_actor is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;

  -- Lock the account before checking its active/credential state. A concurrent
  -- account disable therefore serialises before or after this self-service
  -- change; a disabled session cannot slip through on a stale JWT.
  perform 1
  from public.profiles profile
  where profile.id = v_actor
  for share;

  if not found
    or not private.is_active_portal_account()
    or not private.is_internal_org_member() then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;

  -- Match the HR-directory lock order (person, then details). The person lock
  -- also guarantees the linked active person still exists while the detail is
  -- being changed and while the safe Realtime refresh below is emitted.
  select person.*
  into v_person
  from public.internal_org_people person
  where person.auth_user_id = v_actor
    and person.node_kind = 'person'
    and person.is_active
  for update;

  if not found then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;

  if p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The expected employee detail version is required.' using errcode = '22004';
  end if;

  v_phone := private.normalise_employee_directory_text(p_phone, 64, false, 'Phone');
  v_personal_email := private.normalise_employee_directory_email(p_personal_email, 'Personal email');

  if p_date_of_birth is not null and p_date_of_birth > current_date then
    raise exception 'Date of birth cannot be in the future.' using errcode = '22023';
  end if;

  select detail.*
  into v_detail
  from private.employee_directory_details detail
  where detail.person_id = v_person.id
  for update;
  v_has_detail := found;

  if v_has_detail and v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  if not v_has_detail and p_expected_detail_version <> 0 then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  v_detail_changed := case
    when v_has_detail then
      v_detail.phone is distinct from v_phone
      or v_detail.personal_email is distinct from v_personal_email
      or v_detail.date_of_birth is distinct from p_date_of_birth
    else
      v_phone is not null
      or v_personal_email is not null
      or p_date_of_birth is not null
  end;

  if v_detail_changed then
    select coalesce(array_agg(change.field_name order by change.sort_order), array[]::text[])
    into v_changed_fields
    from (
      values
        (1, 'personal_email'::text, case when v_has_detail then v_detail.personal_email is distinct from v_personal_email else v_personal_email is not null end),
        (2, 'phone'::text, case when v_has_detail then v_detail.phone is distinct from v_phone else v_phone is not null end),
        (3, 'date_of_birth'::text, case when v_has_detail then v_detail.date_of_birth is distinct from p_date_of_birth else p_date_of_birth is not null end)
    ) as change(sort_order, field_name, is_changed)
    where change.is_changed;

    if v_has_detail then
      update private.employee_directory_details detail
      set personal_email = v_personal_email,
          phone = v_phone,
          date_of_birth = p_date_of_birth,
          updated_by = v_actor
      where detail.person_id = v_person.id
      returning * into v_detail;
    else
      insert into private.employee_directory_details (
        person_id,
        first_name,
        last_name,
        personal_email,
        phone,
        date_of_birth,
        created_by,
        updated_by
      )
      values (
        v_person.id,
        null,
        null,
        v_personal_email,
        v_phone,
        p_date_of_birth,
        v_actor,
        v_actor
      )
      returning * into v_detail;
    end if;

    -- Private contact changes do not alter the org hierarchy or any public
    -- field. This touch only advances the existing safe org projection's
    -- version/updated_at trigger so subscribed HR/tree clients can reload;
    -- no private value is copied to public.internal_org_people.
    update public.internal_org_people person
    set updated_by = v_actor
    where person.id = v_person.id;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      v_person.id,
      v_actor,
      'self_service_updated',
      v_changed_fields
    );
  end if;

  return query select * from public.get_my_employee_profile();
end;
$$;

comment on function public.update_my_employee_profile(text, text, date, bigint) is
  'Updates only the current active portal account''s phone, personal email, and date of birth. Work email and work identity are read-only. Expected detail version 0 creates a contact-only detail row when none exists.';

-- Private tables remain non-queryable to browser roles. The only client
-- surface is the two public RPCs above; each derives the target from auth.uid.
revoke all on function private.current_active_portal_employee_id()
  from public, anon, authenticated;
revoke all on function public.get_my_employee_profile()
  from public, anon, authenticated;
revoke all on function public.update_my_employee_profile(text, text, date, bigint)
  from public, anon, authenticated;

grant execute on function public.get_my_employee_profile()
  to authenticated;
grant execute on function public.update_my_employee_profile(text, text, date, bigint)
  to authenticated;

commit;
