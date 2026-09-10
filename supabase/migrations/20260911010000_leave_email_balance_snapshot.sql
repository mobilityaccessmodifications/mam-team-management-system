-- Snapshot submission balances for consistent email delivery and retries.
-- No historical notifications are replayed and no payroll balances are changed.
begin;
create function private.leave_notification_balance_snapshot(p_person uuid,p_leave_type text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c jsonb; balance numeric; kind text; valid_baseline boolean;
begin
  kind:=case when p_leave_type='Annual leave' then 'annual' else 'sick' end;
  if kind='annual' then
    select exists(select 1 from private.employee_annual_leave_balances where person_id=p_person and not is_example) into valid_baseline;
  else
    select exists(select 1 from private.employee_sick_leave_balances where person_id=p_person) into valid_baseline;
  end if;
  if valid_baseline then
    c:=private.calculate_employee_leave_accrual(p_person,(now() at time zone 'Australia/Melbourne')::date-1);
    if c->>'status' in ('current','not_configured') then
      balance:=case when kind='annual' then coalesce((c->>'annualExactHours')::numeric,(c->>'annualHours')::numeric)
        else coalesce((c->>'personalExactHours')::numeric,(c->>'personalHours')::numeric) end;
    end if;
  end if;
  return jsonb_build_object('kind',kind,'status',case when balance is null then 'check_balance' else 'current' end,'hours',balance);
end;
$$;
revoke all on function private.leave_notification_balance_snapshot(uuid,text) from public,anon,authenticated,service_role;

create or replace function private.enqueue_leave_notification(p_request_id uuid, p_event text, p_was_approved boolean)
returns void language sql security definer set search_path='' as $$
  insert into private.leave_notification_outbox(request_id,event,payload)
  select r.id,p_event,jsonb_build_object(
    'version',1,'event',p_event,'requestId',r.id,'wasApproved',p_was_approved,
    'employeeName',coalesce(p.full_name,'Employee'),'company',coalesce(p.company_key,'mam'),
    'leaveType',r.request_type_label,'startDate',r.start_date,'endDate',r.end_date,
    'startTime',to_char(r.start_time,'HH24:MI'),'endTime',to_char(r.end_time,'HH24:MI'),
    'days',r.business_days,'hours',r.hours,
    'status',case p_event when 'leave-approved' then 'Approved' when 'leave-declined' then 'Declined'
      when 'leave-cancelled' then 'Cancelled' when 'leave-conditionally-approved' then 'Approved – pending leave balance' else 'Pending' end,
    'employeeNote',r.reason,'managerNote',r.manager_note)
    || case when p_event='leave-submitted' and r.request_type_label in ('Annual leave','Sick leave','Carer''s leave')
      then jsonb_build_object('leaveBalance',private.leave_notification_balance_snapshot(r.employee_person_id,r.request_type_label))
      else '{}'::jsonb end
  from public.leave_requests r left join public.internal_org_people p on p.id=r.employee_person_id
  where r.id=p_request_id
  on conflict do nothing;
$$;
revoke all on function private.enqueue_leave_notification(uuid,text,boolean) from public,anon,authenticated,service_role;

commit;
