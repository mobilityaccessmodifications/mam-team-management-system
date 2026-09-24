begin;

do $$
declare
  actual_columns text[];
  role_is_limited boolean;
begin
  select array_agg(column_name::text order by ordinal_position)
  into actual_columns
  from information_schema.columns
  where table_schema = 'powerbi_hr'
    and table_name = 'employee_directory';

  if actual_columns is distinct from array[
    'employee_id',
    'first_name',
    'last_name',
    'full_name',
    'company_key',
    'position_title',
    'is_active',
    'started_date',
    'created_at',
    'updated_at',
    'detail_updated_at',
    'scheduled_employment_end_date',
    'employment_type',
    'working_weekdays',
    'working_day_times',
    'reason_for_leaving'
  ]::text[] then
    raise exception 'Power BI employee-directory projection columns changed';
  end if;

  select
    role.rolcanlogin
    and not role.rolsuper
    and not role.rolcreatedb
    and not role.rolcreaterole
    and not role.rolinherit
    and not role.rolreplication
    and not role.rolbypassrls
  into role_is_limited
  from pg_roles role
  where role.rolname = 'mam_powerbi_hr_reader';

  if role_is_limited is distinct from true then
    raise exception 'Power BI database role has unexpected capabilities';
  end if;

  if exists (
    select 1
    from pg_authid role
    where role.rolname = 'mam_powerbi_hr_reader'
      and role.rolpassword is not null
  ) then
    raise exception 'Power BI database password must not be stored in migrations';
  end if;

  if not has_schema_privilege('mam_powerbi_hr_reader', 'powerbi_hr', 'USAGE')
    or has_schema_privilege('mam_powerbi_hr_reader', 'powerbi_hr', 'CREATE')
    or not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'SELECT')
    or has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'INSERT')
    or has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'UPDATE')
    or has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'DELETE')
    or has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'TRUNCATE')
    or has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'REFERENCES')
    or has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'TRIGGER') then
    raise exception 'Power BI role does not have the expected view-only access';
  end if;

  if has_table_privilege('mam_powerbi_hr_reader', 'public.internal_org_people', 'SELECT')
    or has_table_privilege('mam_powerbi_hr_reader', 'private.employee_directory_details', 'SELECT')
    or has_table_privilege('service_role', 'powerbi_hr.employee_directory', 'SELECT')
    or has_schema_privilege('service_role', 'powerbi_hr', 'USAGE')
    or has_schema_privilege('anon', 'powerbi_hr', 'USAGE')
    or has_schema_privilege('authenticated', 'powerbi_hr', 'USAGE')
    or has_schema_privilege('mam_powerbi_hr_reader', 'private', 'USAGE') then
    raise exception 'Power BI access escaped the dedicated view boundary';
  end if;

  if not has_database_privilege('mam_powerbi_hr_reader', current_database(), 'CONNECT')
    or exists (
      select 1
      from pg_auth_members membership
      where membership.member = (
        select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'
      )
    ) then
    raise exception 'Power BI role has invalid database access or role membership';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace schema on schema.oid = relation.relnamespace
    where schema.nspname not in ('pg_catalog', 'information_schema')
      and schema.nspname not like 'pg_temp_%'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and relation.oid <> 'powerbi_hr.employee_directory'::regclass
      and not (
        schema.nspname = 'extensions'
        and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')
      )
      and (
        has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'SELECT')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'INSERT')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'UPDATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'DELETE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRUNCATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'REFERENCES')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRIGGER')
      )
  ) then
    raise exception 'Power BI role has relation access outside its approved view';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace schema on schema.oid = relation.relnamespace
    where schema.nspname = 'extensions'
      and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')
      and (
        has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'INSERT')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'UPDATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'DELETE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRUNCATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'REFERENCES')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRIGGER')
      )
  ) then
    raise exception 'Supabase statistics views must remain read-only';
  end if;

  if exists (
    select 1
    from pg_class sequence
    join pg_namespace schema on schema.oid = sequence.relnamespace
    where schema.nspname not in ('pg_catalog', 'information_schema')
      and schema.nspname not like 'pg_temp_%'
      and sequence.relkind = 'S'
      and (
        has_sequence_privilege('mam_powerbi_hr_reader', sequence.oid, 'USAGE')
        or has_sequence_privilege('mam_powerbi_hr_reader', sequence.oid, 'SELECT')
        or has_sequence_privilege('mam_powerbi_hr_reader', sequence.oid, 'UPDATE')
      )
  ) then
    raise exception 'Power BI role has sequence access';
  end if;

  if exists (
    select 1
    from pg_proc routine
    join pg_namespace schema on schema.oid = routine.pronamespace
    where has_schema_privilege('mam_powerbi_hr_reader', schema.oid, 'USAGE')
      and routine.prosecdef
      and has_function_privilege('mam_powerbi_hr_reader', routine.oid, 'EXECUTE')
  ) then
    raise exception 'Power BI role can execute a SECURITY DEFINER routine';
  end if;

  if not exists (
    select 1
    from pg_class relation
    where relation.oid = 'powerbi_hr.employee_directory'::regclass
      and relation.reloptions @> array['security_barrier=true']
  ) then
    raise exception 'Power BI projection is missing its security barrier';
  end if;

  if not exists (
    select 1
    from pg_db_role_setting settings
    cross join lateral unnest(settings.setconfig) as config(value)
    where settings.setrole = (
      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'
    )
      and config.value = 'default_transaction_read_only=on'
  ) then
    raise exception 'Power BI role is not read-only by default';
  end if;
end;
$$;

set local role mam_powerbi_hr_reader;
select count(*) from powerbi_hr.employee_directory;
reset role;

rollback;
