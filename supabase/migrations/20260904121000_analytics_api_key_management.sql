begin;

-- This migration originally shared version 20260904120000 with the employee
-- work-schedule migration. Production already contains these objects while its
-- migration history records only the work-schedule version, so every statement
-- below is safe to replay when this unique version is first recorded.

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:analytics-api-key-management:20260904', 0)
  );

  if to_regprocedure('private.is_system_portal_account_admin()') is null then
    raise exception 'Analytics API key-management prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Only one active dashboard key is permitted. The raw bearer token never
-- reaches this table: the application persists a SHA-256 hash and safe audit
-- metadata only. Direct table access is denied to browser roles.
create table if not exists private.analytics_api_keys (
  id uuid primary key default gen_random_uuid(),
  key_prefix text not null check (key_prefix ~ '^mam_analytics_[A-Za-z0-9_-]{6,24}$'),
  label text not null check (char_length(label) between 1 and 80),
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  last_used_at timestamptz,
  check ((revoked_at is null) = (revoked_by is null))
);

comment on table private.analytics_api_keys is
  'Hashed MAM Analytics API bearer keys and safe lifecycle metadata. Raw tokens are never stored.';

alter table private.analytics_api_keys enable row level security;
revoke all on table private.analytics_api_keys from public, anon, authenticated;

create unique index if not exists analytics_api_keys_one_active_idx
  on private.analytics_api_keys ((true))
  where revoked_at is null;

create index if not exists analytics_api_keys_created_idx
  on private.analytics_api_keys (created_at desc);

create or replace function public.can_manage_analytics_api()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_manage_analytics_api() is
  'Returns true only for the active System Admin that may manage MAM Analytics API keys.';

create or replace function public.list_analytics_api_keys()
returns table (
  id uuid,
  key_prefix text,
  label text,
  created_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage the Analytics API.' using errcode = '42501';
  end if;

  return query
  select key.id, key.key_prefix, key.label, key.created_at, key.revoked_at, key.last_used_at
  from private.analytics_api_keys key
  order by key.created_at desc, key.id desc;
end;
$$;

create or replace function public.create_analytics_api_key_record(
  p_key_hash text,
  p_key_prefix text,
  p_label text
)
returns table (
  id uuid,
  key_prefix text,
  label text,
  created_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_key_hash text := lower(trim(coalesce(p_key_hash, '')));
  v_key_prefix text := trim(coalesce(p_key_prefix, ''));
  v_label text := trim(coalesce(p_label, ''));
begin
  if v_actor_user_id is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage the Analytics API.' using errcode = '42501';
  end if;
  if v_key_hash !~ '^[a-f0-9]{64}$' or v_key_prefix !~ '^mam_analytics_[A-Za-z0-9_-]{6,24}$' then
    raise exception 'The Analytics API key is invalid.' using errcode = '22023';
  end if;
  if char_length(v_label) not between 1 and 80 then
    raise exception 'Enter a label of up to 80 characters.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mam:analytics-api-key-rotation', 0));
  update private.analytics_api_keys as existing_key
  set revoked_at = clock_timestamp(), revoked_by = v_actor_user_id
  where existing_key.revoked_at is null;

  return query
  insert into private.analytics_api_keys (key_hash, key_prefix, label, created_by)
  values (v_key_hash, v_key_prefix, v_label, v_actor_user_id)
  returning analytics_api_keys.id, analytics_api_keys.key_prefix, analytics_api_keys.label,
    analytics_api_keys.created_at, analytics_api_keys.revoked_at, analytics_api_keys.last_used_at;
end;
$$;

create or replace function public.revoke_analytics_api_key(p_key_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if v_actor_user_id is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage the Analytics API.' using errcode = '42501';
  end if;
  if p_key_id is null then
    raise exception 'The Analytics API key is invalid.' using errcode = '22023';
  end if;

  update private.analytics_api_keys
  set revoked_at = clock_timestamp(), revoked_by = v_actor_user_id
  where id = p_key_id and revoked_at is null;

  return found;
end;
$$;

-- Called exclusively by the server-side analytics route using the Supabase
-- secret role. NULL means no managed key has ever existed, so the pre-existing
-- encrypted Vercel environment key remains the safe migration fallback. Once
-- a managed key is created, a later revocation must fail closed.
create or replace function public.validate_analytics_api_key(p_key_hash text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key_id uuid;
begin
  -- EXECUTE remains restricted to service_role below. Supabase secret keys are
  -- not guaranteed to expose an auth.role() JWT claim, so the database grant is
  -- the reliable authorization boundary here.
  if lower(trim(coalesce(p_key_hash, ''))) !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  select id into v_key_id
  from private.analytics_api_keys
  where key_hash = lower(trim(p_key_hash)) and revoked_at is null;

  if v_key_id is not null then
    update private.analytics_api_keys
    set last_used_at = clock_timestamp()
    where id = v_key_id
      and (last_used_at is null or last_used_at < clock_timestamp() - interval '1 hour');
    return true;
  end if;

  if exists (select 1 from private.analytics_api_keys) then
    return false;
  end if;

  return null;
end;
$$;

revoke all on function public.can_manage_analytics_api() from public, anon, authenticated;
revoke all on function public.list_analytics_api_keys() from public, anon, authenticated;
revoke all on function public.create_analytics_api_key_record(text, text, text) from public, anon, authenticated;
revoke all on function public.revoke_analytics_api_key(uuid) from public, anon, authenticated;
revoke all on function public.validate_analytics_api_key(text) from public, anon, authenticated;

grant execute on function public.can_manage_analytics_api() to authenticated;
grant execute on function public.list_analytics_api_keys() to authenticated;
grant execute on function public.create_analytics_api_key_record(text, text, text) to authenticated;
grant execute on function public.revoke_analytics_api_key(uuid) to authenticated;
grant execute on function public.validate_analytics_api_key(text) to service_role;

commit;
