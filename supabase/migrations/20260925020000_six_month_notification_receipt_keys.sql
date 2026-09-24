begin;

do $$
begin
  if to_regprocedure('private.notification_event_key_valid(text)') is null
    or to_regclass('private.notification_delivery_receipts') is null
    or to_regclass('private.employee_check_in_contract_classifications') is null
    or to_regprocedure('public.prepare_employee_check_in_reminder_delivery(uuid,uuid)') is null then
    raise exception 'Six-month notification receipt prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_key) <= 160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live)' ||
    '|checkin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(2-week|1-month|2-month|3-month|5-month|6-month|6-month-casual):initial:(test|live)' ||
    '|checkin-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:hr:[1-9][0-9]*:(test|live))$'
  ), false)
$$;

do $$
begin
  if not private.notification_event_key_valid('checkin:00000000-0000-4000-8000-000000000001:6-month:initial:live') then
    raise exception 'Permanent six-month notification key rejected.' using errcode = '55000';
  end if;
  if not private.notification_event_key_valid('checkin:00000000-0000-4000-8000-000000000001:6-month-casual:initial:test') then
    raise exception 'Casual six-month notification key rejected.' using errcode = '55000';
  end if;
  if private.notification_event_key_valid('checkin:00000000-0000-4000-8000-000000000001:6-month-casual:final:live') then
    raise exception 'Final six-month notification key accepted.' using errcode = '55000';
  end if;
  if private.notification_event_key_valid('checkin:00000000-0000-4000-8000-000000000001:6-month-contract:initial:live') then
    raise exception 'Unknown six-month notification key accepted.' using errcode = '55000';
  end if;
  if not private.notification_event_key_valid('payroll-comparison:00000000-0000-4000-8000-000000000001')
    or not private.notification_event_key_valid('checkin:00000000-0000-4000-8000-000000000001:2-week:initial:live')
    or not private.notification_event_key_valid('new-starter:00000000-0000-4000-8000-000000000001:day-one:test') then
    raise exception 'Existing notification key family was changed.' using errcode = '55000';
  end if;
end;
$$;

revoke all on function private.notification_event_key_valid(text)
  from public, anon, authenticated, service_role;

commit;
