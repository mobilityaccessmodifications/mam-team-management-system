begin;

-- Return the paid hours for approved People Hub leave that falls after an
-- authoritative Xero snapshot. Completed days on or before the snapshot are
-- already represented by that balance and must not be deducted twice.
create function private.approved_leave_hours_after(
  p_person_id uuid,
  p_leave_types text[],
  p_after date
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_after is null then null
    else coalesce(sum(
      case
        when request.hours is null then (
          select count(*)::numeric
            * case
                when coalesce(request.employment_type_snapshot, detail.employment_type) = 'full_time' then 7.6
                else 7.5
              end
          from generate_series(
            greatest(request.start_date, p_after + 1),
            request.end_date,
            interval '1 day'
          ) day
          where extract(isodow from day) between 1 and 5
        )
        when request.start_time is null or request.end_time is null then
          request.hours
            * (
              select count(*)::numeric
              from generate_series(
                greatest(request.start_date, p_after + 1),
                request.end_date,
                interval '1 day'
              ) day
              where extract(isodow from day) between 1 and 5
            )
            / nullif((
              select count(*)::numeric
              from generate_series(
                request.start_date,
                request.end_date,
                interval '1 day'
              ) day
              where extract(isodow from day) between 1 and 5
            ), 0)
        else (
          select coalesce(sum(
            case
              when day::date = request.start_date and day::date = request.end_date then
                extract(epoch from (request.end_time - request.start_time)) / 3600
              when day::date = request.start_date then
                extract(epoch from (time '18:00' - request.start_time)) / 3600
              when day::date = request.end_date then
                extract(epoch from (request.end_time - time '06:00')) / 3600
              else 12
            end
          ), 0)
          from generate_series(
            greatest(request.start_date, p_after + 1),
            request.end_date,
            interval '1 day'
          ) day
          where extract(isodow from day) between 1 and 5
        )
      end
    ), 0)
  end
  from public.leave_requests request
  left join private.employee_directory_details detail
    on detail.person_id = request.employee_person_id
  where request.employee_person_id = p_person_id
    and request.status = 'approved'
    and request.request_type_label = any(p_leave_types)
    and request.end_date > p_after;
$$;

revoke all on function private.approved_leave_hours_after(uuid, text[], date)
  from public, anon, authenticated, service_role;

comment on function private.approved_leave_hours_after(uuid, text[], date) is
  'Totals approved leave after a payroll snapshot without exposing request details. Full-time full days use 7.6 hours; explicit hours retain their recorded duration and crossing legacy records are prorated by workday.';

-- Preserve every existing authorisation and preview boundary, then add only
-- the totals for balances that the original projection already disclosed.
alter function public.get_leave_priority_workspace(uuid)
  rename to get_leave_priority_workspace_before_approved_deductions;

revoke all on function public.get_leave_priority_workspace_before_approved_deductions(uuid)
  from public, anon, authenticated, service_role;

create function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace jsonb;
  people jsonb := '[]'::jsonb;
  person jsonb;
  requests jsonb := '[]'::jsonb;
  request_metadata jsonb;
  person_id uuid;
  annual_xero_hours numeric;
  annual_xero_date date;
  annual_approved_hours numeric;
  sick_xero_hours numeric;
  sick_xero_date date;
  sick_approved_hours numeric;
  full_day_hours numeric;
begin
  workspace := public.get_leave_priority_workspace_before_approved_deductions(p_preview_person_id);

  for person in select * from jsonb_array_elements(workspace -> 'people') loop
    person_id := (person ->> 'personId')::uuid;

    if coalesce((person ->> 'canViewBalance')::boolean, false)
      and coalesce((person ->> 'paidLeave')::boolean, false) then
      annual_xero_hours := coalesce(
        (person ->> 'annualPayrollHours')::numeric,
        (person ->> 'hours')::numeric
      );
      annual_xero_date := coalesce(
        (person ->> 'annualPayrollDate')::date,
        (person ->> 'asOf')::date
      );
      annual_approved_hours := private.approved_leave_hours_after(
        person_id,
        array['Annual leave']::text[],
        annual_xero_date
      );
      person := person || jsonb_build_object(
        'annualPayrollHours', annual_xero_hours,
        'annualPayrollDate', annual_xero_date,
        'annualApprovedHours', annual_approved_hours,
        'annualAvailableHours', case
          when annual_xero_hours is null or annual_approved_hours is null then null
          else annual_xero_hours - annual_approved_hours
        end
      );
    end if;

    if coalesce((person ->> 'canViewSickBalance')::boolean, false) then
      sick_xero_hours := coalesce(
        (person ->> 'sickPayrollHours')::numeric,
        (person ->> 'sickHours')::numeric
      );
      sick_xero_date := coalesce(
        (person ->> 'sickPayrollDate')::date,
        (person ->> 'sickAsOf')::date
      );
      sick_approved_hours := private.approved_leave_hours_after(
        person_id,
        array['Sick leave', 'Carer''s leave']::text[],
        sick_xero_date
      );
      person := person || jsonb_build_object(
        'sickPayrollHours', sick_xero_hours,
        'sickPayrollDate', sick_xero_date,
        'sickApprovedHours', sick_approved_hours,
        'sickAvailableHours', case
          when sick_xero_hours is null or sick_approved_hours is null then null
          else sick_xero_hours - sick_approved_hours
        end
      );
    end if;

    people := people || jsonb_build_array(person);
  end loop;

  -- The request snapshot, rather than the employee's current classification,
  -- controls historical duration. Legacy rows fall back to the current
  -- classification and then to the former 7.5-hour display rule.
  for request_metadata in select * from jsonb_array_elements(workspace -> 'requests') loop
    select case
      when coalesce(request.employment_type_snapshot, detail.employment_type) = 'full_time' then 7.6
      else 7.5
    end
    into full_day_hours
    from public.leave_requests request
    left join private.employee_directory_details detail
      on detail.person_id = request.employee_person_id
    where request.id = (request_metadata ->> 'id')::uuid;

    requests := requests || jsonb_build_array(
      request_metadata || jsonb_build_object('fullDayHours', coalesce(full_day_hours, 7.5))
    );
  end loop;

  return jsonb_set(
    jsonb_set(workspace, '{people}', people),
    '{requests}',
    requests
  );
end;
$$;

revoke all on function public.get_leave_priority_workspace(uuid)
  from public, anon, authenticated;
grant execute on function public.get_leave_priority_workspace(uuid)
  to authenticated;

-- New notification snapshots contain duration and routing only. Leave balances
-- remain inside People Hub and are never copied into email payloads.
create or replace function private.enqueue_leave_notification(
  p_request_id uuid,
  p_event text,
  p_was_approved boolean
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.leave_notification_outbox(request_id, event, payload)
  select request.id, p_event, jsonb_build_object(
    'version', 1,
    'event', p_event,
    'requestId', request.id,
    'wasApproved', p_was_approved,
    'employeeName', coalesce(person.full_name, 'Employee'),
    'company', coalesce(person.company_key, 'mam'),
    'leaveType', request.request_type_label,
    'startDate', request.start_date,
    'endDate', request.end_date,
    'startTime', to_char(request.start_time, 'HH24:MI'),
    'endTime', to_char(request.end_time, 'HH24:MI'),
    'days', request.business_days,
    'hours', request.hours,
    'fullDayHours', case
      when coalesce(request.employment_type_snapshot, detail.employment_type) = 'full_time' then 7.6
      else 7.5
    end,
    'status', case p_event
      when 'leave-approved' then 'Approved'
      when 'leave-declined' then 'Declined'
      when 'leave-cancelled' then 'Cancelled'
      when 'leave-conditionally-approved' then 'Approved – pending leave balance'
      else 'Pending'
    end,
    'employeeNote', request.reason,
    'managerNote', request.manager_note
  )
  from public.leave_requests request
  left join public.internal_org_people person
    on person.id = request.employee_person_id
  left join private.employee_directory_details detail
    on detail.person_id = request.employee_person_id
  where request.id = p_request_id
  on conflict do nothing;
$$;

revoke all on function private.enqueue_leave_notification(uuid, text, boolean)
  from public, anon, authenticated, service_role;

drop function if exists private.leave_notification_balance_snapshot(uuid, text);

commit;
