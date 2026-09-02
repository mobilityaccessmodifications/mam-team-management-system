begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:fail-closed-portal-login-hardening:20260902', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regprocedure('private.portal_accounts_enforced()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.has_current_portal_access()') is null then
    raise exception 'Portal login hardening prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- The managed-account rollout is complete. Empty development, preview and
-- recovery databases must deny access until an account is explicitly
-- provisioned; an empty profiles table is never an authorization bypass.
create or replace function private.portal_accounts_enforced()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select true;
$$;

create or replace function private.has_current_portal_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_portal_account();
$$;

comment on function private.portal_accounts_enforced() is
  'Compatibility predicate retained for older policies. Managed portal accounts are always enforced, including when profiles is empty.';
comment on function private.has_current_portal_access() is
  'Returns true only for the current active managed portal account. It always fails closed when no account exists.';

create table private.portal_login_rate_limits (
  scope text not null check (scope in ('login', 'source')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, key_hash)
);

create index portal_login_rate_limits_updated_idx
  on private.portal_login_rate_limits (updated_at);

alter table private.portal_login_rate_limits enable row level security;
revoke all on table private.portal_login_rate_limits from public, anon, authenticated;

comment on table private.portal_login_rate_limits is
  'Server-only rolling login limits. It stores SHA-256 fingerprints only, never login names, IP addresses, passwords or Auth aliases.';

create function private.consume_portal_login_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_limit private.portal_login_rate_limits%rowtype;
begin
  if p_scope not in ('login', 'source')
    or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_limit not between 1 and 100 then
    raise exception 'The login limit request is invalid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('portal-login-limit:' || p_scope || ':' || p_key_hash, 0)
  );

  select rate_limit.*
  into v_limit
  from private.portal_login_rate_limits rate_limit
  where rate_limit.scope = p_scope
    and rate_limit.key_hash = p_key_hash
  for update;

  if not found then
    insert into private.portal_login_rate_limits (
      scope,
      key_hash,
      window_started_at,
      attempt_count,
      updated_at
    )
    values (p_scope, p_key_hash, v_now, 1, v_now);
    return true;
  end if;

  if v_limit.blocked_until is not null and v_limit.blocked_until > v_now then
    update private.portal_login_rate_limits rate_limit
    set updated_at = v_now
    where rate_limit.scope = p_scope
      and rate_limit.key_hash = p_key_hash;
    return false;
  end if;

  if v_limit.window_started_at <= v_now - interval '15 minutes' then
    update private.portal_login_rate_limits rate_limit
    set window_started_at = v_now,
        attempt_count = 1,
        blocked_until = null,
        updated_at = v_now
    where rate_limit.scope = p_scope
      and rate_limit.key_hash = p_key_hash;
    return true;
  end if;

  if v_limit.attempt_count >= p_limit then
    update private.portal_login_rate_limits rate_limit
    set attempt_count = rate_limit.attempt_count + 1,
        blocked_until = v_now + interval '15 minutes',
        updated_at = v_now
    where rate_limit.scope = p_scope
      and rate_limit.key_hash = p_key_hash;
    return false;
  end if;

  update private.portal_login_rate_limits rate_limit
  set attempt_count = rate_limit.attempt_count + 1,
      blocked_until = null,
      updated_at = v_now
  where rate_limit.scope = p_scope
    and rate_limit.key_hash = p_key_hash;

  return true;
end;
$$;

create function public.claim_portal_login_attempt(
  p_login_hash text,
  p_source_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_login_allowed boolean;
  v_source_allowed boolean;
begin
  if p_login_hash !~ '^[0-9a-f]{64}$'
    or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'The login attempt is invalid.' using errcode = '22023';
  end if;

  -- Keep the private table bounded without a separate maintenance credential.
  with expired as (
    select rate_limit.scope, rate_limit.key_hash
    from private.portal_login_rate_limits rate_limit
    where rate_limit.updated_at < clock_timestamp() - interval '7 days'
    order by rate_limit.updated_at
    limit 100
  )
  delete from private.portal_login_rate_limits rate_limit
  using expired
  where rate_limit.scope = expired.scope
    and rate_limit.key_hash = expired.key_hash;

  v_login_allowed := private.consume_portal_login_rate_limit('login', p_login_hash, 10);
  v_source_allowed := private.consume_portal_login_rate_limit('source', p_source_hash, 30);
  return v_login_allowed and v_source_allowed;
end;
$$;

create function public.clear_portal_login_rate_limit(
  p_login_hash text,
  p_source_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_login_hash !~ '^[0-9a-f]{64}$'
    or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'The login attempt is invalid.' using errcode = '22023';
  end if;

  delete from private.portal_login_rate_limits rate_limit
  where rate_limit.scope = 'login'
    and rate_limit.key_hash = p_login_hash;

  -- Remove only this successful request from the shared source counter. A
  -- valid login must not erase other failed attempts made from the same
  -- source, which would let one known account reset a brute-force budget.
  update private.portal_login_rate_limits rate_limit
  set attempt_count = greatest(rate_limit.attempt_count - 1, 0),
      updated_at = clock_timestamp()
  where rate_limit.scope = 'source'
    and rate_limit.key_hash = p_source_hash;

  delete from private.portal_login_rate_limits rate_limit
  where rate_limit.scope = 'source'
    and rate_limit.key_hash = p_source_hash
    and rate_limit.attempt_count = 0;
  return true;
end;
$$;

-- Resolve the opaque Auth address in one database roundtrip. Unknown, disabled
-- and malformed login names all return null. This function is service-only so
-- the internal Auth alias can never be enumerated through the browser API.
create function public.resolve_portal_login_auth_email(
  p_login_name text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select member.email
  from public.profiles profile
  join auth.users member on member.id = profile.id
  where profile.login_name = lower(btrim(p_login_name))
    and profile.account_status = 'active'
    and profile.login_name is not null
    and member.email is not null
  limit 1;
$$;

comment on function public.claim_portal_login_attempt(text, text) is
  'Service-only atomic limiter: ten attempts per login fingerprint and thirty per source fingerprint in a rolling fifteen-minute window.';
comment on function public.clear_portal_login_rate_limit(text, text) is
  'Service-only success cleanup that clears the login fingerprint and removes only the successful attempt from the shared source counter.';
comment on function public.resolve_portal_login_auth_email(text) is
  'Service-only opaque Auth-address resolver for one active portal login name.';

revoke all on function private.consume_portal_login_rate_limit(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.claim_portal_login_attempt(text, text)
  from public, anon, authenticated;
revoke all on function public.clear_portal_login_rate_limit(text, text)
  from public, anon, authenticated;
revoke all on function public.resolve_portal_login_auth_email(text)
  from public, anon, authenticated;

grant execute on function public.claim_portal_login_attempt(text, text)
  to service_role;
grant execute on function public.clear_portal_login_rate_limit(text, text)
  to service_role;
grant execute on function public.resolve_portal_login_auth_email(text)
  to service_role;

commit;
