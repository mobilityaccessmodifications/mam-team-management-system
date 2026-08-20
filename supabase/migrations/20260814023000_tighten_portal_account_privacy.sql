begin;

-- Account administrators consume a deliberately narrow summary RPC instead
-- of receiving row access to every present and future profile column.
drop policy if exists profiles_select_account_admin on public.profiles;

create function public.list_portal_account_summaries()
returns table (
  id uuid,
  login_name text,
  account_status text,
  account_version bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select profile.id, profile.login_name, profile.account_status, profile.account_version
  from public.profiles profile
  where private.is_portal_account_admin();
$$;

revoke all on function public.list_portal_account_summaries()
  from public, anon, authenticated;
grant execute on function public.list_portal_account_summaries()
  to authenticated;

-- Claiming a password reset is coordination only. Do not mutate the account's
-- public optimistic version until the external Auth password change succeeds.
create or replace function public.begin_portal_password_reset(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_expected_account_version bigint
)
returns table (
  person_id uuid,
  auth_user_id uuid,
  login_name text,
  account_status text,
  account_version bigint,
  reset_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_token uuid := gen_random_uuid();
  v_version bigint;
  v_login_name text;
  v_status text;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can reset a password.'
      using errcode = '42501';
  end if;

  if p_expected_account_version is null then
    raise exception 'The expected account version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  if exists (
    select 1
    from private.portal_password_reset_claims claim
    where claim.auth_user_id = p_auth_user_id
      and claim.status = 'pending'
      and claim.claimed_at > clock_timestamp() - interval '10 minutes'
  ) then
    raise exception 'A password reset is already in progress. Refresh and try again.'
      using errcode = '40001';
  end if;

  update private.portal_password_reset_claims claim
  set status = 'cancelled',
      cancelled_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.status = 'pending';

  select profile.account_version, profile.login_name, profile.account_status
  into v_version, v_login_name, v_status
  from public.profiles profile
  where profile.id = p_auth_user_id
    and profile.account_version = p_expected_account_version
    and profile.login_name is not null
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.auth_user_id = p_auth_user_id
        and person.node_kind = 'person'
        and person.is_active
    )
  for update;

  if not found then
    raise exception 'The account changed or no longer exists. Refresh and try again.'
      using errcode = '40001';
  end if;

  insert into private.portal_password_reset_claims (
    auth_user_id,
    person_id,
    reset_token,
    claimed_by,
    claimed_at,
    status,
    claimed_account_version,
    final_account_version,
    finalised_at,
    cancelled_at
  )
  values (
    p_auth_user_id,
    p_person_id,
    v_token,
    v_actor,
    clock_timestamp(),
    'pending',
    v_version,
    null,
    null,
    null
  )
  on conflict (auth_user_id) do update
  set person_id = excluded.person_id,
      reset_token = excluded.reset_token,
      claimed_by = excluded.claimed_by,
      claimed_at = excluded.claimed_at,
      status = excluded.status,
      claimed_account_version = excluded.claimed_account_version,
      final_account_version = null,
      finalised_at = null,
      cancelled_at = null;

  return query
  select p_person_id, p_auth_user_id, v_login_name, v_status, v_version, v_token;
end;
$$;

commit;
