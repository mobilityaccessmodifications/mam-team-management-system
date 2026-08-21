begin;

-- Profile deletion is deliberately narrower than archiving.  A profile with a
-- login, reporting children, or check-in history must be retained and
-- deactivated instead so leave, audit, and reminder history cannot disappear.
create or replace function public.can_delete_employee_directory_profile()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or private.is_internal_org_hr();
$$;

create or replace function public.delete_employee_directory_record(
  p_person_id uuid,
  p_expected_person_version bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person public.internal_org_people%rowtype;
  v_has_roster_link boolean := false;
begin
  if not public.can_delete_employee_directory_profile() then
    raise exception 'Only an authorised HR or Super Admin user can delete employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.*
    into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee record no longer exists.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  if v_person.is_active then
    raise exception 'Deactivate the employee and confirm an end date before deleting the profile.'
      using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null then
    raise exception 'Unlink the portal account before deleting this profile.'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.internal_org_people child
    where child.parent_id = p_person_id
  ) then
    raise exception 'Move or delete this employee''s reporting line before deleting the profile.'
      using errcode = '23503';
  end if;

  if to_regclass('private.employee_check_in_reminders') is not null
    and exists (
      select 1
      from private.employee_check_in_reminders reminder
      where reminder.person_id = p_person_id
    ) then
    raise exception 'This profile has check-in history. Deactivate it instead of deleting it.'
      using errcode = '23503';
  end if;

  if to_regclass('private.employee_check_in_enrolments') is not null
    and exists (
      select 1
      from private.employee_check_in_enrolments enrolment
      where enrolment.person_id = p_person_id
    ) then
    raise exception 'This profile has check-in history. Deactivate it instead of deleting it.'
      using errcode = '23503';
  end if;

  if to_regclass('private.employee_roster_person_links') is not null then
    execute 'select exists (select 1 from private.employee_roster_person_links where person_id = $1)'
      into v_has_roster_link
      using p_person_id;
    if v_has_roster_link then
      raise exception 'This profile is part of the authoritative roster. Deactivate it instead of deleting it.'
        using errcode = '23503';
    end if;
  end if;

  begin
    delete from public.internal_org_people person
    where person.id = p_person_id;
  exception
    when foreign_key_violation then
      raise exception 'This profile is referenced by existing records. Deactivate it instead.'
        using errcode = '23503';
  end;

  return p_person_id;
end;
$$;

comment on function public.can_delete_employee_directory_profile() is
  'Returns whether the current HR or Super Admin account may request a guarded employee-profile deletion.';
comment on function public.delete_employee_directory_record(uuid, bigint) is
  'Deletes only inactive, unlinked, history-free employee profiles. Profiles with operational history must be deactivated instead.';

revoke all on function public.can_delete_employee_directory_profile() from public, anon, authenticated;
revoke all on function public.delete_employee_directory_record(uuid, bigint) from public, anon, authenticated;
grant execute on function public.can_delete_employee_directory_profile() to authenticated;
grant execute on function public.delete_employee_directory_record(uuid, bigint) to authenticated;

-- System Admin is a global check-in/calendar reviewer even when the account is
-- intentionally outside the employee roster. HR and scoped managers retain
-- their existing row-scope rules.
create or replace function private.has_employee_check_in_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
with recursive actor as (
  select person.id
  from public.internal_org_people person
  where person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
  limit 1
), descendants as (
  select child.id
  from public.internal_org_people child
  join actor on child.parent_id = actor.id
  where child.node_kind = 'person'
    and child.is_active

  union all

  select child.id
  from public.internal_org_people child
  join descendants parent on child.parent_id = parent.id
  where child.node_kind = 'person'
    and child.is_active
)
select private.has_current_portal_access()
  and (select auth.uid()) is not null
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    private.is_system_portal_account_admin()
    or private.is_internal_org_hr()
    or (
      private.is_internal_org_member()
      and private.is_active_portal_account((select auth.uid()))
      and (
        exists (
          select 1
          from private.employee_check_in_access_grants access_grant
          where access_grant.reviewer_user_id = (select auth.uid())
            and access_grant.revoked_at is null
            and (
              access_grant.scope_kind = 'global'
              or exists (
                select 1
                from public.internal_org_people root_person
                where root_person.id = access_grant.scope_root_person_id
                  and root_person.node_kind = 'person'
                  and root_person.is_active
                  and root_person.auth_user_id = (select auth.uid())
              )
            )
        )
        or exists (select 1 from descendants)
      )
    )
  );
$$;

create or replace function private.can_view_employee_check_in(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
with recursive target_ancestors as (
  select target.id, target.parent_id, 0::integer as depth
  from public.internal_org_people target
  where target.id = p_person_id
    and target.node_kind = 'person'
    and target.is_active

  union all

  select parent.id, parent.parent_id, target_ancestors.depth + 1
  from public.internal_org_people parent
  join target_ancestors on target_ancestors.parent_id = parent.id
  where parent.is_active
), actor as (
  select person.id
  from public.internal_org_people person
  where person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
  limit 1
)
select private.has_employee_check_in_workspace_access()
  and exists (select 1 from target_ancestors where depth = 0)
  and (
    private.is_system_portal_account_admin()
    or private.is_internal_org_hr()
    or exists (
      select 1
      from private.employee_check_in_access_grants access_grant
      where access_grant.reviewer_user_id = (select auth.uid())
        and access_grant.revoked_at is null
        and private.is_active_portal_account(access_grant.reviewer_user_id)
        and (
          access_grant.scope_kind = 'global'
          or (
            access_grant.scope_kind = 'subtree'
            and exists (
              select 1
              from public.internal_org_people root_person
              where root_person.id = access_grant.scope_root_person_id
                and root_person.node_kind = 'person'
                and root_person.is_active
                and root_person.auth_user_id = (select auth.uid())
            )
            and exists (
              select 1
              from target_ancestors ancestor
              where ancestor.id = access_grant.scope_root_person_id
                and ancestor.depth > 0
            )
          )
        )
    )
    or (
      private.is_internal_org_member()
      and private.is_active_portal_account((select auth.uid()))
      and exists (
        select 1
        from target_ancestors ancestor
        join actor on actor.id = ancestor.id
        where ancestor.depth > 0
      )
    )
  );
$$;

-- HR/Super Admin calendars include completed check-in dates for historical
-- visibility. Scoped managers still receive only open actionable milestones.
create or replace function public.list_employee_check_in_calendar_entries()
returns table (
  reminder_id uuid,
  person_id uuid,
  employee_name text,
  milestone text,
  sequence text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_employee_check_in_workspace_access() then
    return;
  end if;

  return query
  select
    reminder.id,
    person.id,
    person.full_name,
    reminder.milestone,
    reminder.reminder_sequence,
    reminder.due_date,
    reminder.delivery_status
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status <> 'superseded'
    and reminder.delivery_status <> 'cancelled'
    and private.can_view_employee_check_in(person.id)
    and (
      private.is_system_portal_account_admin()
      or private.is_internal_org_hr()
      or reminder.delivery_status <> 'completed'
    )
  order by
    reminder.due_date,
    lower(person.full_name),
    reminder.milestone,
    reminder.reminder_sequence;
end;
$$;

revoke all on function private.has_employee_check_in_workspace_access() from public, anon, authenticated;
revoke all on function private.can_view_employee_check_in(uuid) from public, anon, authenticated;
revoke all on function public.list_employee_check_in_calendar_entries() from public, anon, authenticated;
grant execute on function public.list_employee_check_in_calendar_entries() to authenticated;

commit;
