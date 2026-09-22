begin;

-- A narrow patch avoids requiring or overwriting legacy billing fields when
-- a register manager changes ownership, company or status for several rows.
create function public.patch_subscription_v1(
  p_subscription_id uuid,
  p_expected_version bigint,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  current_row private.subscription_register%rowtype;
  changed_fields text[] := array[]::text[];
  assignments text[] := array[]::text[];
  next_responsible uuid;
begin
  if actor is null or coalesce(((select auth.jwt())->>'is_anonymous')::boolean, false)
    or not public.can_manage_subscriptions() then
    raise exception 'You do not have permission to update subscriptions.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'Choose at least one field to update.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_patch) item
    where item.key not in ('company_scope', 'subscription_status', 'responsible_person_id')
      or jsonb_typeof(item.value) <> 'string') then
    raise exception 'Choose valid subscription fields.' using errcode = '22023';
  end if;
  if p_patch ? 'company_scope' and p_patch->>'company_scope' not in ('mam', 'equipsy', 'both') then
    raise exception 'Choose MAM, Equipsy or Both.' using errcode = '22023';
  end if;
  if p_patch ? 'subscription_status' and p_patch->>'subscription_status' not in ('active', 'paused', 'cancelled') then
    raise exception 'Choose a valid subscription status.' using errcode = '22023';
  end if;
  if p_patch ? 'responsible_person_id' then
    if (p_patch->>'responsible_person_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Choose an active responsible employee.' using errcode = '22023';
    end if;
    next_responsible := (p_patch->>'responsible_person_id')::uuid;
    if not private.is_active_subscription_person(next_responsible) then
      raise exception 'Choose an active responsible employee.' using errcode = '23503';
    end if;
  end if;

  select target.* into current_row from private.subscription_register target
  where target.id = p_subscription_id for update;
  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if current_row.version <> p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode = '40001';
  end if;

  if p_patch ? 'company_scope' and current_row.company_scope is distinct from p_patch->>'company_scope' then
    changed_fields := array_append(changed_fields, 'company_scope');
    assignments := array_append(assignments, 'company_scope = $1->>''company_scope''');
  end if;
  if p_patch ? 'subscription_status' and current_row.subscription_status is distinct from p_patch->>'subscription_status' then
    changed_fields := array_append(changed_fields, 'subscription_status');
    assignments := array_append(assignments, 'subscription_status = $1->>''subscription_status''');
  end if;
  if p_patch ? 'responsible_person_id' and current_row.responsible_person_id is distinct from next_responsible then
    changed_fields := array_append(changed_fields, 'responsible_person_id');
    assignments := array_append(assignments, 'responsible_person_id = ($1->>''responsible_person_id'')::uuid');
  end if;

  if cardinality(changed_fields) > 0 then
    -- Only fixed SQL fragments enter the statement; all values are bound.
    -- Omitting untouched columns also avoids their UPDATE OF validators.
    execute 'update private.subscription_register set ' || array_to_string(assignments, ', ')
      || ', updated_by = $2 where id = $3'
      using p_patch, actor, p_subscription_id;
    insert into private.subscription_audit_events(subscription_id, actor_user_id, event_type, changed_fields)
    values(p_subscription_id, actor, 'updated', changed_fields);
  end if;

  return (select jsonb_build_object('id', target.id, 'version', target.version)
    from private.subscription_register target where target.id = p_subscription_id);
end;
$$;
revoke all on function public.patch_subscription_v1(uuid,bigint,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.patch_subscription_v1(uuid,bigint,jsonb) to authenticated;
comment on function public.patch_subscription_v1(uuid,bigint,jsonb) is
  'Version-checked subscription management patch. Changes only selected company, status or responsible employee; existing management grants and audit apply.';

commit;
