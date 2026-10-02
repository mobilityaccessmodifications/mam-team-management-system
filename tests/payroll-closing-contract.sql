begin;
do $$begin
  assert to_regclass('private.payroll_closing_receipts') is not null, 'Closing receipts are required';
  assert to_regclass('private.payroll_carryforward_events') is not null, 'Separate carry-forward reservations are required';
  assert not exists(select 1 from pg_class where oid in ('private.payroll_closing_receipts'::regclass,'private.payroll_carryforward_events'::regclass) and (not relrowsecurity or not relforcerowsecurity));
  assert not has_table_privilege('authenticated','private.payroll_closing_receipts','SELECT,INSERT,UPDATE,DELETE');
  assert not has_table_privilege('service_role','private.payroll_carryforward_events','SELECT,INSERT,UPDATE,DELETE');
end$$;
rollback;
