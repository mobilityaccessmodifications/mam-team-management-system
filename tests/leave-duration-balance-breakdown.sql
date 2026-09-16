\set ON_ERROR_STOP on
do $$begin assert current_database() = 'leave_duration_balance_test', 'Disposable database only'; end$$;

begin;

do $$
declare
  workspace jsonb;
  person jsonb;
  request_metadata jsonb;
  payload jsonb;
begin
  workspace := public.get_leave_priority_workspace();
  person := workspace -> 'people' -> 0;
  request_metadata := workspace -> 'requests' -> 0;

  assert (person ->> 'annualPayrollHours')::numeric = 30.8,
    'Current Xero annual balance is retained';
  assert (person ->> 'annualApprovedHours')::numeric = 26.7,
    'Full-time days and explicit hours are deducted, with crossing imports prorated after the snapshot';
  assert (person ->> 'annualAvailableHours')::numeric = 4.1,
    'Available annual balance is Xero less approved People Hub leave';
  assert (person ->> 'sickApprovedHours')::numeric = 7.6,
    'One full-time sick day uses 7.6 hours';
  assert (person ->> 'sickAvailableHours')::numeric = 34.5,
    'Available sick balance deducts approved leave';
  assert (request_metadata ->> 'fullDayHours')::numeric = 7.6,
    'Pending full-time requests carry the 7.6-hour snapshot';

  perform private.enqueue_leave_notification(
    '20000000-0000-4000-8000-000000000013',
    'leave-submitted',
    false
  );
  select outbox.payload into strict payload
  from private.leave_notification_outbox outbox
  where outbox.request_id = '20000000-0000-4000-8000-000000000013';

  assert not payload ? 'leaveBalance', 'Email payload never stores a leave balance';
  assert (payload ->> 'fullDayHours')::numeric = 7.6,
    'Email duration retains the full-time 7.6-hour rule';
  assert to_regprocedure('private.leave_notification_balance_snapshot(uuid,text)') is null,
    'Obsolete email balance snapshot function is removed';
  assert not has_function_privilege(
    'authenticated',
    'private.approved_leave_hours_after(uuid,text[],date)',
    'execute'
  ), 'Browser sessions cannot call the private commitment helper';
  assert not has_function_privilege(
    'authenticated',
    'public.get_leave_priority_workspace_before_approved_deductions(uuid)',
    'execute'
  ), 'Browser sessions cannot bypass the final authorised projection';
end;
$$;

rollback;
