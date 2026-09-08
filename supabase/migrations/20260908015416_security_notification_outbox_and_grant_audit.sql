begin;

-- A leave mutation and its delivery obligation commit or roll back together.
-- No historical backfill: importing old records must never email staff.
create table private.leave_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.leave_requests(id) on delete set null,
  event text not null check (event in ('leave-submitted','leave-approved','leave-declined','leave-cancelled','leave-conditionally-approved')),
  payload jsonb not null,
  delivery_payload jsonb,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claimed_until timestamptz,
  last_error text
);
alter table private.leave_notification_outbox enable row level security;
revoke all on private.leave_notification_outbox from public, anon, authenticated, service_role;
create index leave_notification_pending_idx on private.leave_notification_outbox(next_attempt_at,created_at)
  where delivered_at is null;
create unique index leave_notification_conditional_once_idx on private.leave_notification_outbox(request_id)
  where event='leave-conditionally-approved';

-- Do not silently destroy pending mail through employee/request deletion.
-- Completed history survives without blocking an otherwise authorised purge.
create function private.protect_pending_leave_notifications()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.leave_notification_outbox q where q.request_id=old.id and q.delivered_at is null) then
    raise exception 'Pending leave notifications must be resolved before deleting this record.' using errcode='55000';
  end if;
  return old;
end;
$$;
revoke all on function private.protect_pending_leave_notifications() from public,anon,authenticated,service_role;
create trigger protect_pending_leave_notifications before delete on public.leave_requests
  for each row execute function private.protect_pending_leave_notifications();

create function private.enqueue_leave_notification(p_request_id uuid, p_event text, p_was_approved boolean)
returns void language sql security definer set search_path='' as $$
  insert into private.leave_notification_outbox(request_id,event,payload)
  select r.id,p_event,jsonb_build_object(
    'version',1,'event',p_event,'requestId',r.id,'wasApproved',p_was_approved,
    'employeeName',coalesce(p.full_name,'Employee'),'company',coalesce(p.company_key,'mam'),
    'leaveType',r.request_type_label,'startDate',r.start_date,'endDate',r.end_date,
    'startTime',to_char(r.start_time,'HH24:MI'),'endTime',to_char(r.end_time,'HH24:MI'),
    'days',r.business_days,'hours',r.hours,
    'status',case p_event when 'leave-approved' then 'Approved' when 'leave-declined' then 'Declined'
      when 'leave-cancelled' then 'Cancelled' when 'leave-conditionally-approved' then 'Approved – pending leave balance' else 'Pending' end,
    'employeeNote',r.reason,'managerNote',r.manager_note)
  from public.leave_requests r left join public.internal_org_people p on p.id=r.employee_person_id
  where r.id=p_request_id
  on conflict do nothing;
$$;
revoke all on function private.enqueue_leave_notification(uuid,text,boolean) from public,anon,authenticated,service_role;

create function private.capture_leave_notification()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_event text;
begin
  if new.record_origin <> 'portal' and (tg_op='INSERT' or new.status <> 'cancelled') then return new; end if;
  if tg_op='UPDATE' and new.status is not distinct from old.status then return new; end if;
  v_event := case new.status when 'submitted' then 'leave-submitted' when 'approved' then 'leave-approved'
    when 'rejected' then 'leave-declined' when 'cancelled' then 'leave-cancelled' end;
  if v_event is not null then
    perform private.enqueue_leave_notification(new.id,v_event,
      case when tg_op='UPDATE' then old.status='approved' or public.leave_notification_was_approved(new.id) else false end);
  end if;
  return new;
end;
$$;
revoke all on function private.capture_leave_notification() from public,anon,authenticated,service_role;
create trigger leave_notification_on_mutation after insert or update on public.leave_requests
  for each row execute function private.capture_leave_notification();

-- Conditional approval leaves the base status submitted. The audit event is
-- inserted after the note has been saved, so snapshot the completed decision.
create function private.capture_conditional_leave_notification()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.event_type='updated' and exists (
    select 1 from private.leave_balance_approvals a join public.leave_requests r on r.id=a.request_id
    where a.request_id=new.leave_request_id and r.status='submitted'
  ) then
    perform private.enqueue_leave_notification(new.leave_request_id,'leave-conditionally-approved',false);
  end if;
  return new;
end;
$$;
revoke all on function private.capture_conditional_leave_notification() from public,anon,authenticated,service_role;
create trigger leave_notification_on_conditional_decision after insert on public.leave_request_events
  for each row execute function private.capture_conditional_leave_notification();

-- Only the server worker can claim/ack. User RPCs cannot read addresses,
-- manufacture acknowledgements, or remove the delivery obligation.
create function public.claim_leave_notification_outbox(p_request_id uuid default null,p_limit integer default 50)
returns table(delivery_id uuid,claim_token uuid,payload jsonb)
language plpgsql security definer set search_path='' as $$
declare r private.leave_notification_outbox%rowtype; v_manager text; v_emails text[]; v_payload jsonb; v_token uuid;
begin
  for r in
    select q.* from private.leave_notification_outbox q
    where q.delivered_at is null and q.next_attempt_at<=clock_timestamp()
      and (q.claimed_until is null or q.claimed_until<clock_timestamp())
      and (p_request_id is null or q.request_id=p_request_id)
      and not exists(select 1 from private.leave_notification_outbox older
        where older.request_id=q.request_id and older.delivered_at is null
          and (older.created_at,older.id)<(q.created_at,q.id))
    order by q.created_at,q.id limit greatest(1,least(coalesce(p_limit,50),50))
    for update of q skip locked
  loop
    v_payload:=r.delivery_payload;
    if v_payload is null then
      select m.manager_email into v_manager from public.resolve_leave_notification_manager(r.request_id) m;
      select e.employee_emails into v_emails from public.resolve_leave_notification_employee_recipients(r.request_id) e;
      v_manager:=lower(nullif(btrim(v_manager),''));
      if coalesce(v_manager,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then v_manager:=null; end if;
      v_emails:=array(select distinct lower(btrim(e.address)) from unnest(coalesce(v_emails,array[]::text[])) e(address)
        where btrim(e.address) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' order by 1);
      -- Missing address can be repaired before the next attempt. Once sent,
      -- the immutable payload and stable event key also govern retries.
      if (r.event in ('leave-submitted','leave-cancelled') and coalesce(v_manager,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
        or (r.event in ('leave-approved','leave-declined','leave-conditionally-approved') and cardinality(v_emails)=0) then
        update private.leave_notification_outbox q set attempts=q.attempts+1,
          last_error='missing_recipient',next_attempt_at=clock_timestamp()+interval '21 minutes' where q.id=r.id;
        -- Surface a failed item to the worker's aggregate/HTTP health signal,
        -- without reserving or freezing an incomplete recipient snapshot.
        return query select r.id,null::uuid,null::jsonb;
        continue;
      end if;
      v_payload:=r.payload || jsonb_build_object('managerEmail',v_manager,
        'employeeEmail',nullif(array_to_string(v_emails,','),''),'employeeEmails',to_jsonb(v_emails));
    end if;
    v_token:=gen_random_uuid();
    update private.leave_notification_outbox q set delivery_payload=v_payload,claim_token=v_token,
      claimed_until=clock_timestamp()+interval '5 minutes',attempts=q.attempts+1 where q.id=r.id;
    return query select r.id,v_token,v_payload;
  end loop;
end;
$$;
revoke all on function public.claim_leave_notification_outbox(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_leave_notification_outbox(uuid,integer) to service_role;

create function public.finish_leave_notification_outbox(p_delivery_id uuid,p_claim_token uuid,p_delivered boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update private.leave_notification_outbox q set
    delivered_at=case when p_delivered then clock_timestamp() else null end,
    last_error=case when p_delivered then null else 'delivery_unconfirmed' end,
    next_attempt_at=clock_timestamp()+interval '21 minutes',claim_token=null,claimed_until=null
  where q.id=p_delivery_id and q.claim_token=p_claim_token and q.delivered_at is null
    and q.claimed_until>clock_timestamp();
  return found;
end;
$$;
revoke all on function public.finish_leave_notification_outbox(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.finish_leave_notification_outbox(uuid,uuid,boolean) to service_role;

-- Preserve each affected identity, including automatic revocations. No FK:
-- employee/account deletion must not erase the security audit history.
create table private.subscription_credential_grant_changes (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  auth_user_id uuid not null,
  person_id uuid not null,
  operation text not null check(operation in ('granted','revoked')),
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default clock_timestamp()
);
alter table private.subscription_credential_grant_changes enable row level security;
revoke all on private.subscription_credential_grant_changes from public,anon,authenticated,service_role;
revoke all on sequence private.subscription_credential_grant_changes_id_seq from public,anon,authenticated,service_role;
create function private.audit_subscription_credential_grant_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op in ('DELETE','UPDATE') then
    insert into private.subscription_credential_grant_changes(actor_user_id,auth_user_id,person_id,operation)
    values(auth.uid(),old.auth_user_id,old.person_id,'revoked');
  end if;
  if tg_op in ('INSERT','UPDATE') then
    insert into private.subscription_credential_grant_changes(actor_user_id,auth_user_id,person_id,operation)
    values(auth.uid(),new.auth_user_id,new.person_id,'granted');
  end if;
  return null;
end;
$$;
revoke all on function private.audit_subscription_credential_grant_change() from public,anon,authenticated,service_role;
create trigger audit_subscription_credential_grant_change after insert or update or delete
  on private.subscription_credential_access_grants for each row execute function private.audit_subscription_credential_grant_change();

commit;
