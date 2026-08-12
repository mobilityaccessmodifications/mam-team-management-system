begin;

-- The real MAM/Equipsy roster is deliberately not seeded here. Import names and
-- position titles separately after the production target and source file have
-- been verified.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.internal_org_member_allowlist (
  email text primary key
    check (
      email = lower(btrim(email))
      and char_length(email) between 3 and 254
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    ),
  auth_user_id uuid unique references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= added_at)
);

comment on table private.internal_org_member_allowlist is
  'Bootstrap directory membership. Add entries out of band after verifying the target; never seed staff emails in source control.';

alter table private.internal_org_member_allowlist enable row level security;
revoke all on table private.internal_org_member_allowlist from public, anon, authenticated;

create index internal_org_member_allowlist_added_by_idx
  on private.internal_org_member_allowlist (added_by)
  where added_by is not null;

create table private.internal_org_domain_allowlist (
  domain text primary key
    check (
      domain = lower(btrim(domain))
      and domain !~ '[@[:space:]]'
      and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'
    ),
  added_at timestamptz not null default now(),
  added_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= added_at)
);

comment on table private.internal_org_domain_allowlist is
  'Confirmed corporate email domains authorized to read the internal directory. Populate only after production target verification.';

alter table private.internal_org_domain_allowlist enable row level security;
revoke all on table private.internal_org_domain_allowlist from public, anon, authenticated;

create index internal_org_domain_allowlist_added_by_idx
  on private.internal_org_domain_allowlist (added_by)
  where added_by is not null;

create table private.internal_org_hr_allowlist (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= added_at)
);

comment on table private.internal_org_hr_allowlist is
  'Explicit HR editor authorization by confirmed auth user ID. Never seed staff identities in source control.';

alter table private.internal_org_hr_allowlist enable row level security;
revoke all on table private.internal_org_hr_allowlist from public, anon, authenticated;

create index internal_org_hr_allowlist_added_by_idx
  on private.internal_org_hr_allowlist (added_by)
  where added_by is not null;

create function private.is_internal_org_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) is false
    and (
      lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'org_role', ''))
        in ('employee', 'manager', 'hr', 'system_admin')
      or exists (
        select 1
        from private.internal_org_member_allowlist membership_rule
        join auth.users member on member.id = (select auth.uid())
        where membership_rule.revoked_at is null
          and member.email_confirmed_at is not null
          and (
            membership_rule.auth_user_id = member.id
            or (
              membership_rule.auth_user_id is null
              and membership_rule.email = lower(coalesce(member.email, ''))
            )
          )
      )
      or exists (
        select 1
        from private.internal_org_domain_allowlist domain_rule
        join auth.users member on member.id = (select auth.uid())
        where domain_rule.revoked_at is null
          and member.email_confirmed_at is not null
          and domain_rule.domain = lower(split_part(coalesce(member.email, ''), '@', 2))
      )
    );
$$;

comment on function private.is_internal_org_member() is
  'Authorizes directory reads from controlled app_metadata or the private confirmed-user allowlist. Never reads user_metadata.';

create function private.is_internal_org_hr()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and (
      lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'org_role', ''))
        in ('hr', 'system_admin')
      or exists (
        select 1
        from private.internal_org_hr_allowlist hr_rule
        join auth.users member on member.id = (select auth.uid())
        where hr_rule.revoked_at is null
          and member.email_confirmed_at is not null
          and hr_rule.auth_user_id = member.id
      )
    );
$$;

comment on function private.is_internal_org_hr() is
  'Authorizes org editing from controlled app_metadata or the private bootstrap allowlist. Never reads user_metadata.';

create function public.can_edit_internal_org()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_internal_org_hr();
$$;

comment on function public.can_edit_internal_org() is
  'Returns whether the current authenticated user may use the internal org editor.';

create table public.internal_org_people (
  id uuid primary key default gen_random_uuid(),
  node_kind text not null default 'person'
    check (node_kind in ('person', 'vacancy', 'org_unit')),
  company_key text not null
    check (company_key in ('mam', 'equipsy')),
  full_name text
    check (
      full_name is null
      or (
        full_name = btrim(full_name)
        and char_length(full_name) between 1 and 120
      )
    ),
  position_title text not null
    check (
      position_title = btrim(position_title)
      and char_length(position_title) between 1 and 120
    ),
  auth_user_id uuid references auth.users (id) on delete set null,
  parent_id uuid references public.internal_org_people (id) on delete restrict,
  started_date date,
  sort_order integer not null default 0
    check (sort_order between 0 and 32767),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  version bigint not null default 1 check (version > 0),
  check (parent_id is null or parent_id <> id),
  check (
    (node_kind = 'person' and full_name is not null)
    or (node_kind in ('vacancy', 'org_unit') and full_name is null)
  ),
  check (node_kind = 'person' or auth_user_id is null),
  check (node_kind = 'person' or started_date is null)
);

comment on table public.internal_org_people is
  'Authenticated internal directory and editable MAM/Equipsy org tree. Contains real roster data and must not be used by the anonymous synthetic leave demo.';
comment on column public.internal_org_people.company_key is
  'Stable application key used to apply the MAM orange or Equipsy blue theme.';
comment on column public.internal_org_people.node_kind is
  'A person profile, a vacant position, or a structural org-unit node.';

create unique index internal_org_people_auth_user_idx
  on public.internal_org_people (auth_user_id)
  where auth_user_id is not null;

create index internal_org_people_parent_sort_idx
  on public.internal_org_people (parent_id, sort_order, position_title);

create index internal_org_people_company_active_idx
  on public.internal_org_people (company_key, is_active, sort_order);

create index internal_org_people_created_by_idx
  on public.internal_org_people (created_by)
  where created_by is not null;

create index internal_org_people_updated_by_idx
  on public.internal_org_people (updated_by)
  where updated_by is not null;

create function private.validate_internal_org_people_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_is_active boolean;
begin
  if tg_op = 'UPDATE' and old.is_active and not new.is_active and exists (
    select 1
    from public.internal_org_people child
    where child.parent_id = new.id
      and child.is_active
  ) then
    raise exception 'Move or archive active direct reports before archiving this node.';
  end if;

  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'An org node cannot report to itself.';
  end if;

  select parent.is_active
  into v_parent_is_active
  from public.internal_org_people parent
  where parent.id = new.parent_id;

  if not found then
    raise exception 'The selected parent org node does not exist.';
  end if;

  if new.is_active and not v_parent_is_active then
    raise exception 'An active org node cannot report to an archived node.';
  end if;

  if exists (
    with recursive ancestors as (
      select parent.id, parent.parent_id
      from public.internal_org_people parent
      where parent.id = new.parent_id

      union

      select parent.id, parent.parent_id
      from public.internal_org_people parent
      join ancestors child on child.parent_id = parent.id
    )
    select 1
    from ancestors
    where ancestors.id = new.id
  ) then
    raise exception 'This reporting link would create a cycle.';
  end if;

  return new;
end;
$$;

create function private.set_internal_org_people_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  new.updated_by = coalesce((select auth.uid()), new.updated_by, old.updated_by);
  new.version = old.version + 1;
  return new;
end;
$$;

create trigger internal_org_people_validate_parent
before insert or update of parent_id, is_active
on public.internal_org_people
for each row execute function private.validate_internal_org_people_parent();

create trigger internal_org_people_set_updated_at
before update on public.internal_org_people
for each row execute function private.set_internal_org_people_updated_at();

create function public.create_internal_org_node(
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0,
  p_auth_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.internal_org_people;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can edit the organisation tree.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  insert into public.internal_org_people (
    company_key,
    node_kind,
    position_title,
    full_name,
    parent_id,
    started_date,
    sort_order,
    auth_user_id,
    created_by,
    updated_by
  )
  values (
    lower(btrim(p_company_key)),
    lower(btrim(p_node_kind)),
    btrim(p_position_title),
    case
      when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '')
      else null
    end,
    p_parent_id,
    case when lower(btrim(p_node_kind)) = 'person' then p_started_date else null end,
    p_sort_order,
    case when lower(btrim(p_node_kind)) = 'person' then p_auth_user_id else null end,
    (select auth.uid()),
    (select auth.uid())
  )
  returning * into v_node;

  return v_node.id;
end;
$$;

create function public.update_internal_org_node(
  p_node_id uuid,
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0,
  p_auth_user_id uuid default null,
  p_is_active boolean default true,
  p_expected_version bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.internal_org_people;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can edit the organisation tree.'
      using errcode = '42501';
  end if;

  if p_expected_version is null then
    raise exception 'The expected org node version is required.'
      using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  if p_is_active is false and exists (
    select 1
    from public.internal_org_people child
    where child.parent_id = p_node_id
      and child.is_active
  ) then
    raise exception 'Move or archive active direct reports before archiving this node.';
  end if;

  update public.internal_org_people node
  set company_key = lower(btrim(p_company_key)),
      node_kind = lower(btrim(p_node_kind)),
      position_title = btrim(p_position_title),
      full_name = case
        when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '')
        else null
      end,
      parent_id = p_parent_id,
      started_date = case
        when lower(btrim(p_node_kind)) = 'person' then p_started_date
        else null
      end,
      sort_order = p_sort_order,
      auth_user_id = case
        when lower(btrim(p_node_kind)) = 'person' then p_auth_user_id
        else null
      end,
      is_active = p_is_active,
      updated_by = (select auth.uid())
  where node.id = p_node_id
    and node.version = p_expected_version
  returning * into v_node;

  if not found then
    if exists (
      select 1
      from public.internal_org_people node
      where node.id = p_node_id
    ) then
      raise exception 'This org node changed since it was opened. Refresh and try again.'
        using errcode = '40001';
    end if;

    raise exception 'The org node does not exist.';
  end if;

  return v_node.id;
end;
$$;

alter table public.internal_org_people enable row level security;
alter table public.internal_org_people force row level security;

create policy internal_org_people_select_member
  on public.internal_org_people for select
  to authenticated
  using (is_active and (select private.is_internal_org_member()));

-- These policies provide a second authorization boundary. Table DML is still
-- withheld from authenticated clients, so writes can only use the narrow RPCs.
revoke all on table public.internal_org_people from public, anon, authenticated;
grant select (
  id,
  node_kind,
  company_key,
  full_name,
  position_title,
  parent_id,
  sort_order,
  is_active,
  updated_at,
  version
) on table public.internal_org_people to authenticated;

revoke all on function private.is_internal_org_member() from public, anon, authenticated;
revoke all on function private.is_internal_org_hr() from public, anon, authenticated;
revoke all on function private.validate_internal_org_people_parent() from public, anon, authenticated;
revoke all on function private.set_internal_org_people_updated_at() from public, anon, authenticated;
revoke all on function public.can_edit_internal_org() from public, anon, authenticated;
revoke all on function public.create_internal_org_node(text, text, text, text, uuid, date, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, uuid, boolean, bigint)
  from public, anon, authenticated;

grant execute on function public.can_edit_internal_org() to authenticated;
grant execute on function public.create_internal_org_node(text, text, text, text, uuid, date, integer, uuid)
  to authenticated;
grant execute on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, uuid, boolean, bigint)
  to authenticated;

grant usage on schema private to authenticated;
grant execute on function private.is_internal_org_member() to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'internal_org_people'
  ) then
    alter publication supabase_realtime add table public.internal_org_people;
  end if;
end;
$$;

commit;
