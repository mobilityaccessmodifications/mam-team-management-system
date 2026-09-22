begin;

-- Enforce at the shared insert boundary, including selected-person and service
-- submissions. Historical imports and existing requests are not rewritten.
create function private.enforce_banked_annual_leave_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  banked numeric;
  snapshot_date date;
  example boolean;
  available numeric;
  required numeric;
begin
  if new.record_origin <> 'portal' or new.request_type_label <> 'Annual leave' then
    return new;
  end if;
  select hours, as_of, is_example into banked, snapshot_date, example
  from private.employee_annual_leave_balances
  where person_id = new.employee_person_id;
  if banked is null or snapshot_date is null or example then
    raise exception 'Your banked annual leave balance is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
  end if;
  available := banked - private.approved_leave_hours_after(new.employee_person_id, array['Annual leave']::text[], snapshot_date);
  required := coalesce(new.hours, new.business_days * case when new.employment_type_snapshot = 'full_time' then 7.6 else 7.5 end);
  if required is null or required <= 0 or available is null then
    raise exception 'Your banked annual leave balance is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
  end if;
  if required > available then
    raise exception 'Not enough balance. Request only the annual leave you have banked, or submit a separate unpaid leave request.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_banked_annual_leave_request() from public, anon, authenticated, service_role;
-- Runs after employment policy sets the person and employment snapshot.
create trigger z_leave_requests_banked_annual_limit before insert on public.leave_requests
for each row execute function private.enforce_banked_annual_leave_request();

alter function public.get_leave_priority_workspace(uuid) rename to get_leave_priority_workspace_before_request_limit;
revoke all on function public.get_leave_priority_workspace_before_request_limit(uuid) from public, anon, authenticated, service_role;
create function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  workspace jsonb;
  person jsonb;
  people jsonb := '[]'::jsonb;
  full_day numeric;
begin
  workspace := public.get_leave_priority_workspace_before_request_limit(p_preview_person_id);
  for person in select * from jsonb_array_elements(workspace -> 'people') loop
    select case when employment_type = 'full_time' then 7.6 else 7.5 end into full_day
    from private.employee_directory_details where person_id = (person ->> 'personId')::uuid;
    people := people || jsonb_build_array(person || jsonb_build_object('requestFullDayHours', coalesce(full_day, 7.5)));
  end loop;
  return jsonb_set(workspace, '{people}', people);
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

commit;
