begin;

create table private.employee_sick_leave_balances (
  person_id uuid primary key references public.internal_org_people(id) on delete cascade,
  hours numeric(12,4) not null check (hours between -10000 and 100000),
  as_of date not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now()
);
create table private.sick_leave_balance_history (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id),
  hours numeric(12,4) not null,
  as_of date not null,
  actor_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table private.employee_sick_leave_balances enable row level security;
alter table private.sick_leave_balance_history enable row level security;
revoke all on private.employee_sick_leave_balances, private.sick_leave_balance_history from public, anon, authenticated;
-- Preserve payroll precision; rounding at a threshold can send an early reminder.
alter table private.employee_annual_leave_balances alter column hours type numeric(12,4);
alter table private.annual_leave_balance_history alter column hours type numeric(12,4);
alter table private.leave_balance_approvals add column required_hours numeric(12,4)
  check(required_hours > 0 and required_hours <= 100000);
alter table private.leave_priority_reminder_deliveries add column balance_ready boolean not null default false;
create unique index one_balance_ready_reminder_per_request
  on private.leave_priority_reminder_deliveries(source_id) where balance_ready;

create function private.can_view_team_leave_balance(p_person_id uuid, p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_active_portal_account(p_actor) and exists (
    select 1 from public.profiles actor where actor.id=p_actor and actor.app_role='manager'
      and (exists(select 1 from public.internal_org_people p where p.id=p_person_id and p.auth_user_id=p_actor and p.is_active)
        or private.can_submit_team_leave(p_person_id,p_actor)
        or exists(select 1 from public.leave_requests r where r.employee_person_id=p_person_id and r.status='submitted'
          and private.is_current_leave_request_reviewer(r.id,p_actor)))
  );
$$;
revoke all on function private.can_view_team_leave_balance(uuid,uuid) from public,anon,authenticated;

create function public.set_employee_sick_leave_balance(p_person_id uuid,p_hours numeric,p_as_of date)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_system_portal_account_admin() then raise exception 'Only System Admin can update balances.' using errcode='42501'; end if;
  if p_hours is null or p_hours::text in ('NaN','Infinity','-Infinity') or p_hours not between -10000 and 100000
    or p_as_of is null or p_as_of > (now() at time zone 'Australia/Melbourne')::date
    or not exists(select 1 from public.internal_org_people where id=p_person_id and is_active and node_kind='person') then
    raise exception 'Choose a valid employee, balance and balance date.' using errcode='22023';
  end if;
  insert into private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
  values(p_person_id,p_hours,p_as_of,auth.uid()) on conflict(person_id) do update
  set hours=excluded.hours,as_of=excluded.as_of,updated_by=excluded.updated_by,updated_at=now();
  insert into private.sick_leave_balance_history(person_id,hours,as_of,actor_user_id)
  values(p_person_id,p_hours,p_as_of,auth.uid());
end;
$$;
revoke all on function public.set_employee_sick_leave_balance(uuid,numeric,date) from public,anon,authenticated;
grant execute on function public.set_employee_sick_leave_balance(uuid,numeric,date) to authenticated;

-- Needed for day-based requests: workdays are not a confirmed payroll-hours conversion.
create function public.set_leave_balance_required_hours(p_request_id uuid,p_hours numeric)
returns void language plpgsql security definer set search_path='' as $$
declare r public.leave_requests%rowtype;
begin
  if auth.uid() is null or not private.is_active_portal_account() or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'An active portal account is required.' using errcode='42501';
  end if;
  select * into r from public.leave_requests where id=p_request_id for update;
  if not found or r.status<>'submitted' or r.request_type_label<>'Annual leave' or r.user_id=auth.uid()
    or not private.can_review_leave_request(r.id) then
    raise exception 'This request is not available for your review.' using errcode='42501';
  end if;
  if p_hours is null or p_hours::text in ('NaN','Infinity','-Infinity') or p_hours<=0 or p_hours>100000 then
    raise exception 'Enter the paid hours required for this request.' using errcode='22023';
  end if;
  update private.leave_balance_approvals set required_hours=p_hours where request_id=r.id;
  if not found then raise exception 'Approve pending balance first.' using errcode='22023'; end if;
  insert into public.leave_request_events(leave_request_id,actor_user_id,event_type,note)
  values(r.id,auth.uid(),'updated','Paid hours required for the payroll balance reminder: '||p_hours::text);
end;
$$;
revoke all on function public.set_leave_balance_required_hours(uuid,numeric) from public,anon,authenticated;
grant execute on function public.set_leave_balance_required_hours(uuid,numeric) to authenticated;

create function private.leave_payroll_balance_sufficient(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.leave_requests r
    join private.leave_balance_approvals a on a.request_id=r.id
    join private.employee_annual_leave_balances b on b.person_id=r.employee_person_id
    join public.internal_org_people p on p.id=r.employee_person_id and p.is_active
    where r.id=p_request_id and r.status='submitted' and r.record_origin='portal' and r.approval_required
      and r.request_type_label='Annual leave' and not b.is_example
      and b.updated_at >= a.approved_at and b.as_of >= (a.approved_at at time zone 'Australia/Melbourne')::date
      and coalesce(a.required_hours,r.hours)>0 and b.hours>=coalesce(a.required_hours,r.hours));
$$;
revoke all on function private.leave_payroll_balance_sufficient(uuid) from public,anon,authenticated;
create or replace function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); scope_actor uuid; scope_person uuid; scope_admin boolean; requests jsonb; calendar_ids uuid[];
begin
  if actor is null or not private.is_active_portal_account(actor)
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  scope_actor := actor;
  scope_person := private.current_active_portal_employee_id();
  if p_preview_person_id is not null then
    if not private.is_system_portal_account_admin() then raise exception 'Only Super Admin can change profile.' using errcode = '42501'; end if;
    select auth_user_id into scope_actor from public.internal_org_people
    where id = p_preview_person_id and is_active and node_kind = 'person';
    if scope_actor is null or not private.is_active_portal_account(scope_actor) then
      raise exception 'An active linked employee is required.' using errcode = '42501';
    end if;
    scope_person := p_preview_person_id;
    requests := public.get_leave_workspace_for_preview(p_preview_person_id)->'requests';
  else
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into requests from public.list_leave_workspace_requests() r;
  end if;
  scope_admin := p_preview_person_id is null and private.is_system_portal_account_admin();
  select array_agg(c.id) into calendar_ids from public.list_leave_calendar_entries() c;
  return jsonb_build_object(
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'personId', p.id, 'name', p.full_name,
        'canSubmit', private.can_submit_team_leave(p.id,scope_actor) and p.auth_user_id is not null and private.is_active_portal_account(p.auth_user_id),
        -- Delegating managers need category eligibility to offer the correct
        -- request types (not a balance). Do not mask it with financial fields.
        'paidLeave', coalesce(d.employment_type in ('full_time','part_time'),false),
        'canViewBalance', coalesce(p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor), false),
        'hours', case when (p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor)) and d.employment_type in ('full_time','part_time') then coalesce(b.hours,80) else null end,
        'asOf', case when p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then b.as_of else null end,
        'canViewSickBalance', scope_admin or private.can_view_team_leave_balance(p.id,scope_actor),
        'sickHours', case when scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then s.hours else null end,
        'sickAsOf', case when scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then s.as_of else null end,
        'isExample', case when p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then coalesce(b.is_example,true) else false end
      ) order by lower(p.full_name)), '[]'::jsonb)
      from public.internal_org_people p
      left join private.employee_directory_details d on d.person_id = p.id
      left join private.employee_annual_leave_balances b on b.person_id = p.id
      left join private.employee_sick_leave_balances s on s.person_id=p.id
      where p.is_active and p.node_kind = 'person'
        and (p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) or private.can_submit_team_leave(p.id,scope_actor))
    ),
    'canManageBalances', private.is_system_portal_account_admin(),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'pendingBalance', r.status = 'submitted' and a.request_id is not null,
        'evidenceDueDate', r.evidence_due_date,
        'requiredHours', coalesce(a.required_hours,r.hours),
        'balanceSufficient', private.leave_payroll_balance_sufficient(r.id),
        'canAttach', private.can_add_my_leave_request_attachment(r.id)
      )), '[]'::jsonb)
      from public.leave_requests r left join private.leave_balance_approvals a on a.request_id = r.id
      where r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
    ),
    'pendingBalanceCalendarIds', (
      select coalesce(jsonb_agg(r.id),'[]'::jsonb)
      from public.leave_requests r join private.leave_balance_approvals a on a.request_id = r.id
      where r.status = 'submitted' and (
        (p_preview_person_id is null and r.id = any(calendar_ids)
          and (r.user_id=actor or private.can_review_leave_request(r.id)))
        or r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
      )
    )
  );
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public, anon, authenticated;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

alter table private.leave_priority_reminder_deliveries drop constraint leave_priority_reminder_deliveri_kind_source_id_notify_date_key;
create unique index leave_priority_daily_delivery on private.leave_priority_reminder_deliveries(kind,source_id,notify_date) where not balance_ready;
create or replace function public.claim_leave_priority_reminders(p_limit integer default 100)
returns table(delivery_id uuid,claim_token uuid,event text,source_id uuid,employee_name text,
  manager_email text,company text,leave_type text,start_date date,end_date date,status text)
language plpgsql security definer set search_path='' as $$
declare
  local_now timestamp := now() at time zone 'Australia/Melbourne';
  today date := local_now::date;
  local_hour integer := extract(hour from local_now);
begin
  if extract(isodow from today)>5 or local_hour<7 or local_hour>=17 then return; end if;
  -- The 07:00 run is birthdays only. Leave reminders still start at 08:00.
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'leave-reminder',r.id,today from public.leave_requests r
  where local_hour>=8 and r.status='submitted' and r.record_origin='portal' and r.approval_required
    and exists(select 1 from public.internal_org_people p where p.id=r.employee_person_id and p.is_active)
    and not exists(select 1 from private.leave_balance_approvals a where a.request_id=r.id)
    and (select count(*) from generate_series((r.submitted_at at time zone 'Australia/Melbourne')::date+1,today,interval '1 day') d
      where extract(isodow from d) between 1 and 5)>=3
  on conflict do nothing;
  -- One durable row per conditional request, retried across days with the same event key.
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date,balance_ready)
  select 'leave-reminder',a.request_id,today,true from private.leave_balance_approvals a
  where local_hour>=8 and private.leave_payroll_balance_sufficient(a.request_id)
    and not exists(select 1 from private.leave_priority_reminder_deliveries q where q.source_id=a.request_id and q.balance_ready)
  on conflict do nothing;
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'team-birthday',p.id,today
  from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
  where p.is_active and p.node_kind='person' and d.date_of_birth is not null
    and exists(select 1 from generate_series(today+1,today+3,interval '1 day') occurrence
      where private.birthday_reminder_date(occurrence::date)=today
        and extract(month from occurrence)=extract(month from d.date_of_birth)
        and extract(day from occurrence)=extract(day from d.date_of_birth))
  on conflict do nothing;
  return query
  with candidates as (
    select q.id from private.leave_priority_reminder_deliveries q
    where (q.notify_date=today or (q.balance_ready and q.notify_date<=today)) and q.sent_at is null and (q.claimed_until is null or q.claimed_until<now())
      and (q.kind='team-birthday' or (local_hour>=8 and ((q.balance_ready and private.leave_payroll_balance_sufficient(q.source_id)) or (not q.balance_ready and exists (
        select 1 from public.leave_requests pending
        where pending.id=q.source_id and pending.status='submitted'
          and pending.record_origin='portal' and pending.approval_required
          and not exists(select 1 from private.leave_balance_approvals a where a.request_id=pending.id)
          and (select count(*) from generate_series(
            (pending.submitted_at at time zone 'Australia/Melbourne')::date+1,today,interval '1 day') d
            where extract(isodow from d) between 1 and 5)>=3
      )))))
      -- Old-schedule rows must not consume delivery leases or batch capacity.
      and (q.kind<>'team-birthday' or exists (
        select 1 from public.internal_org_people person
        join private.employee_directory_details detail on detail.person_id=person.id
        cross join generate_series(today+1,today+3,interval '1 day') occurrence
        where person.id=q.source_id and person.is_active
          and private.birthday_reminder_date(occurrence::date)=today
          and extract(month from occurrence)=extract(month from detail.date_of_birth)
          and extract(day from occurrence)=extract(day from detail.date_of_birth)
      ))
    order by q.id for update skip locked limit greatest(1,least(coalesce(p_limit,100),100))
  ), claimed as (
    update private.leave_priority_reminder_deliveries q set claim_token=gen_random_uuid(),claimed_until=now()+interval '25 minutes'
    from candidates c where c.id=q.id returning q.*
  )
  select q.id,q.claim_token,q.kind,q.source_id,p.full_name,
    case when q.kind='leave-reminder' then lm.manager_email else md.work_email end,
    p.company_key,coalesce(r.request_type_label,'Birthday'),
    case when q.kind='leave-reminder' then r.start_date else birthday.occurrence end,
    case when q.kind='leave-reminder' then r.end_date else birthday.occurrence end,
    case when a.request_id is not null then 'Approved – pending leave balance' else 'Pending' end
  from claimed q
  left join public.leave_requests r on q.kind='leave-reminder' and r.id=q.source_id
  join public.internal_org_people p on p.id=case when q.kind='team-birthday' then q.source_id else r.employee_person_id end and p.is_active
  left join private.leave_balance_approvals a on a.request_id=r.id
  left join lateral public.resolve_leave_notification_manager(r.id) lm on q.kind='leave-reminder'
  left join lateral private.resolve_internal_org_employee_manager(p.id) bm on q.kind='team-birthday'
  left join private.employee_directory_details md on md.person_id=bm.manager_id
  left join private.employee_directory_details pd on pd.person_id=p.id
  left join lateral (
    select occurrence::date from generate_series(today+1,today+3,interval '1 day') occurrence
    where private.birthday_reminder_date(occurrence::date)=today
      and extract(month from occurrence)=extract(month from pd.date_of_birth)
      and extract(day from occurrence)=extract(day from pd.date_of_birth) limit 1
  ) birthday on q.kind='team-birthday'
  where (q.kind='team-birthday' and birthday.occurrence is not null) or r.status='submitted';
end;
$$;
revoke all on function public.claim_leave_priority_reminders(integer) from public,anon,authenticated;
grant execute on function public.claim_leave_priority_reminders(integer) to service_role;


commit;
