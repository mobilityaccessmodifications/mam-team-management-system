begin;
\ir payroll-closing-setup.sql
select public.reconcile_payroll_closing('synthetic-closing-one',pg_temp.closing_payload());
do $$declare w jsonb; p jsonb; projection jsonb; begin
  w:=public.get_leave_priority_workspace();
  select value into p from jsonb_array_elements(w->'people') where value->>'personId'='96000000-0000-4000-8000-000000000003';
  assert (p->>'annualRetainedHours')::numeric=38, 'Retained commitment aggregate must be visible separately';
  assert abs((p->>'annualAvailableHours')::numeric-(94.8321+7.6/13*(select count(*) from generate_series(date '2026-09-25',(now() at time zone 'Australia/Melbourne')::date-1,interval '1 day') day where extract(isodow from day) between 1 and 5)))<0.000000000001, 'Known paid service accrues while the retained commitment remains reserved';
  assert p->>'annualBalanceSource'='owner_estimate';
  perform pg_temp.set_test_actor('96000000-0000-4000-8000-000000000003');
  w:=public.get_leave_priority_workspace();
  assert jsonb_array_length(w->'people')=1;
  p:=w->'people'->0;
  assert (p->>'annualRetainedHours')::numeric=38;
  assert not p ? 'sickRetainedHours';
  assert not p ? 'closingReceipt' and not p ? 'reservations' and not p ? 'accountedHours';
  assert w::text not like '%Owner-approved synthetic%';
  begin perform public.preview_payroll_closing_reconciliation('96000000-0000-4000-8000-000000000002'); raise exception 'Private preview leaked'; exception when sqlstate '42501' then null; end;
  projection:=public.preview_annual_leave_balance('96000000-0000-4000-8000-000000000003','2026-09-25');
  assert (projection->>'retainedHours')::numeric=38;
  assert (projection->>'otherTakenHours')::numeric=0, 'Adopted aggregate must not be debited again';
  assert private.approved_leave_hours_after('96000000-0000-4000-8000-000000000003',array['Annual leave'],null) is null;
end$$;
rollback;
