-- Synthetic, read-only assertions after applying the migration locally.
begin;
do $$
declare d date; actual date;
begin
  for d in select generate_series(date '2026-01-01',date '2028-12-31',interval '1 day')::date loop
    actual := private.birthday_reminder_date(d);
    assert actual < d and extract(isodow from actual) between 1 and 5,
      'Reminder must precede birthday on a weekday';
    assert not exists(select 1 from generate_series(actual+1,d-1,interval '1 day') n
      where extract(isodow from n) between 1 and 5), 'Must be the nearest preceding weekday';
    assert d between actual+1 and actual+3, 'Claim lookahead must contain the birthday';
  end loop;
  assert private.birthday_reminder_date(date '2026-09-14')=date '2026-09-11';
  assert private.birthday_reminder_date(date '2027-01-01')=date '2026-12-31';
  assert private.birthday_reminder_date(date '2028-02-29')=date '2028-02-28';
  assert not has_function_privilege('anon','public.claim_leave_priority_reminders(integer)','EXECUTE');
  assert not has_function_privilege('authenticated','public.claim_leave_priority_reminders(integer)','EXECUTE');
  assert has_function_privilege('service_role','public.claim_leave_priority_reminders(integer)','EXECUTE');
end $$;
rollback;
