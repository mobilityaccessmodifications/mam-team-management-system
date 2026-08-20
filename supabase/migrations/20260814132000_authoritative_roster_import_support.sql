begin;

-- The roster workbook is handled outside source control. These private audit
-- tables intentionally record only run metadata, opaque row digests and
-- database identifiers; they never retain a staff member's source values.
create table private.employee_roster_import_runs (
  id uuid primary key default gen_random_uuid(),
  workbook_sha256 text not null
    check (
      workbook_sha256 = lower(btrim(workbook_sha256))
      and workbook_sha256 ~ '^[0-9a-f]{64}$'
    ),
  source_row_count integer not null check (source_row_count >= 0),
  status text not null default 'prepared'
    check (status in ('prepared', 'applying', 'applied', 'failed', 'superseded')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  completed_by uuid references auth.users (id) on delete set null,
  created_person_count integer not null default 0 check (created_person_count >= 0),
  updated_person_count integer not null default 0 check (updated_person_count >= 0),
  unchanged_person_count integer not null default 0 check (unchanged_person_count >= 0),
  archived_person_count integer not null default 0 check (archived_person_count >= 0),
  preserved_account_count integer not null default 0 check (preserved_account_count >= 0),
  failure_class text
    check (failure_class is null or failure_class in ('validation', 'conflict', 'execution')),
  check (
    (status in ('prepared', 'applying') and completed_at is null and completed_by is null)
    or (status in ('applied', 'failed', 'superseded') and completed_at is not null)
  ),
  check (status <> 'failed' or failure_class is not null),
  check (status = 'failed' or failure_class is null)
);

comment on table private.employee_roster_import_runs is
  'Private, value-free audit ledger for an authoritative employee roster import. The workbook itself and staff values must never be committed or stored in migration source.';
comment on column private.employee_roster_import_runs.workbook_sha256 is
  'SHA-256 digest of the exact workbook bytes, without a filename or workbook contents.';

alter table private.employee_roster_import_runs enable row level security;
revoke all on table private.employee_roster_import_runs from public, anon, authenticated;

create index employee_roster_import_runs_created_at_idx
  on private.employee_roster_import_runs (created_at desc);

-- An external manager is represented in the public tree by an org-unit root,
-- never by a fabricated employee account. The private registry preserves the
-- original workbook Manager label for HR-only profiles and exports.
create table private.employee_roster_external_manager_roots (
  org_unit_id uuid primary key references public.internal_org_people (id) on delete restrict,
  company_key text not null check (company_key in ('mam', 'equipsy')),
  manager_label text not null
    check (
      manager_label = btrim(manager_label)
      and char_length(manager_label) between 1 and 120
    ),
  manager_label_key text generated always as (lower(btrim(manager_label))) stored,
  registered_run_id uuid not null references private.employee_roster_import_runs (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  unique (company_key, manager_label_key)
);

comment on table private.employee_roster_external_manager_roots is
  'Private registry that maps a structural, root-level org-unit node to the original external Manager label from an authoritative roster import.';
comment on column private.employee_roster_external_manager_roots.manager_label is
  'The HR-only Manager cell label for a manager outside the employee roster. It is not a portal account or a public person profile.';

alter table private.employee_roster_external_manager_roots enable row level security;
revoke all on table private.employee_roster_external_manager_roots from public, anon, authenticated;

create function private.validate_employee_roster_external_manager_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.internal_org_people%rowtype;
begin
  select node.*
  into v_node
  from public.internal_org_people node
  where node.id = new.org_unit_id
  for key share;

  if not found
    or v_node.node_kind <> 'org_unit'
    or v_node.parent_id is not null
    or v_node.company_key <> new.company_key then
    raise exception 'An external manager root must reference a root-level org-unit in the same company.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger employee_roster_external_manager_roots_validate
before insert or update of org_unit_id, company_key
on private.employee_roster_external_manager_roots
for each row execute function private.validate_employee_roster_external_manager_root();

-- Once an org-unit is registered as an external manager root, keeping it a
-- root-level org-unit in that company is necessary for the label fallback to
-- remain unambiguous. It may still be archived once it has no active reports.
create function private.prevent_employee_roster_external_manager_root_drift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.employee_roster_external_manager_roots root
    where root.org_unit_id = old.id
  )
  and (
    new.node_kind <> 'org_unit'
    or new.parent_id is not null
    or new.company_key <> old.company_key
  ) then
    raise exception 'An external manager root must remain a root-level org-unit in its registered company.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger internal_org_people_prevent_external_manager_root_drift
before update of node_kind, parent_id, company_key
on public.internal_org_people
for each row execute function private.prevent_employee_roster_external_manager_root_drift();

-- One private, value-free map row is written for every spreadsheet row that
-- was resolved. An archived historical person has no source row, while a
-- skipped/failed source row intentionally has no target person.
create table private.employee_roster_import_row_map (
  id bigint generated always as identity primary key,
  run_id uuid not null references private.employee_roster_import_runs (id) on delete restrict,
  source_row_number integer check (source_row_number is null or source_row_number > 0),
  source_row_sha256 text
    check (
      source_row_sha256 is null
      or (
        source_row_sha256 = lower(btrim(source_row_sha256))
        and source_row_sha256 ~ '^[0-9a-f]{64}$'
      )
    ),
  person_id uuid references public.internal_org_people (id) on delete restrict,
  auth_user_id uuid references auth.users (id) on delete set null,
  operation text not null
    check (operation in ('created', 'updated', 'unchanged', 'archived', 'skipped', 'failed')),
  manager_source_kind text not null default 'none'
    check (manager_source_kind in ('none', 'internal_person', 'external_org_unit')),
  manager_person_id uuid references public.internal_org_people (id) on delete restrict,
  external_manager_root_id uuid references private.employee_roster_external_manager_roots (org_unit_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (operation = 'archived' and source_row_number is null and source_row_sha256 is null)
    or (operation <> 'archived' and source_row_number is not null and source_row_sha256 is not null)
  ),
  check (
    (operation in ('created', 'updated', 'unchanged', 'archived') and person_id is not null)
    or (operation in ('skipped', 'failed') and person_id is null)
  ),
  check (
    (manager_source_kind = 'none' and manager_person_id is null and external_manager_root_id is null)
    or (manager_source_kind = 'internal_person' and manager_person_id is not null and external_manager_root_id is null)
    or (manager_source_kind = 'external_org_unit' and manager_person_id is null and external_manager_root_id is not null)
  )
);

comment on table private.employee_roster_import_row_map is
  'Private, value-free row-to-record reconciliation log for an authoritative roster import. Row digests are supplied by the importer; no source names, contacts, dates, or raw cells are stored here.';

alter table private.employee_roster_import_row_map enable row level security;
revoke all on table private.employee_roster_import_row_map from public, anon, authenticated;

create unique index employee_roster_import_row_map_run_row_idx
  on private.employee_roster_import_row_map (run_id, source_row_number)
  where source_row_number is not null;

create unique index employee_roster_import_row_map_run_person_idx
  on private.employee_roster_import_row_map (run_id, person_id)
  where person_id is not null;

create index employee_roster_import_row_map_person_idx
  on private.employee_roster_import_row_map (person_id, created_at desc)
  where person_id is not null;

-- Resolve the normal employee manager first. Only when the selected person
-- has no person ancestor do we fall back to the closest registered
-- external-manager org-unit root. An active employee cannot have an inactive
-- ancestor under the existing parent constraint, so this also preserves the
-- active-profile projections. Returning a null manager ID for the fallback
-- preserves the existing HR editor's structural-parent behaviour.
create function private.resolve_internal_org_employee_manager(
  p_person_id uuid
)
returns table (
  manager_id uuid,
  manager_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors as (
    select
      parent.id,
      parent.full_name,
      parent.parent_id,
      parent.node_kind,
      1 as depth
    from public.internal_org_people person
    join public.internal_org_people parent on parent.id = person.parent_id
    where person.id = p_person_id

    union all

    select
      parent.id,
      parent.full_name,
      parent.parent_id,
      parent.node_kind,
      ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on parent.id = ancestors.parent_id
  )
  select
    (
      select ancestor.id
      from ancestors ancestor
      where ancestor.node_kind = 'person'
      order by ancestor.depth
      limit 1
    ) as manager_id,
    coalesce(
      (
        select ancestor.full_name
        from ancestors ancestor
        where ancestor.node_kind = 'person'
        order by ancestor.depth
        limit 1
      ),
      (
        select root.manager_label
        from ancestors ancestor
        join private.employee_roster_external_manager_roots root
          on root.org_unit_id = ancestor.id
        where ancestor.node_kind = 'org_unit'
        order by ancestor.depth
        limit 1
      )
    ) as manager_name;
$$;

comment on function private.resolve_internal_org_employee_manager(uuid) is
  'Returns the nearest person manager, or the HR-only original Manager label for the closest registered external org-unit root. A fallback label intentionally has no person ID.';

-- Keep the existing public function signature, grants, SECURITY DEFINER and
-- empty search path unchanged. The resolver affects only the manager columns;
-- all other private-directory access controls remain exactly as before.
create or replace function public.list_employee_directory_records()
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  company_key text,
  is_active boolean,
  first_name text,
  last_name text,
  full_name text,
  position_title text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  country text,
  date_of_birth date,
  started_date date,
  scheduled_employment_end_date date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can access employee directory records.'
      using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    person.company_key,
    person.is_active,
    detail.first_name,
    detail.last_name,
    person.full_name,
    person.position_title,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.country,
    detail.date_of_birth,
    person.started_date,
    detail.scheduled_employment_end_date
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_directory_records() is
  'Returns active HR-only employee directory records. Manager labels resolve to the nearest employee manager, or preserve a registered external roster Manager label without exposing a fabricated person.';

create or replace function public.get_my_employee_profile()
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  has_detail boolean,
  full_name text,
  position_title text,
  company_key text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  date_of_birth date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid := private.current_active_portal_employee_id();
begin
  if v_person_id is null then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    detail.person_id is not null,
    person.full_name,
    person.position_title,
    person.company_key,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.date_of_birth
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.id = v_person_id
    and person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
    and private.is_active_portal_account()
    and private.is_internal_org_member();
end;
$$;

comment on function public.get_my_employee_profile() is
  'Returns only the current active portal account''s safe work identity plus own phone, personal email, date of birth, and read-only work email. The manager label may be a registered external roster manager, but no external private profile is exposed.';

create or replace function public.get_selected_employee_profile_for_hr(
  p_person_id uuid
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  has_detail boolean,
  full_name text,
  position_title text,
  company_key text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  date_of_birth date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can access selected employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'Choose an employee profile.' using errcode = '22004';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    detail.person_id is not null,
    person.full_name,
    person.position_title,
    person.company_key,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.date_of_birth
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;
end;
$$;

comment on function public.get_selected_employee_profile_for_hr(uuid) is
  'Returns one selected active employee''s profile to an actual HR user only. Its manager label may fall back to a registered external roster manager; other private details stay confined to HR.';

revoke all on function private.validate_employee_roster_external_manager_root()
  from public, anon, authenticated;
revoke all on function private.prevent_employee_roster_external_manager_root_drift()
  from public, anon, authenticated;
revoke all on function private.resolve_internal_org_employee_manager(uuid)
  from public, anon, authenticated;

commit;
