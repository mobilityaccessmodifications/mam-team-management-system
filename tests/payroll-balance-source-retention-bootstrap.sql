create schema auth;
create schema private;
create schema storage;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$$;

create table auth.users (
  id uuid primary key
);

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  name text not null,
  metadata jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (bucket_id, name)
);

create table private.payroll_balance_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_files jsonb not null,
  uploaded_by uuid not null references auth.users (id)
);

create function private.has_payroll_balance_import_access_for(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor is not null and exists (
    select 1 from auth.users actor where actor.id = p_actor
  );
$$;

revoke all on function private.has_payroll_balance_import_access_for(uuid)
  from public, anon, authenticated, service_role;
