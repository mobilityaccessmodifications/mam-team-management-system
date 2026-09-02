begin;

do $$
begin
  if to_regprocedure('public.replace_subscription_credential_access_grants(uuid[])') is null
    or to_regclass('private.subscription_credential_access_grants') is null
    or to_regclass('private.subscription_credential_access_audit_events') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null then
    raise exception 'Subscription credential grant repair prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- The production database enforces a safe-update rule that rejects an
-- unqualified DELETE. Keep the replacement semantics, but make the intended
-- all-current-grants operation explicit and reviewable.
create or replace function public.replace_subscription_credential_access_grants(
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
  delete from private.subscription_credential_access_grants access_grant
  where access_grant.auth_user_id is not null;
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

revoke all on function public.replace_subscription_credential_access_grants(uuid[])
  from public, anon, authenticated;
grant execute on function public.replace_subscription_credential_access_grants(uuid[])
  to authenticated;

commit;
