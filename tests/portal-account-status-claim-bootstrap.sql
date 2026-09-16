do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$$;

create schema auth;
create schema private;

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('test.actor', true), '')::uuid;
$$;

create table auth.users (
  id uuid primary key
);

create table public.internal_org_people (
  id uuid primary key,
  auth_user_id uuid references auth.users (id),
  node_kind text not null,
  is_active boolean not null default true
);

create table public.profiles (
  id uuid primary key references auth.users (id),
  login_name text,
  account_status text not null check (account_status in ('active', 'disabled')),
  account_version bigint not null default 1,
  app_role text not null default 'employee',
  disabled_at timestamptz,
  credentials_valid_after timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create table private.portal_account_admins (
  auth_user_id uuid primary key references auth.users (id),
  revoked_at timestamptz
);

create table private.portal_password_reset_claims (
  auth_user_id uuid primary key references auth.users (id),
  status text not null
);

create table private.portal_account_admin_events (
  actor_user_id uuid not null,
  target_user_id uuid not null,
  event_type text not null,
  before_state jsonb not null,
  after_state jsonb not null
);

create function private.is_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.portal_account_admins administrator
    join public.profiles profile on profile.id = administrator.auth_user_id
    where administrator.auth_user_id = (select auth.uid())
      and administrator.revoked_at is null
      and profile.account_status = 'active'
  );
$$;

create function public.set_portal_account_enabled(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_enabled boolean,
  p_expected_account_version bigint
)
returns table (
  person_id uuid,
  auth_user_id uuid,
  login_name text,
  account_status text,
  account_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := case when p_enabled then 'active' else 'disabled' end;
  v_before jsonb;
  v_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can change account status.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'account_status', profile.account_status,
    'account_version', profile.account_version
  )
  into v_before
  from public.profiles profile
  where profile.id = p_auth_user_id;

  update public.profiles profile
  set account_status = v_status,
      disabled_at = case when v_status = 'disabled' then clock_timestamp() else null end,
      credentials_valid_after = clock_timestamp(),
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  where profile.id = p_auth_user_id
    and profile.account_version = p_expected_account_version
    and profile.login_name is not null
  returning profile.account_version into v_version;

  if not found then
    raise exception 'The account changed or no longer exists.' using errcode = '40001';
  end if;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, before_state, after_state
  ) values (
    (select auth.uid()),
    p_auth_user_id,
    case when v_status = 'disabled' then 'account_disabled' else 'account_enabled' end,
    v_before,
    jsonb_build_object('account_status', v_status, 'account_version', v_version)
  );

  return query
  select p_person_id, p_auth_user_id, profile.login_name, v_status, v_version
  from public.profiles profile
  where profile.id = p_auth_user_id;
end;
$$;
