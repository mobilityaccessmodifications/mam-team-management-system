begin;

-- Supabase Auth and Postgres cannot participate in one transaction. Claiming
-- an account-status change keeps concurrent administrators from interleaving
-- opposite Auth mutations while the version-checked database change is in
-- flight. Unresolved claims fail closed and require reconciliation before a
-- later status change can begin.
create table private.portal_account_status_change_claims (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  person_id uuid not null references public.internal_org_people (id) on delete cascade,
  change_token uuid not null unique default gen_random_uuid(),
  claimed_by uuid not null references auth.users (id) on delete restrict,
  claimed_at timestamptz not null default clock_timestamp(),
  requested_enabled boolean not null,
  status text not null default 'pending'
    check (status in ('pending', 'finalised', 'cancelled')),
  claimed_account_status text not null
    check (claimed_account_status in ('active', 'disabled')),
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

alter table private.portal_account_status_change_claims enable row level security;
revoke all on table private.portal_account_status_change_claims from public, anon, authenticated;

create function private.prevent_password_reset_during_account_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'pending' and exists (
    select 1
    from private.portal_account_status_change_claims claim
    where claim.auth_user_id = new.auth_user_id
      and claim.status = 'pending'
  ) then
    raise exception 'An account status change is already in progress.' using errcode = '40001';
  end if;
  return new;
end;
$$;

create trigger portal_password_reset_status_change_guard
before insert or update on private.portal_password_reset_claims
for each row execute function private.prevent_password_reset_during_account_status_change();

revoke all on function private.prevent_password_reset_during_account_status_change()
  from public, anon, authenticated;

create function private.enforce_portal_account_status_change_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.account_status is not distinct from new.account_status
    or (select auth.uid()) is null then
    return new;
  end if;

  if not exists (
    select 1
    from private.portal_account_status_change_claims claim
    where claim.auth_user_id = new.id
      and claim.status = 'pending'
  ) then
    -- Preserve existing create/relink and lifecycle RPCs. The guard only
    -- fences a user while the new cross-service claim protocol is active.
    return new;
  end if;

  if not exists (
    select 1
    from private.portal_account_status_change_claims claim
    where claim.auth_user_id = new.id
      and claim.claimed_by = (select auth.uid())
      and claim.status = 'pending'
      and claim.requested_enabled = (new.account_status = 'active')
  ) then
    raise exception 'Begin an account status change before updating the profile.'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger profiles_account_status_change_claim_guard
before update of account_status on public.profiles
for each row execute function private.enforce_portal_account_status_change_claim();

revoke all on function private.enforce_portal_account_status_change_claim()
  from public, anon, authenticated;

create function public.begin_portal_account_status_change(
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
  account_version bigint,
  change_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_existing private.portal_account_status_change_claims;
  v_token uuid := gen_random_uuid();
  v_login_name text;
  v_status text;
  v_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can change account status.'
      using errcode = '42501';
  end if;

  if p_enabled is null then
    raise exception 'Choose whether the account is enabled.' using errcode = '22004';
  end if;

  if p_expected_account_version is null then
    raise exception 'The expected account version is required.' using errcode = '22004';
  end if;

  if p_auth_user_id = v_actor and not p_enabled then
    raise exception 'You cannot disable your own account.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  if not p_enabled and (
    exists (
      select 1
      from private.portal_account_admins administrator
      where administrator.auth_user_id = p_auth_user_id
        and administrator.revoked_at is null
    )
    or exists (
      select 1
      from public.profiles administrator_profile
      where administrator_profile.id = p_auth_user_id
        and administrator_profile.app_role = 'system_admin'
    )
  ) then
    -- Only one administrator-disable claim may be in flight. Without this
    -- global fence, two different last administrators could both pass the
    -- "another active administrator" check before either finalises.
    perform pg_advisory_xact_lock(hashtextextended('portal_account:administrator_disable', 0));

    if exists (
      select 1
      from private.portal_account_status_change_claims claim
      where claim.status = 'pending'
        and not claim.requested_enabled
        and claim.auth_user_id <> p_auth_user_id
        and (
          exists (
            select 1
            from private.portal_account_admins administrator
            where administrator.auth_user_id = claim.auth_user_id
              and administrator.revoked_at is null
          )
          or exists (
            select 1
            from public.profiles administrator_profile
            where administrator_profile.id = claim.auth_user_id
              and administrator_profile.app_role = 'system_admin'
          )
        )
    ) then
      raise exception 'Another account administrator status change is already in progress.'
        using errcode = '40001';
    end if;
  end if;

  select claim.*
  into v_existing
  from private.portal_account_status_change_claims claim
  where claim.auth_user_id = p_auth_user_id
    and claim.status = 'pending';

  if found then
    if v_existing.claimed_by <> v_actor
      or v_existing.person_id <> p_person_id
      or v_existing.requested_enabled <> p_enabled
      or v_existing.claimed_account_version <> p_expected_account_version then
      raise exception 'An account status change is already in progress or requires reconciliation.'
        using errcode = '40001';
    end if;

    -- The same administrator may safely retry an interrupted request. The
    -- token fences finalisation, while the current database status tells the
    -- caller which provider state is safe if its retry must be rolled back.
    return query
    select p_person_id,
      p_auth_user_id,
      profile.login_name,
      profile.account_status,
      profile.account_version,
      v_existing.change_token
    from public.profiles profile
    where profile.id = p_auth_user_id;
    return;
  end if;

  if exists (
    select 1
    from private.portal_password_reset_claims claim
    where claim.auth_user_id = p_auth_user_id
      and claim.status = 'pending'
  ) then
    raise exception 'A password reset is already in progress.' using errcode = '40001';
  end if;

  select profile.login_name, profile.account_status, profile.account_version
  into v_login_name, v_status, v_version
  from public.profiles profile
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
  for update;

  if not found then
    raise exception 'The account changed or no longer exists. Refresh and try again.'
      using errcode = '40001';
  end if;

  if not p_enabled
    and (
      exists (
        select 1
        from private.portal_account_admins administrator
        where administrator.auth_user_id = p_auth_user_id
          and administrator.revoked_at is null
      )
      or exists (
        select 1
        from public.profiles administrator_profile
        where administrator_profile.id = p_auth_user_id
          and administrator_profile.app_role = 'system_admin'
      )
    )
    and not exists (
      select 1
      from public.profiles other_profile
      where other_profile.id <> p_auth_user_id
        and other_profile.account_status = 'active'
        and other_profile.login_name is not null
        and (
          other_profile.app_role = 'system_admin'
          or exists (
            select 1
            from private.portal_account_admins other_administrator
            where other_administrator.auth_user_id = other_profile.id
              and other_administrator.revoked_at is null
          )
        )
    ) then
    raise exception 'The last active account administrator cannot be disabled.'
      using errcode = '42501';
  end if;

  insert into private.portal_account_status_change_claims (
    auth_user_id,
    person_id,
    change_token,
    claimed_by,
    claimed_at,
    requested_enabled,
    status,
    claimed_account_status,
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
    p_enabled,
    'pending',
    v_status,
    v_version,
    null,
    null,
    null
  )
  on conflict on constraint portal_account_status_change_claims_pkey do update
  set person_id = excluded.person_id,
      change_token = excluded.change_token,
      claimed_by = excluded.claimed_by,
      claimed_at = excluded.claimed_at,
      requested_enabled = excluded.requested_enabled,
      status = excluded.status,
      claimed_account_status = excluded.claimed_account_status,
      claimed_account_version = excluded.claimed_account_version,
      final_account_version = null,
      finalised_at = null,
      cancelled_at = null;

  return query
  select p_person_id, p_auth_user_id, v_login_name, v_status, v_version, v_token;
end;
$$;

create function public.cancel_portal_account_status_change(
  p_auth_user_id uuid,
  p_change_token uuid
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
    raise exception 'Only an account administrator can cancel an account status change.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  update private.portal_account_status_change_claims claim
  set status = 'cancelled',
      cancelled_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.change_token = p_change_token
    and claim.claimed_by = (select auth.uid())
    and claim.status = 'pending';

  v_cancelled := found;
  return v_cancelled;
end;
$$;

create function public.inspect_portal_account_status_change(
  p_auth_user_id uuid,
  p_change_token uuid
)
returns table (
  person_id uuid,
  auth_user_id uuid,
  login_name text,
  account_status text,
  account_version bigint,
  claim_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select claim.person_id,
    claim.auth_user_id,
    profile.login_name,
    profile.account_status,
    profile.account_version,
    claim.status
  from private.portal_account_status_change_claims claim
  join public.profiles profile on profile.id = claim.auth_user_id
  where private.is_portal_account_admin()
    and claim.auth_user_id = p_auth_user_id
    and claim.change_token = p_change_token
    and claim.claimed_by = (select auth.uid());
$$;

create function public.finalise_portal_account_status_change(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_change_token uuid
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
  v_claim private.portal_account_status_change_claims;
  v_row record;
  v_target_status text;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can finalise an account status change.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  select claim.*
  into v_claim
  from private.portal_account_status_change_claims claim
  where claim.auth_user_id = p_auth_user_id
    and claim.change_token = p_change_token
    and claim.person_id = p_person_id
    and claim.claimed_by = (select auth.uid())
  for update;

  if not found or v_claim.status = 'cancelled' then
    raise exception 'The account-status claim is no longer valid.' using errcode = '40001';
  end if;

  if v_claim.status = 'finalised' then
    return query
    select p_person_id, p_auth_user_id, profile.login_name, profile.account_status,
      coalesce(v_claim.final_account_version, profile.account_version)
    from public.profiles profile
    where profile.id = p_auth_user_id;
    return;
  end if;

  v_target_status := case when v_claim.requested_enabled then 'active' else 'disabled' end;

  select p_person_id as person_id,
    p_auth_user_id as auth_user_id,
    profile.login_name,
    profile.account_status,
    profile.account_version
  into v_row
  from public.profiles profile
  where profile.id = p_auth_user_id
    and profile.login_name is not null
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.auth_user_id = p_auth_user_id
        and person.node_kind = 'person'
        and (person.is_active or profile.account_status = v_target_status)
    );

  if not found then
    raise exception 'The account changed or no longer exists. Reconcile the login provider before retrying.'
      using errcode = '40001';
  end if;

  if v_row.account_status <> v_target_status
    and v_row.account_version <> v_claim.claimed_account_version then
    raise exception 'The account changed or no longer exists. Reconcile the login provider before retrying.'
      using errcode = '40001';
  end if;

  if v_row.account_status <> v_target_status then
    select changed.*
    into v_row
    from public.set_portal_account_enabled(
      p_person_id,
      p_auth_user_id,
      v_claim.requested_enabled,
      v_claim.claimed_account_version
    ) changed;
  end if;

  update private.portal_account_status_change_claims claim
  set status = 'finalised',
      final_account_version = v_row.account_version,
      finalised_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.change_token = p_change_token;

  return query
  select v_row.person_id,
    v_row.auth_user_id,
    v_row.login_name,
    v_row.account_status,
    v_row.account_version;
end;
$$;

revoke all on function public.begin_portal_account_status_change(uuid, uuid, boolean, bigint)
  from public, anon, authenticated;
revoke all on function public.cancel_portal_account_status_change(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.inspect_portal_account_status_change(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finalise_portal_account_status_change(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_portal_account_status_change(uuid, uuid, boolean, bigint)
  to authenticated;
grant execute on function public.cancel_portal_account_status_change(uuid, uuid)
  to authenticated;
grant execute on function public.inspect_portal_account_status_change(uuid, uuid)
  to authenticated;
grant execute on function public.finalise_portal_account_status_change(uuid, uuid, uuid)
  to authenticated;

commit;
