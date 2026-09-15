begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:payroll-balance-self-service-import:20260915', 0)
  );

  if to_regclass('private.payroll_balance_imports') is null
    or to_regclass('private.employee_annual_leave_balances') is null
    or to_regclass('private.employee_sick_leave_balances') is null
    or to_regclass('private.annual_leave_balance_history') is null
    or to_regclass('private.sick_leave_balance_history') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or (
      select count(*)
      from pg_catalog.pg_attribute attribute
      where (
        (attribute.attrelid = to_regclass('private.employee_annual_leave_balances') and attribute.attname = 'updated_by')
        or (attribute.attrelid = to_regclass('private.employee_sick_leave_balances') and attribute.attname = 'updated_by')
        or (attribute.attrelid = to_regclass('private.annual_leave_balance_history') and attribute.attname = 'actor_user_id')
        or (attribute.attrelid = to_regclass('private.sick_leave_balance_history') and attribute.attname = 'actor_user_id')
      )
        and attribute.attnum > 0
        and not attribute.attisdropped
        and not attribute.attnotnull
    ) <> 4
    or (
      select count(*)
      from pg_catalog.pg_constraint constraint_row
      where (
        (constraint_row.conrelid = to_regclass('private.employee_annual_leave_balances') and constraint_row.conname = 'annual_balance_actor_or_import')
        or (constraint_row.conrelid = to_regclass('private.employee_sick_leave_balances') and constraint_row.conname = 'sick_balance_actor_or_import')
        or (constraint_row.conrelid = to_regclass('private.annual_leave_balance_history') and constraint_row.conname = 'annual_history_actor_or_import')
        or (constraint_row.conrelid = to_regclass('private.sick_leave_balance_history') and constraint_row.conname = 'sick_history_actor_or_import')
      )
        and constraint_row.convalidated
    ) <> 4 then
    raise exception 'Payroll balance import prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create table private.payroll_balance_import_grants (
  person_id uuid primary key references public.internal_org_people (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.payroll_balance_import_grants is
  'Explicit active-employee grants for payroll leave-balance imports. System Admin access remains role-derived.';

create table private.payroll_balance_import_grant_events (
  id bigint generated always as identity primary key,
  person_id uuid not null references public.internal_org_people (id) on delete restrict,
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in ('granted', 'revoked')),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.payroll_balance_import_grant_events is
  'Append-only payroll importer access audit. It contains identities and event metadata, never payroll values.';

create table private.payroll_balance_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  source_files jsonb not null check (jsonb_typeof(source_files) = 'array'),
  uploaded_by uuid not null references auth.users (id) on delete restrict,
  batch_status text not null default 'staged' check (batch_status in ('staged', 'committed')),
  row_count integer not null check (row_count between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  committed_at timestamptz,
  version bigint not null default 1 check (version > 0),
  check ((batch_status = 'committed') = (committed_at is not null))
);

comment on table private.payroll_balance_import_batches is
  'Server-parsed payroll upload batches. Raw file bytes are never retained; only bounded source metadata and reconciled rows persist.';

create table private.payroll_balance_import_stage_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references private.payroll_balance_import_batches (id) on delete cascade,
  company_key text not null check (company_key in ('mam', 'equipsy')),
  employee_name text not null check (char_length(employee_name) between 1 and 200),
  normalised_employee_name text not null check (char_length(normalised_employee_name) between 1 and 200),
  annual_hours numeric(12,4) check (annual_hours between -10000 and 100000),
  sick_hours numeric(12,4) check (sick_hours between -10000 and 100000),
  as_of date not null,
  source_file text not null check (char_length(source_file) between 1 and 800),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  person_id uuid references public.internal_org_people (id) on delete set null,
  match_status text not null default 'unmatched' check (
    match_status in ('linked', 'inactive', 'unmatched', 'company_mismatch', 'ambiguous')
  ),
  check (annual_hours is not null or sick_hours is not null),
  check ((match_status in ('linked', 'inactive')) = (person_id is not null)),
  unique (batch_id, company_key, normalised_employee_name, as_of)
);

comment on table private.payroll_balance_import_stage_rows is
  'Private staged balance rows reconciled by exact punctuation-insensitive name within the supplied company. Ambiguous rows never update a balance.';

alter table private.payroll_balance_import_grants enable row level security;
alter table private.payroll_balance_import_grant_events enable row level security;
alter table private.payroll_balance_import_batches enable row level security;
alter table private.payroll_balance_import_stage_rows enable row level security;

revoke all on table private.payroll_balance_import_grants from public, anon, authenticated, service_role;
revoke all on table private.payroll_balance_import_grant_events from public, anon, authenticated, service_role;
revoke all on table private.payroll_balance_import_batches from public, anon, authenticated, service_role;
revoke all on table private.payroll_balance_import_stage_rows from public, anon, authenticated, service_role;
revoke all on sequence private.payroll_balance_import_grant_events_id_seq from public, anon, authenticated, service_role;
revoke all on sequence private.payroll_balance_import_stage_rows_id_seq from public, anon, authenticated, service_role;

alter table private.payroll_balance_imports
  alter column annual_hours drop not null,
  alter column sick_hours drop not null,
  add column batch_id uuid references private.payroll_balance_import_batches (id) on delete set null;

do $$
declare
  duplicate_constraint name;
begin
  for duplicate_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'private.payroll_balance_imports'::regclass
      and constraint_row.contype = 'u'
      and (
        select array_agg(attribute_row.attname order by key_row.ordinality)
        from unnest(constraint_row.conkey) with ordinality as key_row(attnum, ordinality)
        join pg_catalog.pg_attribute attribute_row
          on attribute_row.attrelid = constraint_row.conrelid
          and attribute_row.attnum = key_row.attnum
      ) = array['source_sha256', 'company_key', 'employee_name', 'as_of']::name[]
  loop
    execute format(
      'alter table private.payroll_balance_imports drop constraint %I',
      duplicate_constraint
    );
  end loop;
end;
$$;

alter table private.payroll_balance_imports
  drop constraint if exists payroll_balance_imports_match_status_check;
alter table private.payroll_balance_imports
  add constraint payroll_balance_imports_match_status_check check (
    match_status in ('linked', 'inactive', 'unmatched', 'company_mismatch', 'ambiguous')
  ),
  add constraint payroll_balance_import_has_hours check (
    annual_hours is not null or sick_hours is not null
  ),
  add constraint payroll_balance_imports_batch_source_row_unique unique (
    batch_id,
    source_sha256,
    company_key,
    employee_name,
    as_of
  );

create index payroll_balance_import_batches_recent_idx
  on private.payroll_balance_import_batches (created_at desc, id);
create unique index payroll_balance_import_batches_open_digest_idx
  on private.payroll_balance_import_batches (uploaded_by, source_digest)
  where batch_status = 'staged';
create index payroll_balance_import_stage_rows_batch_idx
  on private.payroll_balance_import_stage_rows (batch_id, match_status, company_key, normalised_employee_name);
create index payroll_balance_imports_company_snapshot_idx
  on private.payroll_balance_imports (company_key, as_of desc)
  where match_status = 'linked';

create function private.normalise_payroll_employee_name(p_name text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select regexp_replace(
    lower(normalize(coalesce(p_name, ''), NFKD)),
    '[^[:alnum:]]',
    '',
    'g'
  );
$$;

create function private.has_payroll_balance_import_access_for(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor is not null
    and private.is_active_portal_account(p_actor)
    and (
      exists (
        select 1
        from public.profiles profile
        where profile.id = p_actor
          and profile.app_role = 'system_admin'
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
      or exists (
        select 1
        from private.payroll_balance_import_grants access_grant
        join public.internal_org_people person on person.id = access_grant.person_id
        where person.auth_user_id = p_actor
          and person.node_kind = 'person'
          and person.is_active
      )
    );
$$;

create function private.has_payroll_balance_import_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_payroll_balance_import_access_for((select auth.uid()));
$$;

create function public.can_import_payroll_balances()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_payroll_balance_import_access();
$$;

create function public.can_manage_payroll_balance_import_grants()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_import_payroll_balances() is
  'True only for a current System Admin or an explicitly granted active linked employee.';

create function private.reconcile_payroll_balance_import_batch(p_batch_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  with matches as (
    select
      stage.id,
      count(person.id) filter (where person.company_key = stage.company_key and person.is_active) as active_count,
      count(person.id) filter (where person.company_key = stage.company_key and not person.is_active) as inactive_count,
      count(person.id) as any_count,
      count(person.id) filter (where person.company_key = stage.company_key) as same_company_count,
      (array_agg(person.id order by person.id) filter (where person.company_key = stage.company_key and person.is_active))[1] as active_id,
      (array_agg(person.id order by person.id) filter (where person.company_key = stage.company_key and not person.is_active))[1] as inactive_id
    from private.payroll_balance_import_stage_rows stage
    left join (
      public.internal_org_people person
      left join private.employee_directory_details detail on detail.person_id = person.id
    ) on person.node_kind = 'person'
      and stage.normalised_employee_name in (
        private.normalise_payroll_employee_name(person.full_name),
        private.normalise_payroll_employee_name(coalesce(detail.first_name, '') || ' ' || coalesce(detail.last_name, ''))
      )
    where stage.batch_id = p_batch_id
    group by stage.id
  )
  update private.payroll_balance_import_stage_rows stage
  set
    person_id = case
      when matches.active_count = 1 then matches.active_id
      when matches.active_count = 0 and matches.inactive_count = 1 then matches.inactive_id
      else null
    end,
    match_status = case
      when matches.active_count = 1 then 'linked'
      when matches.active_count > 1 or (matches.active_count = 0 and matches.inactive_count > 1) then 'ambiguous'
      when matches.active_count = 0 and matches.inactive_count = 1 then 'inactive'
      when matches.any_count > 0 and matches.same_company_count = 0 then 'company_mismatch'
      else 'unmatched'
    end
  from matches
  where stage.id = matches.id;

  with duplicate_snapshots as (
    select person_id, as_of
    from private.payroll_balance_import_stage_rows
    where batch_id = p_batch_id
      and match_status = 'linked'
      and person_id is not null
    group by person_id, as_of
    having count(*) > 1
  )
  update private.payroll_balance_import_stage_rows stage
  set person_id = null,
      match_status = 'ambiguous'
  where stage.batch_id = p_batch_id
    and exists (
      select 1
      from duplicate_snapshots duplicate
      where duplicate.person_id = stage.person_id
        and duplicate.as_of = stage.as_of
    );
end;
$$;

create function private.payroll_balance_import_batch_projection(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'batchId', batch.id,
    'version', batch.version,
    'status', batch.batch_status,
    'files', batch.source_files,
    'createdAt', batch.created_at,
    'committedAt', batch.committed_at,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rowId', stage.id,
        'employeeName', stage.employee_name,
        'company', stage.company_key,
        'annualHours', stage.annual_hours,
        'sickHours', stage.sick_hours,
        'asOf', stage.as_of,
        'status', stage.match_status,
        'linkedName', person.full_name,
        'willApplyAnnual', stage.match_status = 'linked'
          and stage.annual_hours is not null
          and not exists (
            select 1
            from private.payroll_balance_import_stage_rows newer
            where newer.batch_id = stage.batch_id
              and newer.person_id = stage.person_id
              and newer.match_status = 'linked'
              and newer.annual_hours is not null
              and newer.as_of > stage.as_of
          )
          and (
            annual_balance.person_id is null
            or annual_balance.as_of < stage.as_of
            or (
              annual_balance.as_of = stage.as_of
              and (
                annual_balance.hours is distinct from stage.annual_hours
                or annual_balance.is_example
              )
            )
          ),
        'willApplySick', stage.match_status = 'linked'
          and stage.sick_hours is not null
          and not exists (
            select 1
            from private.payroll_balance_import_stage_rows newer
            where newer.batch_id = stage.batch_id
              and newer.person_id = stage.person_id
              and newer.match_status = 'linked'
              and newer.sick_hours is not null
              and newer.as_of > stage.as_of
          )
          and (
            sick_balance.person_id is null
            or sick_balance.as_of < stage.as_of
            or (
              sick_balance.as_of = stage.as_of
              and sick_balance.hours is distinct from stage.sick_hours
            )
          )
      ) order by stage.company_key, lower(stage.employee_name), stage.id)
      from private.payroll_balance_import_stage_rows stage
      left join public.internal_org_people person on person.id = stage.person_id
      left join private.employee_annual_leave_balances annual_balance on annual_balance.person_id = stage.person_id
      left join private.employee_sick_leave_balances sick_balance on sick_balance.person_id = stage.person_id
      where stage.batch_id = batch.id
    ), '[]'::jsonb)
  )
  from private.payroll_balance_import_batches batch
  where batch.id = p_batch_id;
$$;

create function public.stage_payroll_balance_import(
  p_actor_user_id uuid,
  p_source_digest text,
  p_files jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := p_actor_user_id;
  batch private.payroll_balance_import_batches%rowtype;
begin
  if actor is null or not private.has_payroll_balance_import_access_for(actor) then
    raise exception 'You do not have permission to import payroll balances.' using errcode = '42501';
  end if;
  if p_source_digest is null or p_source_digest !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_files) <> 'array'
    or jsonb_array_length(p_files) not between 1 and 4
    or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'The payroll balance upload is invalid.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_files) as source(
      name text,
      sha256 text,
      "sizeBytes" integer,
      companies jsonb,
      "asOfDates" jsonb,
      "employeeRows" integer
    )
    where source.name is null
      or char_length(source.name) not between 1 and 180
      or source.name !~* '\.(csv|xlsx)$'
      or source.name ~ '[[:cntrl:]/\\]'
      or source.sha256 !~ '^[0-9a-f]{64}$'
      or source."sizeBytes" not between 1 and 500000
      or source."employeeRows" not between 1 and 1000
      or jsonb_typeof(source.companies) is distinct from 'array'
      or jsonb_array_length(source.companies) not between 1 and 2
      or exists (
        select 1
        from jsonb_array_elements_text(source.companies) as company(value)
        where company.value not in ('mam', 'equipsy')
      )
      or jsonb_typeof(source."asOfDates") is distinct from 'array'
      or jsonb_array_length(source."asOfDates") not between 1 and 12
      or exists (
        select 1
        from jsonb_array_elements_text(source."asOfDates") as snapshot(value)
        where snapshot.value !~ '^\d{4}-\d{2}-\d{2}$'
          or snapshot.value::date > (clock_timestamp() at time zone 'Australia/Melbourne')::date
      )
  ) then
    raise exception 'The payroll source file metadata is invalid.' using errcode = '22023';
  end if;
  if (
    select coalesce(sum(source."sizeBytes"), 0) > 900000
      or count(*) <> count(distinct source.name)
      or count(*) <> count(distinct source.sha256)
    from jsonb_to_recordset(p_files) as source(name text, sha256 text, "sizeBytes" integer)
  ) then
    raise exception 'The payroll source file set is invalid.' using errcode = '22023';
  end if;

  insert into private.payroll_balance_import_batches (
    source_digest,
    source_files,
    uploaded_by,
    row_count
  )
  values (
    p_source_digest,
    p_files,
    actor,
    jsonb_array_length(p_rows)
  )
  on conflict (uploaded_by, source_digest) where batch_status = 'staged' do nothing
  returning * into batch;

  if not found then
    select existing.* into batch
    from private.payroll_balance_import_batches existing
    where existing.source_digest = p_source_digest
      and existing.uploaded_by = actor
      and existing.batch_status = 'staged';
    if not found then
      raise exception 'The payroll balance upload could not be staged.' using errcode = '40001';
    end if;
    return private.payroll_balance_import_batch_projection(batch.id);
  end if;

  insert into private.payroll_balance_import_stage_rows (
    batch_id,
    company_key,
    employee_name,
    normalised_employee_name,
    annual_hours,
    sick_hours,
    as_of,
    source_file,
    source_sha256
  )
  select
    batch.id,
    source."companyKey",
    btrim(source."employeeName"),
    private.normalise_payroll_employee_name(source."employeeName"),
    source."annualHours",
    source."sickHours",
    source."asOf",
    source."sourceFile",
    source."sourceSha256"
  from jsonb_to_recordset(p_rows) as source(
    "companyKey" text,
    "employeeName" text,
    "annualHours" numeric,
    "sickHours" numeric,
    "asOf" date,
    "sourceFile" text,
    "sourceSha256" text
  )
  where source."companyKey" in ('mam', 'equipsy')
    and char_length(btrim(coalesce(source."employeeName", ''))) between 1 and 200
    and char_length(private.normalise_payroll_employee_name(source."employeeName")) between 1 and 200
    and (source."annualHours" is not null or source."sickHours" is not null)
    and (source."annualHours" is null or source."annualHours" between -10000 and 100000)
    and (source."sickHours" is null or source."sickHours" between -10000 and 100000)
    and source."asOf" is not null
    and source."asOf" <= (clock_timestamp() at time zone 'Australia/Melbourne')::date
    and char_length(coalesce(source."sourceFile", '')) between 1 and 800
    and source."sourceSha256" ~ '^[0-9a-f]{64}$';

  if (select count(*) from private.payroll_balance_import_stage_rows where batch_id = batch.id) <> batch.row_count then
    raise exception 'One or more payroll balance rows are invalid.' using errcode = '22023';
  end if;

  perform private.reconcile_payroll_balance_import_batch(batch.id);
  return private.payroll_balance_import_batch_projection(batch.id);
end;
$$;

create function public.get_payroll_balance_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  batch private.payroll_balance_import_batches%rowtype;
begin
  if not private.has_payroll_balance_import_access() or p_batch_id is null then
    raise exception 'You do not have permission to view this payroll import.' using errcode = '42501';
  end if;
  select source.* into batch
  from private.payroll_balance_import_batches source
  where source.id = p_batch_id;
  if not found then
    raise exception 'The payroll import is no longer available.' using errcode = 'P0002';
  end if;
  if batch.uploaded_by <> (select auth.uid()) and not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to view this payroll import.' using errcode = '42501';
  end if;
  return private.payroll_balance_import_batch_projection(batch.id);
end;
$$;

create function public.commit_payroll_balance_import(
  p_batch_id uuid,
  p_expected_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  batch private.payroll_balance_import_batches%rowtype;
begin
  if actor is null or not private.has_payroll_balance_import_access() then
    raise exception 'You do not have permission to import payroll balances.' using errcode = '42501';
  end if;
  if p_batch_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The payroll import is invalid.' using errcode = '22023';
  end if;

  select source.* into batch
  from private.payroll_balance_import_batches source
  where source.id = p_batch_id
  for update;
  if not found then
    raise exception 'The payroll import is no longer available.' using errcode = 'P0002';
  end if;
  if batch.uploaded_by <> actor and not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to commit this payroll import.' using errcode = '42501';
  end if;
  if batch.batch_status = 'committed' then
    return private.payroll_balance_import_batch_projection(batch.id);
  end if;
  if batch.version <> p_expected_version then
    raise exception 'This payroll import has changed. Re-open it and try again.' using errcode = '40001';
  end if;

  lock table public.internal_org_people, private.employee_directory_details in share mode;
  perform private.reconcile_payroll_balance_import_batch(batch.id);

  insert into private.payroll_balance_imports (
    company_key,
    employee_name,
    annual_hours,
    sick_hours,
    as_of,
    source_file,
    source_sha256,
    person_id,
    match_status,
    batch_id
  )
  select
    stage.company_key,
    stage.employee_name,
    stage.annual_hours,
    stage.sick_hours,
    stage.as_of,
    stage.source_file,
    stage.source_sha256,
    stage.person_id,
    stage.match_status,
    batch.id
  from private.payroll_balance_import_stage_rows stage
  where stage.batch_id = batch.id;

  -- Migration 20260910015007 makes these audit actors nullable only when a
  -- source_import_id is present. Imported snapshots deliberately use that
  -- immutable source identity instead of presenting the uploader as a manual
  -- balance editor; the prerequisite assertion above verifies this contract.
  insert into private.employee_annual_leave_balances as balance (
    person_id,
    hours,
    as_of,
    is_example,
    updated_by,
    source_import_id
  )
  select distinct on (imported.person_id)
    imported.person_id,
    imported.annual_hours,
    imported.as_of,
    false,
    null,
    imported.id
  from private.payroll_balance_imports imported
  where imported.batch_id = batch.id
    and imported.match_status = 'linked'
    and imported.person_id is not null
    and imported.annual_hours is not null
  order by imported.person_id, imported.as_of desc, imported.id desc
  on conflict (person_id) do update
  set hours = excluded.hours,
      as_of = excluded.as_of,
      is_example = false,
      updated_by = null,
      source_import_id = excluded.source_import_id,
      updated_at = clock_timestamp()
  where balance.as_of < excluded.as_of
    or (
      balance.as_of = excluded.as_of
      and (
        balance.hours is distinct from excluded.hours
        or balance.is_example
      )
    );

  insert into private.employee_sick_leave_balances as balance (
    person_id,
    hours,
    as_of,
    updated_by,
    source_import_id
  )
  select distinct on (imported.person_id)
    imported.person_id,
    imported.sick_hours,
    imported.as_of,
    null,
    imported.id
  from private.payroll_balance_imports imported
  where imported.batch_id = batch.id
    and imported.match_status = 'linked'
    and imported.person_id is not null
    and imported.sick_hours is not null
  order by imported.person_id, imported.as_of desc, imported.id desc
  on conflict (person_id) do update
  set hours = excluded.hours,
      as_of = excluded.as_of,
      updated_by = null,
      source_import_id = excluded.source_import_id,
      updated_at = clock_timestamp()
  where balance.as_of < excluded.as_of
    or (
      balance.as_of = excluded.as_of
      and balance.hours is distinct from excluded.hours
    );

  insert into private.annual_leave_balance_history (
    person_id,
    hours,
    as_of,
    is_example,
    actor_user_id,
    source_import_id
  )
  select balance.person_id, balance.hours, balance.as_of, false, null, balance.source_import_id
  from private.employee_annual_leave_balances balance
  join private.payroll_balance_imports imported on imported.id = balance.source_import_id
  where imported.batch_id = batch.id
    and balance.source_import_id is not null
  on conflict do nothing;

  insert into private.sick_leave_balance_history (
    person_id,
    hours,
    as_of,
    actor_user_id,
    source_import_id
  )
  select balance.person_id, balance.hours, balance.as_of, null, balance.source_import_id
  from private.employee_sick_leave_balances balance
  join private.payroll_balance_imports imported on imported.id = balance.source_import_id
  where imported.batch_id = batch.id
    and balance.source_import_id is not null
  on conflict do nothing;

  update private.payroll_balance_import_batches target
  set batch_status = 'committed',
      committed_at = clock_timestamp(),
      version = target.version + 1
  where target.id = batch.id;

  return private.payroll_balance_import_batch_projection(batch.id);
end;
$$;

create function private.payroll_balance_monthly_reminder_projection()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with local_date as (
    select (clock_timestamp() at time zone 'Australia/Melbourne')::date as today
  ), latest as (
    select
      max(imported.as_of) filter (where imported.company_key = 'mam' and imported.match_status = 'linked') as mam_as_of,
      max(imported.as_of) filter (where imported.company_key = 'equipsy' and imported.match_status = 'linked') as equipsy_as_of
    from private.payroll_balance_imports imported
  )
  select jsonb_build_object(
    'dueOn', date_trunc('month', local_date.today::timestamp)::date,
    'mamAsOf', latest.mam_as_of,
    'equipsyAsOf', latest.equipsy_as_of,
    'mamComplete', latest.mam_as_of >= date_trunc('month', local_date.today::timestamp)::date,
    'equipsyComplete', latest.equipsy_as_of >= date_trunc('month', local_date.today::timestamp)::date,
    'complete', latest.mam_as_of >= date_trunc('month', local_date.today::timestamp)::date
      and latest.equipsy_as_of >= date_trunc('month', local_date.today::timestamp)::date
  )
  from local_date, latest;
$$;

create function public.get_payroll_balance_import_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  if not private.has_payroll_balance_import_access() then
    return jsonb_build_object('canImport', false, 'canManageAccess', false);
  end if;
  return jsonb_build_object(
    'canImport', true,
    'canManageAccess', private.is_system_portal_account_admin(),
    'reminder', private.payroll_balance_monthly_reminder_projection(),
    'recentBatches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'batchId', recent.id,
        'status', recent.batch_status,
        'files', recent.source_files,
        'rowCount', recent.row_count,
        'createdAt', recent.created_at,
        'committedAt', recent.committed_at
      ) order by recent.created_at desc, recent.id)
      from (
        select batch.*
        from private.payroll_balance_import_batches batch
        where batch.uploaded_by = (select auth.uid())
          or private.is_system_portal_account_admin()
        order by batch.created_at desc, batch.id
        limit 6
      ) recent
    ), '[]'::jsonb)
  );
end;
$$;

create function public.list_payroll_balance_reminder_calendar_entries()
returns table (
  reminder_id text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reminder jsonb;
begin
  if not private.has_payroll_balance_import_access() then
    return;
  end if;
  reminder := private.payroll_balance_monthly_reminder_projection();
  if coalesce((reminder->>'complete')::boolean, false) then
    return;
  end if;
  return query
  select
    'payroll-balance:' || (reminder->>'dueOn'),
    (reminder->>'dueOn')::date,
    'due'::text;
end;
$$;

create function public.list_payroll_balance_import_grant_candidates()
returns table (
  person_id uuid,
  full_name text,
  position_title text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can manage payroll import access.' using errcode = '42501';
  end if;
  return query
  select person.id, person.full_name, person.position_title
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.node_kind = 'person'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null
  order by lower(person.full_name), person.id;
end;
$$;

create function public.list_payroll_balance_import_grants()
returns table (
  person_id uuid,
  full_name text,
  position_title text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can manage payroll import access.' using errcode = '42501';
  end if;
  return query
  select person.id, person.full_name, person.position_title
  from private.payroll_balance_import_grants access_grant
  join public.internal_org_people person on person.id = access_grant.person_id
  join public.profiles profile on profile.id = person.auth_user_id
  where person.node_kind = 'person'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null
  order by lower(person.full_name), person.id;
end;
$$;

create function public.replace_payroll_balance_import_grants(p_person_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  selected_ids uuid[] := coalesce(p_person_ids, array[]::uuid[]);
  selected_count integer;
  valid_count integer;
begin
  if actor is null or not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can manage payroll import access.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:payroll-balance-import-grants', 0));
  select count(distinct selected.person_id) into selected_count
  from unnest(selected_ids) as selected(person_id);
  if selected_count <> cardinality(selected_ids) or selected_count > 25 then
    raise exception 'Choose a valid unique payroll importer list.' using errcode = '22023';
  end if;
  select count(*) into valid_count
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = any(selected_ids)
    and person.node_kind = 'person'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null;
  if valid_count <> selected_count then
    raise exception 'Choose active linked employees for payroll import access.' using errcode = '23503';
  end if;

  insert into private.payroll_balance_import_grant_events (person_id, actor_user_id, event_type)
  select existing.person_id, actor, 'revoked'
  from private.payroll_balance_import_grants existing
  where not (existing.person_id = any(selected_ids));

  insert into private.payroll_balance_import_grant_events (person_id, actor_user_id, event_type)
  select selected.person_id, actor, 'granted'
  from unnest(selected_ids) as selected(person_id)
  where not exists (
    select 1 from private.payroll_balance_import_grants existing where existing.person_id = selected.person_id
  );

  delete from private.payroll_balance_import_grants existing
  where not (existing.person_id = any(selected_ids));

  insert into private.payroll_balance_import_grants (person_id, granted_by)
  select selected.person_id, actor
  from unnest(selected_ids) as selected(person_id)
  on conflict (person_id) do nothing;
end;
$$;

comment on function public.stage_payroll_balance_import(uuid, text, jsonb, jsonb) is
  'Service-only ingestion boundary for server-parsed CSV/XLSX leave balances; records the validated actor and reconciles exact same-company employee identities without guessing.';
comment on function public.commit_payroll_balance_import(uuid, bigint) is
  'Rechecks staged identities, preserves every source row, and updates only unambiguous active same-company balances that are not older.';
comment on function public.get_payroll_balance_import_workspace() is
  'Returns the current importer capability, monthly first-day reminder status and bounded batch summaries.';
comment on function public.list_payroll_balance_reminder_calendar_entries() is
  'Returns one current-month first-day reminder to authorised importers until both company snapshots are current.';

revoke all on function private.normalise_payroll_employee_name(text) from public, anon, authenticated, service_role;
revoke all on function private.has_payroll_balance_import_access_for(uuid) from public, anon, authenticated, service_role;
revoke all on function private.has_payroll_balance_import_access() from public, anon, authenticated, service_role;
revoke all on function private.reconcile_payroll_balance_import_batch(uuid) from public, anon, authenticated, service_role;
revoke all on function private.payroll_balance_import_batch_projection(uuid) from public, anon, authenticated, service_role;
revoke all on function private.payroll_balance_monthly_reminder_projection() from public, anon, authenticated, service_role;
revoke all on function public.can_import_payroll_balances() from public, anon, authenticated, service_role;
revoke all on function public.can_manage_payroll_balance_import_grants() from public, anon, authenticated, service_role;
revoke all on function public.stage_payroll_balance_import(uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_payroll_balance_import_batch(uuid) from public, anon, authenticated, service_role;
revoke all on function public.commit_payroll_balance_import(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.get_payroll_balance_import_workspace() from public, anon, authenticated, service_role;
revoke all on function public.list_payroll_balance_reminder_calendar_entries() from public, anon, authenticated, service_role;
revoke all on function public.list_payroll_balance_import_grant_candidates() from public, anon, authenticated, service_role;
revoke all on function public.list_payroll_balance_import_grants() from public, anon, authenticated, service_role;
revoke all on function public.replace_payroll_balance_import_grants(uuid[]) from public, anon, authenticated, service_role;

grant execute on function public.can_import_payroll_balances() to authenticated;
grant execute on function public.can_manage_payroll_balance_import_grants() to authenticated;
grant execute on function public.stage_payroll_balance_import(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.get_payroll_balance_import_batch(uuid) to authenticated;
grant execute on function public.commit_payroll_balance_import(uuid, bigint) to authenticated;
grant execute on function public.get_payroll_balance_import_workspace() to authenticated;
grant execute on function public.list_payroll_balance_reminder_calendar_entries() to authenticated;
grant execute on function public.list_payroll_balance_import_grant_candidates() to authenticated;
grant execute on function public.list_payroll_balance_import_grants() to authenticated;
grant execute on function public.replace_payroll_balance_import_grants(uuid[]) to authenticated;

commit;
