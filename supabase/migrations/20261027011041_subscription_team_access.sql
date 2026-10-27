begin;
set local search_path = '';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control', 0));
lock table private.confirmed_test_identity_purges, private.confirmed_test_purge_schema
  in share row exclusive mode nowait;
do $subscription_import_catalog$
declare
  stored_hash text;
  current_hash text;
  query text;
  definitions text[];
  removed_hash text;
  previous_hash text;
  import_line text := E'  if private.consume_existing_subscription_import(to_jsonb(new), tg_op) then return new; end if;\n';
begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1 then
    raise exception 'Exact subscription predecessor fingerprint required.' using errcode = '55000';
  end if;
  select schema_hash into stored_hash from private.confirmed_test_purge_schema where singleton;
  current_hash := private.confirmed_test_purge_schema_hash();
  if stored_hash = current_hash then return; end if;
  select prosrc into query from pg_proc where oid = 'private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query, 'sha256'), 'hex') <> 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Subscription catalog collector differs.' using errcode = '55000';
  end if;
  query := replace(query,
    $aggregate$select encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex') from ($aggregate$,
    'select array_agg(definition order by definition) from (');
  execute query into definitions;
  select encode(extensions.digest(coalesce(string_agg(definition, E'\n' order by definition collate "C"), ''), 'sha256'), 'hex')
  into removed_hash from (
    select replace(replace(definition, ':' || 'postgres'::regrole::oid || ':', ':owner:'),
      'arwdDxtm/postgres', 'arwdDxt/postgres') as definition
    from unnest(definitions) item(definition)
    where definition like 'private.existing_subscription_imports:%'
      or definition like 'private.existing_subscription_imports_pkey:%'
      or definition like 'CREATE OR REPLACE FUNCTION private.consume_existing_subscription_import(%'
      or definition like 'private.consume_existing_subscription_import(%'
  ) removed;
  if removed_hash <> 'd4592e880795ee83b6083b69d8ba1a6b67b591516d4fe8eb2cb9485c349a93af' then
    raise exception 'Existing subscription import catalog differs.' using errcode = '55000';
  end if;
  select encode(extensions.digest(coalesce(string_agg(replace(definition, import_line, ''),
    E'\n' order by replace(definition, import_line, '') collate "C"), ''), 'sha256'), 'hex')
  into previous_hash from unnest(definitions) item(definition)
  where definition not like 'private.existing_subscription_imports:%'
    and definition not like 'private.existing_subscription_imports_pkey:%'
    and definition not like 'CREATE OR REPLACE FUNCTION private.consume_existing_subscription_import(%'
    and definition not like 'private.consume_existing_subscription_import(%';
  if previous_hash is distinct from stored_hash then
    raise exception 'Unreviewed subscription predecessor catalog drift.' using errcode = '55000';
  end if;
  update private.confirmed_test_purge_schema set schema_hash = current_hash
    where singleton and schema_hash = stored_hash;
  if not found then
    raise exception 'Subscription predecessor fingerprint changed.' using errcode = '55000';
  end if;
end;
$subscription_import_catalog$;
do $$ begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription team access requires the reviewed predecessor catalog.' using errcode = '55000';
  end if;
  perform set_config('mam.subscription_team_access.previous_hash', private.confirmed_test_purge_schema_hash(), true);
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
do $subscription_team_catalog$
declare query text; previous_hash text; resulting_hash text;
begin
  select prosrc into query from pg_proc where oid = 'private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query, 'sha256'), 'hex') <> 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Subscription catalog collector differs.' using errcode = '55000';
  end if;
  query := replace(query, ') definitions;', $filter$) definitions
    where not starts_with(definition, 'CREATE OR REPLACE FUNCTION public.update_subscription_members_v1(')
      and not starts_with(definition, 'public.update_subscription_members_v1(');$filter$);
  execute query into previous_hash;
  if previous_hash is distinct from current_setting('mam.subscription_team_access.previous_hash') then
    raise exception 'Unreviewed catalog change during subscription team access migration.' using errcode = '55000';
  end if;
  resulting_hash := private.confirmed_test_purge_schema_hash();
  update private.confirmed_test_purge_schema set schema_hash = resulting_hash
    where singleton and schema_hash = previous_hash;
  if not found or private.confirmed_test_purge_schema_hash() is distinct from resulting_hash then
    raise exception 'Subscription team access catalog readback differs.' using errcode = '55000';
  end if;
end;
$subscription_team_catalog$;
commit;
