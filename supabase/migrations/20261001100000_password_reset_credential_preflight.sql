begin;

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

  perform c.id from private.employee_onboarding_credentials c
  where c.auth_user_id = p_auth_user_id or c.person_id = p_person_id
  for update;

  if exists (select 1 from private.employee_onboarding_credentials c
    where (c.auth_user_id = p_auth_user_id or c.person_id = p_person_id)
      and (c.status in ('claimed','sending') or (c.status = 'needs_review' and c.claimed_login is not null))) then
    raise exception 'Onboarding credential delivery in progress' using errcode = '55000';
  end if;

  if exists (
    select 1
    from private.portal_password_reset_claims claim
    where claim.auth_user_id = p_auth_user_id
      and claim.status = 'pending'
  ) then
    raise exception 'A password reset is already in progress. Refresh and try again.'
      using errcode = '40001';
  end if;

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
  for update nowait;

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
  on conflict on constraint portal_password_reset_claims_pkey do update
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
exception when lock_not_available then
  raise exception 'The account changed or no longer exists. Refresh and try again.'
    using errcode = '40001';
end;
$$;

revoke all on function public.begin_portal_password_reset(uuid, uuid, bigint) from public, anon;
grant execute on function public.begin_portal_password_reset(uuid, uuid, bigint) to authenticated, service_role;

create or replace function public.claim_due_onboarding_credentials(p_limit integer default 10)
returns table(delivery_id uuid,claim_token uuid,person_id uuid,auth_user_id uuid,login_name text,work_email text,personal_email text)
language plpgsql security definer set search_path = '' as $$
declare candidate private.employee_onboarding_credentials%rowtype; v_token uuid;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_limit < 1 or p_limit > 20 then raise exception 'Invalid limit' using errcode='22023'; end if;
  update private.employee_onboarding_credentials set status='needs_review',review_code='expired_claim',claim_token=null,claim_expires_at=null,updated_at=clock_timestamp()
    where status = 'claimed' and claim_expires_at < clock_timestamp();
  for candidate in
    select * from private.employee_onboarding_credentials c
    where c.status='scheduled' and c.due_date <= timezone('Australia/Melbourne',clock_timestamp())::date
    order by c.due_date,c.created_at for update skip locked limit p_limit
  loop
    if exists (select 1 from private.portal_password_reset_claims r
      where r.auth_user_id = candidate.auth_user_id and r.status = 'pending') then
      continue;
    end if;
    v_token := gen_random_uuid();
    update private.employee_onboarding_credentials c set status='claimed',claim_token=v_token,
      claim_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() where c.id=candidate.id;
    insert into private.employee_onboarding_credential_events(delivery_id,event_type) values(candidate.id,'claimed');
    return query select candidate.id,v_token,candidate.person_id,candidate.auth_user_id,p.login_name,
      lower(nullif(btrim(d.work_email),'')),lower(nullif(btrim(d.personal_email),''))
      from public.internal_org_people person
      left join public.profiles p on p.id=person.auth_user_id
      left join private.employee_directory_details d on d.person_id=person.id
      where person.id=candidate.person_id;
  end loop;
end $$;

revoke all on function public.claim_due_onboarding_credentials(integer) from public, anon, authenticated;
grant execute on function public.claim_due_onboarding_credentials(integer) to service_role;

create or replace function public.begin_onboarding_credential_delivery(p_delivery_id uuid,p_claim_token uuid,p_login text,p_work_email text,p_personal_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_row private.employee_onboarding_credentials%rowtype; v_current record;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into v_row from private.employee_onboarding_credentials where id=p_delivery_id for update;
  if v_row.status <> 'claimed' or v_row.claim_token is distinct from p_claim_token or v_row.claim_expires_at < clock_timestamp() then return false; end if;
  if exists (select 1 from private.portal_password_reset_claims r
    where r.auth_user_id = v_row.auth_user_id and r.status = 'pending') then
    return false;
  end if;
  select person.auth_user_id, person.is_active, person.started_date, p.account_status,
    lower(btrim(p.login_name)) as login, lower(nullif(btrim(d.work_email),'')) as work,
    lower(nullif(btrim(d.personal_email),'')) as personal
    into v_current from public.internal_org_people person
    join public.profiles p on p.id=person.auth_user_id
    join private.employee_directory_details d on d.person_id=person.id
    where person.id=v_row.person_id
    for share of person,p,d;
  if not found or v_current.auth_user_id is distinct from v_row.auth_user_id
    or v_current.is_active is distinct from true or v_current.started_date is distinct from v_row.due_date
    or v_current.account_status is distinct from 'active' or v_current.login is null
    or (v_current.login is distinct from v_current.work and v_current.login is distinct from v_current.personal)
    or v_current.login is distinct from p_login or v_current.work is distinct from p_work_email
    or v_current.personal is distinct from p_personal_email then
    update private.employee_onboarding_credentials set status='needs_review',review_code='invalid_context',claim_token=null,claim_expires_at=null where id=p_delivery_id;
    insert into private.employee_onboarding_credential_events(delivery_id,event_type,code) values(p_delivery_id,'needs_review','invalid_context');
    return false;
  end if;
  update private.employee_onboarding_credentials set status='sending',claimed_login=v_current.login,
    claimed_work_email=v_current.work,claimed_personal_email=v_current.personal,updated_at=clock_timestamp() where id=p_delivery_id;
  insert into private.employee_onboarding_credential_events(delivery_id,event_type) values(p_delivery_id,'sending');
  return true;
end $$;

revoke all on function public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text) to service_role;

commit;
