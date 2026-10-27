begin;
set local search_path = '';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control', 0));
lock table private.confirmed_test_identity_purges, private.confirmed_test_purge_schema
  in share row exclusive mode nowait;
do $$ begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription team access requires the reviewed predecessor catalog.' using errcode = '55000';
  end if;
end $$;

create function public.update_subscription_members_v1(
  p_subscription_id uuid,
  p_expected_version bigint,
  p_member_person_ids uuid[]
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  target private.subscription_register%rowtype;
  members uuid[];
  previous_members uuid[];
begin
  if actor is null or not private.lock_subscription_role_authority(false) then
    raise exception 'Subscription register permission is required.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1
    or p_member_person_ids is null or cardinality(p_member_person_ids) > 250
    or array_position(p_member_person_ids, null) is not null then
    raise exception 'Choose valid team members for subscription access.' using errcode = '22023';
  end if;
  select coalesce(array_agg(person_id order by person_id), array[]::uuid[]) into members
  from (select distinct unnest(p_member_person_ids) as person_id) selected;

  select subscription.* into target from private.subscription_register subscription
  where subscription.id = p_subscription_id for update;
  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if target.version <> p_expected_version then
    raise exception 'This subscription has changed. Reload access before saving.' using errcode = '40001';
  end if;
  perform 1 from public.internal_org_people person
  where person.id = any(members) order by person.id for share;
  if (select count(*) from public.internal_org_people person
      where person.id = any(members) and person.node_kind = 'person' and person.is_active) <> cardinality(members) then
    raise exception 'Choose active team members for subscription access.' using errcode = '23503';
  end if;
  select coalesce(array_agg(membership.person_id order by membership.person_id), array[]::uuid[])
  into previous_members from private.subscription_memberships membership
  where membership.subscription_id = target.id;

  if members is distinct from previous_members then
    update private.subscription_register set updated_by = actor where id = target.id;
    delete from private.subscription_memberships membership
    where membership.subscription_id = target.id and not (membership.person_id = any(members));
    insert into private.subscription_memberships(subscription_id, person_id, created_by)
    select target.id, selected.person_id, actor from unnest(members) selected(person_id)
    where not (selected.person_id = any(previous_members));
    insert into private.subscription_audit_events(subscription_id, actor_user_id, event_type, changed_fields)
    values(target.id, actor, 'updated', array['member_person_ids']);
  end if;
  return (select item from private.subscription_register_v2_projection(target.id) projection(item));
end;
$$;
revoke all on function public.update_subscription_members_v1(uuid,bigint,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.update_subscription_members_v1(uuid,bigint,uuid[]) to authenticated;

set constraints all immediate;
update private.confirmed_test_purge_schema set schema_hash = private.confirmed_test_purge_schema_hash() where singleton;
commit;
