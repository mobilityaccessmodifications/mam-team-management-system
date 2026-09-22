begin;

-- Booking estimate only. Never changes payroll snapshots, accrual checkpoints,
-- reconciliation records or approval rules.
create function private.project_annual_leave_balance(p_person uuid, p_start date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  bank private.employee_annual_leave_balances%rowtype;
  pol private.leave_accrual_policies%rowtype;
  rev private.leave_accrual_day_reviews%rowtype;
  day date; employment_start date; employment_end date;
  approved numeric; ordinary numeric; eligible numeric; unpaid numeric;
  earned_numerator numeric := 0; extra_taken numeric := 0;
  terms jsonb := '{}'::jsonb; term jsonb; result jsonb;
  unavailable boolean := false;
begin
  select * into bank from private.employee_annual_leave_balances where person_id=p_person;
  if bank.person_id is null or bank.is_example or p_start is null then
    return jsonb_build_object('status','unavailable','projectedDate',p_start);
  end if;
  approved := private.approved_leave_hours_after(p_person,array['Annual leave']::text[],bank.as_of);
  result := jsonb_build_object('status','projected','projectedDate',p_start,
    'fromDate',bank.as_of+1,'throughDate',p_start-1,'payrollDate',bank.as_of,
    'payrollHours',bank.hours,'approvedHours',approved,'accruedHours',0,
    'otherTakenHours',0,'availableHours',bank.hours-approved,'terms','[]'::jsonb);
  if p_start <= bank.as_of then return result || jsonb_build_object('status','banked_only'); end if;
  if p_start-bank.as_of>3660 then return jsonb_build_object('status','unavailable','projectedDate',p_start); end if;
  -- Apply known extra usage even if an uncovered policy interval prevents a
  -- forecast. A stale usage review cannot safely support either allowance.
  for rev in select distinct on (service_date) * from private.leave_accrual_day_reviews
    where person_id=p_person and service_date>bank.as_of and service_date<p_start
    order by service_date,created_at desc,id desc loop
    if rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,rev.service_date) then
      return jsonb_build_object('status','unavailable','projectedDate',p_start);
    end if;
    extra_taken := extra_taken+greatest(0,rev.annual_taken_hours-
      (private.approved_leave_hours_after(p_person,array['Annual leave']::text[],rev.service_date-1)
       -private.approved_leave_hours_after(p_person,array['Annual leave']::text[],rev.service_date)));
  end loop;
  result := result || jsonb_build_object('otherTakenHours',extra_taken,'availableHours',bank.hours-approved-extra_taken);
  select person.started_date,detail.scheduled_employment_end_date
    into employment_start,employment_end
    from public.internal_org_people person
    join private.employee_directory_details detail on detail.person_id=person.id
    where person.id=p_person;
  for day in select value::date from generate_series(bank.as_of+1,p_start-1,interval '1 day') value loop
    if day<coalesce(employment_start,day) or day>coalesce(employment_end,day) then continue; end if;
    select * into pol from private.leave_accrual_policies where person_id=p_person and effective_from<=day
      order by effective_from desc,created_at desc,id desc limit 1;
    if not found then unavailable:=true; exit; end if;
    select * into rev from private.leave_accrual_day_reviews where person_id=p_person and service_date=day
      order by created_at desc,id desc limit 1;
    if (pol.requires_review and rev.id is null)
      or (rev.id is not null and rev.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,day)) then
      unavailable:=true; exit;
    end if;
    -- Keep the 420-based numerator exact across weekday counts and policies.
    ordinary := case when pol.enabled and extract(isodow from day)::integer=any(pol.weekdays)
      then pol.weekly_hours*(420/cardinality(pol.weekdays)) else 0 end;
    unpaid := greatest(0,private.approved_leave_hours_after(p_person,array['Unpaid leave']::text[],day-1)
      - private.approved_leave_hours_after(p_person,array['Unpaid leave']::text[],day));
    eligible := case when pol.enabled or pol.requires_review
      then coalesce(rev.annual_eligible_hours*420,greatest(0,ordinary-unpaid*420)) else 0 end;
    earned_numerator := earned_numerator+eligible*pol.annual_weeks;
    term := coalesce(terms->pol.id::text,jsonb_build_object('fromDate',day,'weeklyHours',pol.weekly_hours,
      'weekdays',pol.weekdays,'annualWeeks',pol.annual_weeks,'eligibleNumerator',0));
    term := term || jsonb_build_object('throughDate',day,'eligibleNumerator',(term->>'eligibleNumerator')::numeric+eligible);
    terms := jsonb_set(terms,array[pol.id::text],term);
  end loop;
  if unavailable then return result || jsonb_build_object('status','banked_only'); end if;
  return result || jsonb_build_object('accruedHours',earned_numerator/(420*52),
    'otherTakenHours',extra_taken,'availableHours',bank.hours-approved-extra_taken+earned_numerator/(420*52),
    'terms',coalesce((select jsonb_agg((value-'eligibleNumerator') || jsonb_build_object(
      'eligibleHours',(value->>'eligibleNumerator')::numeric/420,
      'accruedHours',(value->>'eligibleNumerator')::numeric*(value->>'annualWeeks')::numeric/(420*52))
      order by value->>'fromDate') from jsonb_each(terms)),'[]'::jsonb));
end;
$$;
revoke all on function private.project_annual_leave_balance(uuid,date) from public,anon,authenticated,service_role;

create function public.preview_annual_leave_balance(p_person_id uuid,p_start_date date,p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare workspace jsonb;
begin
  -- Reuse the exact role/profile-preview boundary. No raw policy notes or
  -- other employees' absences are returned by this calculator.
  workspace := public.get_leave_priority_workspace(p_preview_person_id);
  if not exists(select 1 from jsonb_array_elements(workspace->'people') person
    where person->>'personId'=p_person_id::text and (person->>'canViewBalance')::boolean
      and (person->>'paidLeave')::boolean) then
    raise exception 'Annual leave balance access denied.' using errcode='42501';
  end if;
  return private.project_annual_leave_balance(p_person_id,p_start_date);
end;
$$;
revoke all on function public.preview_annual_leave_balance(uuid,date,uuid) from public,anon,authenticated,service_role;
grant execute on function public.preview_annual_leave_balance(uuid,date,uuid) to authenticated;

create or replace function private.enforce_banked_annual_leave_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare projection jsonb; required numeric;
begin
  if new.record_origin <> 'portal' or new.request_type_label <> 'Annual leave' then return new; end if;
  projection := private.project_annual_leave_balance(new.employee_person_id,new.start_date);
  required := coalesce(new.hours,new.business_days*case when new.employment_type_snapshot='full_time' then 7.6 else 7.5 end);
  if projection->>'status'='unavailable' or required is null or required<=0 then
    raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
  end if;
  if required>(projection->>'availableHours')::numeric then
    if projection->>'status'='banked_only' then
      raise exception 'Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.' using errcode='22023';
    end if;
    raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_banked_annual_leave_request() from public,anon,authenticated,service_role;

commit;
