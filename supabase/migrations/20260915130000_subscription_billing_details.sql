begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-billing-details:20260915', 0)
  );

  if to_regclass('private.subscription_register') is null
    or to_regclass('private.subscription_memberships') is null
    or to_regclass('private.subscription_audit_events') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_subscription_person(uuid)') is null
    or to_regprocedure('private.next_paid_subscription_quarter_review_on(date)') is null
    or to_regprocedure('public.can_view_subscription_register()') is null then
    raise exception 'Subscription billing detail prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

alter table private.subscription_register
  add column seat_count integer,
  add column mam_credit_card_used boolean,
  add column billing_anchor_date date,
  add constraint subscription_register_seat_count_valid check (
    seat_count is null or seat_count between 1 and 100000
  ),
  add constraint subscription_register_free_billing_details_empty check (
    pricing_model = 'paid'
    or (seat_count is null and mam_credit_card_used is null and billing_anchor_date is null)
  );

comment on column private.subscription_register.seat_count is
  'Recorded number of paid seats or licences. Null on legacy paid rows means the value still needs review.';
comment on column private.subscription_register.mam_credit_card_used is
  'Whether the paid service is charged to a MAM credit card. Null on legacy paid rows means not yet reviewed.';
comment on column private.subscription_register.billing_anchor_date is
  'A known billing occurrence used to calculate the next monthly, quarterly or annual billing date.';

alter table private.subscription_audit_events
  drop constraint if exists subscription_audit_changed_fields_valid;
alter table private.subscription_audit_events
  add constraint subscription_audit_changed_fields_valid check (
    changed_fields <@ array[
      'service_name', 'plan_name', 'subscription_status', 'pricing_model',
      'billing_cycle', 'amount_cents', 'currency_code', 'renewal_date',
      'next_review_on', 'responsible_person_id', 'member_person_ids',
      'seat_count', 'mam_credit_card_used', 'billing_anchor_date'
    ]::text[]
  );

create function private.next_subscription_billing_on(
  p_anchor_date date,
  p_billing_cycle text,
  p_reference_date date default private.mam_local_calendar_date()
)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  interval_months integer;
  elapsed_months integer;
  interval_count integer;
  candidate date;
  reference_date date := coalesce(p_reference_date, private.mam_local_calendar_date());
begin
  if p_anchor_date is null or p_billing_cycle not in ('monthly', 'quarterly', 'annual') then
    return null;
  end if;
  if p_anchor_date >= reference_date then
    return p_anchor_date;
  end if;
  interval_months := case p_billing_cycle when 'monthly' then 1 when 'quarterly' then 3 else 12 end;
  elapsed_months := (extract(year from age(reference_date, p_anchor_date))::integer * 12)
    + extract(month from age(reference_date, p_anchor_date))::integer;
  interval_count := greatest(0, elapsed_months / interval_months);
  candidate := (p_anchor_date + make_interval(months => interval_count * interval_months))::date;
  if candidate < reference_date then
    candidate := (p_anchor_date + make_interval(months => (interval_count + 1) * interval_months))::date;
  end if;
  return candidate;
end;
$$;

comment on function private.next_subscription_billing_on(date, text, date) is
  'Calculates the next on-or-after billing date from a known billing occurrence, preserving the anchor day where the calendar allows it.';

create function private.subscription_register_v2_projection(p_subscription_id uuid default null)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'subscription_id', subscription.id,
    'subscription_code', subscription.subscription_code,
    'service_name', subscription.service_name,
    'plan_name', subscription.plan_name,
    'subscription_status', subscription.subscription_status,
    'pricing_model', subscription.pricing_model,
    'billing_cycle', subscription.billing_cycle,
    'amount_cents', subscription.amount_cents,
    'currency_code', subscription.currency_code,
    'renewal_date', subscription.renewal_date,
    'seat_count', subscription.seat_count,
    'mam_credit_card_used', subscription.mam_credit_card_used,
    'billing_anchor_date', subscription.billing_anchor_date,
    'next_billing_on', private.next_subscription_billing_on(
      subscription.billing_anchor_date,
      subscription.billing_cycle,
      private.mam_local_calendar_date()
    ),
    'last_reviewed_on', (
      select max((event.created_at at time zone 'Australia/Melbourne')::date)
      from private.subscription_audit_events event
      where event.subscription_id = subscription.id
        and event.event_type = 'reviewed'
    ),
    'next_review_on', subscription.next_review_on,
    'responsible_person_id', owner.id,
    'responsible_person_name', owner.full_name,
    'responsible_person_title', owner.position_title,
    'member_person_ids', coalesce(
      array_agg(member.id order by lower(member.full_name), member.id) filter (where member.id is not null),
      array[]::uuid[]
    ),
    'member_names', coalesce(
      array_agg(member.full_name order by lower(member.full_name), member.id) filter (where member.id is not null),
      array[]::text[]
    ),
    'created_at', subscription.created_at,
    'version', subscription.version
  )
  from private.subscription_register subscription
  join public.internal_org_people owner on owner.id = subscription.responsible_person_id
  left join private.subscription_memberships membership on membership.subscription_id = subscription.id
  left join public.internal_org_people member on member.id = membership.person_id
  where p_subscription_id is null or subscription.id = p_subscription_id
  group by subscription.id, owner.id;
$$;

create function public.list_subscriptions_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_view_subscription_register() then
    raise exception 'You do not have permission to access subscriptions.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(projection.item order by (projection.item->>'next_review_on')::date, lower(projection.item->>'service_name'), projection.item->>'subscription_id')
    from private.subscription_register_v2_projection() as projection(item)
  ), '[]'::jsonb);
end;
$$;

create function public.create_subscription_v2(
  p_service_name text,
  p_plan_name text,
  p_pricing_model text,
  p_billing_cycle text,
  p_amount_cents integer,
  p_renewal_date date,
  p_seat_count integer,
  p_mam_credit_card_used boolean,
  p_billing_anchor_date date,
  p_responsible_person_id uuid,
  p_member_person_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  v_service_name text := btrim(coalesce(p_service_name, ''));
  v_plan_name text := nullif(btrim(coalesce(p_plan_name, '')), '');
  v_pricing_model text := lower(btrim(coalesce(p_pricing_model, '')));
  v_billing_cycle text := nullif(lower(btrim(coalesce(p_billing_cycle, ''))), '');
  v_member_ids uuid[];
  v_subscription_code text;
  v_subscription private.subscription_register%rowtype;
  active_member_count integer;
begin
  if actor is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to create subscriptions.' using errcode = '42501';
  end if;
  if char_length(v_service_name) not between 1 and 160
    or (v_plan_name is not null and char_length(v_plan_name) > 160) then
    raise exception 'Enter a valid service and plan name.' using errcode = '22023';
  end if;
  if v_pricing_model not in ('free', 'paid') then
    raise exception 'Choose whether this subscription is free or paid.' using errcode = '22023';
  end if;
  if v_pricing_model = 'paid' and (
    v_billing_cycle not in ('monthly', 'quarterly', 'annual', 'other')
    or p_amount_cents is null or p_amount_cents not between 0 and 100000000
    or p_seat_count is null or p_seat_count not between 1 and 100000
    or p_mam_credit_card_used is null
    or p_billing_anchor_date is null
  ) then
    raise exception 'Paid subscriptions need billing, seat and payment-card details.' using errcode = '22023';
  end if;
  if v_pricing_model = 'free' then
    v_billing_cycle := null;
    p_amount_cents := null;
    p_seat_count := null;
    p_mam_credit_card_used := null;
    p_billing_anchor_date := null;
  end if;
  if not private.is_active_subscription_person(p_responsible_person_id) then
    raise exception 'Choose an active employee responsible for this subscription.' using errcode = '23503';
  end if;

  select coalesce(array_agg(selected.person_id order by selected.person_id), array[]::uuid[])
  into v_member_ids
  from (select distinct person_id from unnest(coalesce(p_member_person_ids, array[]::uuid[])) as item(person_id)) selected;
  if cardinality(v_member_ids) > 250 then
    raise exception 'Choose no more than 250 employees for subscription access.' using errcode = '22023';
  end if;
  select count(*) into active_member_count
  from public.internal_org_people person
  where person.id = any(v_member_ids)
    and person.node_kind = 'person'
    and person.is_active;
  if active_member_count <> cardinality(v_member_ids) then
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
    seat_count,
    mam_credit_card_used,
    billing_anchor_date,
    next_review_on,
    responsible_person_id,
    created_by,
    updated_by
  ) values (
    v_subscription_code,
    v_service_name,
    v_plan_name,
    v_pricing_model,
    v_billing_cycle,
    p_amount_cents,
    p_renewal_date,
    p_seat_count,
    p_mam_credit_card_used,
    p_billing_anchor_date,
    private.next_paid_subscription_quarter_review_on(),
    p_responsible_person_id,
    actor,
    actor
  ) returning * into v_subscription;

  insert into private.subscription_memberships (subscription_id, person_id, created_by)
  select v_subscription.id, selected.person_id, actor
  from unnest(v_member_ids) as selected(person_id);

  insert into private.subscription_audit_events (
    subscription_id,
    actor_user_id,
    event_type,
    changed_fields
  ) values (
    v_subscription.id,
    actor,
    'created',
    array_remove(array[
      'service_name',
      case when v_plan_name is not null then 'plan_name' end,
      'pricing_model',
      case when v_billing_cycle is not null then 'billing_cycle' end,
      case when p_amount_cents is not null then 'amount_cents' end,
      case when p_renewal_date is not null then 'renewal_date' end,
      case when p_seat_count is not null then 'seat_count' end,
      case when p_mam_credit_card_used is not null then 'mam_credit_card_used' end,
      case when p_billing_anchor_date is not null then 'billing_anchor_date' end,
      'next_review_on',
      'responsible_person_id',
      case when cardinality(v_member_ids) > 0 then 'member_person_ids' end
    ]::text[], null)
  );

  return (
    select projection.item
    from private.subscription_register_v2_projection(v_subscription.id) as projection(item)
  );
end;
$$;

create function public.update_subscription_v2(
  p_subscription_id uuid,
  p_expected_version bigint,
  p_service_name text,
  p_plan_name text,
  p_subscription_status text,
  p_pricing_model text,
  p_billing_cycle text,
  p_amount_cents integer,
  p_renewal_date date,
  p_seat_count integer,
  p_mam_credit_card_used boolean,
  p_billing_anchor_date date,
  p_responsible_person_id uuid,
  p_member_person_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  v_subscription private.subscription_register%rowtype;
  v_previous_subscription private.subscription_register%rowtype;
  v_service_name text := btrim(coalesce(p_service_name, ''));
  v_plan_name text := nullif(btrim(coalesce(p_plan_name, '')), '');
  v_subscription_status text := lower(btrim(coalesce(p_subscription_status, '')));
  v_pricing_model text := lower(btrim(coalesce(p_pricing_model, '')));
  v_billing_cycle text := nullif(lower(btrim(coalesce(p_billing_cycle, ''))), '');
  v_member_ids uuid[];
  v_previous_member_ids uuid[];
  active_member_count integer;
  v_changed_fields text[];
begin
  if actor is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to update subscriptions.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;
  if char_length(v_service_name) not between 1 and 160
    or (v_plan_name is not null and char_length(v_plan_name) > 160) then
    raise exception 'Enter a valid service and plan name.' using errcode = '22023';
  end if;
  if v_subscription_status not in ('active', 'paused', 'cancelled') then
    raise exception 'Choose a valid subscription status.' using errcode = '22023';
  end if;
  if v_pricing_model not in ('free', 'paid') then
    raise exception 'Choose whether this subscription is free or paid.' using errcode = '22023';
  end if;
  if v_pricing_model = 'paid' and (
    v_billing_cycle not in ('monthly', 'quarterly', 'annual', 'other')
    or p_amount_cents is null or p_amount_cents not between 0 and 100000000
    or p_seat_count is null or p_seat_count not between 1 and 100000
    or p_mam_credit_card_used is null
    or p_billing_anchor_date is null
  ) then
    raise exception 'Paid subscriptions need billing, seat and payment-card details.' using errcode = '22023';
  end if;
  if v_pricing_model = 'free' then
    v_billing_cycle := null;
    p_amount_cents := null;
    p_seat_count := null;
    p_mam_credit_card_used := null;
    p_billing_anchor_date := null;
  end if;
  if not private.is_active_subscription_person(p_responsible_person_id) then
    raise exception 'Choose an active employee responsible for this subscription.' using errcode = '23503';
  end if;

  select coalesce(array_agg(selected.person_id order by selected.person_id), array[]::uuid[])
  into v_member_ids
  from (select distinct person_id from unnest(coalesce(p_member_person_ids, array[]::uuid[])) as item(person_id)) selected;
  if cardinality(v_member_ids) > 250 then
    raise exception 'Choose no more than 250 employees for subscription access.' using errcode = '22023';
  end if;
  select count(*) into active_member_count
  from public.internal_org_people person
  where person.id = any(v_member_ids)
    and person.node_kind = 'person'
    and person.is_active;
  if active_member_count <> cardinality(v_member_ids) then
    raise exception 'Choose active employees for subscription access.' using errcode = '23503';
  end if;

  select target.* into v_subscription
  from private.subscription_register target
  where target.id = p_subscription_id
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
    case when p_seat_count is distinct from v_previous_subscription.seat_count then 'seat_count' end,
    case when p_mam_credit_card_used is distinct from v_previous_subscription.mam_credit_card_used then 'mam_credit_card_used' end,
    case when p_billing_anchor_date is distinct from v_previous_subscription.billing_anchor_date then 'billing_anchor_date' end,
    case when p_responsible_person_id is distinct from v_previous_subscription.responsible_person_id then 'responsible_person_id' end,
    case when v_member_ids is distinct from v_previous_member_ids then 'member_person_ids' end
  ]::text[], null);

  if cardinality(v_changed_fields) = 0 then
    return (
      select projection.item
      from private.subscription_register_v2_projection(v_subscription.id) as projection(item)
    );
  end if;

  update private.subscription_register target
  set service_name = v_service_name,
      plan_name = v_plan_name,
      subscription_status = v_subscription_status,
      pricing_model = v_pricing_model,
      billing_cycle = v_billing_cycle,
      amount_cents = p_amount_cents,
      renewal_date = p_renewal_date,
      seat_count = p_seat_count,
      mam_credit_card_used = p_mam_credit_card_used,
      billing_anchor_date = p_billing_anchor_date,
      responsible_person_id = p_responsible_person_id,
      updated_by = actor
  where target.id = v_subscription.id
  returning * into v_subscription;

  delete from private.subscription_memberships membership
  where membership.subscription_id = v_subscription.id;
  insert into private.subscription_memberships (subscription_id, person_id, created_by)
  select v_subscription.id, selected.person_id, actor
  from unnest(v_member_ids) as selected(person_id);

  insert into private.subscription_audit_events (
    subscription_id,
    actor_user_id,
    event_type,
    changed_fields
  ) values (v_subscription.id, actor, 'updated', v_changed_fields);

  return (
    select projection.item
    from private.subscription_register_v2_projection(v_subscription.id) as projection(item)
  );
end;
$$;

create function public.mark_subscription_reviewed_v2(
  p_subscription_id uuid,
  p_expected_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  v_subscription private.subscription_register%rowtype;
begin
  if actor is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to review subscriptions.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;
  select target.* into v_subscription
  from private.subscription_register target
  where target.id = p_subscription_id
  for update;
  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if v_subscription.version <> p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode = '40001';
  end if;
  if v_subscription.subscription_status not in ('active', 'paused')
    or v_subscription.pricing_model <> 'paid' then
    raise exception 'Only active paid subscriptions need a quarterly review.' using errcode = '22023';
  end if;

  update private.subscription_register target
  set next_review_on = private.next_paid_subscription_quarter_review_on(
        greatest(
          private.mam_local_calendar_date(),
          coalesce(v_subscription.next_review_on, private.mam_local_calendar_date())
        )
      ),
      updated_by = actor
  where target.id = v_subscription.id
  returning * into v_subscription;

  insert into private.subscription_audit_events (
    subscription_id,
    actor_user_id,
    event_type,
    changed_fields
  ) values (
    v_subscription.id,
    actor,
    'reviewed',
    array['next_review_on']::text[]
  );

  return (
    select projection.item
    from private.subscription_register_v2_projection(v_subscription.id) as projection(item)
  );
end;
$$;

comment on function public.list_subscriptions_v2() is
  'System Admin subscription register including paid seats, MAM card use, billing anchor, calculated next billing date and last review date.';
comment on function public.create_subscription_v2(text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[]) is
  'Creates a subscription with complete paid billing details through the System Admin boundary.';
comment on function public.update_subscription_v2(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[]) is
  'Updates a subscription with optimistic versioning and complete paid billing details through the System Admin boundary.';

revoke all on function private.next_subscription_billing_on(date, text, date) from public, anon, authenticated, service_role;
revoke all on function private.subscription_register_v2_projection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_subscriptions_v2() from public, anon, authenticated, service_role;
revoke all on function public.create_subscription_v2(text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.update_subscription_v2(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.mark_subscription_reviewed_v2(uuid, bigint) from public, anon, authenticated, service_role;

grant execute on function public.list_subscriptions_v2() to authenticated;
grant execute on function public.create_subscription_v2(text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[]) to authenticated;
grant execute on function public.update_subscription_v2(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[]) to authenticated;
grant execute on function public.mark_subscription_reviewed_v2(uuid, bigint) to authenticated;

commit;
