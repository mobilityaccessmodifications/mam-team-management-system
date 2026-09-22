begin;

-- Named register delegates are distinct from credential-vault delegates and
-- System Admins. Names are resolved once below, never used for runtime access.
create table private.subscription_management_grants (
  person_id uuid primary key references public.internal_org_people(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table private.subscription_management_grants enable row level security;
revoke all on private.subscription_management_grants from public, anon, authenticated, service_role;

create or replace function public.can_manage_subscriptions()
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.is_system_portal_account_admin() or (
    (select auth.uid()) is not null
    and coalesce(((select auth.jwt())->>'is_anonymous')::boolean, false) = false
    and private.has_current_portal_access()
    and private.is_active_linked_internal_employee((select auth.uid()))
    and exists (
      select 1 from private.subscription_management_grants grant_row
      join public.internal_org_people person on person.id = grant_row.person_id
      join public.profiles profile on profile.id = person.auth_user_id
      where person.auth_user_id = (select auth.uid())
        and person.is_active and person.node_kind = 'person'
        and profile.account_status = 'active' and profile.login_name is not null
    )
  );
$$;

create or replace function public.can_view_subscription_register()
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.can_view_people_operational_tabs() or public.can_manage_subscriptions();
$$;

-- Empty synthetic databases have no roster. A real/partial roster must resolve
-- both explicitly requested people uniquely, or the migration fails closed.
do $$
declare target_name text; target_id uuid; matches integer;
begin
  if exists (select 1 from public.internal_org_people where lower(btrim(full_name)) in ('europe karki', 'luke symes')) then
    foreach target_name in array array['europe karki', 'luke symes'] loop
      select count(*), (array_agg(person.id))[1] into matches, target_id
      from public.internal_org_people person
      join public.profiles profile on profile.id = person.auth_user_id
      where lower(btrim(person.full_name)) = target_name
        and person.node_kind = 'person' and person.is_active
        and profile.account_status = 'active' and profile.login_name is not null;
      if matches <> 1 then
        raise exception 'Subscription manager % must resolve to one active linked employee; found %.', target_name, matches;
      end if;
      insert into private.subscription_management_grants(person_id) values (target_id);
    end loop;
  end if;
end;
$$;

alter table private.subscription_register add column company_scope text
  check (company_scope in ('mam', 'equipsy', 'both'));
comment on column private.subscription_register.company_scope is
  'Company using the subscription: MAM, Equipsy or both. NULL means not yet classified; never inferred from owner or payment card.';

alter table private.subscription_audit_events drop constraint subscription_audit_changed_fields_valid;
alter table private.subscription_audit_events add constraint subscription_audit_changed_fields_valid check (
  changed_fields <@ array[
    'service_name','plan_name','subscription_status','pricing_model','billing_cycle',
    'amount_cents','currency_code','renewal_date','next_review_on','responsible_person_id',
    'member_person_ids','seat_count','mam_credit_card_used','credit_card_used',
    'credit_card_holder','billing_anchor_date','company_scope'
  ]::text[]
);

-- Preserve the established validation/audit/version logic verbatim. Change only
-- the six named register guards; do not widen account or vault capabilities.
do $$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.list_subscription_people()',
    'public.create_subscription_v2(text,text,text,text,integer,date,integer,boolean,date,uuid,uuid[])',
    'public.update_subscription_v2(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,date,uuid,uuid[])',
    'public.create_subscription_v3(text,text,text,text,integer,date,integer,boolean,text,date,uuid,uuid[])',
    'public.update_subscription_v3(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,uuid[])',
    'public.mark_subscription_reviewed_v2(uuid,bigint)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if strpos(definition, 'not private.is_system_portal_account_admin()') = 0 then
      raise exception 'Unexpected subscription guard in %', signature;
    end if;
    execute replace(definition, 'not private.is_system_portal_account_admin()', 'not public.can_manage_subscriptions()');
  end loop;
  definition := pg_get_functiondef('private.subscription_register_v2_projection(uuid)'::regprocedure);
  if strpos(definition, '''subscription_id'', subscription.id,') = 0 then
    raise exception 'Unexpected subscription projection';
  end if;
  execute replace(definition, '''subscription_id'', subscription.id,',
    '''company_scope'', subscription.company_scope, ''subscription_id'', subscription.id,');
end;
$$;

create function private.set_subscription_company(p_subscription_id uuid, p_company_scope text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.can_manage_subscriptions() then
    raise exception 'You do not have permission to manage subscriptions.' using errcode = '42501';
  end if;
  if p_company_scope is null or p_company_scope not in ('mam','equipsy','both') then
    raise exception 'Choose MAM, Equipsy or Both.' using errcode = '22023';
  end if;
  update private.subscription_register set company_scope = p_company_scope, updated_by = (select auth.uid())
  where id = p_subscription_id and company_scope is distinct from p_company_scope;
  if found then
    insert into private.subscription_audit_events(subscription_id, actor_user_id, event_type, changed_fields)
    values (p_subscription_id, (select auth.uid()), 'updated', array['company_scope']);
  end if;
end;
$$;
revoke all on function private.set_subscription_company(uuid,text) from public, anon, authenticated, service_role;

create function public.create_subscription_v4(
  p_service_name text, p_plan_name text, p_pricing_model text, p_billing_cycle text,
  p_amount_cents integer, p_renewal_date date, p_seat_count integer, p_credit_card_used boolean,
  p_credit_card_holder text, p_billing_anchor_date date, p_responsible_person_id uuid,
  p_company_scope text, p_member_person_ids uuid[] default array[]::uuid[]
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare result jsonb; target_id uuid;
begin
  if not public.can_manage_subscriptions() then
    raise exception 'You do not have permission to create subscriptions.' using errcode = '42501';
  end if;
  result := public.create_subscription_v3(p_service_name,p_plan_name,p_pricing_model,p_billing_cycle,
    p_amount_cents,p_renewal_date,p_seat_count,p_credit_card_used,p_credit_card_holder,
    p_billing_anchor_date,p_responsible_person_id,p_member_person_ids);
  target_id := (result->>'subscription_id')::uuid;
  perform private.set_subscription_company(target_id,p_company_scope);
  return (select item from private.subscription_register_v2_projection(target_id) as projection(item));
end;
$$;

create function public.update_subscription_v4(
  p_subscription_id uuid, p_expected_version bigint, p_service_name text, p_plan_name text,
  p_subscription_status text, p_pricing_model text, p_billing_cycle text, p_amount_cents integer,
  p_renewal_date date, p_seat_count integer, p_credit_card_used boolean, p_credit_card_holder text,
  p_billing_anchor_date date, p_responsible_person_id uuid, p_company_scope text,
  p_member_person_ids uuid[] default array[]::uuid[]
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.can_manage_subscriptions() then
    raise exception 'You do not have permission to update subscriptions.' using errcode = '42501';
  end if;
  -- The existing update locks the record and checks the expected version;
  -- the company update remains in that same transaction and lock.
  perform public.update_subscription_v3(p_subscription_id,p_expected_version,p_service_name,p_plan_name,
    p_subscription_status,p_pricing_model,p_billing_cycle,p_amount_cents,p_renewal_date,p_seat_count,
    p_credit_card_used,p_credit_card_holder,p_billing_anchor_date,p_responsible_person_id,p_member_person_ids);
  perform private.set_subscription_company(p_subscription_id,p_company_scope);
  return (select item from private.subscription_register_v2_projection(p_subscription_id) as projection(item));
end;
$$;

revoke all on function public.create_subscription_v4(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.update_subscription_v4(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.create_subscription_v4(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[]) to authenticated;
grant execute on function public.update_subscription_v4(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[]) to authenticated;
comment on function public.can_manage_subscriptions() is
  'System Admin or an active linked employee with an explicit register-management grant; no vault or account administration access.';

commit;
