create function pg_temp.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Assertion failed: %', p_message;
  end if;
end;
$$;

select pg_temp.assert(
  pg_get_function_result('public.list_calendar_birthdays()'::regprocedure)
    = 'TABLE(employee_name text, birthday_month smallint, birthday_day smallint)',
  'live birthday projection preserves the name plus recurring month/day contract'
);
select pg_temp.assert(
  pg_get_function_result('public.list_calendar_birthdays_for_preview(uuid)'::regprocedure)
    = 'TABLE(employee_name text, birthday_month smallint, birthday_day smallint)',
  'preview birthday projection preserves the same minimal contract'
);

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000006'),
  ('10000000-0000-4000-8000-000000000007'),
  ('10000000-0000-4000-8000-000000000008'),
  ('10000000-0000-4000-8000-000000000009');

insert into public.profiles (id, app_role, account_status, login_name) values
  ('10000000-0000-4000-8000-000000000001', 'system_admin', 'active', 'admin'),
  ('10000000-0000-4000-8000-000000000002', 'manager', 'active', 'manager'),
  ('10000000-0000-4000-8000-000000000003', 'employee', 'active', 'employee'),
  ('10000000-0000-4000-8000-000000000004', 'manager', 'active', 'nested-manager'),
  ('10000000-0000-4000-8000-000000000005', 'employee', 'active', 'nested-employee'),
  ('10000000-0000-4000-8000-000000000006', 'employee', 'active', 'outside'),
  ('10000000-0000-4000-8000-000000000007', 'employee', 'active', 'archived'),
  ('10000000-0000-4000-8000-000000000008', 'employee', 'active', 'unlinked'),
  ('10000000-0000-4000-8000-000000000009', 'system_admin', 'active', 'non-roster-admin');

insert into public.internal_org_people (
  id, auth_user_id, parent_id, node_kind, is_active, full_name, company_key
) values
  ('20000000-0000-4000-8000-000000000010', null, null, 'org_unit', true, null, 'mam'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000010', 'person', true, 'System Admin', 'mam'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000010', 'person', true, 'Manager Example', 'mam'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'person', true, 'Employee Example', 'mam'),
  ('20000000-0000-4000-8000-000000000011', null, '20000000-0000-4000-8000-000000000002', 'org_unit', true, null, 'equipsy'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000011', 'person', true, 'Nested Manager', 'equipsy'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000004', 'person', true, 'Nested Employee', 'equipsy'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000010', 'person', true, 'Outside Employee', 'mam'),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002', 'person', false, 'Archived Employee', 'mam');

insert into private.employee_directory_details (person_id, date_of_birth) values
  ('20000000-0000-4000-8000-000000000001', '1980-01-01'),
  ('20000000-0000-4000-8000-000000000002', '1981-02-02'),
  ('20000000-0000-4000-8000-000000000003', '1982-03-03'),
  ('20000000-0000-4000-8000-000000000004', '1983-04-04'),
  ('20000000-0000-4000-8000-000000000005', '1984-05-05'),
  ('20000000-0000-4000-8000-000000000006', '1985-06-06'),
  ('20000000-0000-4000-8000-000000000007', '1986-07-07');

set role authenticated;
set request.jwt.claims = '{"is_anonymous":false}';

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', false);
select pg_temp.assert(
  (select count(*) = 1 and bool_and(employee_name = 'Employee Example')
   from public.list_calendar_birthdays()),
  'ordinary employees receive only their own birthday'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
select pg_temp.assert(
  (select count(*) = 4 from public.list_calendar_birthdays()),
  'manager receives their own birthday and every active reporting descendant'
);
select pg_temp.assert(
  (select array_agg(employee_name order by employee_name)
   from public.list_calendar_birthdays())
    = array['Employee Example', 'Manager Example', 'Nested Employee', 'Nested Manager'],
  'manager scope crosses active org units but excludes peers and archived staff'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
select pg_temp.assert(
  (select array_agg(employee_name order by employee_name)
   from public.list_calendar_birthdays())
    = array['Nested Employee', 'Nested Manager'],
  'nested manager scope is limited to their own subtree'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
select pg_temp.assert(
  (select count(*) = 6 from public.list_calendar_birthdays()),
  'linked System Admin retains the operational all-active birthday view'
);
select pg_temp.assert(
  (select count(*) = 1 and bool_and(employee_name = 'Employee Example')
   from public.list_calendar_birthdays_for_preview('20000000-0000-4000-8000-000000000003')),
  'System Admin employee preview simulates self-only birthday scope'
);
select pg_temp.assert(
  (select count(*) = 4
   from public.list_calendar_birthdays_for_preview('20000000-0000-4000-8000-000000000002')),
  'System Admin manager preview simulates the selected reporting subtree'
);
select pg_temp.assert(
  (select count(*) = 6
   from public.list_calendar_birthdays_for_preview('20000000-0000-4000-8000-000000000001')),
  'System Admin preview of a System Admin preserves global scope'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000009', false);
select pg_temp.assert(
  (select count(*) = 6 from public.list_calendar_birthdays()),
  'an active non-roster System Admin retains operational birthday access'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000008', false);
do $$
begin
  perform count(*) from public.list_calendar_birthdays();
  raise exception 'Expected an unlinked employee birthday request to be denied.';
exception
  when insufficient_privilege then null;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', false);
do $$
begin
  perform count(*)
  from public.list_calendar_birthdays_for_preview('20000000-0000-4000-8000-000000000002');
  raise exception 'Expected employee preview access to be denied.';
exception
  when insufficient_privilege then null;
end;
$$;

set request.jwt.claims = '{"is_anonymous":true}';
do $$
begin
  perform count(*) from public.list_calendar_birthdays();
  raise exception 'Expected anonymous birthday access to be denied.';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;
update public.profiles
set app_role = 'employee'
where id = '10000000-0000-4000-8000-000000000002';

set role authenticated;
set request.jwt.claims = '{"is_anonymous":false}';
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
select pg_temp.assert(
  (select count(*) = 1 and bool_and(employee_name = 'Manager Example')
   from public.list_calendar_birthdays()),
  'removing the manager role immediately contracts birthday visibility to self'
);

reset role;

select pg_temp.assert(
  not has_function_privilege(
    'authenticated',
    'private.list_calendar_birthday_person_ids_for(uuid)',
    'EXECUTE'
  ),
  'the target-aware birthday scope helper remains private'
);
