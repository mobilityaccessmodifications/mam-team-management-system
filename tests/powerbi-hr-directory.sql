begin;

do $$ begin
  assert current_database() = 'mam_test_powerbi_contract', 'Disposable Power BI fixture required';
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create role mam_powerbi_hr_reader login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role mam_powerbi_hr_reader set default_transaction_read_only = on;
alter role mam_powerbi_hr_reader set statement_timeout = '60s';
create schema private;
create schema powerbi_hr;
create schema extensions;
revoke all on schema private, powerbi_hr from public, anon, authenticated, service_role;
create table public.internal_org_people (
  id uuid primary key, full_name text, company_key text, position_title text,
  is_active boolean, started_date date, created_at timestamptz, updated_at timestamptz, node_kind text
);
create table private.employee_directory_details (
  person_id uuid primary key, first_name text, last_name text, updated_at timestamptz,
  scheduled_employment_end_date date, employment_type text, working_weekdays text[],
  working_day_times jsonb, archive_reason text, private_contact text
);
insert into public.internal_org_people values
  ('00000000-0000-4000-8000-000000000001', 'Synthetic Employee', 'fixture', 'Fixture Role', true,
   '2026-01-01', '2026-01-01Z', '2026-01-01Z', 'person');
insert into private.employee_directory_details values
  ('00000000-0000-4000-8000-000000000001', 'Synthetic', 'Employee', '2026-01-01Z', null,
   'fixture', array['monday'], '{}'::jsonb, null, 'synthetic-private-contact');
create view powerbi_hr.employee_directory with (security_barrier = true) as
select p.id as employee_id, d.first_name, d.last_name, p.full_name, p.company_key,
  p.position_title, p.is_active, p.started_date, p.created_at, p.updated_at,
  d.updated_at as detail_updated_at, d.scheduled_employment_end_date, d.employment_type,
  d.working_weekdays, d.working_day_times, d.archive_reason as reason_for_leaving
from public.internal_org_people p join private.employee_directory_details d on d.person_id = p.id
where p.node_kind = 'person';
grant usage on schema powerbi_hr to mam_powerbi_hr_reader;
grant select on powerbi_hr.employee_directory to mam_powerbi_hr_reader;
create table public.powerbi_contract_other (value text);
create sequence public.powerbi_contract_sequence;
create function public.powerbi_contract_definer() returns integer language sql security definer as 'select 1';
revoke all on function public.powerbi_contract_definer() from public;
create view extensions.pg_stat_statements as select 'synthetic-statistics'::text as query;
create view extensions.pg_stat_statements_info as select 0::bigint as dealloc;
grant select on extensions.pg_stat_statements, extensions.pg_stat_statements_info to public;

set local role mam_powerbi_hr_reader;
do $$
begin
  if (select count(*) from powerbi_hr.employee_directory) <> 1 then
    raise exception 'Synthetic projection SELECT failed';
  end if;
  begin
    perform private_contact from powerbi_hr.employee_directory;
    raise exception 'Private column unexpectedly exposed';
  exception when undefined_column then null;
  end;
  begin
    perform 1 from public.internal_org_people;
    raise exception 'Source table unexpectedly readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from private.employee_directory_details;
    raise exception 'Private table unexpectedly readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into powerbi_hr.employee_directory(employee_id) values ('00000000-0000-4000-8000-000000000002');
    raise exception 'INSERT unexpectedly permitted';
  exception when insufficient_privilege or object_not_in_prerequisite_state then null;
  end;
  begin
    update powerbi_hr.employee_directory set full_name = 'Changed';
    raise exception 'UPDATE unexpectedly permitted';
  exception when insufficient_privilege or object_not_in_prerequisite_state then null;
  end;
  begin
    delete from powerbi_hr.employee_directory;
    raise exception 'DELETE unexpectedly permitted';
  exception when insufficient_privilege or object_not_in_prerequisite_state then null;
  end;
  begin
    perform 1 from public.powerbi_contract_other;
    raise exception 'Other relation unexpectedly readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform nextval('public.powerbi_contract_sequence');
    raise exception 'Sequence unexpectedly usable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.powerbi_contract_definer();
    raise exception 'SECURITY DEFINER unexpectedly executable';
  exception when insufficient_privilege then null;
  end;
  begin
    execute 'create table powerbi_hr.forbidden(value text)';
    raise exception 'Schema write unexpectedly permitted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

select 'PASS: synthetic Power BI SELECT and ten exposure/mutation denials';
commit;
