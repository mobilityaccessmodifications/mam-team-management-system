create or replace function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_key) <= 160 and (
    p_key ~ ('^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
      '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
      '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
      '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
      '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live)' ||
      '|checkin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(2-week|1-month|2-month|3-month|5-month|6-month|6-month-casual):initial:(test|live)' ||
      '|checkin-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:hr:[1-9][0-9]*:(test|live))$')
    or p_key ~ '^onboarding-credential:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), false)
$$;

create table private.employee_onboarding_credentials (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null unique references public.internal_org_people(id),
  auth_user_id uuid unique references auth.users(id),
  status text not null default 'pending_account' check (status in ('pending_account','scheduled','claimed','sending','delivered','needs_review','cancelled')),
  due_date date,
  claim_token uuid,
  claim_expires_at timestamptz,
  claimed_login text,
  claimed_work_email text,
  claimed_personal_email text,
  review_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz
);
create table private.employee_onboarding_credential_events (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references private.employee_onboarding_credentials(id),
  event_type text not null,
  code text,
  created_at timestamptz not null default clock_timestamp()
);
create index employee_onboarding_credentials_due_idx on private.employee_onboarding_credentials(due_date) where status = 'scheduled';
alter table private.employee_onboarding_credentials enable row level security;
alter table private.employee_onboarding_credentials force row level security;
alter table private.employee_onboarding_credential_events enable row level security;
alter table private.employee_onboarding_credential_events force row level security;
revoke all on private.employee_onboarding_credentials, private.employee_onboarding_credential_events from public, anon, authenticated, service_role;
revoke all on sequence private.employee_onboarding_credential_events_id_seq from public, anon, authenticated, service_role;

create function private.sync_employee_onboarding_credentials() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status text; v_login text;
begin
  if new.node_kind <> 'person' then return new; end if;
  if new.is_active is distinct from true then
    if new.auth_user_id is not null then
      update public.profiles set login_name = null, updated_at = clock_timestamp()
        where id = new.auth_user_id and account_status = 'disabled' and login_name is not null;
    end if;
    update private.employee_onboarding_credentials set status='cancelled',claim_token=null,claim_expires_at=null,updated_at=clock_timestamp()
      where person_id=new.id and status in ('pending_account','scheduled','claimed');
    return new;
  end if;
  if new.auth_user_id is not null then
    select login_name into v_login from public.profiles where id = new.auth_user_id and account_status = 'active';
  end if;
  v_status := case when new.auth_user_id is not null and v_login is not null then 'scheduled' else 'pending_account' end;
  insert into private.employee_onboarding_credentials(person_id,auth_user_id,status,due_date)
    values(new.id,new.auth_user_id,v_status,new.started_date)
    on conflict (person_id) do update
      set auth_user_id=excluded.auth_user_id,status=excluded.status,due_date=excluded.due_date,
          claim_token=null,claim_expires_at=null,updated_at=clock_timestamp()
      where private.employee_onboarding_credentials.status in ('pending_account','scheduled');
  select id into v_id from private.employee_onboarding_credentials where person_id=new.id;
  if v_id is not null then
    insert into private.employee_onboarding_credential_events(delivery_id,event_type) values(v_id,v_status);
  end if;
  return new;
end $$;
create trigger sync_employee_onboarding_credentials after insert or update of auth_user_id,is_active,started_date
on public.internal_org_people for each row execute function private.sync_employee_onboarding_credentials();

create function private.guard_onboarding_credential_send() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_person uuid; v_user uuid;
begin
  if tg_table_name = 'internal_org_people' then v_person := old.id;
  elsif tg_table_name = 'employee_directory_details' then v_person := old.person_id;
  else v_user := old.id; end if;
  if exists (select 1 from private.employee_onboarding_credentials c
    where ((v_person is not null and c.person_id=v_person)
      or (v_user is not null and c.auth_user_id=v_user))
      and (c.status in ('claimed','sending') or (c.status='needs_review' and c.claimed_login is not null))
    for update) then
    raise exception 'Onboarding credential delivery in progress' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger guard_onboarding_person before update or delete on public.internal_org_people
  for each row execute function private.guard_onboarding_credential_send();
create trigger guard_onboarding_contacts before update or delete on private.employee_directory_details
  for each row execute function private.guard_onboarding_credential_send();
create trigger guard_onboarding_account before update or delete on public.profiles
  for each row execute function private.guard_onboarding_credential_send();

create function public.claim_due_onboarding_credentials(p_limit integer default 10)
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
create function public.begin_onboarding_credential_delivery(p_delivery_id uuid,p_claim_token uuid,p_login text,p_work_email text,p_personal_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_row private.employee_onboarding_credentials%rowtype; v_current record;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into v_row from private.employee_onboarding_credentials where id=p_delivery_id for update;
  if v_row.status <> 'claimed' or v_row.claim_token is distinct from p_claim_token or v_row.claim_expires_at < clock_timestamp() then return false; end if;
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
create function public.complete_onboarding_credential_delivery(p_delivery_id uuid,p_claim_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  update private.employee_onboarding_credentials c set status='delivered',claim_token=null,claim_expires_at=null,delivered_at=clock_timestamp(),updated_at=clock_timestamp()
    where c.id=p_delivery_id and c.status='sending' and c.claim_token=p_claim_token and c.claim_expires_at > clock_timestamp()
      and exists (
        select 1 from public.internal_org_people person
        join public.profiles profile on profile.id=person.auth_user_id
        where person.id=c.person_id and person.auth_user_id=c.auth_user_id
          and person.is_active and profile.account_status='active' and profile.login_name is not null
      );
  if not found then return false; end if;
  insert into private.employee_onboarding_credential_events(delivery_id,event_type) values(p_delivery_id,'delivered');
  return true;
end $$;
create function public.fail_onboarding_credential_delivery(p_delivery_id uuid,p_claim_token uuid,p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_code not in ('invalid_recipient','invalid_context','password_update_failed','password_update_uncertain','provider_rejected','invalid_ack','delivery_uncertain') then raise exception 'Invalid code' using errcode='22023'; end if;
  update private.employee_onboarding_credentials set status='needs_review',review_code=p_code,claim_token=null,claim_expires_at=null,updated_at=clock_timestamp()
    where id=p_delivery_id and claim_token=p_claim_token and status in ('claimed','sending');
  if not found then return false; end if;
  insert into private.employee_onboarding_credential_events(delivery_id,event_type,code) values(p_delivery_id,'needs_review',p_code);
  return true;
end $$;
revoke all on function private.sync_employee_onboarding_credentials(),public.claim_due_onboarding_credentials(integer),
  public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text),public.complete_onboarding_credential_delivery(uuid,uuid),
  public.fail_onboarding_credential_delivery(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_due_onboarding_credentials(integer),public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text),
  public.complete_onboarding_credential_delivery(uuid,uuid),public.fail_onboarding_credential_delivery(uuid,uuid,text) to service_role;
