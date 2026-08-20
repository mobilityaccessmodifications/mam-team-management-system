begin;

-- Portal logins are managed identities, separate from editable HR directory
-- fields. Auth passwords remain in GoTrue and are never stored in Postgres.
alter table public.profiles
  add column login_name text,
  add column account_status text not null default 'active'
    check (account_status in ('active', 'disabled')),
  add column must_change_password boolean not null default false,
  add column password_changed_at timestamptz,
  add column temporary_password_issued_at timestamptz,
  add column disabled_at timestamptz,
  add column credentials_valid_after timestamptz not null default now(),
  add column account_version bigint not null default 1 check (account_version > 0),
  add constraint profiles_login_name_format_check check (
    login_name is null
    or (
      login_name = lower(btrim(login_name))
      and login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    )
  ),
  add constraint profiles_account_status_timestamps_check check (
    (account_status = 'active' and disabled_at is null)
    or (account_status = 'disabled' and disabled_at is not null)
  );

create unique index profiles_login_name_unique_idx
  on public.profiles (login_name)
  where login_name is not null;

comment on column public.profiles.login_name is
  'Case-normalized portal username. The corresponding Auth email is an implementation detail and is never displayed as the login.';
comment on column public.profiles.must_change_password is
  'Reserved for a future forced-change flow. The current simple portal keeps this false.';
comment on column public.profiles.credentials_valid_after is
  'Database-side credential epoch used to invalidate sensitive access independently of JWT expiry. Compared at JWT iat second precision.';

drop policy profiles_insert_own on public.profiles;
revoke insert on table public.profiles from authenticated;

-- Reassert the self-service column boundary after adding account-control
-- columns. Authenticated users may update only harmless personal fields; role,
-- login, status and credential epochs remain writable solely by definer RPCs.
revoke update on table public.profiles from authenticated;
grant update (full_name, preferred_name, timezone, updated_at)
  on table public.profiles to authenticated;

create table private.portal_account_admins (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= added_at)
);

comment on table private.portal_account_admins is
  'Explicit account-administration allowlist. Populate only after verifying the production target; no identity is seeded in source control.';

alter table private.portal_account_admins enable row level security;
revoke all on table private.portal_account_admins from public, anon, authenticated;

create index portal_account_admins_added_by_idx
  on private.portal_account_admins (added_by)
  where added_by is not null;

create table private.portal_account_admin_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users (id) on delete set null,
  target_user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in (
    'account_linked',
    'login_renamed',
    'password_reset_recorded',
    'password_changed',
    'account_disabled',
    'account_enabled',
    'account_admin_added',
    'account_admin_removed'
  )),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

comment on table private.portal_account_admin_events is
  'Append-only account administration audit. Passwords and temporary credentials must never be written here.';

alter table private.portal_account_admin_events enable row level security;
revoke all on table private.portal_account_admin_events from public, anon, authenticated;

create index portal_account_admin_events_target_created_idx
  on private.portal_account_admin_events (target_user_id, created_at desc);
create index portal_account_admin_events_actor_created_idx
  on private.portal_account_admin_events (actor_user_id, created_at desc);

create function private.portal_accounts_enforced()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.login_name is not null
  );
$$;

create function private.is_active_portal_account(p_user_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = coalesce(p_user_id, (select auth.uid()))
      and profile.login_name is not null
      and profile.account_status = 'active'
      and (
        p_user_id is not null
        or date_trunc('second', profile.credentials_valid_after) <= coalesce(
          to_timestamp(nullif((select auth.jwt()) ->> 'iat', '')::double precision),
          '-infinity'::timestamptz
        )
      )
  );
$$;

create function private.has_current_portal_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.portal_accounts_enforced()
    or private.is_active_portal_account();
$$;

create function private.is_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.is_active_portal_account()
    and (
      exists (
        select 1
        from private.portal_account_admins administrator
        where administrator.auth_user_id = (select auth.uid())
          and administrator.revoked_at is null
      )
      or exists (
        select 1
        from public.profiles profile
        where profile.id = (select auth.uid())
          and profile.app_role = 'system_admin'
      )
    );
$$;

create function public.can_manage_portal_accounts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_portal_account_admin();
$$;

comment on function public.can_manage_portal_accounts() is
  'Returns whether the current active portal user may manage login identifiers, status and password-reset state.';

create policy profiles_select_account_admin
  on public.profiles for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select private.is_portal_account_admin())
  );

-- Every pre-existing application policy also passes through the managed-account
-- boundary. This prevents a disabled user with an access token that has not yet
-- expired from reaching the Data API directly.
drop policy profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select auth.uid()) = id
  );

drop policy profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select auth.uid()) = id
  )
  with check (
    (select private.has_current_portal_access())
    and (select auth.uid()) = id
  );

drop policy memberships_select_own on public.team_memberships;
create policy memberships_select_own
  on public.team_memberships for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select auth.uid()) = user_id
  );

drop policy teams_select_for_member on public.teams;
create policy teams_select_for_member
  on public.teams for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and exists (
      select 1
      from public.team_memberships membership
      where membership.team_id = teams.id
        and membership.user_id = (select auth.uid())
    )
  );

drop policy leave_requests_select_own on public.leave_requests;
create policy leave_requests_select_own
  on public.leave_requests for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select auth.uid()) = user_id
  );

drop policy leave_requests_insert_own on public.leave_requests;
create policy leave_requests_insert_own
  on public.leave_requests for insert
  to authenticated
  with check (
    (select private.has_current_portal_access())
    and (select auth.uid()) = user_id
    and status in ('draft', 'submitted')
    and decided_by is null
    and decided_at is null
  );

drop policy leave_requests_update_own_open on public.leave_requests;
create policy leave_requests_update_own_open
  on public.leave_requests for update
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select auth.uid()) = user_id
    and status in ('draft', 'changes_requested')
  )
  with check (
    (select private.has_current_portal_access())
    and (select auth.uid()) = user_id
    and status in ('draft', 'submitted', 'cancelled')
    and decided_by is null
    and decided_at is null
  );

drop policy leave_requests_delete_own_draft on public.leave_requests;
create policy leave_requests_delete_own_draft
  on public.leave_requests for delete
  to authenticated
  using (
    (select private.has_current_portal_access())
    and (select auth.uid()) = user_id
    and status = 'draft'
  );

drop policy leave_events_select_own_request on public.leave_request_events;
create policy leave_events_select_own_request
  on public.leave_request_events for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and exists (
      select 1
      from public.leave_requests request
      where request.id = leave_request_events.leave_request_id
        and request.user_id = (select auth.uid())
    )
  );

drop policy leave_events_insert_own_request on public.leave_request_events;
create policy leave_events_insert_own_request
  on public.leave_request_events for insert
  to authenticated
  with check (
    (select private.has_current_portal_access())
    and actor_user_id = (select auth.uid())
    and event_type in ('created', 'submitted', 'updated', 'cancelled')
    and exists (
      select 1
      from public.leave_requests request
      where request.id = leave_request_events.leave_request_id
        and request.user_id = (select auth.uid())
    )
  );

create or replace function private.can_review_leave_request(p_leave_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles viewer
      join public.leave_requests request
        on request.id = p_leave_request_id
      where viewer.id = (select auth.uid())
        and (
          viewer.app_role in ('hr', 'system_admin')
          or exists (
            select 1
            from public.team_memberships reviewer_membership
            join public.team_memberships employee_membership
              on employee_membership.team_id = reviewer_membership.team_id
            where reviewer_membership.user_id = viewer.id
              and reviewer_membership.team_role in ('team_lead', 'manager')
              and employee_membership.user_id = request.user_id
          )
        )
    );
$$;

drop policy leave_attachments_insert_owner on public.leave_request_attachments;
create policy leave_attachments_insert_owner
  on public.leave_request_attachments for insert
  to authenticated
  with check (
    (select private.has_current_portal_access())
    and uploaded_by = (select auth.uid())
    and exists (
      select 1
      from public.leave_requests request
      where request.id = leave_request_attachments.leave_request_id
        and request.user_id = (select auth.uid())
        and request.status in ('draft', 'submitted', 'changes_requested')
    )
  );

drop policy leave_attachments_select_reviewer on public.leave_request_attachments;
create policy leave_attachments_select_reviewer
  on public.leave_request_attachments for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and private.can_review_leave_request(leave_request_id)
  );

drop policy leave_evidence_insert_owner on storage.objects;
create policy leave_evidence_insert_owner
  on storage.objects for insert
  to authenticated
  with check (
    (select private.has_current_portal_access())
    and bucket_id = 'leave-evidence'
    and exists (
      select 1
      from public.leave_requests request
      where request.id::text = (storage.foldername(name))[1]
        and request.user_id = (select auth.uid())
        and request.status in ('draft', 'submitted', 'changes_requested')
    )
  );

drop policy leave_evidence_select_reviewer on storage.objects;
create policy leave_evidence_select_reviewer
  on storage.objects for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and bucket_id = 'leave-evidence'
    and exists (
      select 1
      from public.leave_request_attachments attachment
      where attachment.storage_path = storage.objects.name
        and private.can_review_leave_request(attachment.leave_request_id)
    )
  );

drop policy leave_requests_select_reviewer on public.leave_requests;
create policy leave_requests_select_reviewer
  on public.leave_requests for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and private.can_review_leave_request(id)
  );

create function public.set_portal_account_admin(
  p_auth_user_id uuid,
  p_is_admin boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can change account administrators.'
      using errcode = '42501';
  end if;

  if p_is_admin is null then
    raise exception 'Choose whether this account is an administrator.' using errcode = '22004';
  end if;

  if not private.is_active_portal_account(p_auth_user_id) then
    raise exception 'Only an active portal account can be an administrator.'
      using errcode = '23503';
  end if;

  if not p_is_admin and p_auth_user_id = (select auth.uid()) then
    raise exception 'You cannot remove your own account-administrator access.'
      using errcode = '42501';
  end if;

  if p_is_admin then
    insert into private.portal_account_admins (auth_user_id, added_by, revoked_at)
    values (p_auth_user_id, (select auth.uid()), null)
    on conflict (auth_user_id) do update
    set added_at = clock_timestamp(),
        added_by = (select auth.uid()),
        revoked_at = null;
  else
    update private.portal_account_admins administrator
    set revoked_at = clock_timestamp()
    where administrator.auth_user_id = p_auth_user_id
      and administrator.revoked_at is null;
  end if;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, after_state
  )
  values (
    (select auth.uid()),
    p_auth_user_id,
    case when p_is_admin then 'account_admin_added' else 'account_admin_removed' end,
    jsonb_build_object('account_admin', p_is_admin)
  );

  return p_is_admin;
end;
$$;

create function public.create_portal_account(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_login_name text,
  p_app_role text default 'employee',
  p_expected_person_version bigint default null
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
  v_actor uuid := (select auth.uid());
  v_login_name text := lower(btrim(p_login_name));
  v_person public.internal_org_people;
  v_before jsonb;
  v_account_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can create a portal account.'
      using errcode = '42501';
  end if;

  if v_login_name !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception 'Choose a valid login name.' using errcode = '22023';
  end if;

  if p_app_role is null
    or lower(btrim(p_app_role)) not in ('employee', 'manager', 'hr', 'system_admin') then
    raise exception 'Choose a valid application role.' using errcode = '22023';
  end if;

  if p_expected_person_version is null then
    raise exception 'The expected person version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  select person.*
  into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.version = p_expected_person_version
    and person.node_kind = 'person'
    and person.is_active
  for update;

  if not found then
    raise exception 'The selected person changed, is archived, or is not a person.'
      using errcode = '40001';
  end if;

  if not exists (select 1 from auth.users auth_user where auth_user.id = p_auth_user_id) then
    raise exception 'The Auth user does not exist.' using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null and v_person.auth_user_id <> p_auth_user_id then
    raise exception 'This person is already linked to another account.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.internal_org_people other_person
    where other_person.auth_user_id = p_auth_user_id
      and other_person.id <> p_person_id
  ) then
    raise exception 'This account is already linked to another person.'
      using errcode = '23505';
  end if;

  select jsonb_build_object(
    'login_name', profile.login_name,
    'account_status', profile.account_status,
    'must_change_password', profile.must_change_password,
    'account_version', profile.account_version,
    'person_id', linked_person.id
  )
  into v_before
  from public.profiles profile
  left join public.internal_org_people linked_person
    on linked_person.auth_user_id = profile.id
  where profile.id = p_auth_user_id;

  insert into public.profiles as profile (
    id,
    full_name,
    preferred_name,
    app_role,
    login_name,
    account_status,
    must_change_password,
    temporary_password_issued_at,
    disabled_at,
    credentials_valid_after
  )
  values (
    p_auth_user_id,
    v_person.full_name,
    null,
    lower(btrim(p_app_role)),
    v_login_name,
    'active',
    false,
    null,
    null,
    clock_timestamp()
  )
  on conflict (id) do update
  set full_name = excluded.full_name,
      app_role = excluded.app_role,
      login_name = excluded.login_name,
      account_status = 'active',
      must_change_password = false,
      password_changed_at = clock_timestamp(),
      temporary_password_issued_at = null,
      disabled_at = null,
      credentials_valid_after = clock_timestamp(),
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  returning profile.account_version into v_account_version;

  update public.internal_org_people person
  set auth_user_id = p_auth_user_id,
      updated_by = v_actor
  where person.id = p_person_id;

  insert into private.portal_account_admin_events (
    actor_user_id,
    target_user_id,
    event_type,
    before_state,
    after_state
  )
  values (
    v_actor,
    p_auth_user_id,
    'account_linked',
    v_before,
    jsonb_build_object(
      'login_name', v_login_name,
      'account_status', 'active',
      'must_change_password', false,
      'account_version', v_account_version,
      'person_id', p_person_id
    )
  );

  return query
  select p_person_id, p_auth_user_id, v_login_name, 'active'::text, v_account_version;
end;
$$;

create function public.update_portal_login(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_login_name text,
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
  v_login_name text := lower(btrim(p_login_name));
  v_before jsonb;
  v_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can rename a login.'
      using errcode = '42501';
  end if;

  if v_login_name !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception 'Choose a valid login name.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    where person.id = p_person_id
      and person.auth_user_id = p_auth_user_id
      and person.node_kind = 'person'
      and person.is_active
  ) then
    raise exception 'The account is not linked to this active person.' using errcode = '23503';
  end if;

  select jsonb_build_object(
    'login_name', profile.login_name,
    'account_version', profile.account_version
  )
  into v_before
  from public.profiles profile
  where profile.id = p_auth_user_id;

  update public.profiles profile
  set login_name = v_login_name,
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  where profile.id = p_auth_user_id
    and profile.account_version = p_expected_account_version
    and profile.login_name is not null
  returning profile.account_version into v_version;

  if not found then
    raise exception 'The account changed or no longer exists. Refresh and try again.'
      using errcode = '40001';
  end if;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, before_state, after_state
  )
  values (
    (select auth.uid()),
    p_auth_user_id,
    'login_renamed',
    v_before,
    jsonb_build_object('login_name', v_login_name, 'account_version', v_version)
  );

  return query
  select p_person_id, p_auth_user_id, v_login_name, profile.account_status, v_version
  from public.profiles profile
  where profile.id = p_auth_user_id;
end;
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
    raise exception 'Only an account administrator can change account status.'
      using errcode = '42501';
  end if;

  if p_enabled is null then
    raise exception 'Choose whether the account is enabled.' using errcode = '22004';
  end if;

  if p_auth_user_id = (select auth.uid()) and v_status = 'disabled' then
    raise exception 'You cannot disable your own account.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    where person.id = p_person_id
      and person.auth_user_id = p_auth_user_id
      and person.node_kind = 'person'
      and person.is_active
  ) then
    raise exception 'The account is not linked to this active person.' using errcode = '23503';
  end if;

  if v_status = 'disabled'
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
      select 1 from public.profiles other_profile
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
    raise exception 'The account changed or no longer exists. Refresh and try again.'
      using errcode = '40001';
  end if;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, before_state, after_state
  )
  values (
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

create function public.record_portal_password_reset(
  p_person_id uuid,
  p_auth_user_id uuid
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
  v_before jsonb;
  v_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can record a password reset.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    where person.id = p_person_id
      and person.auth_user_id = p_auth_user_id
      and person.node_kind = 'person'
      and person.is_active
  ) then
    raise exception 'The account is not linked to this active person.' using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  select jsonb_build_object(
    'must_change_password', profile.must_change_password,
    'account_version', profile.account_version
  )
  into v_before
  from public.profiles profile
  where profile.id = p_auth_user_id;

  update public.profiles profile
  set must_change_password = false,
      password_changed_at = clock_timestamp(),
      temporary_password_issued_at = null,
      credentials_valid_after = clock_timestamp(),
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  where profile.id = p_auth_user_id
    and profile.login_name is not null
  returning profile.account_version into v_version;

  if not found then
    raise exception 'The account no longer exists.' using errcode = '23503';
  end if;

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

create function public.current_portal_account()
returns table (
  auth_user_id uuid,
  person_id uuid,
  login_name text,
  account_status text,
  must_change_password boolean,
  account_version bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    profile.id,
    person.id,
    profile.login_name,
    profile.account_status,
    profile.must_change_password,
    profile.account_version
  from public.profiles profile
  left join public.internal_org_people person
    on person.auth_user_id = profile.id
      and person.node_kind = 'person'
      and person.is_active
  where profile.id = (select auth.uid())
    and private.is_active_portal_account();
$$;

-- Keep every remaining exposed helper behind the same active-account check so
-- direct Data API calls cannot retain access after an account is disabled.
create or replace function public.can_edit_internal_org()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_internal_org_hr();
$$;

-- Account linkage is controlled only by the account RPCs above. HR can still
-- maintain names, titles and hierarchy, but cannot attach an Auth identity.
revoke all on function public.create_internal_org_node(text, text, text, text, uuid, date, integer, uuid)
  from public, anon, authenticated;
drop function public.create_internal_org_node(text, text, text, text, uuid, date, integer, uuid);

revoke all on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, uuid, boolean, bigint)
  from public, anon, authenticated;
drop function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, uuid, boolean, bigint);

create function public.create_internal_org_node(
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0
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
    if not private.is_portal_account_admin() then
      raise exception 'Only an authorized HR user can edit the organisation tree.'
        using errcode = '42501';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  insert into public.internal_org_people (
    company_key, node_kind, position_title, full_name, parent_id,
    started_date, sort_order, auth_user_id, created_by, updated_by
  )
  values (
    lower(btrim(p_company_key)),
    lower(btrim(p_node_kind)),
    btrim(p_position_title),
    case when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '') else null end,
    p_parent_id,
    case when lower(btrim(p_node_kind)) = 'person' then p_started_date else null end,
    p_sort_order,
    null,
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
    if not private.is_portal_account_admin() then
      raise exception 'Only an authorized HR user can edit the organisation tree.'
        using errcode = '42501';
    end if;
  end if;

  if p_expected_version is null then
    raise exception 'The expected org node version is required.' using errcode = '22004';
  end if;

  if lower(btrim(p_node_kind)) <> 'person' and exists (
    select 1
    from public.internal_org_people linked_person
    where linked_person.id = p_node_id
      and linked_person.auth_user_id is not null
  ) then
    raise exception 'Disable or relink the portal account before changing this person node.'
      using errcode = '23503';
  end if;

  if p_is_active is false and exists (
    select 1
    from public.internal_org_people linked_person
    join public.profiles linked_account
      on linked_account.id = linked_person.auth_user_id
    where linked_person.id = p_node_id
      and linked_person.auth_user_id is not null
      and linked_account.account_status = 'active'
  ) then
    raise exception 'Disable the portal account before archiving this person.'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  update public.internal_org_people node
  set company_key = lower(btrim(p_company_key)),
      node_kind = lower(btrim(p_node_kind)),
      position_title = btrim(p_position_title),
      full_name = case when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '') else null end,
      parent_id = p_parent_id,
      started_date = case when lower(btrim(p_node_kind)) = 'person' then p_started_date else null end,
      sort_order = p_sort_order,
      is_active = p_is_active,
      updated_by = (select auth.uid())
  where node.id = p_node_id
    and node.version = p_expected_version
  returning * into v_node;

  if not found then
    if exists (select 1 from public.internal_org_people node where node.id = p_node_id) then
      raise exception 'This org node changed since it was opened. Refresh and try again.'
        using errcode = '40001';
    end if;
    raise exception 'The org node does not exist.';
  end if;

  return v_node.id;
end;
$$;

-- Once portal accounts exist, legacy directory membership/HR allowlists remain
-- the role boundary but only active managed accounts may exercise those roles.
create or replace function private.is_internal_org_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (not private.portal_accounts_enforced() or private.is_active_portal_account())
    and (select auth.uid()) is not null
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

create or replace function private.is_internal_org_hr()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (not private.portal_accounts_enforced() or private.is_active_portal_account())
    and (select auth.uid()) is not null
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

-- Remove the public synthetic identity surface. The real leave, evidence and
-- internal organisation tables are deliberately preserved.
do $$
begin
  if to_regprocedure('public.reset_demo_leave_requests(boolean)') is not null then
    revoke all on function public.reset_demo_leave_requests(boolean) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.submit_demo_leave_request(text,text,date,date,time without time zone,time without time zone,text)') is not null then
    revoke all on function public.submit_demo_leave_request(text, text, date, date, time, time, text) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.decide_demo_leave_request(text,text,text,text)') is not null then
    revoke all on function public.decide_demo_leave_request(text, text, text, text) from public, anon, authenticated;
  end if;
  if to_regprocedure('private.seed_demo_leave_requests()') is not null then
    revoke all on function private.seed_demo_leave_requests() from public, anon, authenticated;
  end if;
  if to_regprocedure('private.set_demo_updated_at()') is not null then
    revoke all on function private.set_demo_updated_at() from public, anon, authenticated;
  end if;
end;
$$;

drop function if exists public.reset_demo_leave_requests(boolean);
drop function if exists public.submit_demo_leave_request(text, text, date, date, time without time zone, time without time zone, text);
drop function if exists public.decide_demo_leave_request(text, text, text, text);
drop function if exists private.seed_demo_leave_requests();

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'demo_leave_requests'
  ) then
    alter publication supabase_realtime drop table public.demo_leave_requests;
  end if;
end;
$$;

drop table if exists public.demo_leave_requests;
drop table if exists public.demo_profiles;
drop sequence if exists public.demo_leave_request_number_seq;
drop function if exists private.set_demo_updated_at();

revoke all on function private.portal_accounts_enforced() from public, anon, authenticated;
revoke all on function private.is_active_portal_account(uuid) from public, anon, authenticated;
revoke all on function private.has_current_portal_access() from public, anon, authenticated;
revoke all on function private.is_portal_account_admin() from public, anon, authenticated;
revoke all on function public.can_manage_portal_accounts() from public, anon, authenticated;
revoke all on function public.set_portal_account_admin(uuid, boolean) from public, anon, authenticated;
revoke all on function public.create_portal_account(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.update_portal_login(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.set_portal_account_enabled(uuid, uuid, boolean, bigint) from public, anon, authenticated;
revoke all on function public.record_portal_password_reset(uuid, uuid) from public, anon, authenticated;
revoke all on function public.current_portal_account() from public, anon, authenticated;
revoke all on function public.create_internal_org_node(text, text, text, text, uuid, date, integer)
  from public, anon, authenticated;
revoke all on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, boolean, bigint)
  from public, anon, authenticated;

grant usage on schema private to authenticated;
grant execute on function public.can_manage_portal_accounts() to authenticated;
grant execute on function public.set_portal_account_admin(uuid, boolean) to authenticated;
grant execute on function public.create_portal_account(uuid, uuid, text, text, bigint) to authenticated;
grant execute on function public.update_portal_login(uuid, uuid, text, bigint) to authenticated;
grant execute on function public.set_portal_account_enabled(uuid, uuid, boolean, bigint) to authenticated;
grant execute on function public.record_portal_password_reset(uuid, uuid) to authenticated;
grant execute on function public.current_portal_account() to authenticated;
grant execute on function public.create_internal_org_node(text, text, text, text, uuid, date, integer)
  to authenticated;
grant execute on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, boolean, bigint)
  to authenticated;

commit;
