begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-management:20260828', 0)
  );

  if to_regclass('public.internal_org_people') is null
    or to_regclass('public.profiles') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_active_linked_internal_employee(uuid)') is null then
    raise exception 'Subscription-management prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Subscription access is an operational record, not a credential vault. Any
-- usernames, passwords, passcodes or recovery codes remain in the approved
-- password manager and are intentionally absent from this schema and its RPCs.
create sequence private.subscription_code_sequence
  as bigint
  start with 1
  increment by 1
  minvalue 1;

create table private.subscription_register (
  id uuid primary key default gen_random_uuid(),
  subscription_code text not null,
  service_name text not null,
  plan_name text,
  subscription_status text not null default 'active',
  pricing_model text not null default 'free',
  billing_cycle text,
  amount_cents integer,
  currency_code text not null default 'AUD',
  renewal_date date,
  next_review_on date not null,
  responsible_person_id uuid not null references public.internal_org_people (id) on delete restrict,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version bigint not null default 1,
  constraint subscription_register_code_format check (subscription_code ~ '^MAM-SUB-[0-9]{6,}$'),
  constraint subscription_register_service_name_valid check (char_length(btrim(service_name)) between 1 and 160),
  constraint subscription_register_plan_name_valid check (plan_name is null or char_length(btrim(plan_name)) between 1 and 160),
  constraint subscription_register_status_valid check (subscription_status in ('active', 'paused', 'cancelled')),
  constraint subscription_register_pricing_model_valid check (pricing_model in ('free', 'paid')),
  constraint subscription_register_billing_cycle_valid check (billing_cycle is null or billing_cycle in ('monthly', 'quarterly', 'annual', 'other')),
  constraint subscription_register_currency_valid check (currency_code = 'AUD'),
  constraint subscription_register_amount_valid check (amount_cents is null or amount_cents >= 0),
  constraint subscription_register_paid_terms_valid check (
    (pricing_model = 'free' and billing_cycle is null and amount_cents is null)
    or (pricing_model = 'paid' and billing_cycle is not null and amount_cents is not null)
  ),
  constraint subscription_register_version_positive check (version > 0)
);

comment on table private.subscription_register is
  'System Admin-managed MAM subscriptions. Records ownership, renewal and quarterly review cadence but never credentials, passcodes or recovery information.';

create unique index subscription_register_code_unique_idx
  on private.subscription_register (lower(subscription_code));

create index subscription_register_review_idx
  on private.subscription_register (next_review_on, responsible_person_id)
  where subscription_status in ('active', 'paused');

create table private.subscription_memberships (
  subscription_id uuid not null references private.subscription_register (id) on delete cascade,
  person_id uuid not null references public.internal_org_people (id) on delete restrict,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (subscription_id, person_id)
);

comment on table private.subscription_memberships is
  'Employee access assignments for the subscription register. Active employees may only read their own non-cancelled assignments through a narrow RPC.';

create index subscription_memberships_person_idx
  on private.subscription_memberships (person_id, subscription_id);

create table private.subscription_audit_events (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references private.subscription_register (id) on delete restrict,
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in ('created', 'updated', 'reviewed')),
  changed_fields text[] not null default array[]::text[],
  created_at timestamptz not null default clock_timestamp(),
  constraint subscription_audit_changed_fields_valid check (
    changed_fields <@ array[
      'service_name', 'plan_name', 'subscription_status', 'pricing_model',
      'billing_cycle', 'amount_cents', 'currency_code', 'renewal_date',
      'next_review_on', 'responsible_person_id', 'member_person_ids'
    ]::text[]
  )
);

comment on table private.subscription_audit_events is
  'Append-only subscription audit. It records only actor, event type and changed field names, never credential values or price history.';

alter table private.subscription_register enable row level security;
alter table private.subscription_memberships enable row level security;
alter table private.subscription_audit_events enable row level security;

revoke all on table private.subscription_register from public, anon, authenticated;
revoke all on table private.subscription_memberships from public, anon, authenticated;
revoke all on table private.subscription_audit_events from public, anon, authenticated;
revoke all on sequence private.subscription_code_sequence from public, anon, authenticated;

create function private.is_active_subscription_person(
  p_person_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.node_kind = 'person'
        and person.is_active
    );
$$;

create function private.validate_subscription_register_people()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_active_subscription_person(new.responsible_person_id) then
    raise exception 'Choose an active employee responsible for this subscription.' using errcode = '23503';
  end if;
  return new;
end;
$$;

create function private.validate_subscription_membership_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_active_subscription_person(new.person_id) then
    raise exception 'Choose active employees for subscription access.' using errcode = '23503';
  end if;
  return new;
end;
$$;

create function private.set_subscription_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger subscription_register_validate_people
before insert or update of responsible_person_id on private.subscription_register
for each row execute function private.validate_subscription_register_people();

create trigger subscription_memberships_validate_person
before insert or update of person_id on private.subscription_memberships
for each row execute function private.validate_subscription_membership_person();

create trigger subscription_register_set_updated_at
before update on private.subscription_register
for each row execute function private.set_subscription_updated_at();

-- Managers have a read-only operational register. Controlled System Admin
-- accounts are the only mutation boundary. HR and director users must be
-- promoted to system_admin in profiles.app_role; titles never grant access.
create function public.can_view_subscription_register()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or (
      private.has_current_portal_access()
      and private.is_active_linked_internal_employee((select auth.uid()))
      and exists (
        select 1
        from public.profiles profile
        where profile.id = (select auth.uid())
          and profile.app_role = 'manager'
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
    );
$$;

create function public.can_manage_subscriptions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

-- This is intentionally separate from the management-register capability:
-- every active linked employee can read only their own safe subscription DTO,
-- while managers and System Admins can read the operational register.
create function public.can_access_own_subscriptions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_active_portal_employee_id() is not null;
$$;

comment on function public.can_view_subscription_register() is
  'Returns whether the current active System Admin or manager may read the credential-free subscription register.';

comment on function public.can_manage_subscriptions() is
  'Returns whether the current active System Admin may create, edit, assign or review subscriptions.';

comment on function public.can_access_own_subscriptions() is
  'Returns whether the current active linked employee may access their own safe subscription projection.';

create function private.subscription_register_projection()
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  amount_cents integer,
  currency_code text,
  renewal_date date,
  next_review_on date,
  responsible_person_id uuid,
  responsible_person_name text,
  responsible_person_title text,
  member_person_ids uuid[],
  member_names text[],
  created_at timestamptz,
  version bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    subscription.id,
    subscription.subscription_code,
    subscription.service_name,
    subscription.plan_name,
    subscription.subscription_status,
    subscription.pricing_model,
    subscription.billing_cycle,
    subscription.amount_cents,
    subscription.currency_code,
    subscription.renewal_date,
    subscription.next_review_on,
    owner.id,
    owner.full_name,
    owner.position_title,
    coalesce(array_agg(member.id order by lower(member.full_name), member.id) filter (where member.id is not null), array[]::uuid[]),
    coalesce(array_agg(member.full_name order by lower(member.full_name), member.id) filter (where member.id is not null), array[]::text[]),
    subscription.created_at,
    subscription.version
  from private.subscription_register subscription
  join public.internal_org_people owner on owner.id = subscription.responsible_person_id
  left join private.subscription_memberships membership on membership.subscription_id = subscription.id
  left join public.internal_org_people member on member.id = membership.person_id
  group by subscription.id, owner.id;
$$;

create function public.list_subscriptions()
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  amount_cents integer,
  currency_code text,
  renewal_date date,
  next_review_on date,
  responsible_person_id uuid,
  responsible_person_name text,
  responsible_person_title text,
  member_person_ids uuid[],
  member_names text[],
  created_at timestamptz,
  version bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_view_subscription_register() then
    raise exception 'You do not have permission to access subscriptions.' using errcode = '42501';
  end if;

  return query
  select *
  from private.subscription_register_projection()
  order by next_review_on asc, lower(service_name), subscription_id;
end;
$$;

create function public.list_subscription_people()
returns table (
  person_id uuid,
  full_name text,
  position_title text,
  team_name text,
  company_key text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage subscriptions.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title,
    coalesce(detail.team_name, ''::text),
    person.company_key
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$$;

create function public.create_subscription(
  p_service_name text,
  p_plan_name text,
  p_pricing_model text,
  p_billing_cycle text,
  p_amount_cents integer,
  p_renewal_date date,
  p_responsible_person_id uuid,
  p_member_person_ids uuid[] default array[]::uuid[]
)
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  amount_cents integer,
  currency_code text,
  renewal_date date,
  next_review_on date,
  responsible_person_id uuid,
  responsible_person_name text,
  responsible_person_title text,
  member_person_ids uuid[],
  member_names text[],
  created_at timestamptz,
  version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_service_name text := btrim(coalesce(p_service_name, ''));
  v_plan_name text := nullif(btrim(coalesce(p_plan_name, '')), '');
  v_pricing_model text := lower(btrim(coalesce(p_pricing_model, '')));
  v_billing_cycle text := nullif(lower(btrim(coalesce(p_billing_cycle, ''))), '');
  v_member_person_ids uuid[] := coalesce(p_member_person_ids, array[]::uuid[]);
  v_subscription_code text;
  v_subscription private.subscription_register%rowtype;
  v_active_member_count integer;
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to create subscriptions.' using errcode = '42501';
  end if;

  if char_length(v_service_name) < 1 or char_length(v_service_name) > 160 then
    raise exception 'Service name must be between 1 and 160 characters.' using errcode = '22023';
  end if;
  if v_plan_name is not null and char_length(v_plan_name) > 160 then
    raise exception 'Plan name must be 160 characters or fewer.' using errcode = '22023';
  end if;
  if v_pricing_model not in ('free', 'paid') then
    raise exception 'Choose whether this subscription is free or paid.' using errcode = '22023';
  end if;
  if v_pricing_model = 'paid' and (v_billing_cycle not in ('monthly', 'quarterly', 'annual', 'other') or p_amount_cents is null or p_amount_cents < 0) then
    raise exception 'Paid subscriptions need a billing cycle and a valid amount.' using errcode = '22023';
  end if;
  if v_pricing_model = 'free' then
    v_billing_cycle := null;
    p_amount_cents := null;
  end if;
  if not private.is_active_subscription_person(p_responsible_person_id) then
    raise exception 'Choose an active employee responsible for this subscription.' using errcode = '23503';
  end if;

  select count(*) into v_active_member_count
  from (
    select distinct member_id
    from unnest(v_member_person_ids) as selected(member_id)
  ) members
  join public.internal_org_people person on person.id = members.member_id
  where person.node_kind = 'person'
    and person.is_active;

  if v_active_member_count <> cardinality(array(select distinct member_id from unnest(v_member_person_ids) as selected(member_id))) then
    raise exception 'Choose active employees for subscription access.' using errcode = '23503';
  end if;

  v_subscription_code := 'MAM-SUB-' || lpad(
    nextval('private.subscription_code_sequence'::regclass)::text,
    6,
    '0'
  );

  insert into private.subscription_register (
    subscription_code,
    service_name,
    plan_name,
    pricing_model,
    billing_cycle,
    amount_cents,
    renewal_date,
    next_review_on,
    responsible_person_id,
    created_by,
    updated_by
  )
  values (
    v_subscription_code,
    v_service_name,
    v_plan_name,
    v_pricing_model,
    v_billing_cycle,
    p_amount_cents,
    p_renewal_date,
    (current_date + interval '3 months')::date,
    p_responsible_person_id,
    v_actor_user_id,
    v_actor_user_id
  )
  returning * into v_subscription;

  insert into private.subscription_memberships (subscription_id, person_id, created_by)
  select v_subscription.id, selected.member_id, v_actor_user_id
  from (
    select distinct member_id
    from unnest(v_member_person_ids) as selected(member_id)
  ) selected;

  insert into private.subscription_audit_events (subscription_id, actor_user_id, event_type, changed_fields)
  values (
    v_subscription.id,
    v_actor_user_id,
    'created',
    array_remove(array[
      'service_name',
      case when v_plan_name is not null then 'plan_name' end,
      'pricing_model',
      case when v_billing_cycle is not null then 'billing_cycle' end,
      case when p_amount_cents is not null then 'amount_cents' end,
      case when p_renewal_date is not null then 'renewal_date' end,
      'next_review_on',
      'responsible_person_id',
      case when cardinality(v_member_person_ids) > 0 then 'member_person_ids' end
    ]::text[], null)
  );

  return query
  select * from private.subscription_register_projection()
  where subscription_id = v_subscription.id;
end;
$$;

create function public.update_subscription(
  p_subscription_id uuid,
  p_expected_version bigint,
  p_service_name text,
  p_plan_name text,
  p_subscription_status text,
  p_pricing_model text,
  p_billing_cycle text,
  p_amount_cents integer,
  p_renewal_date date,
  p_responsible_person_id uuid,
  p_member_person_ids uuid[] default array[]::uuid[]
)
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  amount_cents integer,
  currency_code text,
  renewal_date date,
  next_review_on date,
  responsible_person_id uuid,
  responsible_person_name text,
  responsible_person_title text,
  member_person_ids uuid[],
  member_names text[],
  created_at timestamptz,
  version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_subscription private.subscription_register%rowtype;
  v_service_name text := btrim(coalesce(p_service_name, ''));
  v_plan_name text := nullif(btrim(coalesce(p_plan_name, '')), '');
  v_subscription_status text := lower(btrim(coalesce(p_subscription_status, '')));
  v_pricing_model text := lower(btrim(coalesce(p_pricing_model, '')));
  v_billing_cycle text := nullif(lower(btrim(coalesce(p_billing_cycle, ''))), '');
  v_member_person_ids uuid[] := coalesce(p_member_person_ids, array[]::uuid[]);
  v_active_member_count integer;
  v_previous_member_ids uuid[];
  v_previous_subscription private.subscription_register%rowtype;
  v_changed_fields text[];
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to update subscriptions.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;
  if char_length(v_service_name) < 1 or char_length(v_service_name) > 160 then
    raise exception 'Service name must be between 1 and 160 characters.' using errcode = '22023';
  end if;
  if v_plan_name is not null and char_length(v_plan_name) > 160 then
    raise exception 'Plan name must be 160 characters or fewer.' using errcode = '22023';
  end if;
  if v_subscription_status not in ('active', 'paused', 'cancelled') then
    raise exception 'Choose a valid subscription status.' using errcode = '22023';
  end if;
  if v_pricing_model not in ('free', 'paid') then
    raise exception 'Choose whether this subscription is free or paid.' using errcode = '22023';
  end if;
  if v_pricing_model = 'paid' and (v_billing_cycle not in ('monthly', 'quarterly', 'annual', 'other') or p_amount_cents is null or p_amount_cents < 0) then
    raise exception 'Paid subscriptions need a billing cycle and a valid amount.' using errcode = '22023';
  end if;
  if v_pricing_model = 'free' then
    v_billing_cycle := null;
    p_amount_cents := null;
  end if;
  if not private.is_active_subscription_person(p_responsible_person_id) then
    raise exception 'Choose an active employee responsible for this subscription.' using errcode = '23503';
  end if;

  select count(*) into v_active_member_count
  from (
    select distinct member_id
    from unnest(v_member_person_ids) as selected(member_id)
  ) members
  join public.internal_org_people person on person.id = members.member_id
  where person.node_kind = 'person'
    and person.is_active;
  if v_active_member_count <> cardinality(array(select distinct member_id from unnest(v_member_person_ids) as selected(member_id))) then
    raise exception 'Choose active employees for subscription access.' using errcode = '23503';
  end if;

  select coalesce(array_agg(members.member_id order by members.member_id), array[]::uuid[])
  into v_member_person_ids
  from (
    select distinct selected.member_id
    from unnest(v_member_person_ids) as selected(member_id)
  ) members;

  select subscription.* into v_subscription
  from private.subscription_register subscription
  where subscription.id = p_subscription_id
  for update;

  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if v_subscription.version <> p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode = '40001';
  end if;

  v_previous_subscription := v_subscription;

  select coalesce(array_agg(membership.person_id order by membership.person_id), array[]::uuid[])
  into v_previous_member_ids
  from private.subscription_memberships membership
  where membership.subscription_id = v_subscription.id;

  v_changed_fields := array_remove(array[
    case when v_service_name is distinct from v_previous_subscription.service_name then 'service_name' end,
    case when v_plan_name is distinct from v_previous_subscription.plan_name then 'plan_name' end,
    case when v_subscription_status is distinct from v_previous_subscription.subscription_status then 'subscription_status' end,
    case when v_pricing_model is distinct from v_previous_subscription.pricing_model then 'pricing_model' end,
    case when v_billing_cycle is distinct from v_previous_subscription.billing_cycle then 'billing_cycle' end,
    case when p_amount_cents is distinct from v_previous_subscription.amount_cents then 'amount_cents' end,
    case when p_renewal_date is distinct from v_previous_subscription.renewal_date then 'renewal_date' end,
    case when p_responsible_person_id is distinct from v_previous_subscription.responsible_person_id then 'responsible_person_id' end,
    case when v_member_person_ids is distinct from v_previous_member_ids then 'member_person_ids' end
  ]::text[], null);

  -- A no-op edit should not bump the optimistic version or create an audit
  -- event that claims something was changed.
  if cardinality(v_changed_fields) = 0 then
    return query
    select * from private.subscription_register_projection()
    where subscription_id = v_subscription.id;
    return;
  end if;

  update private.subscription_register subscription
  set service_name = v_service_name,
      plan_name = v_plan_name,
      subscription_status = v_subscription_status,
      pricing_model = v_pricing_model,
      billing_cycle = v_billing_cycle,
      amount_cents = p_amount_cents,
      renewal_date = p_renewal_date,
      responsible_person_id = p_responsible_person_id,
      updated_by = v_actor_user_id
  where subscription.id = v_subscription.id
  returning * into v_subscription;

  delete from private.subscription_memberships membership
  where membership.subscription_id = v_subscription.id;
  insert into private.subscription_memberships (subscription_id, person_id, created_by)
  select v_subscription.id, selected.member_id, v_actor_user_id
  from (
    select distinct member_id
    from unnest(v_member_person_ids) as selected(member_id)
  ) selected;

  insert into private.subscription_audit_events (subscription_id, actor_user_id, event_type, changed_fields)
  values (
    v_subscription.id,
    v_actor_user_id,
    'updated',
    v_changed_fields
  );

  return query
  select * from private.subscription_register_projection()
  where subscription_id = v_subscription.id;
end;
$$;

create function public.mark_subscription_reviewed(
  p_subscription_id uuid,
  p_expected_version bigint
)
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  amount_cents integer,
  currency_code text,
  renewal_date date,
  next_review_on date,
  responsible_person_id uuid,
  responsible_person_name text,
  responsible_person_title text,
  member_person_ids uuid[],
  member_names text[],
  created_at timestamptz,
  version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_subscription private.subscription_register%rowtype;
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to review subscriptions.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;

  select subscription.* into v_subscription
  from private.subscription_register subscription
  where subscription.id = p_subscription_id
  for update;
  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if v_subscription.version <> p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode = '40001';
  end if;
  if v_subscription.subscription_status = 'cancelled' then
    raise exception 'Cancelled subscriptions cannot be reviewed.' using errcode = '22023';
  end if;

  update private.subscription_register subscription
  set next_review_on = (current_date + interval '3 months')::date,
      updated_by = v_actor_user_id
  where subscription.id = v_subscription.id
  returning * into v_subscription;

  insert into private.subscription_audit_events (subscription_id, actor_user_id, event_type, changed_fields)
  values (v_subscription.id, v_actor_user_id, 'reviewed', array['next_review_on']::text[]);

  return query
  select * from private.subscription_register_projection()
  where subscription_id = v_subscription.id;
end;
$$;

-- The self-service projection is intentionally small: a person sees only the
-- subscriptions they are assigned to, with no price, owner, credential or
-- other employees' access information.
create function public.list_my_subscriptions()
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  renewal_date date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid := private.current_active_portal_employee_id();
begin
  if v_person_id is null then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;

  return query
  select
    subscription.id,
    subscription.subscription_code,
    subscription.service_name,
    subscription.plan_name,
    subscription.subscription_status,
    subscription.pricing_model,
    subscription.billing_cycle,
    subscription.renewal_date
  from private.subscription_memberships membership
  join private.subscription_register subscription on subscription.id = membership.subscription_id
  join public.internal_org_people person on person.id = membership.person_id
  where membership.person_id = v_person_id
    and person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
    and subscription.subscription_status <> 'cancelled'
  order by lower(subscription.service_name), subscription.id;
end;
$$;

create function public.list_employee_subscriptions_for_preview(
  p_person_id uuid
)
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  renewal_date date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can preview employee subscriptions.' using errcode = '42501';
  end if;
  if p_person_id is null
    or not private.is_active_subscription_person(p_person_id) then
    raise exception 'The selected employee profile is unavailable.' using errcode = '23503';
  end if;

  return query
  select
    subscription.id,
    subscription.subscription_code,
    subscription.service_name,
    subscription.plan_name,
    subscription.subscription_status,
    subscription.pricing_model,
    subscription.billing_cycle,
    subscription.renewal_date
  from private.subscription_memberships membership
  join private.subscription_register subscription on subscription.id = membership.subscription_id
  where membership.person_id = p_person_id
    and subscription.subscription_status <> 'cancelled'
  order by lower(subscription.service_name), subscription.id;
end;
$$;

revoke all on function private.is_active_subscription_person(uuid) from public, anon, authenticated;
revoke all on function private.validate_subscription_register_people() from public, anon, authenticated;
revoke all on function private.validate_subscription_membership_person() from public, anon, authenticated;
revoke all on function private.set_subscription_updated_at() from public, anon, authenticated;
revoke all on function private.subscription_register_projection() from public, anon, authenticated;
revoke all on function public.can_view_subscription_register() from public, anon, authenticated;
revoke all on function public.can_manage_subscriptions() from public, anon, authenticated;
revoke all on function public.can_access_own_subscriptions() from public, anon, authenticated;
revoke all on function public.list_subscriptions() from public, anon, authenticated;
revoke all on function public.list_subscription_people() from public, anon, authenticated;
revoke all on function public.create_subscription(text, text, text, text, integer, date, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.update_subscription(uuid, bigint, text, text, text, text, text, integer, date, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.mark_subscription_reviewed(uuid, bigint) from public, anon, authenticated;
revoke all on function public.list_my_subscriptions() from public, anon, authenticated;
revoke all on function public.list_employee_subscriptions_for_preview(uuid) from public, anon, authenticated;

grant execute on function public.can_view_subscription_register() to authenticated;
grant execute on function public.can_manage_subscriptions() to authenticated;
grant execute on function public.can_access_own_subscriptions() to authenticated;
grant execute on function public.list_subscriptions() to authenticated;
grant execute on function public.list_subscription_people() to authenticated;
grant execute on function public.create_subscription(text, text, text, text, integer, date, uuid, uuid[]) to authenticated;
grant execute on function public.update_subscription(uuid, bigint, text, text, text, text, text, integer, date, uuid, uuid[]) to authenticated;
grant execute on function public.mark_subscription_reviewed(uuid, bigint) to authenticated;
grant execute on function public.list_my_subscriptions() to authenticated;
grant execute on function public.list_employee_subscriptions_for_preview(uuid) to authenticated;

commit;
