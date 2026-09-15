-- Synthetic integration test. Never run against production.
\set ON_ERROR_STOP on
do $$begin
  assert current_database() ~ '^priority_v[0-9]+$', 'Never run payroll reminder fixtures in production';
end$$;

begin;
\ir sql-test-auth.sql

insert into auth.users (id)
values ('30000000-0000-4000-8000-000000000001');

insert into public.profiles (id, full_name, app_role, login_name, credentials_valid_after)
values (
  '30000000-0000-4000-8000-000000000001',
  'Synthetic Payroll Recipient',
  'employee',
  'syntheticpayroll',
  now() - interval '1 day'
);

insert into public.internal_org_people (
  id,
  full_name,
  company_key,
  position_title,
  auth_user_id,
  parent_id
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    'Synthetic Payroll Recipient',
    'mam',
    'Synthetic payroll role',
    '30000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'Synthetic Equipsy Person',
    'equipsy',
    'Synthetic employee',
    null,
    null
  );

insert into private.employee_directory_details (
  person_id,
  first_name,
  last_name,
  work_email,
  employment_type
)
values (
  '30000000-0000-4000-8000-000000000001',
  'Synthetic',
  'Recipient',
  'synthetic.payroll@example.test',
  'full_time'
);

insert into private.payroll_balance_import_grants (person_id)
values ('30000000-0000-4000-8000-000000000001');

insert into private.payroll_balance_email_recipients (person_id)
values ('30000000-0000-4000-8000-000000000001');

do $$begin
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-10-01 07:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'The birthday scheduler run must not send the payroll email before 08:00';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-09-15 08:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'Mid-month execution must not create catch-up mail';
  assert not has_table_privilege('authenticated', 'private.payroll_balance_email_recipients', 'SELECT');
  assert not has_table_privilege('authenticated', 'private.payroll_balance_email_reminders', 'SELECT');
  assert not has_table_privilege('service_role', 'private.payroll_balance_email_reminders', 'SELECT');
  assert not has_function_privilege('authenticated', 'public.claim_due_payroll_balance_email_reminders(integer)', 'EXECUTE');
  assert has_function_privilege('service_role', 'public.claim_due_payroll_balance_email_reminders(integer)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.prepare_payroll_balance_email_reminder_delivery(uuid,uuid)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'private.claim_due_payroll_balance_email_reminders_at(integer,timestamptz)', 'EXECUTE');
end$$;

create temporary table october_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-10-01 08:00:00 Australia/Melbourne'::timestamptz
);

do $$begin
  assert (select count(*) = 1 from october_claim), 'One configured recipient receives one October claim';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-10-01 08:01:00 Australia/Melbourne'::timestamptz
    )
  ), 'The active claim lease prevents duplicate delivery';
end$$;

create temporary table october_prepared as
select prepared.*
from october_claim claim
cross join lateral private.prepare_payroll_balance_email_reminder_delivery_at(
  claim.reminder_id,
  claim.claim_token,
  '2026-10-01 08:02:00 Australia/Melbourne'::timestamptz
) prepared;

do $$begin
  assert (
    select delivery_required
      and recipient_name = 'Synthetic'
      and recipient_email = 'synthetic.payroll@example.test'
      and reminder_month = '2026-10-01'
      and missing_companies = array['mam', 'equipsy']::text[]
    from october_prepared
  ), 'Preparation derives the current HR address and both missing companies';
  assert not (
    select public.complete_payroll_balance_email_reminder_delivery(
      reminder_id,
      gen_random_uuid(),
      'wrong-token'
    )
    from october_claim
  ), 'A mismatched claim token cannot complete delivery';
  assert (
    select public.complete_payroll_balance_email_reminder_delivery(
      reminder_id,
      claim_token,
      'payroll-balance:synthetic:2026-10'
    )
    from october_claim
  ), 'The matching claim completes once';
  assert not (
    select public.complete_payroll_balance_email_reminder_delivery(
      reminder_id,
      claim_token,
      'payroll-balance:synthetic:2026-10'
    )
    from october_claim
  ), 'A completed reminder cannot be completed twice';
end$$;

-- One current company snapshot makes the November message identify only the
-- other company as outstanding.
insert into private.payroll_balance_imports (
  company_key,
  employee_name,
  annual_hours,
  sick_hours,
  as_of,
  source_file,
  source_sha256,
  person_id,
  match_status
)
values (
  'mam',
  'Synthetic Payroll Recipient',
  10,
  20,
  '2026-11-01',
  'synthetic-mam.xlsx',
  repeat('a', 64),
  '30000000-0000-4000-8000-000000000001',
  'linked'
);

create temporary table november_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-11-01 08:00:00 Australia/Melbourne'::timestamptz
);

create temporary table november_prepared as
select prepared.*
from november_claim claim
cross join lateral private.prepare_payroll_balance_email_reminder_delivery_at(
  claim.reminder_id,
  claim.claim_token,
  '2026-11-01 08:01:00 Australia/Melbourne'::timestamptz
) prepared;

do $$begin
  assert (
    select missing_companies = array['equipsy']::text[]
    from november_prepared
  ), 'Only the stale company is included in the outbound payload';
  assert (
    select private.fail_payroll_balance_email_reminder_delivery_at(
      reminder_id,
      claim_token,
      'network_error',
      '2026-11-01 08:02:00 Australia/Melbourne'::timestamptz
    )
    from november_claim
  ), 'An allow-listed provider failure releases the same-day claim';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-11-01 08:14:00 Australia/Melbourne'::timestamptz
    )
  ), 'The retry backoff is enforced';
end$$;

create temporary table november_retry as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-11-01 08:18:00 Australia/Melbourne'::timestamptz
);

update private.employee_directory_details
set work_email = null
where person_id = '30000000-0000-4000-8000-000000000001';

do $$begin
  assert (
    select count(*) = 0
    from november_retry claim
    cross join lateral private.prepare_payroll_balance_email_reminder_delivery_at(
      claim.reminder_id,
      claim.claim_token,
      '2026-11-01 08:19:00 Australia/Melbourne'::timestamptz
    )
  ), 'Preparation fails closed after the current HR work email is removed';
  assert (
    select delivery_status = 'needs_review' and needs_review_reason = 'missing_work_email'
    from private.payroll_balance_email_reminders
    where reminder_month = '2026-11-01'
  ), 'The stale recipient is held for review rather than emailed';
end$$;

update private.employee_directory_details
set work_email = 'synthetic.payroll@example.test'
where person_id = '30000000-0000-4000-8000-000000000001';

-- If both files become current after a claim but before delivery, preparation
-- resolves the work without sending an unnecessary email.
create temporary table december_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-12-01 08:00:00 Australia/Melbourne'::timestamptz
);

insert into private.payroll_balance_imports (
  company_key,
  employee_name,
  annual_hours,
  sick_hours,
  as_of,
  source_file,
  source_sha256,
  person_id,
  match_status
)
values
  (
    'mam',
    'Synthetic Payroll Recipient',
    11,
    21,
    '2026-12-01',
    'synthetic-mam-december.xlsx',
    repeat('b', 64),
    '30000000-0000-4000-8000-000000000001',
    'linked'
  ),
  (
    'equipsy',
    'Synthetic Equipsy Person',
    12,
    22,
    '2026-12-01',
    'synthetic-equipsy-december.xlsx',
    repeat('c', 64),
    '30000000-0000-4000-8000-000000000002',
    'linked'
  );

create temporary table december_prepared as
select prepared.*
from december_claim claim
cross join lateral private.prepare_payroll_balance_email_reminder_delivery_at(
  claim.reminder_id,
  claim.claim_token,
  '2026-12-01 08:01:00 Australia/Melbourne'::timestamptz
) prepared;

do $$begin
  assert (
    select not delivery_required
      and recipient_email is null
      and missing_companies = array[]::text[]
    from december_prepared
  ), 'A completed month is resolved without exposing or mailing the recipient';
  assert (
    select delivery_status = 'not_required'
    from private.payroll_balance_email_reminders
    where reminder_month = '2026-12-01'
  );
  assert (
    select count(*) = 1
    from private.payroll_balance_email_reminder_events
    where reminder_id = (select reminder_id from december_claim)
      and event_type = 'not_required'
  );
end$$;

rollback;
