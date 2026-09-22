begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:automatic-leave-balance-required-hours:20260922', 0)
  );

  if to_regclass('public.leave_requests') is null
    or to_regclass('private.leave_balance_approvals') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_annual_leave_balances') is null
    or to_regprocedure('private.approved_leave_hours_after(uuid,text[],date)') is null
    or to_regprocedure('private.calculate_employee_leave_accrual(uuid,date)') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.can_review_leave_request(uuid)') is null
    or to_regprocedure('public.decide_my_managed_leave_request(uuid,text,text)') is null then
    raise exception 'Automatic leave balance hours prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Keep one authoritative duration rule at the database boundary. Explicit
-- part-day hours win; full-day requests use the snapshotted employment type,
-- with the current directory classification only as a legacy fallback.
create function private.leave_request_required_hours(p_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    request.hours,
    request.business_days::numeric
      * case
          when coalesce(request.employment_type_snapshot, detail.employment_type) = 'full_time'
            then 7.6
          else 7.5
        end
  )
  from public.leave_requests request
  left join private.employee_directory_details detail
    on detail.person_id = request.employee_person_id
  where request.id = p_request_id;
$$;

comment on function private.leave_request_required_hours(uuid) is
  'Returns the authoritative paid hours for one leave request. Explicit request hours take precedence; otherwise full-time days use 7.6 hours and other days use 7.5 hours.';

revoke all on function private.leave_request_required_hours(uuid)
  from public, anon, authenticated, service_role;

-- The trigger also covers an in-flight invocation of the previous decision
-- function during deployment. Its older INSERT omitted required_hours.
create function private.fill_leave_balance_required_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.required_hours is null then
    new.required_hours := private.leave_request_required_hours(new.request_id);
  end if;
  return new;
end;
$$;

revoke all on function private.fill_leave_balance_required_hours()
  from public, anon, authenticated, service_role;

create trigger leave_balance_approvals_fill_required_hours
before insert on private.leave_balance_approvals
for each row execute function private.fill_leave_balance_required_hours();

-- Serialise with conditional approvals while the legacy nullable rows are
-- repaired, then make the invariant permanent for every future approval.
lock table private.leave_balance_approvals in access exclusive mode;

update private.leave_balance_approvals approval
set required_hours = private.leave_request_required_hours(approval.request_id)
where approval.required_hours is null;

do $$
begin
  if exists (
    select 1
    from private.leave_balance_approvals approval
    where approval.required_hours is null or approval.required_hours <= 0
  ) then
    raise exception 'A conditional approval has no derivable paid hours.' using errcode = '23502';
  end if;
end;
$$;

alter table private.leave_balance_approvals
  alter column required_hours set not null;

comment on column private.leave_balance_approvals.required_hours is
  'System-calculated paid hours snapshotted atomically when coverage is conditionally approved.';

create or replace function public.decide_leave_with_balance(
  p_request_id uuid,
  p_status text,
  p_manager_note text default null
)
returns table(id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.leave_requests%rowtype;
  v_required_hours numeric;
begin
  if auth.uid() is null
    or not private.is_active_portal_account()
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;

  if p_status is distinct from 'Approved – pending leave balance' then
    return query
      select *
      from public.decide_my_managed_leave_request(p_request_id, p_status, p_manager_note);
    return;
  end if;

  select *
  into r
  from public.leave_requests
  where leave_requests.id = p_request_id
  for update;

  if not found
    or r.status <> 'submitted'
    or r.request_type_label <> 'Annual leave'
    or r.user_id = auth.uid()
    or not private.can_review_leave_request(r.id) then
    raise exception 'This annual leave request is not available for your decision.' using errcode = '42501';
  end if;

  if length(coalesce(p_manager_note, '')) > 2000 then
    raise exception 'Reviewer note is too long.' using errcode = '22023';
  end if;

  if exists (
    select 1 from private.leave_balance_approvals where request_id = r.id
  ) then
    raise exception 'Coverage is already approved; confirm the balance to approve paid leave.' using errcode = '22023';
  end if;

  v_required_hours := private.leave_request_required_hours(r.id);
  if v_required_hours is null or v_required_hours <= 0 then
    raise exception 'Paid hours could not be calculated for this request.' using errcode = '22023';
  end if;

  insert into private.leave_balance_approvals(request_id, approved_by, required_hours)
  values(r.id, auth.uid(), v_required_hours);

  update public.leave_requests
  set manager_note = nullif(btrim(p_manager_note), ''),
      updated_at = now()
  where leave_requests.id = r.id;

  insert into public.leave_request_events(leave_request_id, actor_user_id, event_type, note)
  values(
    r.id,
    auth.uid(),
    'updated',
    'Coverage approved; paid annual leave awaits balance confirmation.'
  );

  return query select r.id, 'Approved – pending leave balance'::text;
end;
$$;

revoke all on function public.decide_leave_with_balance(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.decide_leave_with_balance(uuid, text, text)
  to authenticated;

-- Retain the old RPC during rollout, but prevent it from overriding the
-- system-derived value. The new application no longer calls this function.
create or replace function public.set_leave_balance_required_hours(
  p_request_id uuid,
  p_hours numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.leave_requests%rowtype;
  v_required_hours numeric;
begin
  if auth.uid() is null
    or not private.is_active_portal_account()
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;

  select *
  into r
  from public.leave_requests
  where id = p_request_id
  for update;

  if not found
    or r.status <> 'submitted'
    or r.request_type_label <> 'Annual leave'
    or r.user_id = auth.uid()
    or not private.can_review_leave_request(r.id) then
    raise exception 'This request is not available for your review.' using errcode = '42501';
  end if;

  v_required_hours := private.leave_request_required_hours(r.id);
  if p_hours is null
    or p_hours::text in ('NaN', 'Infinity', '-Infinity')
    or p_hours is distinct from v_required_hours then
    raise exception 'Paid hours are calculated automatically for this request.' using errcode = '22023';
  end if;

  update private.leave_balance_approvals
  set required_hours = v_required_hours
  where request_id = r.id;

  if not found then
    raise exception 'Approve pending balance first.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.set_leave_balance_required_hours(uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.set_leave_balance_required_hours(uuid, numeric)
  to authenticated;

-- Compare the request with true available hours, not the gross payroll or
-- accrual balance. Future approved bookings remain reserved until taken.
create or replace function private.leave_payroll_balance_sufficient(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.leave_requests request
    join private.leave_balance_approvals approval
      on approval.request_id = request.id
    join private.employee_annual_leave_balances balance
      on balance.person_id = request.employee_person_id
    join public.internal_org_people person
      on person.id = request.employee_person_id and person.is_active
    cross join lateral (
      select private.calculate_employee_leave_accrual(
        person.id,
        (now() at time zone 'Australia/Melbourne')::date - 1
      ) calculation
    ) calculated
    where request.id = p_request_id
      and request.status = 'submitted'
      and request.record_origin = 'portal'
      and request.approval_required
      and request.request_type_label = 'Annual leave'
      and not balance.is_example
      and calculated.calculation ->> 'status' <> 'needs_review'
      and case
        when calculated.calculation ->> 'status' = 'current' then
          (calculated.calculation ->> 'annualAsOf')::date
            >= (approval.approved_at at time zone 'Australia/Melbourne')::date
          and (
            (calculated.calculation ->> 'annualExactHours')::numeric
            - coalesce(private.approved_leave_hours_after(
                person.id,
                array['Annual leave']::text[],
                (calculated.calculation ->> 'annualAsOf')::date
              ), 0)
          ) >= approval.required_hours
        else
          balance.updated_at >= approval.approved_at
          and balance.as_of >= (approval.approved_at at time zone 'Australia/Melbourne')::date
          and (
            balance.hours
            - coalesce(private.approved_leave_hours_after(
                person.id,
                array['Annual leave']::text[],
                balance.as_of
              ), 0)
          ) >= approval.required_hours
      end
  );
$$;

comment on function private.leave_payroll_balance_sufficient(uuid) is
  'Returns true only when a fresh confirmed balance, after other approved annual-leave commitments, covers the system-calculated request hours.';

revoke all on function private.leave_payroll_balance_sufficient(uuid)
  from public, anon, authenticated, service_role;

commit;
