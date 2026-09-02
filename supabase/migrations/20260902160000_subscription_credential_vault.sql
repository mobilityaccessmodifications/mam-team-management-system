begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-credential-vault:20260902', 0)
  );

  if to_regclass('private.subscription_register') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('public.can_view_subscription_register()') is null then
    raise exception 'Subscription credential vault prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- This table never stores plaintext. The application encrypts the complete
-- service-login payload with a server-only AES-256-GCM key before it reaches
-- this database. Direct table access is denied to every browser role.
create table private.subscription_credential_vault (
  subscription_id uuid primary key references private.subscription_register (id) on delete cascade,
  credential_ciphertext text not null
    check (
      credential_ciphertext ~ '^[A-Za-z0-9_-]+$'
      and char_length(credential_ciphertext) <= 32768
    ),
  credential_iv text not null
    check (credential_iv ~ '^[A-Za-z0-9_-]{16}$'),
  credential_auth_tag text not null
    check (credential_auth_tag ~ '^[A-Za-z0-9_-]{22}$'),
  credential_key_version smallint not null default 1
    check (credential_key_version between 1 and 32767),
  credential_version bigint not null default 1
    check (credential_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on table private.subscription_credential_vault is
  'Application-layer encrypted subscription service credentials. It stores ciphertext, IV, authentication tag and metadata only; plaintext is never persisted.';

-- Explicit people are grants, while a current System Admin remains an implicit
-- administrator. Auth-user IDs are the authorization boundary; person IDs are
-- retained solely for a safe System Admin picker and must resolve to an active
-- linked account every time the capability is checked.
create table private.subscription_credential_access_grants (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  person_id uuid not null unique references public.internal_org_people (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.subscription_credential_access_grants is
  'Explicit vault delegates. Access remains conditional on the active portal account and current linked employee relationship.';

create table private.subscription_credential_audit_events (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references private.subscription_register (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in ('revealed', 'saved', 'removed')),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.subscription_credential_audit_events is
  'Append-only vault audit. It records only subscription identifier, actor, action and time; it never records plaintext, ciphertext or field values.';

create table private.subscription_credential_access_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users (id) on delete set null,
  delegate_count smallint not null check (delegate_count between 0 and 24),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.subscription_credential_access_audit_events is
  'Append-only access-grant audit. It records only actor, timestamp and delegate count; it does not preserve people or secret values.';

alter table private.subscription_credential_vault enable row level security;
alter table private.subscription_credential_access_grants enable row level security;
alter table private.subscription_credential_audit_events enable row level security;
alter table private.subscription_credential_access_audit_events enable row level security;

revoke all on table private.subscription_credential_vault from public, anon, authenticated;
revoke all on table private.subscription_credential_access_grants from public, anon, authenticated;
revoke all on table private.subscription_credential_audit_events from public, anon, authenticated;
revoke all on table private.subscription_credential_access_audit_events from public, anon, authenticated;

create index subscription_credential_audit_subscription_created_idx
  on private.subscription_credential_audit_events (subscription_id, created_at desc);
create index subscription_credential_audit_actor_created_idx
  on private.subscription_credential_audit_events (actor_user_id, created_at desc)
  where actor_user_id is not null;

create function private.is_current_subscription_credential_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or (
      private.has_current_portal_access()
      and exists (
        select 1
        from private.subscription_credential_access_grants access_grant
        join public.profiles profile
          on profile.id = access_grant.auth_user_id
          and profile.account_status = 'active'
          and profile.login_name is not null
        join public.internal_org_people person
          on person.id = access_grant.person_id
          and person.auth_user_id = profile.id
          and person.node_kind = 'person'
          and person.is_active
        where access_grant.auth_user_id = (select auth.uid())
      )
    );
$$;

create function public.can_manage_subscription_credentials()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_current_subscription_credential_manager();
$$;

create function public.can_manage_subscription_credential_grants()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

-- The credential vault is a separate, explicit capability. Do not let the
-- historical manager-register projection make the company-wide operational
-- subscription register visible to every manager. Employees retain their
-- existing own-subscription projection through its separate RPC.
create or replace function public.can_view_subscription_register()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_manage_subscription_credentials() is
  'Returns true for the active System Admin or an active linked employee explicitly granted subscription credential access.';
comment on function public.can_manage_subscription_credential_grants() is
  'Returns true only for the active System Admin that may replace explicit subscription credential grants.';

-- Delegates receive only service identity, status and whether an encrypted
-- credential exists. Costs, owners, members and review data remain in the
-- System-Admin-only subscription register.
create function public.list_subscription_credential_catalogue()
returns table (
  subscription_id uuid,
  service_name text,
  plan_name text,
  subscription_status text,
  credentials_saved boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_current_subscription_credential_manager() then
    raise exception 'You do not have permission to access subscription credentials.' using errcode = '42501';
  end if;

  return query
  select
    subscription.id,
    subscription.service_name,
    coalesce(subscription.plan_name, ''::text),
    subscription.subscription_status,
    exists (
      select 1
      from private.subscription_credential_vault credential
      where credential.subscription_id = subscription.id
    )
  from private.subscription_register subscription
  order by lower(subscription.service_name), subscription.id;
end;
$$;

-- This function returns encrypted material only to the server-side action for
-- an explicitly authorised viewer. It records the reveal without recording
-- the credential itself.
create function public.get_subscription_credential(
  p_subscription_id uuid
)
returns table (
  credential_ciphertext text,
  credential_iv text,
  credential_auth_tag text,
  credential_key_version integer,
  credential_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_credential private.subscription_credential_vault%rowtype;
begin
  if v_actor_user_id is null or not private.is_current_subscription_credential_manager() then
    raise exception 'You do not have permission to access subscription credentials.' using errcode = '42501';
  end if;
  if p_subscription_id is null then
    raise exception 'The subscription credential request is invalid.' using errcode = '22023';
  end if;

  perform 1
  from private.subscription_register subscription
  where subscription.id = p_subscription_id;
  if not found then
    raise exception 'The subscription credential request is invalid.' using errcode = '22023';
  end if;

  select credential.*
  into v_credential
  from private.subscription_credential_vault credential
  where credential.subscription_id = p_subscription_id;
  if not found then
    return;
  end if;

  insert into private.subscription_credential_audit_events (
    subscription_id,
    actor_user_id,
    event_type
  ) values (
    p_subscription_id,
    v_actor_user_id,
    'revealed'
  );

  return query
  select
    v_credential.credential_ciphertext,
    v_credential.credential_iv,
    v_credential.credential_auth_tag,
    v_credential.credential_key_version::integer,
    v_credential.credential_version;
end;
$$;

create function public.save_subscription_credential(
  p_subscription_id uuid,
  p_expected_credential_version bigint,
  p_credential_ciphertext text,
  p_credential_iv text,
  p_credential_auth_tag text,
  p_credential_key_version integer
)
returns table (
  credential_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_current private.subscription_credential_vault%rowtype;
  v_next_version bigint;
begin
  if v_actor_user_id is null or not private.is_current_subscription_credential_manager() then
    raise exception 'You do not have permission to manage subscription credentials.' using errcode = '42501';
  end if;
  if p_subscription_id is null
    or p_expected_credential_version is null
    or p_expected_credential_version < 0
    or p_credential_key_version is null
    or p_credential_key_version not between 1 and 32767
    or p_credential_ciphertext is null
    or p_credential_ciphertext !~ '^[A-Za-z0-9_-]+$'
    or char_length(p_credential_ciphertext) > 32768
    or p_credential_iv is null
    or p_credential_iv !~ '^[A-Za-z0-9_-]{16}$'
    or p_credential_auth_tag is null
    or p_credential_auth_tag !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception 'The subscription credential request is invalid.' using errcode = '22023';
  end if;

  perform 1
  from private.subscription_register subscription
  where subscription.id = p_subscription_id;
  if not found then
    raise exception 'The subscription credential request is invalid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-credential:' || p_subscription_id::text, 0)
  );
  select credential.*
  into v_current
  from private.subscription_credential_vault credential
  where credential.subscription_id = p_subscription_id
  for update;

  if found then
    if v_current.credential_version <> p_expected_credential_version then
      raise exception 'The subscription credential version changed.' using errcode = '40001';
    end if;
    v_next_version := v_current.credential_version + 1;
    update private.subscription_credential_vault credential
    set credential_ciphertext = p_credential_ciphertext,
        credential_iv = p_credential_iv,
        credential_auth_tag = p_credential_auth_tag,
        credential_key_version = p_credential_key_version,
        credential_version = v_next_version,
        updated_at = clock_timestamp(),
        updated_by = v_actor_user_id
    where credential.subscription_id = p_subscription_id;
  else
    if p_expected_credential_version <> 0 then
      raise exception 'The subscription credential version changed.' using errcode = '40001';
    end if;
    v_next_version := 1;
    insert into private.subscription_credential_vault (
      subscription_id,
      credential_ciphertext,
      credential_iv,
      credential_auth_tag,
      credential_key_version,
      credential_version,
      created_by,
      updated_by
    ) values (
      p_subscription_id,
      p_credential_ciphertext,
      p_credential_iv,
      p_credential_auth_tag,
      p_credential_key_version,
      v_next_version,
      v_actor_user_id,
      v_actor_user_id
    );
  end if;

  insert into private.subscription_credential_audit_events (
    subscription_id,
    actor_user_id,
    event_type
  ) values (
    p_subscription_id,
    v_actor_user_id,
    'saved'
  );

  return query select v_next_version;
end;
$$;

create function public.remove_subscription_credential(
  p_subscription_id uuid,
  p_expected_credential_version bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_current_version bigint;
begin
  if v_actor_user_id is null or not private.is_current_subscription_credential_manager() then
    raise exception 'You do not have permission to manage subscription credentials.' using errcode = '42501';
  end if;
  if p_subscription_id is null
    or p_expected_credential_version is null
    or p_expected_credential_version < 1 then
    raise exception 'The subscription credential request is invalid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-credential:' || p_subscription_id::text, 0)
  );
  select credential.credential_version
  into v_current_version
  from private.subscription_credential_vault credential
  where credential.subscription_id = p_subscription_id
  for update;
  if not found or v_current_version <> p_expected_credential_version then
    raise exception 'The subscription credential version changed.' using errcode = '40001';
  end if;

  delete from private.subscription_credential_vault credential
  where credential.subscription_id = p_subscription_id;

  insert into private.subscription_credential_audit_events (
    subscription_id,
    actor_user_id,
    event_type
  ) values (
    p_subscription_id,
    v_actor_user_id,
    'removed'
  );
end;
$$;

create function public.list_subscription_credential_access_grants()
returns table (
  person_id uuid,
  full_name text,
  position_title text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage credential access.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title
  from private.subscription_credential_access_grants access_grant
  join public.internal_org_people person
    on person.id = access_grant.person_id
    and person.auth_user_id = access_grant.auth_user_id
    and person.node_kind = 'person'
    and person.is_active
  join public.profiles profile
    on profile.id = access_grant.auth_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null
  order by lower(person.full_name), person.id;
end;
$$;

-- The picker is deliberately narrower than the general subscription people
-- endpoint: it only returns active employees that are already linked to an
-- active portal account, exactly matching the grant validation below.
create function public.list_subscription_credential_grant_candidates()
returns table (
  person_id uuid,
  full_name text,
  position_title text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage credential access.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title
  from public.internal_org_people person
  join public.profiles profile
    on profile.id = person.auth_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$$;

create function public.replace_subscription_credential_access_grants(
  p_person_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_person_ids uuid[] := coalesce(p_person_ids, array[]::uuid[]);
  v_requested_count integer := coalesce(cardinality(v_person_ids), 0);
  v_unique_count integer;
  v_valid_count integer;
begin
  if v_actor_user_id is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage credential access.' using errcode = '42501';
  end if;
  if v_requested_count > 24 then
    raise exception 'Choose no more than 24 credential delegates.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_person_ids) as requested(person_id) where requested.person_id is null) then
    raise exception 'Choose valid active employees for credential access.' using errcode = '22023';
  end if;

  select count(distinct requested.person_id)::integer
  into v_unique_count
  from unnest(v_person_ids) as requested(person_id);
  if v_unique_count <> v_requested_count then
    raise exception 'Choose each credential delegate only once.' using errcode = '22023';
  end if;

  select count(*)::integer
  into v_valid_count
  from public.internal_org_people person
  join public.profiles profile
    on profile.id = person.auth_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null
  where person.id = any(v_person_ids)
    and person.node_kind = 'person'
    and person.is_active;
  if v_valid_count <> v_requested_count then
    raise exception 'Choose active employees with active portal accounts for credential access.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-credential-access-grants', 0)
  );
  delete from private.subscription_credential_access_grants;
  insert into private.subscription_credential_access_grants (
    auth_user_id,
    person_id,
    granted_by
  )
  select
    profile.id,
    person.id,
    v_actor_user_id
  from public.internal_org_people person
  join public.profiles profile
    on profile.id = person.auth_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null
  where person.id = any(v_person_ids)
    and person.node_kind = 'person'
    and person.is_active;

  insert into private.subscription_credential_access_audit_events (
    actor_user_id,
    delegate_count
  ) values (
    v_actor_user_id,
    v_requested_count
  );
end;
$$;

revoke all on function private.is_current_subscription_credential_manager()
  from public, anon, authenticated;
revoke all on function public.can_manage_subscription_credentials()
  from public, anon, authenticated;
revoke all on function public.can_manage_subscription_credential_grants()
  from public, anon, authenticated;
revoke all on function public.can_view_subscription_register()
  from public, anon, authenticated;
revoke all on function public.list_subscription_credential_catalogue()
  from public, anon, authenticated;
revoke all on function public.get_subscription_credential(uuid)
  from public, anon, authenticated;
revoke all on function public.save_subscription_credential(uuid, bigint, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.remove_subscription_credential(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.list_subscription_credential_access_grants()
  from public, anon, authenticated;
revoke all on function public.list_subscription_credential_grant_candidates()
  from public, anon, authenticated;
revoke all on function public.replace_subscription_credential_access_grants(uuid[])
  from public, anon, authenticated;

grant execute on function public.can_manage_subscription_credentials()
  to authenticated;
grant execute on function public.can_manage_subscription_credential_grants()
  to authenticated;
grant execute on function public.can_view_subscription_register()
  to authenticated;
grant execute on function public.list_subscription_credential_catalogue()
  to authenticated;
grant execute on function public.get_subscription_credential(uuid)
  to authenticated;
grant execute on function public.save_subscription_credential(uuid, bigint, text, text, text, integer)
  to authenticated;
grant execute on function public.remove_subscription_credential(uuid, bigint)
  to authenticated;
grant execute on function public.list_subscription_credential_access_grants()
  to authenticated;
grant execute on function public.list_subscription_credential_grant_candidates()
  to authenticated;
grant execute on function public.replace_subscription_credential_access_grants(uuid[])
  to authenticated;

commit;
