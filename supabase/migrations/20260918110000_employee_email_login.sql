begin;

-- Add email-shaped portal usernames without removing legacy administrator
-- usernames or altering Auth credentials, roles, account status or linkage.
create function private.is_valid_portal_login(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    p_value = lower(btrim(p_value)) and (
      p_value ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      or (
        length(p_value) <= 254
        and length(split_part(p_value, '@', 1)) <= 64
        and split_part(p_value, '@', 1) not like '.%'
        and split_part(p_value, '@', 1) not like '%.'
        and position('..' in split_part(p_value, '@', 1)) = 0
        and p_value ~ $email$^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$$email$
      )
    ), false
  );
$function$;

alter table public.profiles drop constraint profiles_login_name_format_check;
alter table public.profiles add constraint profiles_login_name_format_check check (
  login_name is null or private.is_valid_portal_login(login_name)
);

-- Retain the unique login index: normalised emails cannot be shared by two
-- accounts. Roster-specific employee renames happen in a separate audited step
-- after the email-capable application is live. This migration renames nobody.
comment on column public.profiles.login_name is
  'Unique case-normalized portal login. Employees use work email or personal email; existing administrator usernames remain supported. Auth email remains private.';

revoke all on function private.is_valid_portal_login(text) from public, anon, authenticated;
-- This pure validator is also evaluated by the profiles check constraint when
-- employees update their permitted profile columns. It exposes no account data.
grant execute on function private.is_valid_portal_login(text) to authenticated, service_role;

create or replace function public.create_portal_account(
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

  if not private.is_valid_portal_login(v_login_name) then
    raise exception 'Choose a valid email or username.' using errcode = '22023';
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

create or replace function public.update_portal_login(
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

  if not private.is_valid_portal_login(v_login_name) then
    raise exception 'Choose a valid email or username.' using errcode = '22023';
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


commit;
