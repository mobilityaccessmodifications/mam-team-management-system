begin;

do $$
begin
  if to_regclass('public.leave_requests') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.enforce_leave_request_employment_policy()') is null
    or to_regprocedure('public.list_leave_workspace_requests()') is null
    or to_regprocedure('public.list_leave_calendar_entries()') is null then
    raise exception 'Historical leave import prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Leave ownership was originally coupled to a portal login. Historical records
-- must also support former employees who have a retained HR profile but no
-- login. The stable directory person is now the durable employee identity.
alter table public.leave_requests
  add column employee_person_id uuid references public.internal_org_people (id) on delete restrict,
  add column record_origin text not null default 'portal',
  add column source_record_sha256 text;

update public.leave_requests request
set employee_person_id = (
  select person.id
  from public.internal_org_people person
  where person.auth_user_id = request.user_id
    and person.node_kind = 'person'
  order by person.is_active desc, person.updated_at desc, person.id
  limit 1
);

do $$
begin
  if exists (
    select 1
    from public.leave_requests request
    where request.employee_person_id is null
  ) then
    raise exception 'Every existing leave request must resolve to one employee before historical import support is enabled.'
      using errcode = '55000';
  end if;
end;
$$;

alter table public.leave_requests
  alter column employee_person_id set not null,
  alter column user_id drop not null,
  add constraint leave_requests_record_origin_check
    check (record_origin in ('portal', 'historical_import')),
  add constraint leave_requests_origin_identity_check
    check (
      (record_origin = 'portal' and user_id is not null and source_record_sha256 is null)
      or (
        record_origin = 'historical_import'
        and source_record_sha256 ~ '^[0-9a-f]{64}$'
      )
    );

create unique index leave_requests_historical_source_idx
  on public.leave_requests (source_record_sha256)
  where record_origin = 'historical_import';

create index leave_requests_employee_person_dates_idx
  on public.leave_requests (employee_person_id, start_date, end_date);

comment on column public.leave_requests.employee_person_id is
  'Stable employee-directory identity. It remains available after a portal account is disabled or absent.';
comment on column public.leave_requests.record_origin is
  'Portal for ordinary workflow records; historical_import for approved legacy records imported without notifications.';
comment on column public.leave_requests.source_record_sha256 is
  'Non-reversible canonical source-row digest used to make historical imports idempotent.';

-- Preserve the existing eligibility enforcement for portal submissions. A
-- historical import is already-decided source data: it must identify a real
-- retained employee profile, but it must not be reinterpreted using the
-- employee's current classification or active-account status.
create or replace function private.enforce_leave_request_employment_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_person_auth_user_id uuid;
  v_employment_type text;
begin
  if new.record_origin = 'historical_import' then
    select person.id, person.auth_user_id, detail.employment_type
    into v_person_id, v_person_auth_user_id, v_employment_type
    from public.internal_org_people person
    left join private.employee_directory_details detail
      on detail.person_id = person.id
    where person.id = new.employee_person_id
      and person.node_kind = 'person'
    limit 1;

    if v_person_id is null then
      raise exception 'A retained employee profile is required for historical leave.'
        using errcode = '23503';
    end if;

    if new.user_id is not null and new.user_id is distinct from v_person_auth_user_id then
      raise exception 'The historical leave login does not belong to the selected employee.'
        using errcode = '23503';
    end if;

    new.employment_type_snapshot := coalesce(new.employment_type_snapshot, v_employment_type);
    new.pay_treatment := coalesce(
      new.pay_treatment,
      case
        when new.request_type_label = 'Unpaid leave' then 'unpaid'
        when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
        when v_employment_type in ('abn', 'casual') then 'unpaid'
        else null
      end
    );
    return new;
  end if;

  select person.id, detail.employment_type
  into v_person_id, v_employment_type
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.auth_user_id = new.user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_employment_type in ('abn', 'casual')
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'This employment type only allows Unpaid leave.'
      using errcode = '22023';
  end if;

  if v_employment_type is null
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'Ask a System Admin to set your employment type before requesting this leave.'
      using errcode = '22023';
  end if;

  new.employee_person_id := v_person_id;
  new.employment_type_snapshot := v_employment_type;
  new.pay_treatment := case
    when new.request_type_label = 'Unpaid leave' then 'unpaid'
    when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
    else 'unpaid'
  end;

  return new;
end;
$$;

drop function public.list_leave_workspace_requests();

create function public.list_leave_workspace_requests()
returns table (
  id uuid,
  person_id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  approval_required boolean,
  status text,
  submitted_at timestamptz,
  assigned_reviewer_label text,
  can_decide boolean,
  can_cancel boolean,
  can_attach boolean,
  employee_note text,
  manager_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_is_system_admin boolean := private.is_system_portal_account_admin();
  v_actor_person_id uuid := private.current_active_portal_employee_id();
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr and v_actor_person_id is null then
    raise exception 'An active linked employee account is required to view leave.'
      using errcode = '42501';
  end if;

  return query
  select
    request.id,
    employee.id,
    coalesce(employee.full_name, profile.full_name, 'Employee'),
    employee.company_key,
    request.request_type_label,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    request.approval_required,
    case request.status
      when 'approved' then 'Approved'
      when 'rejected' then 'Declined'
      when 'cancelled' then 'Cancelled'
      else 'Pending'
    end,
    request.submitted_at,
    coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot),
    (
      request.user_id is distinct from v_actor_user_id
      and request.approval_required
      and request.status = 'submitted'
      and private.can_review_leave_request(request.id)
    ),
    (
      request.user_id is not null
      and (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status <> 'cancelled'
    ),
    (
      request.user_id is not null
      and (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status in ('submitted', 'approved')
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.internal_org_people employee
    on employee.id = request.employee_person_id
   and employee.node_kind = 'person'
  left join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select assignment.reviewer_label
    from private.leave_request_reviewer_assignments assignment
    where assignment.leave_request_id = request.id
      and assignment.is_primary
    limit 1
  ) primary_assignment on true
  where request.status in ('submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')
    and (
      request.user_id = v_actor_user_id
      or request.employee_person_id = v_actor_person_id
      or private.can_review_leave_request(request.id)
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$$;

comment on function public.list_leave_workspace_requests() is
  'Returns authorised leave records using a stable employee identity, including read-only history for retained archived profiles.';

-- The historical projection removes the stable person_id OUT column from the
-- preceding function contract. PostgreSQL cannot change a table-returning
-- function's OUT row type with CREATE OR REPLACE, so recreate it explicitly.
drop function public.list_leave_calendar_entries();

create function public.list_leave_calendar_entries()
returns table (
  id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_person_id uuid;
  v_actor_company_key text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view the calendar.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr then
    v_actor_person_id := private.current_active_portal_employee_id();
    if v_actor_person_id is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;

    select person.company_key
    into v_actor_company_key
    from public.internal_org_people person
    where person.id = v_actor_person_id
      and person.auth_user_id = v_actor_user_id
      and person.node_kind = 'person'
      and person.is_active;

    if v_actor_company_key is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    request.id,
    employee.full_name,
    employee.company_key,
    case
      when v_actor_is_hr
        or request.user_id = v_actor_user_id
        or request.employee_person_id = v_actor_person_id
        or private.can_review_leave_request(request.id)
        then request.request_type_label
      else 'Away'
    end,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    case request.status
      when 'approved' then 'Approved'
      else 'Pending'
    end
  from public.leave_requests request
  join public.internal_org_people employee
    on employee.id = request.employee_person_id
   and employee.node_kind = 'person'
  where request.status in ('submitted', 'approved')
    and (v_actor_is_hr or employee.company_key = v_actor_company_key)
  order by request.start_date, request.created_at, request.id;
end;
$$;

revoke all on function public.list_leave_workspace_requests() from public, anon, authenticated;
revoke all on function public.list_leave_calendar_entries() from public, anon, authenticated;
revoke all on function private.enforce_leave_request_employment_policy() from public, anon, authenticated;

grant execute on function public.list_leave_workspace_requests() to authenticated;
grant execute on function public.list_leave_calendar_entries() to authenticated;

commit;
