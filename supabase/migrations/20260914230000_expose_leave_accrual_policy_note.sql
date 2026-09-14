begin;

-- The administrator editor must round-trip the audit note it requires on save.
-- Keep the note inside the existing actual-system-admin/no-preview boundary.
create or replace function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
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
        person:=person||jsonb_build_object('accrualReviewDate',c->'reviewDate','accrualPolicy',case when pol.id is null then null else jsonb_build_object('weeklyHours',pol.weekly_hours,'annualWeeks',pol.annual_weeks,'personalWeeks',pol.personal_weeks,'shiftworker',pol.shiftworker,'enabled',pol.enabled,'note',pol.note) end);
      end if;
    end if;
    people:=people||jsonb_build_array(person);
  end loop;
  return jsonb_set(w,'{people}',people);
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public,anon,authenticated;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

commit;
