begin;

-- A password is changed in GoTrue while the account audit lives in Postgres.
-- Claiming the reset first serialises concurrent administrators without ever
-- storing the password itself. The opaque claim token also makes finalisation
-- safe to retry after a network timeout.
create table private.portal_password_reset_claims (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  person_id uuid not null references public.internal_org_people (id) on delete cascade,
  reset_token uuid not null unique default gen_random_uuid(),
  claimed_by uuid not null references auth.users (id) on delete restrict,
  claimed_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending'
    check (status in ('pending', 'finalised', 'cancelled')),
  claimed_account_version bigint not null check (claimed_account_version > 0),
  final_account_version bigint check (final_account_version is null or final_account_version > 0),
  finalised_at timestamptz,
  cancelled_at timestamptz,
  check (
    (status = 'pending' and finalised_at is null and cancelled_at is null)
    or (status = 'finalised' and finalised_at is not null and cancelled_at is null)
    or (status = 'cancelled' and finalised_at is null and cancelled_at is not null)
  )
);

alter table private.portal_password_reset_claims enable row level security;
revoke all on table private.portal_password_reset_claims from public, anon, authenticated;

revoke all on function public.record_portal_password_reset(uuid, uuid)
  from public, anon, authenticated;
drop function public.record_portal_password_reset(uuid, uuid);

create function public.begin_portal_password_reset(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_expected_account_version bigint
)
returns table (
  person_id uuid,
  auth_user_id uuid,
  login_name text,
  account_status text,
  account_version bigint,
  reset_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_token uuid := gen_random_uuid();
  v_version bigint;
  v_login_name text;
  v_status text;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can reset a password.'
      using errcode = '42501';
  end if;

  if p_expected_account_version is null then
    raise exception 'The expected account version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  if exists (
    select 1
    from private.portal_password_reset_claims claim
    where claim.auth_user_id = p_auth_user_id
      and claim.status = 'pending'
      and claim.claimed_at > clock_timestamp() - interval '10 minutes'
  ) then
    raise exception 'A password reset is already in progress. Refresh and try again.'
      using errcode = '40001';
  end if;

  update private.portal_password_reset_claims claim
  set status = 'cancelled',
      cancelled_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.status = 'pending';

  update public.profiles profile
  set account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  where profile.id = p_auth_user_id
    and profile.account_version = p_expected_account_version
    and profile.login_name is not null
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.auth_user_id = p_auth_user_id
        and person.node_kind = 'person'
        and person.is_active
    )
  returning profile.account_version, profile.login_name, profile.account_status
  into v_version, v_login_name, v_status;

  if not found then
    raise exception 'The account changed or no longer exists. Refresh and try again.'
      using errcode = '40001';
  end if;

  insert into private.portal_password_reset_claims (
    auth_user_id,
    person_id,
    reset_token,
    claimed_by,
    claimed_at,
    status,
    claimed_account_version,
    final_account_version,
    finalised_at,
    cancelled_at
  )
  values (
    p_auth_user_id,
    p_person_id,
    v_token,
    v_actor,
    clock_timestamp(),
    'pending',
    v_version,
    null,
    null,
    null
  )
  on conflict (auth_user_id) do update
  set person_id = excluded.person_id,
      reset_token = excluded.reset_token,
      claimed_by = excluded.claimed_by,
      claimed_at = excluded.claimed_at,
      status = excluded.status,
      claimed_account_version = excluded.claimed_account_version,
      final_account_version = null,
      finalised_at = null,
      cancelled_at = null;

  return query
  select p_person_id, p_auth_user_id, v_login_name, v_status, v_version, v_token;
end;
$$;

create function public.cancel_portal_password_reset(
  p_auth_user_id uuid,
  p_reset_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled boolean;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can cancel a password reset.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  update private.portal_password_reset_claims claim
  set status = 'cancelled',
      cancelled_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.reset_token = p_reset_token
    and claim.claimed_by = (select auth.uid())
    and claim.status = 'pending';

  v_cancelled := found;
  return v_cancelled;
end;
$$;

create function public.finalise_portal_password_reset(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_reset_token uuid
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
  v_claim private.portal_password_reset_claims;
  v_before jsonb;
  v_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can finalise a password reset.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  select claim.*
  into v_claim
  from private.portal_password_reset_claims claim
  where claim.auth_user_id = p_auth_user_id
    and claim.reset_token = p_reset_token
    and claim.person_id = p_person_id
    and claim.claimed_by = (select auth.uid())
  for update;

  if not found or v_claim.status = 'cancelled' then
    raise exception 'The password-reset claim is no longer valid.' using errcode = '40001';
  end if;

  if v_claim.status = 'finalised' then
    return query
    select p_person_id, p_auth_user_id, profile.login_name, profile.account_status,
      coalesce(v_claim.final_account_version, profile.account_version)
    from public.profiles profile
    where profile.id = p_auth_user_id;
    return;
  end if;

  select jsonb_build_object(
    'must_change_password', profile.must_change_password,
    'account_version', profile.account_version
  )
  into v_before
  from public.profiles profile
  where profile.id = p_auth_user_id
    and profile.login_name is not null
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.auth_user_id = p_auth_user_id
        and person.node_kind = 'person'
        and person.is_active
    );

  if not found then
    raise exception 'The account no longer exists.' using errcode = '23503';
  end if;

  update public.profiles profile
  set must_change_password = false,
      password_changed_at = clock_timestamp(),
      temporary_password_issued_at = null,
      credentials_valid_after = clock_timestamp(),
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  where profile.id = p_auth_user_id
  returning profile.account_version into v_version;

  update private.portal_password_reset_claims claim
  set status = 'finalised',
      final_account_version = v_version,
      finalised_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.reset_token = p_reset_token;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, before_state, after_state
  )
  values (
    (select auth.uid()),
    p_auth_user_id,
    'password_reset_recorded',
    v_before,
    jsonb_build_object('must_change_password', false, 'account_version', v_version)
  );

  return query
  select p_person_id, p_auth_user_id, profile.login_name, profile.account_status, v_version
  from public.profiles profile
  where profile.id = p_auth_user_id;
end;
$$;

revoke all on function public.begin_portal_password_reset(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.cancel_portal_password_reset(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finalise_portal_password_reset(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_portal_password_reset(uuid, uuid, bigint)
  to authenticated;
grant execute on function public.cancel_portal_password_reset(uuid, uuid)
  to authenticated;
grant execute on function public.finalise_portal_password_reset(uuid, uuid, uuid)
  to authenticated;

commit;
