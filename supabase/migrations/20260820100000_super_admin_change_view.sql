begin;

-- Change view is a narrow testing/administration capability. It intentionally
-- reuses the durable system-admin predicate rather than the broader HR or
-- portal-account-admin predicates, so full HR administrators cannot select or
-- edit another employee's private contact profile merely by calling an RPC.
create function public.can_change_employee_view()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_change_employee_view() is
  'Returns whether the active controlled system administrator may use the Super Admin Change view. HR and portal account administrators are intentionally excluded.';

-- Keep the existing return signature, security-definer boundary, active-person
-- filter, and external-manager resolution. The only authority change is that
-- the selected-profile read now requires the same Super Admin capability as
-- the Change view control itself.
create or replace function public.get_selected_employee_profile_for_hr(
  p_person_id uuid
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
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the Super Admin can access selected employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'Choose an employee profile.' using errcode = '22004';
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
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.date_of_birth
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;
end;
$$;

comment on function public.get_selected_employee_profile_for_hr(uuid) is
  'Returns one selected active employee profile only to the Super Admin Change view. Its manager label may fall back to a registered external roster manager; private details remain confined to that capability.';

-- Preserve the established optimistic-concurrency and audit behaviour. This
-- path calls the read function at its end, so both the write and read are
-- independently protected by the Super Admin predicate.
create or replace function public.update_selected_employee_profile_for_hr(
  p_person_id uuid,
  p_personal_email text,
  p_phone text,
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
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the Super Admin can update selected employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'Choose an employee profile.' using errcode = '22004';
  end if;

  if p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The expected employee detail version is required.' using errcode = '22004';
  end if;

  v_phone := private.normalise_employee_directory_text(p_phone, 64, false, 'Phone');
  v_personal_email := private.normalise_employee_directory_email(p_personal_email, 'Personal email');

  if p_date_of_birth is not null and p_date_of_birth > current_date then
    raise exception 'Date of birth cannot be in the future.' using errcode = '22023';
  end if;

  -- Lock in the same order as the existing HR directory and self-service
  -- profile paths. A private contact update then serialises with any hierarchy
  -- edit, detail edit, account relink, or self-service contact update.
  select person.*
  into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
  for update;

  if not found then
    raise exception 'The active employee profile does not exist.' using errcode = '23503';
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
      -- A legacy linked employee may not yet have a full HR detail row. Match
      -- the self-service behaviour: create a contact-only row and leave the
      -- canonical work identity in public.internal_org_people untouched.
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

    -- Do not copy private contact values to the public org tree. Touching the
    -- safe projection only advances its version/updated_at trigger so tree
    -- subscribers and the HR directory can refresh after this change.
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
      case when v_has_detail then 'updated' else 'created' end,
      v_changed_fields
    );
  end if;

  return query select * from public.get_selected_employee_profile_for_hr(v_person.id);
end;
$$;

comment on function public.update_selected_employee_profile_for_hr(uuid, text, text, date, bigint) is
  'Super Admin-only Change view update of a selected active employee''s personal email, phone, and date of birth. Work email and work identity remain read-only here.';

revoke all on function public.can_change_employee_view()
  from public, anon, authenticated;
revoke all on function public.get_selected_employee_profile_for_hr(uuid)
  from public, anon, authenticated;
revoke all on function public.update_selected_employee_profile_for_hr(uuid, text, text, date, bigint)
  from public, anon, authenticated;

grant execute on function public.can_change_employee_view()
  to authenticated;
grant execute on function public.get_selected_employee_profile_for_hr(uuid)
  to authenticated;
grant execute on function public.update_selected_employee_profile_for_hr(uuid, text, text, date, bigint)
  to authenticated;

commit;
