create function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_message; end if;
end;
$$;

create function pg_temp.manager_cannot_approve(p_reminder_id uuid)
returns void language plpgsql as $$
begin
  perform public.approve_employee_check_in_employment_decision(p_reminder_id, 1);
  raise exception 'A Manager unexpectedly approved an employment decision';
exception when insufficient_privilege then null;
end;
$$;

select pg_temp.assert(
  not exists (
    select 1 from private.employee_check_in_schedule(date '2026-03-01')
    where milestone = '6_month'
  ),
  'the six-month schedule remains hidden until its release flag is enabled'
);

update private.people_hub_release_flags
set enabled = true, enabled_at = clock_timestamp()
where feature = 'six_month_check_in_review';

select pg_temp.assert(
  (select due_date = date '2026-09-01' and notify_date = date '2026-08-25'
   from private.employee_check_in_schedule(date '2026-03-01')
   where milestone = '6_month'),
  'the six-month due date uses a calendar-month anniversary and sends five Victorian business days beforehand'
);

update public.internal_org_people
set started_date = date '2026-03-01'
where id = '75000000-0000-4000-8000-000000000002';
select private.sync_employee_check_in_reminders('75000000-0000-4000-8000-000000000002', false, false);

select pg_temp.assert(
  not exists (
    select 1 from private.employee_check_in_reminders
    where person_id = '75000000-0000-4000-8000-000000000002'
      and milestone = '6_month'
  ),
  'unclassified employees are not enrolled in the six-month workflow'
);

select pg_temp.assert(
  not has_table_privilege('authenticated', 'private.employee_check_in_contract_classifications', 'select')
  and not has_table_privilege('service_role', 'private.employee_check_in_contract_classifications', 'select'),
  'contract classifications are not directly readable through database roles'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
do $$
begin
  perform public.set_employee_check_in_contract_classification(
    '75000000-0000-4000-8000-000000000002', 'permanent'
  );
  raise exception 'A Manager unexpectedly changed an employee contract classification';
exception when insufficient_privilege then null;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000004', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select public.set_employee_check_in_contract_classification(
  '75000000-0000-4000-8000-000000000002', 'fixed_term'
);
reset role;

select pg_temp.assert(
  (select contract_type = 'fixed_term'
   from private.employee_check_in_contract_classifications
   where person_id = '75000000-0000-4000-8000-000000000002')
  and exists (
    select 1 from private.employee_check_in_reminders
    where person_id = '75000000-0000-4000-8000-000000000002'
      and milestone = '6_month'
      and due_date = date '2026-09-01'
      and notify_date = date '2026-08-25'
      and delivery_status = 'needs_review'
      and needs_review_reason = 'historic_cutover'
  ),
  'System Admin classification enrolls the six-month review while missed notices wait for manual review'
);

select id as six_month_reminder_id
from private.employee_check_in_reminders
where person_id = '75000000-0000-4000-8000-000000000002'
  and milestone = '6_month' \gset

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select * from public.record_employee_check_in_review(
  :'six_month_reminder_id'::uuid,
  'probation_extension_pending_hr',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'People & Culture review is required before communicating an extension.',
  null
);

select pg_temp.assert(
  exists (
    select 1
    from public.list_employee_check_in_workspace() workspace
    cross join lateral jsonb_array_elements(workspace.reminders) reminder
    where workspace.person_id = '75000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '6_month'
      and reminder ->> 'reviewOutcome' = 'probation_extension_pending_hr'
      and reminder ->> 'peopleCultureApproved' = 'false'
  ),
  'the manager sees that the employment decision is awaiting People & Culture approval'
);

select pg_temp.manager_cannot_approve(:'six_month_reminder_id'::uuid);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000004', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select public.approve_employee_check_in_employment_decision(
  :'six_month_reminder_id'::uuid,
  1
);

select pg_temp.assert(
  exists (
    select 1
    from public.list_employee_check_in_workspace_for_preview('75000000-0000-4000-8000-000000000001') workspace
    cross join lateral jsonb_array_elements(workspace.reminders) reminder
    where workspace.person_id = '75000000-0000-4000-8000-000000000002'
      and reminder ->> 'milestone' = '6_month'
      and reminder ->> 'peopleCultureApproved' = 'true'
  ),
  'the approved version is visible to the authorized manager after System Admin approval'
);
reset role;

select pg_temp.assert(
  (select people_culture_approved_version = version
     and people_culture_approved_by_user_id = '74000000-0000-4000-8000-000000000004'
     and people_culture_approved_at is not null
   from private.employee_check_in_reviews
   where reminder_id = :'six_month_reminder_id'::uuid),
  'the People & Culture approval is recorded against the exact reviewed version and actor'
);

select 'Six-month Check-In eligibility, scheduling and People & Culture approval passed' as result;
