begin;

create role mam_powerbi_hr_reader
  login
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  noreplication
  nobypassrls;

grant connect on database postgres to mam_powerbi_hr_reader;
alter role mam_powerbi_hr_reader set default_transaction_read_only = on;
alter role mam_powerbi_hr_reader set statement_timeout = '60s';

create schema powerbi_hr;

create view powerbi_hr.employee_directory
with (security_barrier = true)
as
select
  person.id as employee_id,
  detail.first_name,
  detail.last_name,
  person.full_name,
  person.company_key,
  person.position_title,
  person.is_active,
  person.started_date,
  person.created_at,
  person.updated_at,
  detail.updated_at as detail_updated_at,
  detail.scheduled_employment_end_date,
  detail.employment_type,
  detail.working_weekdays,
  detail.working_day_times,
  detail.archive_reason as reason_for_leaving
from public.internal_org_people person
join private.employee_directory_details detail
  on detail.person_id = person.id
where person.node_kind = 'person';

revoke all on schema powerbi_hr from public, anon, authenticated, service_role;
grant usage on schema powerbi_hr to mam_powerbi_hr_reader;
revoke all on table powerbi_hr.employee_directory
  from public, anon, authenticated, service_role;
grant select on table powerbi_hr.employee_directory to mam_powerbi_hr_reader;

commit;
