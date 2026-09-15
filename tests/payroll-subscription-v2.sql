-- Synthetic integration test. Never run against a production database.
\set ON_ERROR_STOP on
do $$begin
  assert current_database() ~ '^priority_v[0-9]+$', 'Never run fixtures in production';
end$$;

begin;
\ir sql-test-auth.sql

insert into auth.users (id)
values
  ('20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000004');

insert into public.profiles (id, full_name, app_role, login_name, credentials_valid_after)
values
  ('20000000-0000-4000-8000-000000000001', 'Synthetic Admin', 'system_admin', 'syntheticadmin', now() - interval '1 day'),
  ('20000000-0000-4000-8000-000000000002', 'Synthetic Delegate', 'employee', 'syntheticdelegate', now() - interval '1 day'),
  ('20000000-0000-4000-8000-000000000003', 'Synthetic Other Delegate', 'employee', 'syntheticother', now() - interval '1 day'),
  ('20000000-0000-4000-8000-000000000004', 'Synthetic Owner', 'employee', 'syntheticowner', now() - interval '1 day');

insert into public.internal_org_people (id, full_name, company_key, position_title, auth_user_id, parent_id)
values
  ('20000000-0000-4000-8000-000000000001', 'Synthetic Admin', 'mam', 'Test administrator', '20000000-0000-4000-8000-000000000001', null),
  ('20000000-0000-4000-8000-000000000002', 'Synthetic Delegate', 'mam', 'Test bookkeeper', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000003', 'Synthetic Other Delegate', 'mam', 'Test payroll backup', '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000004', 'Synthetic Owner', 'mam', 'Test subscription owner', '20000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000010', 'Portal Display', 'mam', 'Test employee', null, '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000011', 'MAM Current', 'mam', 'Test employee', null, '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000012', 'Equipsy Match', 'equipsy', 'Test employee', null, null),
  ('20000000-0000-4000-8000-000000000013', 'Inactive Match', 'mam', 'Test employee', null, '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000014', 'Cross Company', 'equipsy', 'Test employee', null, null),
  ('20000000-0000-4000-8000-000000000015', 'Duplicate Name', 'mam', 'Test employee', null, '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000016', 'Duplicate.Name', 'mam', 'Test employee', null, '20000000-0000-4000-8000-000000000001');

update public.internal_org_people
set is_active = false
where id = '20000000-0000-4000-8000-000000000013';

insert into private.employee_directory_details (person_id, first_name, last_name, employment_type)
values ('20000000-0000-4000-8000-000000000010', 'Payroll', 'Match', 'full_time');

select pg_temp.set_test_actor('20000000-0000-4000-8000-000000000001');
select public.replace_payroll_balance_import_grants(array['20000000-0000-4000-8000-000000000002']::uuid[]);
select public.set_employee_annual_leave_balance(
  '20000000-0000-4000-8000-000000000010',
  99,
  current_date,
  false
);

do $$begin
  assert public.can_import_payroll_balances(), 'System Admin receives role-derived import access';
  assert public.can_manage_payroll_balance_import_grants(), 'System Admin manages delegate access';
  assert (select count(*) = 1 from public.list_payroll_balance_import_grants()), 'One explicit delegate is listed';
end$$;

select pg_temp.set_test_actor('20000000-0000-4000-8000-000000000002');
do $$begin
  assert public.can_import_payroll_balances(), 'Explicit active delegate can import';
  assert not public.can_manage_payroll_balance_import_grants(), 'Delegate cannot manage access';
  assert (select count(*) = 1 from public.list_payroll_balance_reminder_calendar_entries()), 'An incomplete month has one first-day reminder';
  assert not has_function_privilege(
    'authenticated',
    'public.stage_payroll_balance_import(uuid,text,jsonb,jsonb)',
    'EXECUTE'
  ), 'Browser sessions cannot submit parsed payroll JSON directly';
  assert has_function_privilege(
    'service_role',
    'public.stage_payroll_balance_import(uuid,text,jsonb,jsonb)',
    'EXECUTE'
  ), 'Only the trusted server client can stage parsed payroll JSON';
  assert private.normalise_payroll_employee_name('Māori 李 O’Connor') = 'maori李oconnor', 'Payroll matching retains Unicode letters and normalises accents';
end$$;

create temporary table staged_payroll_batch as
select public.stage_payroll_balance_import(
  '20000000-0000-4000-8000-000000000002',
  repeat('d', 64),
  jsonb_build_array(
    jsonb_build_object(
      'name', 'mam-balances.csv',
      'sha256', repeat('1', 64),
      'sizeBytes', 320,
      'companies', jsonb_build_array('mam'),
      'asOfDates', jsonb_build_array(current_date - 1, current_date),
      'employeeRows', 6
    ),
    jsonb_build_object(
      'name', 'equipsy-balances.xlsx',
      'sha256', repeat('2', 64),
      'sizeBytes', 640,
      'companies', jsonb_build_array('equipsy'),
      'asOfDates', jsonb_build_array(current_date),
      'employeeRows', 1
    )
  ),
  jsonb_build_array(
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'Payroll-Match', 'annualHours', 10, 'sickHours', 20, 'asOf', current_date - 1, 'sourceFile', 'mam-balances.csv', 'sourceSha256', repeat('1', 64)),
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'MAM Current', 'annualHours', 11, 'sickHours', 22, 'asOf', current_date, 'sourceFile', 'mam-balances.csv', 'sourceSha256', repeat('1', 64)),
    jsonb_build_object('companyKey', 'equipsy', 'employeeName', 'Equipsy Match', 'annualHours', 30, 'sickHours', 40, 'asOf', current_date, 'sourceFile', 'equipsy-balances.xlsx', 'sourceSha256', repeat('2', 64)),
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'Inactive Match', 'annualHours', 1, 'sickHours', 2, 'asOf', current_date, 'sourceFile', 'mam-balances.csv', 'sourceSha256', repeat('1', 64)),
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'Cross Company', 'annualHours', 3, 'sickHours', 4, 'asOf', current_date, 'sourceFile', 'mam-balances.csv', 'sourceSha256', repeat('1', 64)),
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'Duplicate Name', 'annualHours', 5, 'sickHours', 6, 'asOf', current_date, 'sourceFile', 'mam-balances.csv', 'sourceSha256', repeat('1', 64)),
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'Nobody New', 'annualHours', 7, 'sickHours', 8, 'asOf', current_date, 'sourceFile', 'mam-balances.csv', 'sourceSha256', repeat('1', 64))
  )
) as payload;

do $$
declare
  payload jsonb := (select staged_payroll_batch.payload from staged_payroll_batch);
begin
  assert jsonb_array_length(payload->'rows') = 7;
  assert (select count(*) = 3 from jsonb_array_elements(payload->'rows') row where row->>'status' = 'linked');
  assert (select count(*) = 1 from jsonb_array_elements(payload->'rows') row where row->>'status' = 'inactive');
  assert (select count(*) = 1 from jsonb_array_elements(payload->'rows') row where row->>'status' = 'company_mismatch');
  assert (select count(*) = 1 from jsonb_array_elements(payload->'rows') row where row->>'status' = 'ambiguous');
  assert (select count(*) = 1 from jsonb_array_elements(payload->'rows') row where row->>'status' = 'unmatched');
  assert (
    select not (row->>'willApplyAnnual')::boolean and (row->>'willApplySick')::boolean
    from jsonb_array_elements(payload->'rows') row
    where row->>'employeeName' = 'Payroll-Match'
  ), 'Older annual source is previewed as held while its missing sick balance can update';
end$$;

create temporary table committed_payroll_batch as
select public.commit_payroll_balance_import(
  (staged_payroll_batch.payload->>'batchId')::uuid,
  (staged_payroll_batch.payload->>'version')::bigint
) as payload
from staged_payroll_batch;

do $$begin
  assert (select count(*) = 7 from private.payroll_balance_imports where batch_id = (select (payload->>'batchId')::uuid from committed_payroll_batch));
  assert (select hours = 99 from private.employee_annual_leave_balances where person_id = '20000000-0000-4000-8000-000000000010'), 'An older source never replaces a newer annual balance';
  assert (select hours = 20 from private.employee_sick_leave_balances where person_id = '20000000-0000-4000-8000-000000000010');
  assert (select hours = 11 from private.employee_annual_leave_balances where person_id = '20000000-0000-4000-8000-000000000011');
  assert (select hours = 40 from private.employee_sick_leave_balances where person_id = '20000000-0000-4000-8000-000000000012');
  assert (select count(*) = 2 from private.annual_leave_balance_history where source_import_id is not null);
  assert (select count(*) = 3 from private.sick_leave_balance_history where source_import_id is not null);
  assert (select (public.get_payroll_balance_import_workspace()->'reminder'->>'complete')::boolean), 'Both current company snapshots complete the month';
  assert (select count(*) = 0 from public.list_payroll_balance_reminder_calendar_entries()), 'Completed month clears the reminder';
  assert not has_table_privilege('authenticated', 'private.payroll_balance_import_stage_rows', 'SELECT');
  assert not has_table_privilege('authenticated', 'private.payroll_balance_import_grants', 'SELECT');
  assert not has_function_privilege('authenticated', 'private.payroll_balance_import_batch_projection(uuid)', 'EXECUTE');
end$$;

-- A previously held source row must become importable after the directory is
-- corrected. A later repeat of an already-applied snapshot remains auditable
-- without creating duplicate balance history.
insert into public.internal_org_people (id, full_name, company_key, position_title, parent_id)
values (
  '20000000-0000-4000-8000-000000000017',
  'Nobody New',
  'mam',
  'Test employee',
  '20000000-0000-4000-8000-000000000001'
);

create temporary table retried_payroll_batch as
select public.stage_payroll_balance_import(
  '20000000-0000-4000-8000-000000000002',
  repeat('e', 64),
  jsonb_build_array(
    jsonb_build_object(
      'name', 'mam-balances.csv',
      'sha256', repeat('1', 64),
      'sizeBytes', 320,
      'companies', jsonb_build_array('mam'),
      'asOfDates', jsonb_build_array(current_date),
      'employeeRows', 1
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'companyKey', 'mam',
      'employeeName', 'Nobody New',
      'annualHours', 7,
      'sickHours', 8,
      'asOf', current_date,
      'sourceFile', 'mam-balances.csv',
      'sourceSha256', repeat('1', 64)
    )
  )
) as payload;

create temporary table committed_retried_payroll_batch as
select public.commit_payroll_balance_import(
  (retried_payroll_batch.payload->>'batchId')::uuid,
  (retried_payroll_batch.payload->>'version')::bigint
) as payload
from retried_payroll_batch;

do $$begin
  assert (select count(*) = 2 from private.payroll_balance_imports where employee_name = 'Nobody New'), 'Retry preserves both import attempts';
  assert (select hours = 7 from private.employee_annual_leave_balances where person_id = '20000000-0000-4000-8000-000000000017'), 'Previously unmatched annual balance applies after directory correction';
  assert (select hours = 8 from private.employee_sick_leave_balances where person_id = '20000000-0000-4000-8000-000000000017'), 'Previously unmatched sick balance applies after directory correction';
  assert (select count(*) = 3 from private.annual_leave_balance_history where source_import_id is not null);
  assert (select count(*) = 4 from private.sick_leave_balance_history where source_import_id is not null);
end$$;

create temporary table repeated_payroll_batch as
select public.stage_payroll_balance_import(
  '20000000-0000-4000-8000-000000000002',
  repeat('e', 64),
  jsonb_build_array(
    jsonb_build_object(
      'name', 'mam-balances.csv',
      'sha256', repeat('1', 64),
      'sizeBytes', 320,
      'companies', jsonb_build_array('mam'),
      'asOfDates', jsonb_build_array(current_date),
      'employeeRows', 1
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'companyKey', 'mam',
      'employeeName', 'Nobody New',
      'annualHours', 7,
      'sickHours', 8,
      'asOf', current_date,
      'sourceFile', 'mam-balances.csv',
      'sourceSha256', repeat('1', 64)
    )
  )
) as payload;

do $$declare payload jsonb := (select repeated_payroll_batch.payload from repeated_payroll_batch); begin
  assert payload->>'batchId' <> (select committed_retried_payroll_batch.payload->>'batchId' from committed_retried_payroll_batch), 'A committed file can be reconciled again after directory changes';
  assert (select not (row->>'willApplyAnnual')::boolean and not (row->>'willApplySick')::boolean from jsonb_array_elements(payload->'rows') row), 'An unchanged current snapshot previews as no-op';
end$$;

create temporary table committed_repeated_payroll_batch as
select public.commit_payroll_balance_import(
  (repeated_payroll_batch.payload->>'batchId')::uuid,
  (repeated_payroll_batch.payload->>'version')::bigint
) as payload
from repeated_payroll_batch;

do $$begin
  assert (select count(*) = 3 from private.annual_leave_balance_history where source_import_id is not null), 'No-op repeat does not duplicate annual history';
  assert (select count(*) = 4 from private.sick_leave_balance_history where source_import_id is not null), 'No-op repeat does not duplicate sick history';
  begin
    perform public.stage_payroll_balance_import(
      '20000000-0000-4000-8000-000000000003',
      repeat('f', 64),
      '[]'::jsonb,
      '[]'::jsonb
    );
    raise exception 'The trusted ingestion function accepted an ungranted actor';
  exception when insufficient_privilege then null; end;
end$$;

create temporary table multi_date_payroll_batch as
select public.stage_payroll_balance_import(
  '20000000-0000-4000-8000-000000000002',
  repeat('a', 64),
  jsonb_build_array(
    jsonb_build_object(
      'name', 'mam-multi-date.csv',
      'sha256', repeat('4', 64),
      'sizeBytes', 240,
      'companies', jsonb_build_array('mam'),
      'asOfDates', jsonb_build_array(current_date - 1, current_date),
      'employeeRows', 2
    )
  ),
  jsonb_build_array(
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'MAM Current', 'annualHours', 10, 'sickHours', 21, 'asOf', current_date - 1, 'sourceFile', 'mam-multi-date.csv', 'sourceSha256', repeat('4', 64)),
    jsonb_build_object('companyKey', 'mam', 'employeeName', 'MAM Current', 'annualHours', 12, 'sickHours', 23, 'asOf', current_date, 'sourceFile', 'mam-multi-date.csv', 'sourceSha256', repeat('4', 64))
  )
) as payload;

do $$declare payload jsonb := (select multi_date_payroll_batch.payload from multi_date_payroll_batch); begin
  assert (select count(*) = 2 from jsonb_array_elements(payload->'rows') row where row->>'status' = 'linked'), 'Multiple dates for one person remain linked';
  assert (select count(*) = 1 from jsonb_array_elements(payload->'rows') row where (row->>'willApplyAnnual')::boolean), 'Only the newest applicable annual snapshot is selected';
  assert (select count(*) = 1 from jsonb_array_elements(payload->'rows') row where (row->>'willApplySick')::boolean), 'Only the newest applicable sick snapshot is selected';
end$$;

create temporary table committed_multi_date_payroll_batch as
select public.commit_payroll_balance_import(
  (multi_date_payroll_batch.payload->>'batchId')::uuid,
  (multi_date_payroll_batch.payload->>'version')::bigint
) as payload
from multi_date_payroll_batch;

do $$begin
  assert (select hours = 12 from private.employee_annual_leave_balances where person_id = '20000000-0000-4000-8000-000000000011'), 'Newest annual row wins within a multi-date batch';
  assert (select hours = 23 from private.employee_sick_leave_balances where person_id = '20000000-0000-4000-8000-000000000011'), 'Newest sick row wins within a multi-date batch';
  assert (select count(*) = 4 from private.annual_leave_balance_history where source_import_id is not null);
  assert (select count(*) = 5 from private.sick_leave_balance_history where source_import_id is not null);
end$$;

select pg_temp.set_test_actor('20000000-0000-4000-8000-000000000001');
select public.replace_payroll_balance_import_grants(array[
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003'
]::uuid[]);

select pg_temp.set_test_actor('20000000-0000-4000-8000-000000000003');
do $$begin
  assert jsonb_array_length(public.get_payroll_balance_import_workspace()->'recentBatches') = 0,
    'A delegate cannot see another importer''s filenames or batch metadata';
end$$;

select pg_temp.set_test_actor('20000000-0000-4000-8000-000000000001');
do $$begin
  assert private.next_subscription_billing_on('2026-08-17', 'monthly', '2026-09-15') = date '2026-09-17';
  assert private.next_subscription_billing_on('2026-01-31', 'monthly', '2026-02-01') = date '2026-02-28';
  assert private.next_subscription_billing_on('2024-02-29', 'annual', '2026-02-01') = date '2026-02-28';
end$$;

create temporary table created_subscription as
select public.create_subscription_v3(
  'Synthetic Service',
  'Team plan',
  'paid',
  'monthly',
  12345,
  private.mam_local_calendar_date() + 30,
  14,
  true,
  'Synthetic Corporate Card',
  private.mam_local_calendar_date(),
  '20000000-0000-4000-8000-000000000004',
  array['20000000-0000-4000-8000-000000000002']::uuid[]
) as payload;

do $$declare payload jsonb := (select created_subscription.payload from created_subscription); begin
  assert (payload->>'seat_count')::integer = 14;
  assert (payload->>'credit_card_used')::boolean;
  assert payload->>'credit_card_holder' = 'Synthetic Corporate Card';
  assert (payload->>'mam_credit_card_used')::boolean, 'Legacy projection key remains compatible';
  assert (payload->>'billing_anchor_date')::date = private.mam_local_calendar_date();
  assert (payload->>'next_billing_on')::date = private.mam_local_calendar_date();
  assert payload->>'last_reviewed_on' is null;
end$$;

create temporary table updated_subscription as
select public.update_subscription_v3(
  (created_subscription.payload->>'subscription_id')::uuid,
  (created_subscription.payload->>'version')::bigint,
  'Synthetic Service',
  'Team plan',
  'active',
  'paid',
  'monthly',
  12345,
  private.mam_local_calendar_date() + 30,
  14,
  false,
  'This stale value must be cleared',
  private.mam_local_calendar_date(),
  '20000000-0000-4000-8000-000000000004',
  array['20000000-0000-4000-8000-000000000002']::uuid[]
) as payload
from created_subscription;

do $$declare payload jsonb := (select updated_subscription.payload from updated_subscription); begin
  assert not (payload->>'credit_card_used')::boolean;
  assert payload->>'credit_card_holder' is null, 'Cardholder is cleared when no credit card is used';
  assert (payload->>'version')::bigint > (select (created_subscription.payload->>'version')::bigint from created_subscription);
end$$;

create temporary table reviewed_subscription as
select public.mark_subscription_reviewed_v2(
  (updated_subscription.payload->>'subscription_id')::uuid,
  (updated_subscription.payload->>'version')::bigint
) as payload
from updated_subscription;

do $$declare payload jsonb := (select reviewed_subscription.payload from reviewed_subscription); begin
  assert (payload->>'last_reviewed_on')::date = private.mam_local_calendar_date();
  assert (payload->>'version')::bigint > (select (created_subscription.payload->>'version')::bigint from created_subscription);
  assert jsonb_array_length(public.list_subscriptions_v2()) = 1;
  assert not has_table_privilege('authenticated', 'private.subscription_register', 'SELECT');
  assert not has_function_privilege('authenticated', 'private.subscription_register_v2_projection(uuid)', 'EXECUTE');
  assert has_function_privilege(
    'authenticated',
    'public.create_subscription_v3(text,text,text,text,integer,date,integer,boolean,text,date,uuid,uuid[])',
    'EXECUTE'
  );
end$$;

do $$begin
  begin
    perform public.create_subscription_v3(
      'Incomplete paid service', null, 'paid', 'monthly', 1000, null,
      1, true, null, private.mam_local_calendar_date(),
      '20000000-0000-4000-8000-000000000004', array[]::uuid[]
    );
    raise exception 'A used credit card without a cardholder was accepted';
  exception when invalid_parameter_value then null; end;
end$$;

rollback;
