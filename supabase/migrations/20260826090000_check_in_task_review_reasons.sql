begin;

-- Keep the manager task projection safe while exposing the non-sensitive reason
-- that an automatic reminder was paused. This lets an authorised manager
-- understand what needs fixing without exposing HR register fields.
do $$
begin
  if to_regprocedure('public.list_employee_check_in_workspace()') is null then
    raise exception 'Check-in workspace projection is missing.' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.list_employee_check_in_workspace()
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
begin
  if not private.has_employee_check_in_workspace_access() then
    raise exception 'Check-in workspace access is required.' using errcode = '42501';
  end if;

  return query
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
        'completedAt', reminder.completed_at,
        'needsReviewReason', reminder.needs_review_reason
      )
      order by
        reminder.due_date,
        reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where person.node_kind = 'person'
    and person.is_active
    and private.can_view_employee_check_in(person.id)
  order by lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_check_in_workspace() is
  'Returns scoped employee check-ins with non-sensitive delivery review reasons; excludes HR register and recipient details.';

-- The Super Admin Change Profile preview uses a separate scope-checked
-- projection, so keep its safe task details consistent with the live view.
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

  if not found or v_target_auth_user_id is null then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from auth.users member
    where member.id = v_target_auth_user_id
      and member.email_confirmed_at is not null
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
    join auth.users member on member.id = v_target_auth_user_id
    where access_grant.reviewer_user_id = v_target_auth_user_id
      and access_grant.scope_kind = 'global'
      and access_grant.revoked_at is null
      and member.email_confirmed_at is not null
      and private.is_active_portal_account(v_target_auth_user_id)
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
  ) into v_target_is_global;

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
        'completedAt', reminder.completed_at,
        'needsReviewReason', reminder.needs_review_reason
      )
      order by reminder.due_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where person.node_kind = 'person'
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
  'Super Admin-only projection of a selected profile scope with non-sensitive delivery review reasons.';

commit;
