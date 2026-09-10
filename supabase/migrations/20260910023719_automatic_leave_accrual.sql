begin;

-- Immutable effective-dated policy: the owner confirmed 38 ordinary hours/week.
create table private.leave_accrual_policies (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id),
  effective_from date not null,
  weekly_hours numeric(8,4) not null check(weekly_hours > 0 and weekly_hours <= 38),
  weekdays integer[] not null check(cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]),
  annual_weeks numeric(8,4) not null check(annual_weeks >= 4 and annual_weeks <= 52),
  personal_weeks numeric(8,4) not null check(personal_weeks >= 2 and personal_weeks <= 52),
  shiftworker boolean not null default false,
  enabled boolean not null,
  requires_review boolean not null default false,
  note text not null check(length(note) between 1 and 1000),
  actor_user_id uuid references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  check(not shiftworker or annual_weeks >= 5)
);
create index leave_accrual_policy_latest on private.leave_accrual_policies(person_id,effective_from desc,created_at desc);
create table private.leave_accrual_day_reviews (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id),
  service_date date not null,
  annual_eligible_hours numeric(8,4) not null check(annual_eligible_hours between 0 and 24),
  personal_eligible_hours numeric(8,4) not null check(personal_eligible_hours between 0 and 24),
  annual_taken_hours numeric(8,4) not null check(annual_taken_hours between 0 and 24),
  personal_taken_hours numeric(8,4) not null check(personal_taken_hours between 0 and 24),
  request_fingerprint text not null,
  note text not null check(length(note) between 1 and 1000),
  actor_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index leave_accrual_review_latest on private.leave_accrual_day_reviews(person_id,service_date,created_at desc);
create table private.leave_accrual_calculations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id),
  calculated_at timestamptz not null default clock_timestamp(),
  result jsonb not null,
  unique(person_id,result)
);
-- The source snapshots/history are never rewritten by the accrual engine.
alter table private.leave_accrual_policies enable row level security;
alter table private.leave_accrual_day_reviews enable row level security;
alter table private.leave_accrual_calculations enable row level security;
revoke all on private.leave_accrual_policies,private.leave_accrual_day_reviews,private.leave_accrual_calculations from public,anon,authenticated,service_role;

create function private.leave_accrual_request_fingerprint(p_person uuid,p_day date)
returns text language sql stable security definer set search_path='' as $$
  select md5(coalesce(jsonb_agg(jsonb_build_array(r.id,r.status,r.start_date,r.end_date,r.start_time,r.end_time,r.request_type_label,r.pay_treatment,r.hours) order by r.id)::text,'[]'))
  from public.leave_requests r where r.employee_person_id=p_person and r.status='approved' and p_day between r.start_date and r.end_date;
$$;
revoke all on function private.leave_accrual_request_fingerprint(uuid,date) from public,anon,authenticated,service_role;

create function private.calculate_employee_leave_accrual(p_person uuid,p_through date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.employee_annual_leave_balances%rowtype; s private.employee_sick_leave_balances%rowtype;
  pol private.leave_accrual_policies%rowtype; rev private.leave_accrual_day_reviews%rowtype;
  day date; through_day date; first_day date; review_day date; ordinary numeric;
  annual_delta numeric:=0; personal_delta numeric:=0; annual_taken numeric:=0; personal_taken numeric:=0;
  annual_eligible numeric; personal_eligible numeric; start_day date; end_day date; enabled_any boolean;
  fingerprint text; policy_id uuid; status text;
begin
  select * into a from private.employee_annual_leave_balances where person_id=p_person;
  select * into s from private.employee_sick_leave_balances where person_id=p_person;
  select p.started_date,d.scheduled_employment_end_date into start_day,end_day
  from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id where p.id=p_person;
  through_day:=least(p_through,(now() at time zone 'Australia/Melbourne')::date-1);
  select exists(select 1 from private.leave_accrual_policies where person_id=p_person) into enabled_any;
  if p_through is null or ((a.person_id is null or a.is_example) and s.person_id is null) or not enabled_any then
    return jsonb_build_object('status','not_configured','annualHours',a.hours,'personalHours',s.hours,'annualAsOf',a.as_of,'personalAsOf',s.as_of,
      'annualPayrollHours',a.hours,'personalPayrollHours',s.hours,'annualPayrollDate',a.as_of,'personalPayrollDate',s.as_of);
  end if;
  first_day:=least(case when a.person_id is not null and not a.is_example then a.as_of end,s.as_of)+1;
  -- Never silently drop older periods from a very old payroll baseline.
  if through_day-first_day>3660 then
    return jsonb_build_object('status','needs_review','reviewDate',first_day,'annualHours',a.hours,'personalHours',s.hours,'annualAsOf',a.as_of,'personalAsOf',s.as_of,
      'annualPayrollHours',a.hours,'personalPayrollHours',s.hours,'annualPayrollDate',a.as_of,'personalPayrollDate',s.as_of);
  end if;
  for day in select x::date from generate_series(first_day,through_day,interval '1 day') x loop
    if day<coalesce(start_day,day) or day>coalesce(end_day,day) then continue; end if;
    select * into pol from private.leave_accrual_policies where person_id=p_person and effective_from<=day order by effective_from desc,created_at desc,id desc limit 1;
    if not found then
      -- Unknown service/usage between the payroll close and first policy is
      -- not a zero-credit/zero-debit interval. A newer opening snapshot is needed.
      review_day:=day; through_day:=day-1; exit;
    end if;
    policy_id:=pol.id;
    fingerprint:=private.leave_accrual_request_fingerprint(p_person,day);
    select * into rev from private.leave_accrual_day_reviews where person_id=p_person and service_date=day order by created_at desc,id desc limit 1;
    if (pol.requires_review and rev.id is null)
      or (rev.id is not null and rev.request_fingerprint<>fingerprint)
      or (rev.id is null and fingerprint<>md5('[]')) then
      review_day:=day; through_day:=day-1; exit;
    end if;
    -- 420 is divisible by every possible weekday count (1..7). Keep the
    -- numerator exact across days/policies and divide once after summation.
    ordinary:=case when pol.enabled and extract(isodow from day)::integer=any(pol.weekdays) then pol.weekly_hours*(420/cardinality(pol.weekdays)) else 0 end;
    annual_eligible:=case when pol.enabled or pol.requires_review then coalesce(rev.annual_eligible_hours*420,ordinary) else 0 end;
    personal_eligible:=case when pol.enabled or pol.requires_review then coalesce(rev.personal_eligible_hours*420,ordinary) else 0 end;
    if a.person_id is not null and not a.is_example and day>a.as_of then
      annual_delta:=annual_delta+annual_eligible*pol.annual_weeks;
      annual_taken:=annual_taken+coalesce(rev.annual_taken_hours,0);
    end if;
    if day>s.as_of then
      personal_delta:=personal_delta+personal_eligible*pol.personal_weeks;
      personal_taken:=personal_taken+coalesce(rev.personal_taken_hours,0);
    end if;
  end loop;
  annual_delta:=annual_delta/(420*52); personal_delta:=personal_delta/(420*52);
  status:=case when review_day is not null then 'needs_review' else 'current' end;
  return jsonb_build_object('status',status,'reviewDate',review_day,
    'annualHours',round(a.hours+annual_delta-annual_taken,4),'personalHours',round(s.hours+personal_delta-personal_taken,4),
    'annualExactHours',a.hours+annual_delta-annual_taken,'personalExactHours',s.hours+personal_delta-personal_taken,
    'annualAsOf',case when a.person_id is null or a.is_example then a.as_of else greatest(a.as_of,through_day) end,'personalAsOf',case when s.person_id is null then null else greatest(s.as_of,through_day) end,'policyId',policy_id,
    'annualPayrollHours',a.hours,'personalPayrollHours',s.hours,'annualPayrollDate',a.as_of,'personalPayrollDate',s.as_of,
    'annualEarned',annual_delta,'personalEarned',personal_delta,'annualTaken',annual_taken,'personalTaken',personal_taken);
end;
$$;
revoke all on function private.calculate_employee_leave_accrual(uuid,date) from public,anon,authenticated,service_role;

-- Daily durable checkpoints; live reads re-evaluate inputs so a cancellation,
-- policy edit or refreshed payroll snapshot never leaves a stale spendable balance.
create function public.refresh_employee_leave_accrual()
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  insert into private.leave_accrual_calculations(person_id,result)
  select distinct p.person_id,private.calculate_employee_leave_accrual(p.person_id,(now() at time zone 'Australia/Melbourne')::date-1)
  from private.leave_accrual_policies p on conflict(person_id,result) do nothing;
  get diagnostics n=row_count; return n;
end;
$$;
revoke all on function public.refresh_employee_leave_accrual() from public,anon,authenticated;
grant execute on function public.refresh_employee_leave_accrual() to service_role;

create function public.set_employee_leave_accrual_policy(p_person_id uuid,p_weekly_hours numeric,p_annual_weeks numeric,p_personal_weeks numeric,p_shiftworker boolean,p_enabled boolean,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare weekdays integer[]; employment text;
begin
  if not private.is_system_portal_account_admin() then raise exception 'Only System Admin can configure accrual.' using errcode='42501';end if;
  select d.employment_type,case when cardinality(d.working_weekdays)>0 then d.working_weekdays else array[1,2,3,4,5] end into employment,weekdays
  from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id=p_person_id and p.is_active for update of p,d;
  if not found or employment not in ('full_time','part_time') or employment is null then raise exception 'An active permanent employee is required.';end if;
  if p_enabled and not exists(select 1 from private.leave_accrual_policies where person_id=p_person_id) then
    if not exists(select 1 from private.employee_annual_leave_balances where person_id=p_person_id and not is_example)
      and not exists(select 1 from private.employee_sick_leave_balances where person_id=p_person_id) then
      raise exception 'Supply an authoritative opening payroll balance first.';
    end if;
    if exists(select 1 from private.employee_annual_leave_balances where person_id=p_person_id and not is_example and as_of<(now() at time zone 'Australia/Melbourne')::date-1)
      or exists(select 1 from private.employee_sick_leave_balances where person_id=p_person_id and as_of<(now() at time zone 'Australia/Melbourne')::date-1) then
      raise exception 'Supply opening payroll balances covering yesterday before first activation.';
    end if;
  end if;
  if p_weekly_hours::text in ('NaN','Infinity','-Infinity') or p_annual_weeks::text in ('NaN','Infinity','-Infinity') or p_personal_weeks::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter finite hours and entitlements.';end if;
  insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,shiftworker,enabled,note,actor_user_id)
  values(p_person_id,greatest((now() at time zone 'Australia/Melbourne')::date,(select max(effective_from) from private.leave_accrual_policies where person_id=p_person_id)),p_weekly_hours,weekdays,p_annual_weeks,p_personal_weeks,p_shiftworker,p_enabled,btrim(p_note),auth.uid());
end;
$$;
revoke all on function public.set_employee_leave_accrual_policy(uuid,numeric,numeric,numeric,boolean,boolean,text) from public,anon,authenticated;
grant execute on function public.set_employee_leave_accrual_policy(uuid,numeric,numeric,numeric,boolean,boolean,text) to authenticated;

create function public.review_employee_leave_accrual_day(p_person_id uuid,p_date date,p_annual_eligible numeric,p_personal_eligible numeric,p_annual_taken numeric,p_personal_taken numeric,p_note text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_system_portal_account_admin() then raise exception 'Only System Admin can reconcile payroll hours.' using errcode='42501';end if;
  if p_date is null or p_date>(now() at time zone 'Australia/Melbourne')::date-1
    or not exists(select 1 from private.leave_accrual_policies where person_id=p_person_id and effective_from<=p_date) then raise exception 'Choose a completed day covered by an accrual policy.';end if;
  if p_annual_eligible::text in ('NaN','Infinity','-Infinity') or p_personal_eligible::text in ('NaN','Infinity','-Infinity')
    or p_annual_taken::text in ('NaN','Infinity','-Infinity') or p_personal_taken::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter finite hours.';end if;
  if (p_annual_eligible>0 or p_personal_eligible>0) and exists(select 1 from (select enabled,requires_review from private.leave_accrual_policies where person_id=p_person_id and effective_from<=p_date order by effective_from desc,created_at desc,id desc limit 1) policy where not enabled and not requires_review) then
    raise exception 'This period is explicitly non-accruing.';
  end if;
  -- Serialize the confirmed absence fingerprint against concurrent leave decisions.
  lock table public.leave_requests in share mode;
  insert into private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
  values(p_person_id,p_date,p_annual_eligible,p_personal_eligible,p_annual_taken,p_personal_taken,private.leave_accrual_request_fingerprint(p_person_id,p_date),btrim(p_note),auth.uid());
end;
$$;
revoke all on function public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text) to authenticated;

-- Employment/schedule changes take effect prospectively, never rewrite earned history.
-- Changes before the initial start must also supersede that future-dated policy.
create function private.leave_accrual_track_employment()
returns trigger language plpgsql security definer set search_path='' as $$
declare person uuid; pol private.leave_accrual_policies%rowtype; weekdays integer[]; eligible boolean; classification_changed boolean:=false; reactivated boolean:=false;
begin
  if tg_table_name='employee_directory_details' then
    if new.employment_type is not distinct from old.employment_type and new.working_weekdays is not distinct from old.working_weekdays then return new;end if;
    person:=new.person_id; classification_changed:=new.employment_type is distinct from old.employment_type;
  else
    if new.is_active is not distinct from old.is_active then return new;end if;
    person:=new.id; reactivated:=new.is_active and not old.is_active;
  end if;
  select * into pol from private.leave_accrual_policies where person_id=person order by effective_from desc,created_at desc,id desc limit 1;
  if not found then return new;end if;
  select p.is_active and (d.employment_type is null or d.employment_type in ('full_time','part_time')),case when cardinality(d.working_weekdays)>0 then d.working_weekdays else array[1,2,3,4,5] end
  into eligible,weekdays from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id=person;
  insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,shiftworker,enabled,requires_review,note,actor_user_id)
  values(person,greatest((now() at time zone 'Australia/Melbourne')::date,pol.effective_from),pol.weekly_hours,weekdays,pol.annual_weeks,pol.personal_weeks,pol.shiftworker,
    case when classification_changed then false else pol.enabled and coalesce(eligible,false) end,
    coalesce(eligible,false) and (classification_changed or pol.requires_review or reactivated),
    'Employment or schedule changed; classification changes require confirmation of ordinary hours.',null);
  return new;
end;
$$;
revoke all on function private.leave_accrual_track_employment() from public,anon,authenticated,service_role;
create trigger leave_accrual_detail_change after update on private.employee_directory_details for each row execute function private.leave_accrual_track_employment();
create trigger leave_accrual_active_change after update on public.internal_org_people for each row execute function private.leave_accrual_track_employment();

-- Initial rollout is limited to confirmed active Full Time payroll employees.
insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
select p.id,'2026-09-11',38,case when cardinality(d.working_weekdays)>0 then d.working_weekdays else array[1,2,3,4,5] end,4,2,true,
  'Owner confirmed 38 ordinary hours weekly on 10 September 2026; NES base entitlement, payroll close 10 September.'
from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
join private.employee_annual_leave_balances a on a.person_id=p.id and not a.is_example
join private.employee_sick_leave_balances s on s.person_id=p.id
where p.is_active and d.employment_type='full_time' and a.source_import_id is not null and s.source_import_id is not null;

-- Preserve the existing authorisation and preview DTO exactly, then replace only
-- fields the original projection already permitted. No sick-derived metadata to staff.
alter function public.get_leave_priority_workspace(uuid) rename to get_leave_priority_workspace_before_accrual;
revoke all on function public.get_leave_priority_workspace_before_accrual(uuid) from public,anon,authenticated,service_role;
create function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w jsonb; people jsonb:='[]'; person jsonb; c jsonb; pol private.leave_accrual_policies%rowtype;
begin
  w:=public.get_leave_priority_workspace_before_accrual(p_preview_person_id);
  for person in select * from jsonb_array_elements(w->'people') loop
    if coalesce((person->>'canViewBalance')::boolean,false) or coalesce((person->>'canViewSickBalance')::boolean,false) then
      c:=private.calculate_employee_leave_accrual((person->>'personId')::uuid,(now() at time zone 'Australia/Melbourne')::date-1);
      if c->>'status'<>'not_configured' and (person->>'canViewBalance')::boolean and (person->>'paidLeave')::boolean then
        person:=person||jsonb_build_object('hours',coalesce(c->'annualHours',person->'hours'),'asOf',c->'annualAsOf',
          'annualPayrollHours',c->'annualPayrollHours','annualPayrollDate',c->'annualPayrollDate');
      end if;
      if c->>'status'<>'not_configured' and (person->>'canViewSickBalance')::boolean then
        person:=person||jsonb_build_object('sickHours',c->'personalHours','sickAsOf',c->'personalAsOf',
          'sickPayrollHours',c->'personalPayrollHours','sickPayrollDate',c->'personalPayrollDate');
      end if;
      -- A neutral reconciliation status contains no leave type, amount or reason.
      person:=person||jsonb_build_object('accrualStatus',c->'status');
      if private.is_system_portal_account_admin() and p_preview_person_id is null then
        select * into pol from private.leave_accrual_policies where person_id=(person->>'personId')::uuid order by effective_from desc,created_at desc,id desc limit 1;
        person:=person||jsonb_build_object('accrualReviewDate',c->'reviewDate','accrualPolicy',case when pol.id is null then null else jsonb_build_object('weeklyHours',pol.weekly_hours,'annualWeeks',pol.annual_weeks,'personalWeeks',pol.personal_weeks,'shiftworker',pol.shiftworker,'enabled',pol.enabled) end);
      end if;
    end if;
    people:=people||jsonb_build_array(person);
  end loop;
  return jsonb_set(w,'{people}',people);
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public,anon,authenticated;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

create or replace function private.leave_payroll_balance_sufficient(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leave_requests r
 join private.leave_balance_approvals a on a.request_id=r.id
 join private.employee_annual_leave_balances b on b.person_id=r.employee_person_id
 join public.internal_org_people p on p.id=r.employee_person_id and p.is_active
 cross join lateral (select private.calculate_employee_leave_accrual(p.id,(now() at time zone 'Australia/Melbourne')::date-1) c) calculated
 where r.id=p_request_id and r.status='submitted' and r.record_origin='portal' and r.approval_required
 and r.request_type_label='Annual leave' and not b.is_example and coalesce(a.required_hours,r.hours)>0
 and calculated.c->>'status'<>'needs_review'
 and case when calculated.c->>'status'='current' then
   (calculated.c->>'annualAsOf')::date >= (a.approved_at at time zone 'Australia/Melbourne')::date
   and (calculated.c->>'annualExactHours')::numeric>=coalesce(a.required_hours,r.hours)
 else b.updated_at>=a.approved_at and b.as_of>=(a.approved_at at time zone 'Australia/Melbourne')::date
   and b.hours>=coalesce(a.required_hours,r.hours) end);
$$;

commit;
