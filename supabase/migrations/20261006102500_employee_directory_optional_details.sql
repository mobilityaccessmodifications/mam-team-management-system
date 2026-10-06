begin;
set local search_path = '';
set local lock_timeout = '2s';
set local statement_timeout = '120s';

do $directory_details_before$
declare
  r record;
  previous_hash text;
  previous_functions jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge', 0)) then
    raise exception 'Concurrent purge; defer directory projection migration' using errcode = '55P03';
  end if;
  select schema_hash into strict previous_hash
  from private.confirmed_test_purge_schema where singleton for update nowait;
  if private.confirmed_test_purge_schema_hash() is distinct from previous_hash then
    raise exception 'Directory projection schema predecessor changed' using errcode = '55000';
  end if;
  for r in select * from (values
    ('public.list_employee_directory_records_with_work_schedule_times(boolean)', 'fe3cfcbb1d935f054f95d97af01b95e49139568449716d17c8d02fcff590b911'),
    ('public.get_employee_directory_record_with_work_schedule_times(uuid)', '14ca9c6df8258629f92de33001ab4cb4038272dc949d06d0a2e01d2353746b35')
  ) expected(signature, definition_sha256)
  loop
    if encode(extensions.digest(pg_get_functiondef(to_regprocedure(r.signature)), 'sha256'), 'hex')
      is distinct from r.definition_sha256 then
      raise exception 'Directory projection function predecessor changed (%)', r.signature using errcode = '55000';
    end if;
  end loop;
  select jsonb_object_agg(p.oid::regprocedure::text,
    jsonb_build_object('definition', pg_get_functiondef(p.oid), 'metadata',
      (to_jsonb(p) - 'prosrc' - 'proargdefaults') ||
      jsonb_build_object('proargdefaults', pg_get_expr(p.proargdefaults, 0))))
  into previous_functions from pg_catalog.pg_proc p
  where p.oid in (
    'public.list_employee_directory_records_with_work_schedule_times(boolean)'::regprocedure,
    'public.get_employee_directory_record_with_work_schedule_times(uuid)'::regprocedure
  );
  perform set_config('mam.directory_details_previous_hash', previous_hash, true);
  perform set_config('mam.directory_details_previous_functions', previous_functions::text, true);
end;
$directory_details_before$;

CREATE OR REPLACE FUNCTION public.list_employee_directory_records_with_work_schedule_times(p_include_archived boolean DEFAULT false)
 RETURNS TABLE(person_id uuid, person_version bigint, detail_version bigint, company_key text, is_active boolean, first_name text, last_name text, full_name text, position_title text, team_name text, manager_id uuid, manager_name text, work_email text, personal_email text, phone text, country text, address text, date_of_birth date, started_date date, scheduled_employment_end_date date, archive_reason text, employment_type text, has_paid_leave_entitlement boolean, laptop_supplied text, laptop_id text, mouse_id text, keyboard_id text, asset_tags text[], working_weekdays smallint[], working_day_times jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    record.person_id,
    record.person_version,
    record.detail_version,
    record.company_key,
    record.is_active,
    record.first_name,
    record.last_name,
    record.full_name,
    record.position_title,
    record.team_name,
    record.manager_id,
    record.manager_name,
    record.work_email,
    record.personal_email,
    record.phone,
    record.country,
    record.address,
    record.date_of_birth,
    record.started_date,
    record.scheduled_employment_end_date,
    record.archive_reason,
    record.employment_type,
    record.has_paid_leave_entitlement,
    record.laptop_supplied,
    record.laptop_id,
    record.mouse_id,
    record.keyboard_id,
    record.asset_tags,
    record.working_weekdays,
    detail.working_day_times
  from public.list_employee_directory_records_with_work_schedule(
    p_include_archived
  ) record
  left join private.employee_directory_details detail
    on detail.person_id = record.person_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_employee_directory_record_with_work_schedule_times(p_person_id uuid)
 RETURNS TABLE(person_id uuid, person_version bigint, detail_version bigint, company_key text, is_active boolean, first_name text, last_name text, full_name text, position_title text, team_name text, manager_id uuid, manager_name text, work_email text, personal_email text, phone text, country text, address text, date_of_birth date, started_date date, scheduled_employment_end_date date, archive_reason text, employment_type text, has_paid_leave_entitlement boolean, laptop_supplied text, laptop_id text, mouse_id text, keyboard_id text, asset_tags text[], working_weekdays smallint[], working_day_times jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    record.person_id,
    record.person_version,
    record.detail_version,
    record.company_key,
    record.is_active,
    record.first_name,
    record.last_name,
    record.full_name,
    record.position_title,
    record.team_name,
    record.manager_id,
    record.manager_name,
    record.work_email,
    record.personal_email,
    record.phone,
    record.country,
    record.address,
    record.date_of_birth,
    record.started_date,
    record.scheduled_employment_end_date,
    record.archive_reason,
    record.employment_type,
    record.has_paid_leave_entitlement,
    record.laptop_supplied,
    record.laptop_id,
    record.mouse_id,
    record.keyboard_id,
    record.asset_tags,
    record.working_weekdays,
    detail.working_day_times
  from public.get_employee_directory_record_with_work_schedule(
    p_person_id
  ) record
  left join private.employee_directory_details detail
    on detail.person_id = record.person_id;
$function$;

do $directory_details_after$
declare
  r record;
  previous_functions jsonb := current_setting('mam.directory_details_previous_functions')::jsonb;
  previous_hash text := current_setting('mam.directory_details_previous_hash');
  actual_metadata jsonb;
  collector_source text;
  normalized_hash text;
  replacements text;
begin
  for r in select key as signature, value as previous from jsonb_each(previous_functions)
  loop
    if pg_get_functiondef(to_regprocedure(r.signature)) is distinct from replace(
      r.previous->>'definition',
      E'\n  join private.employee_directory_details detail\n',
      E'\n  left join private.employee_directory_details detail\n'
    ) then
      raise exception 'Unexpected directory projection definition change (%)', r.signature using errcode = '55000';
    end if;
    select (to_jsonb(p) - 'prosrc' - 'proargdefaults') ||
      jsonb_build_object('proargdefaults', pg_get_expr(p.proargdefaults, 0)) into strict actual_metadata
    from pg_catalog.pg_proc p where p.oid = to_regprocedure(r.signature);
    if actual_metadata is distinct from r.previous->'metadata' then
      raise exception 'Directory projection signature or security changed (%)', r.signature using errcode = '55000';
    end if;
  end loop;
  select prosrc into strict collector_source from pg_catalog.pg_proc
  where oid = 'private.confirmed_test_purge_schema_hash()'::regprocedure;
  if (length(collector_source) - length(replace(collector_source, 'pg_get_functiondef(p.oid)', '')))
    / length('pg_get_functiondef(p.oid)') <> 1 then
    raise exception 'Directory projection catalog collector changed' using errcode = '55000';
  end if;
  select string_agg(format('when p.oid = %L::regprocedure then %L', key, value->>'definition'), E'\n' order by key)
  into replacements from jsonb_each(previous_functions);
  execute replace(collector_source, 'pg_get_functiondef(p.oid)',
    'case ' || replacements || ' else pg_get_functiondef(p.oid) end') into normalized_hash;
  if normalized_hash is distinct from previous_hash then
    raise exception 'Unrelated catalog change during directory projection migration' using errcode = '55000';
  end if;
  update private.confirmed_test_purge_schema
  set schema_hash = private.confirmed_test_purge_schema_hash()
  where singleton and schema_hash = previous_hash;
  if not found then
    raise exception 'Directory projection schema baseline changed' using errcode = '40001';
  end if;
end;
$directory_details_after$;

notify pgrst, 'reload schema';
commit;
