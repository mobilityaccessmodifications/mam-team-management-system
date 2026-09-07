begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:archive-combined-employment-account-disable:20260908', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regclass('private.portal_account_admin_events') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regprocedure('public.archive_employee_directory_record(uuid,bigint,bigint,date,text)') is null then
    raise exception 'Combined employment archive prerequisites are missing.'
      using errcode = '55000';
  end if;
end;
$$;

-- Ending employment is a single lifecycle decision. Keep the directory
-- archive and the database-side portal-account disablement in one transaction
-- so an employee cannot remain active in one surface and archived in another.
drop function if exists public.archive_employee_directory_record(uuid, bigint, bigint, date, text);

create function public.archive_employee_directory_record(
  p_person_id uuid,
  p_expected_person_version bigint,
  p_expected_detail_version bigint,
  p_end_date date,
  p_archive_reason text
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_profile public.profiles%rowtype;
  v_reason text := nullif(btrim(p_archive_reason), '');
  v_profile_before jsonb;
  v_profile_version bigint;
  v_updated_person public.internal_org_people%rowtype;
  v_updated_detail private.employee_directory_details%rowtype;
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can archive employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1
    or p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  if p_end_date is null then
    raise exception 'Choose an employment end date.' using errcode = '22004';
  end if;

  if v_reason is null or v_reason not in ('Resigned', 'End of contract', 'Terminated', 'Redundant', 'Other') then
    raise exception 'Choose an archive reason.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.* into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee record no longer exists.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  if v_person.started_date is not null and p_end_date < v_person.started_date then
    raise exception 'The end date cannot be before the start date.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.internal_org_people child
    where child.parent_id = p_person_id
      and child.is_active
  ) then
    raise exception 'Move or archive this employee''s active direct reports first.' using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null then
    select profile.* into v_profile
    from public.profiles profile
    where profile.id = v_person.auth_user_id
    for update;

    if found and v_profile.account_status = 'active' then
      if v_person.auth_user_id = v_actor then
        raise exception 'You cannot end employment and disable your own portal account.'
          using errcode = '42501';
      end if;

      if (
        exists (
          select 1
          from private.portal_account_admins administrator
          where administrator.auth_user_id = v_person.auth_user_id
            and administrator.revoked_at is null
        )
        or v_profile.app_role = 'system_admin'
      )
      and not exists (
        select 1
        from public.profiles other_profile
        where other_profile.id <> v_person.auth_user_id
          and other_profile.account_status = 'active'
          and other_profile.login_name is not null
          and (
            other_profile.app_role = 'system_admin'
            or exists (
              select 1
              from private.portal_account_admins other_administrator
              where other_administrator.auth_user_id = other_profile.id
                and other_administrator.revoked_at is null
            )
          )
      ) then
        raise exception 'The last active account administrator cannot be disabled.'
          using errcode = '42501';
      end if;

      v_profile_before := jsonb_build_object(
        'account_status', v_profile.account_status,
        'account_version', v_profile.account_version
      );

      update public.profiles profile
      set account_status = 'disabled',
          disabled_at = clock_timestamp(),
          credentials_valid_after = clock_timestamp(),
          account_version = profile.account_version + 1,
          updated_at = clock_timestamp()
      where profile.id = v_person.auth_user_id
        and profile.account_version = v_profile.account_version
      returning profile.account_version into v_profile_version;

      if not found then
        raise exception 'The portal account changed. Refresh and try again.'
          using errcode = '40001';
      end if;

      insert into private.portal_account_admin_events (
        actor_user_id,
        target_user_id,
        event_type,
        before_state,
        after_state
      )
      values (
        v_actor,
        v_person.auth_user_id,
        'account_disabled',
        v_profile_before,
        jsonb_build_object(
          'account_status', 'disabled',
          'account_version', v_profile_version
        )
      );
    end if;
  end if;

  select detail.* into v_detail
  from private.employee_directory_details detail
  where detail.person_id = p_person_id
  for update;

  if not found then
    raise exception 'The employee detail does not exist.' using errcode = '23503';
  end if;

  if v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  update public.internal_org_people person
  set is_active = false,
      updated_by = v_actor
  where person.id = p_person_id
  returning * into v_updated_person;

  update private.employee_directory_details detail
  set scheduled_employment_end_date = p_end_date,
      archive_reason = v_reason,
      updated_by = v_actor
  where detail.person_id = p_person_id
  returning * into v_updated_detail;

  insert into private.employee_directory_audit_events (
    person_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    p_person_id,
    v_actor,
    'updated',
    array['is_active', 'scheduled_employment_end_date']::text[]
  );

  return query select v_updated_person.id, v_updated_person.version, v_updated_detail.version;
end;
$$;

comment on function public.archive_employee_directory_record(uuid, bigint, bigint, date, text) is
  'Archives an employee and disables the linked portal account in one database transaction while retaining the HR record for authorised reviewers.';

revoke all on function public.archive_employee_directory_record(uuid, bigint, bigint, date, text)
  from public, anon, authenticated;
grant execute on function public.archive_employee_directory_record(uuid, bigint, bigint, date, text)
  to authenticated;

commit;
