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
      '2026-10-03 08:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'Saturday must not create or claim payroll reminder mail';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-10-04 08:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'Sunday must not create or claim payroll reminder mail';
  assert exists (
    select 1
    from pg_attribute
    where attrelid = 'private.payroll_balance_email_reminders'::regclass
      and attname = 'reminder_date'
      and attnotnull
      and not attisdropped
  ), 'The daily outbox date is required';
  assert not has_table_privilege('authenticated', 'private.payroll_balance_email_recipients', 'SELECT');
  assert not has_table_privilege('authenticated', 'private.payroll_balance_email_reminders', 'SELECT');
  assert not has_table_privilege('service_role', 'private.payroll_balance_email_reminders', 'SELECT');
  assert not has_function_privilege('authenticated', 'public.claim_due_payroll_balance_email_reminders(integer)', 'EXECUTE');
  assert has_function_privilege('service_role', 'public.claim_due_payroll_balance_email_reminders(integer)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.prepare_payroll_balance_email_reminder_delivery(uuid,uuid)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'private.claim_due_payroll_balance_email_reminders_at(integer,timestamptz)', 'EXECUTE');
end$$;

do $$begin
  begin
    insert into private.payroll_balance_email_reminders (
      person_id,
      reminder_month,
      reminder_date
    ) values (
      '30000000-0000-4000-8000-000000000001',
      '2026-10-01',
      '2026-10-03'
    );
    assert false, 'A weekend reminder row must be rejected';
  exception when check_violation then
    null;
  end;
end$$;

create temporary table september_midmonth_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-09-15 08:00:00 Australia/Melbourne'::timestamptz
);

do $$begin
  assert (select count(*) = 1 from september_midmonth_claim),
    'A missing current-month snapshot produces a reminder on a later workday';
  assert (
    select reminder.reminder_date = '2026-09-15'
      and reminder.reminder_month = '2026-09-01'
    from private.payroll_balance_email_reminders reminder
    join september_midmonth_claim claim on claim.reminder_id = reminder.id
  ), 'The durable reminder is scoped to its Melbourne workday and month';
  assert (
    select public.complete_payroll_balance_email_reminder_delivery(
      reminder_id,
      claim_token,
      'payroll-balance:synthetic-sep15:2026-09'
    )
    from september_midmonth_claim
  );
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

create temporary table october_second_workday_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-10-02 08:00:00 Australia/Melbourne'::timestamptz
);

do $$begin
  assert (select count(*) = 1 from october_second_workday_claim),
    'An incomplete month produces one new reminder on the next workday';
  assert (
    select second.reminder_id <> first.reminder_id
    from october_second_workday_claim second
    cross join october_claim first
  ), 'Each workday uses a distinct durable row and delivery key';
  assert (
    select public.complete_payroll_balance_email_reminder_delivery(
      reminder_id,
      claim_token,
      'payroll-balance:synthetic-oct02:2026-10'
    )
    from october_second_workday_claim
  );
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-10-02 08:01:00 Australia/Melbourne'::timestamptz
    )
  ), 'A delivered workday reminder cannot be repeated that day';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-10-03 08:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'The recurring series pauses on Saturday';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-10-04 08:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'The recurring series pauses on Sunday';
end$$;

create temporary table october_monday_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-10-05 08:00:00 Australia/Melbourne'::timestamptz
);

do $$begin
  assert (select count(*) = 1 from october_monday_claim),
    'The recurring reminder resumes on Monday while balances remain stale';
  assert (
    select public.complete_payroll_balance_email_reminder_delivery(
      reminder_id,
      claim_token,
      'payroll-balance:synthetic-oct05:2026-10'
    )
    from october_monday_claim
  );
  assert (
    select array_agg(reminder_date order by reminder_date)
      = array['2026-10-01'::date, '2026-10-02'::date, '2026-10-05'::date]
    from private.payroll_balance_email_reminders
    where reminder_month = '2026-10-01'
      and delivery_status = 'delivered'
  ), 'Exactly one reminder is retained for each eligible October workday';
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
  '2026-11-02 08:00:00 Australia/Melbourne'::timestamptz
);

create temporary table november_prepared as
select prepared.*
from november_claim claim
cross join lateral private.prepare_payroll_balance_email_reminder_delivery_at(
  claim.reminder_id,
  claim.claim_token,
  '2026-11-02 08:01:00 Australia/Melbourne'::timestamptz
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
      '2026-11-02 08:02:00 Australia/Melbourne'::timestamptz
    )
    from november_claim
  ), 'An allow-listed provider failure releases the same-day claim';
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-11-02 08:14:00 Australia/Melbourne'::timestamptz
    )
  ), 'The retry backoff is enforced';
end$$;

create temporary table november_retry as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2026-11-02 08:18:00 Australia/Melbourne'::timestamptz
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
      '2026-11-02 08:19:00 Australia/Melbourne'::timestamptz
    )
  ), 'Preparation fails closed after the current HR work email is removed';
  assert (
    select delivery_status = 'needs_review' and needs_review_reason = 'missing_work_email'
    from private.payroll_balance_email_reminders
    where reminder_date = '2026-11-02'
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
  assert (
    select count(*) = 0
    from private.claim_due_payroll_balance_email_reminders_at(
      10,
      '2026-12-02 08:00:00 Australia/Melbourne'::timestamptz
    )
  ), 'No further workday email is created after both monthly snapshots are current';
  assert not exists (
    select 1
    from private.payroll_balance_email_reminders
    where reminder_date = '2026-12-02'
  );
end$$;

-- A provider delay must not turn a Friday claim into a weekend email. The old
-- row is held for review, and the recurring series can create a fresh Monday
-- row while the month remains incomplete.
create temporary table january_friday_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2027-01-08 16:59:00 Australia/Melbourne'::timestamptz
);

create temporary table january_weekend_prepared as
select prepared.*
from january_friday_claim claim
cross join lateral private.prepare_payroll_balance_email_reminder_delivery_at(
  claim.reminder_id,
  claim.claim_token,
  '2027-01-09 00:01:00 Australia/Melbourne'::timestamptz
) prepared;

create temporary table january_monday_claim as
select *
from private.claim_due_payroll_balance_email_reminders_at(
  10,
  '2027-01-11 08:00:00 Australia/Melbourne'::timestamptz
);

do $$begin
  assert (select count(*) = 1 from january_friday_claim);
  assert (select count(*) = 0 from january_weekend_prepared),
    'A Friday claim cannot expose a recipient or send after Saturday begins';
  assert (
    select delivery_status = 'needs_review'
      and needs_review_reason = 'missed_delivery'
    from private.payroll_balance_email_reminders
    where reminder_date = '2027-01-08'
  );
  assert (select count(*) = 1 from january_monday_claim),
    'A fresh daily row resumes the series on Monday';
end$$;

rollback;
