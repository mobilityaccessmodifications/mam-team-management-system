begin;

lock table private.confirmed_test_identity_purges, private.confirmed_test_purge_schema
  in share row exclusive mode nowait;
do $$ begin
  if (select count(*) from private.confirmed_test_purge_schema)<>1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Password recovery requires the reviewed predecessor catalog.' using errcode='55000';
  end if;
end $$;

create table private.portal_password_recovery_requests (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  person_id uuid not null references public.internal_org_people(id) on delete cascade,
  request_id uuid not null unique default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  recipient text not null,
  account_version bigint not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  reset_token uuid
);
alter table private.portal_password_recovery_requests enable row level security;
revoke all on private.portal_password_recovery_requests from public, anon, authenticated, service_role;

create function public.issue_portal_password_recovery(p_email text, p_token_hash text)
returns table(request_id uuid, recipient text)
language plpgsql security definer set search_path = '' as $$
declare v_target record; v_count integer; v_request uuid := gen_random_uuid();
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_email is null or length(p_email)>254 or p_email<>lower(btrim(p_email))
    or p_email !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid input' using errcode='22023';
  end if;
  select count(*) into v_count
  from public.profiles p join public.internal_org_people person on person.auth_user_id=p.id
  join private.employee_directory_details d on d.person_id=person.id
  where person.node_kind='person' and person.is_active and p.account_status='active' and p.login_name is not null
    and p_email in (lower(btrim(d.work_email)),lower(btrim(d.personal_email)));
  if v_count<>1 then return; end if;
  select p.id as user_id,person.id as person_id,p.account_version into v_target
  from public.profiles p join public.internal_org_people person on person.auth_user_id=p.id
  join private.employee_directory_details d on d.person_id=person.id
  where person.node_kind='person' and person.is_active and p.account_status='active' and p.app_role<>'system_admin' and p.login_name is not null
    and p_email in (lower(btrim(d.work_email)),lower(btrim(d.personal_email)));
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || v_target.user_id::text,0));
  if exists(select 1 from private.portal_password_reset_claims c where c.auth_user_id=v_target.user_id and c.status='pending') then return; end if;
  insert into private.portal_password_recovery_requests as r
    (auth_user_id,person_id,request_id,token_hash,recipient,account_version,expires_at)
  values (v_target.user_id,v_target.person_id,v_request,p_token_hash,p_email,v_target.account_version,clock_timestamp()+interval '1 hour')
  on conflict (auth_user_id) do update set person_id=excluded.person_id,request_id=excluded.request_id,
    token_hash=excluded.token_hash,recipient=excluded.recipient,account_version=excluded.account_version,
    expires_at=excluded.expires_at,consumed_at=null,reset_token=null;
  return query select v_request,p_email;
end $$;

create function public.begin_portal_password_recovery(p_token_hash text)
returns table(auth_user_id uuid, reset_token uuid)
language plpgsql security definer set search_path = '' as $$
declare v_request private.portal_password_recovery_requests; v_token uuid := gen_random_uuid();
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return; end if;
  select r.* into v_request from private.portal_password_recovery_requests r where r.token_hash=p_token_hash;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || v_request.auth_user_id::text,0));
  perform c.id from private.employee_onboarding_credentials c
    where c.auth_user_id=v_request.auth_user_id or c.person_id=v_request.person_id for update;
  if exists(select 1 from private.employee_onboarding_credentials c
    where (c.auth_user_id=v_request.auth_user_id or c.person_id=v_request.person_id)
      and (c.status in ('claimed','sending') or (c.status='needs_review' and c.claimed_login is not null)))
    or exists(select 1 from private.portal_password_reset_claims c where c.auth_user_id=v_request.auth_user_id and c.status='pending') then
    raise exception 'Password change in progress' using errcode='55000';
  end if;
  select r.* into v_request from private.portal_password_recovery_requests r
    where r.token_hash=p_token_hash and r.consumed_at is null and r.expires_at>clock_timestamp() for update;
  if not found then return; end if;
  perform p.id from public.profiles p join public.internal_org_people person on person.auth_user_id=p.id
    join private.employee_directory_details d on d.person_id=person.id
    where p.id=v_request.auth_user_id and p.account_status='active' and p.app_role<>'system_admin' and p.login_name is not null
      and p.account_version=v_request.account_version and person.id=v_request.person_id
      and person.node_kind='person' and person.is_active
      and v_request.recipient in (lower(btrim(d.work_email)),lower(btrim(d.personal_email)))
      and 1=(select count(*) from private.employee_directory_details other_d
        join public.internal_org_people other_person on other_person.id=other_d.person_id
        join public.profiles other_p on other_p.id=other_person.auth_user_id
        where other_person.node_kind='person' and other_person.is_active and other_p.account_status='active' and other_p.login_name is not null
          and v_request.recipient in (lower(btrim(other_d.work_email)),lower(btrim(other_d.personal_email))))
    for update of p,person,d;
  if not found then return; end if;
  insert into private.portal_password_reset_claims as c
    (auth_user_id,person_id,reset_token,claimed_by,claimed_at,status,claimed_account_version)
  values (v_request.auth_user_id,v_request.person_id,v_token,v_request.auth_user_id,clock_timestamp(),'pending',v_request.account_version)
  on conflict on constraint portal_password_reset_claims_pkey do update
    set person_id=excluded.person_id,reset_token=excluded.reset_token,claimed_by=excluded.claimed_by,
      claimed_at=excluded.claimed_at,status='pending',claimed_account_version=excluded.claimed_account_version,
      final_account_version=null,finalised_at=null,cancelled_at=null;
  update private.portal_password_recovery_requests r set consumed_at=clock_timestamp(),reset_token=v_token
    where r.auth_user_id=v_request.auth_user_id;
  return query select v_request.auth_user_id,v_token;
end $$;

create function public.finish_portal_password_recovery(p_auth_user_id uuid,p_reset_token uuid,p_applied boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_claim private.portal_password_reset_claims; v_version bigint;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_applied is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text,0));
  select c.* into v_claim from private.portal_password_reset_claims c
    where c.auth_user_id=p_auth_user_id and c.reset_token=p_reset_token and c.claimed_by=p_auth_user_id
      and exists(select 1 from private.portal_password_recovery_requests r
        where r.auth_user_id=c.auth_user_id and r.reset_token=c.reset_token and r.consumed_at is not null)
    for update;
  if not found then return false; end if;
  if v_claim.status='finalised' then return p_applied; end if;
  if v_claim.status<>'pending' then return false; end if;
  if not p_applied then
    update private.portal_password_reset_claims set status='cancelled',cancelled_at=clock_timestamp()
      where auth_user_id=p_auth_user_id and reset_token=p_reset_token;
    return true;
  end if;
  update public.profiles p set must_change_password=false,password_changed_at=clock_timestamp(),
    temporary_password_issued_at=null,credentials_valid_after=clock_timestamp(),account_version=p.account_version+1,updated_at=clock_timestamp()
    where p.id=p_auth_user_id and p.account_status='active' and p.app_role<>'system_admin' and p.account_version=v_claim.claimed_account_version
      and exists(select 1 from public.internal_org_people person where person.id=v_claim.person_id
        and person.auth_user_id=p.id and person.is_active and person.node_kind='person')
    returning p.account_version into v_version;
  if not found then return false; end if;
  update private.portal_password_reset_claims set status='finalised',final_account_version=v_version,finalised_at=clock_timestamp()
    where auth_user_id=p_auth_user_id and reset_token=p_reset_token;
  update private.employee_onboarding_credentials set status='cancelled',updated_at=clock_timestamp()
    where auth_user_id=p_auth_user_id and status in ('scheduled','pending_account');
  insert into private.portal_account_admin_events(actor_user_id,target_user_id,event_type,before_state,after_state)
    values (p_auth_user_id,p_auth_user_id,'password_reset_recorded',jsonb_build_object('account_version',v_claim.claimed_account_version),
      jsonb_build_object('account_version',v_version,'must_change_password',false));
  return true;
end $$;

revoke all on function public.issue_portal_password_recovery(text,text),public.begin_portal_password_recovery(text),
  public.finish_portal_password_recovery(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.issue_portal_password_recovery(text,text),public.begin_portal_password_recovery(text),
  public.finish_portal_password_recovery(uuid,uuid,boolean) to service_role;

create or replace function public.update_portal_login(
  p_person_id uuid,
  p_auth_user_id uuid,
  p_login_name text,
  p_expected_account_version bigint
)
returns table (
  person_id uuid,
  auth_user_id uuid,
  login_name text,
  account_status text,
  account_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_login_name text := lower(btrim(p_login_name));
  v_before jsonb;
  v_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can rename a login.'
      using errcode = '42501';
  end if;

  if not private.is_valid_portal_login(v_login_name) then
    raise exception 'Choose a valid email or username.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));
  if exists (select 1 from private.portal_password_reset_claims claim
    where claim.auth_user_id = p_auth_user_id and claim.status = 'pending') then
    raise exception 'A password reset is in progress. Refresh and try again.' using errcode = '55000';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    where person.id = p_person_id
      and person.auth_user_id = p_auth_user_id
      and person.node_kind = 'person'
      and person.is_active
  ) then
    raise exception 'The account is not linked to this active person.' using errcode = '23503';
  end if;

  select jsonb_build_object(
    'login_name', profile.login_name,
    'account_version', profile.account_version
  )
  into v_before
  from public.profiles profile
  where profile.id = p_auth_user_id;

  update public.profiles profile
  set login_name = v_login_name,
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  where profile.id = p_auth_user_id
    and profile.account_version = p_expected_account_version
    and profile.login_name is not null
  returning profile.account_version into v_version;

  if not found then
    raise exception 'The account changed or no longer exists. Refresh and try again.'
      using errcode = '40001';
  end if;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, before_state, after_state
  )
  values (
    (select auth.uid()),
    p_auth_user_id,
    'login_renamed',
    v_before,
    jsonb_build_object('login_name', v_login_name, 'account_version', v_version)
  );

  return query
  select p_person_id, p_auth_user_id, v_login_name, profile.account_status, v_version
  from public.profiles profile
  where profile.id = p_auth_user_id;
end;
$$;

update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;

commit;
