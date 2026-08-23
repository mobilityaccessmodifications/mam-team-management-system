begin;

do $$
begin
  if to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_access_grants') is null then
    raise exception 'Preview check-in prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- A selected directory person without a live portal account has no effective
-- manager scope. Return an empty preview rather than borrowing the person's
-- hierarchy, which previously let a disabled or unlinked profile appear to
-- have access it could not exercise after sign-in.
create or replace function public.list_employee_check_in_workspace_for_preview(p_person_id uuid)
returns table (
  person_id uuid,
  full_name text,
  position_title text,
  company_key text,
  start_date date,
  reminders jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_auth_user_id uuid;
  v_target_can_access boolean := false;
  v_target_is_hr boolean := false;
  v_target_is_global boolean := false;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a Super Admin may preview check-in scope.' using errcode = '42501';
  end if;

  select person.auth_user_id
    into v_target_auth_user_id
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from auth.users member
    where member.id = v_target_auth_user_id
      and member.email_confirmed_at is not null
      and private.is_active_portal_account(member.id)
      and (
        lower(coalesce(member.raw_app_meta_data ->> 'org_role', '')) in ('employee', 'manager', 'hr', 'system_admin')
        or exists (
          select 1
          from private.internal_org_member_allowlist rule
          where rule.revoked_at is null
            and (rule.auth_user_id = member.id or rule.email = lower(coalesce(member.email, '')))
        )
        or exists (
          select 1
          from private.internal_org_domain_allowlist rule
          where rule.revoked_at is null
            and rule.domain = lower(split_part(coalesce(member.email, ''), '@', 2))
        )
      )
  ) into v_target_can_access;

  if v_target_can_access then
    select exists (
      select 1
      from auth.users member
      where member.id = v_target_auth_user_id
        and (
          lower(coalesce(member.raw_app_meta_data ->> 'org_role', '')) in ('hr', 'system_admin')
          or exists (
            select 1
            from private.internal_org_hr_allowlist rule
            where rule.auth_user_id = member.id
              and rule.revoked_at is null
          )
        )
    ) into v_target_is_hr;

    select exists (
      select 1
      from private.employee_check_in_access_grants access_grant
      where access_grant.reviewer_user_id = v_target_auth_user_id
        and access_grant.scope_kind = 'global'
        and access_grant.revoked_at is null
    ) into v_target_is_global;
  end if;

  return query
  with recursive descendants as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active

    union all

    select child.id, child.parent_id, descendants.depth + 1
    from public.internal_org_people child
    join descendants on child.parent_id = descendants.id
    where child.node_kind = 'person'
      and child.is_active
  )
  select
    person.id,
    person.full_name,
    person.position_title,
    person.company_key,
    person.started_date,
    coalesce(schedule.reminders, '[]'::jsonb)
  from public.internal_org_people person
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', reminder.id,
        'milestone', reminder.milestone,
        'sequence', reminder.reminder_sequence,
        'dueDate', reminder.due_date,
        'notifyDate', reminder.notify_date,
        'status', reminder.delivery_status,
        'deliveredAt', reminder.delivered_at,
        'completedAt', reminder.completed_at
      )
      order by reminder.due_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where v_target_can_access
    and person.node_kind = 'person'
    and person.is_active
    and (
      v_target_is_hr
      or v_target_is_global
      or exists (
        select 1
        from descendants
        where descendants.id = person.id
          and descendants.depth > 0
      )
    )
  order by lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_check_in_workspace_for_preview(uuid) is
  'System Admin Change Profile projection of the selected person''s effective live check-in scope. Disabled or unlinked profiles safely return no records.';

revoke all on function public.list_employee_check_in_workspace_for_preview(uuid)
  from public, anon, authenticated;
grant execute on function public.list_employee_check_in_workspace_for_preview(uuid)
  to authenticated, service_role;

commit;
