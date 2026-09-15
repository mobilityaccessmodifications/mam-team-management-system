begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:subscription-credit-card-holder:20260915', 0)
  );

  if to_regclass('private.subscription_register') is null
    or to_regclass('private.subscription_audit_events') is null
    or to_regprocedure('private.subscription_register_v2_projection(uuid)') is null
    or to_regprocedure('public.create_subscription_v2(text,text,text,text,integer,date,integer,boolean,date,uuid,uuid[])') is null
    or to_regprocedure('public.update_subscription_v2(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,date,uuid,uuid[])') is null then
    raise exception 'Subscription credit-card holder prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

alter table private.subscription_register
  add column credit_card_holder text,
  drop constraint subscription_register_free_billing_details_empty,
  add constraint subscription_register_credit_card_holder_valid check (
    credit_card_holder is null
    or (
      mam_credit_card_used is true
      and credit_card_holder = btrim(credit_card_holder)
      and char_length(credit_card_holder) between 1 and 160
    )
  ),
  add constraint subscription_register_free_billing_details_empty check (
    pricing_model = 'paid'
    or (
      seat_count is null
      and mam_credit_card_used is null
      and credit_card_holder is null
      and billing_anchor_date is null
    )
  );

comment on column private.subscription_register.mam_credit_card_used is
  'Whether the paid service is charged to a company or staff credit card. The legacy column name is retained for compatibility.';
comment on column private.subscription_register.credit_card_holder is
  'Free-text cardholder or company-card name. Never store a card number, expiry date or security code.';

create function private.normalise_subscription_credit_card_holder()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  new.credit_card_holder := nullif(btrim(new.credit_card_holder), '');
  if new.mam_credit_card_used is distinct from true then
    new.credit_card_holder := null;
  end if;
  return new;
end;
$$;

create trigger subscription_register_normalise_credit_card_holder
before insert or update of mam_credit_card_used, credit_card_holder
on private.subscription_register
for each row execute function private.normalise_subscription_credit_card_holder();

comment on function private.normalise_subscription_credit_card_holder() is
  'Clears stale cardholder text whenever a subscription is free or no credit card is used.';
revoke all on function private.normalise_subscription_credit_card_holder() from public, anon, authenticated, service_role;

alter table private.subscription_audit_events
  drop constraint subscription_audit_changed_fields_valid;
alter table private.subscription_audit_events
  add constraint subscription_audit_changed_fields_valid check (
    changed_fields <@ array[
      'service_name', 'plan_name', 'subscription_status', 'pricing_model',
      'billing_cycle', 'amount_cents', 'currency_code', 'renewal_date',
      'next_review_on', 'responsible_person_id', 'member_person_ids',
      'seat_count', 'mam_credit_card_used', 'credit_card_used',
      'credit_card_holder', 'billing_anchor_date'
    ]::text[]
  );

create or replace function private.subscription_register_v2_projection(p_subscription_id uuid default null)
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
    'credit_card_used', subscription.mam_credit_card_used,
    'credit_card_holder', subscription.credit_card_holder,
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

create function public.create_subscription_v3(
  p_service_name text,
  p_plan_name text,
  p_pricing_model text,
  p_billing_cycle text,
  p_amount_cents integer,
  p_renewal_date date,
  p_seat_count integer,
  p_credit_card_used boolean,
  p_credit_card_holder text,
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
  v_holder text := nullif(btrim(coalesce(p_credit_card_holder, '')), '');
  created jsonb;
  subscription_id uuid;
begin
  if actor is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to create subscriptions.' using errcode = '42501';
  end if;
  if lower(btrim(coalesce(p_pricing_model, ''))) = 'paid'
    and p_credit_card_used is true
    and (v_holder is null or char_length(v_holder) > 160) then
    raise exception 'Enter a cardholder or card name.' using errcode = '22023';
  end if;
  if lower(btrim(coalesce(p_pricing_model, ''))) <> 'paid'
    or p_credit_card_used is distinct from true then
    v_holder := null;
  end if;

  created := public.create_subscription_v2(
    p_service_name,
    p_plan_name,
    p_pricing_model,
    p_billing_cycle,
    p_amount_cents,
    p_renewal_date,
    p_seat_count,
    p_credit_card_used,
    p_billing_anchor_date,
    p_responsible_person_id,
    p_member_person_ids
  );
  subscription_id := (created->>'subscription_id')::uuid;

  if v_holder is not null then
    update private.subscription_register target
    set credit_card_holder = v_holder,
        updated_by = actor
    where target.id = subscription_id;

    insert into private.subscription_audit_events (
      subscription_id,
      actor_user_id,
      event_type,
      changed_fields
    ) values (
      subscription_id,
      actor,
      'updated',
      array['credit_card_holder']::text[]
    );
  end if;

  return (
    select projection.item
    from private.subscription_register_v2_projection(subscription_id) as projection(item)
  );
end;
$$;

create function public.update_subscription_v3(
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
  p_credit_card_used boolean,
  p_credit_card_holder text,
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
  v_holder text := nullif(btrim(coalesce(p_credit_card_holder, '')), '');
  previous_holder text;
begin
  if actor is null or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to update subscriptions.' using errcode = '42501';
  end if;
  if lower(btrim(coalesce(p_pricing_model, ''))) = 'paid'
    and p_credit_card_used is true
    and (v_holder is null or char_length(v_holder) > 160) then
    raise exception 'Enter a cardholder or card name.' using errcode = '22023';
  end if;
  if lower(btrim(coalesce(p_pricing_model, ''))) <> 'paid'
    or p_credit_card_used is distinct from true then
    v_holder := null;
  end if;

  select target.credit_card_holder into previous_holder
  from private.subscription_register target
  where target.id = p_subscription_id;

  perform public.update_subscription_v2(
    p_subscription_id,
    p_expected_version,
    p_service_name,
    p_plan_name,
    p_subscription_status,
    p_pricing_model,
    p_billing_cycle,
    p_amount_cents,
    p_renewal_date,
    p_seat_count,
    p_credit_card_used,
    p_billing_anchor_date,
    p_responsible_person_id,
    p_member_person_ids
  );

  if v_holder is distinct from previous_holder then
    update private.subscription_register target
    set credit_card_holder = v_holder,
        updated_by = actor
    where target.id = p_subscription_id
      and target.credit_card_holder is distinct from v_holder;

    insert into private.subscription_audit_events (
      subscription_id,
      actor_user_id,
      event_type,
      changed_fields
    ) values (
      p_subscription_id,
      actor,
      'updated',
      array['credit_card_holder']::text[]
    );
  end if;

  return (
    select projection.item
    from private.subscription_register_v2_projection(p_subscription_id) as projection(item)
  );
end;
$$;

comment on function public.create_subscription_v3(text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[]) is
  'Creates a subscription with generic credit-card use and an audited free-text cardholder or company-card name.';
comment on function public.update_subscription_v3(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[]) is
  'Updates a subscription with generic credit-card details and optimistic versioning.';

revoke all on function public.create_subscription_v3(text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.update_subscription_v3(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[]) from public, anon, authenticated, service_role;

grant execute on function public.create_subscription_v3(text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[]) to authenticated;
grant execute on function public.update_subscription_v3(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[]) to authenticated;

commit;
