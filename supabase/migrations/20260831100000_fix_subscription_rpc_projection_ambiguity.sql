begin;

-- The initial subscription functions return a table whose output names overlap
-- with columns from the projection. In PL/pgSQL, unqualified references then
-- become ambiguous at runtime. Keep the public signatures and authorization
-- model unchanged; explicitly qualify every projection column instead.
do $$
begin
  if to_regprocedure('private.subscription_register_projection()') is null
    or to_regprocedure('public.can_view_subscription_register()') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regclass('private.subscription_register') is null
    or to_regclass('private.subscription_memberships') is null then
    raise exception 'Subscription RPC repair prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.list_subscriptions()
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
  select projection.*
  from private.subscription_register_projection() as projection
  order by projection.next_review_on asc, lower(projection.service_name), projection.subscription_id;
end;
$$;

create or replace function public.create_subscription(
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
  select projection.*
  from private.subscription_register_projection() as projection
  where projection.subscription_id = v_subscription.id;
end;
$$;

create or replace function public.update_subscription(
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

  if cardinality(v_changed_fields) = 0 then
    return query
    select projection.*
    from private.subscription_register_projection() as projection
    where projection.subscription_id = v_subscription.id;
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
  select projection.*
  from private.subscription_register_projection() as projection
  where projection.subscription_id = v_subscription.id;
end;
$$;

create or replace function public.mark_subscription_reviewed(
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
  select projection.*
  from private.subscription_register_projection() as projection
  where projection.subscription_id = v_subscription.id;
end;
$$;

commit;
