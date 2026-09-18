begin;

-- Release remains blocked until full-stack concurrency/trigger verification.
-- Installing this migration alone must not enable writes.
create table private.openclaw_leave_release_gate (
  singleton boolean primary key default true check(singleton), enabled boolean not null default false
);
insert into private.openclaw_leave_release_gate values(true,false);
alter table private.openclaw_leave_release_gate enable row level security;
revoke all on private.openclaw_leave_release_gate from public,anon,authenticated,service_role;

-- No existing portal RPC or grants are changed. All bridge state is private.
create table private.openclaw_leave_drafts (
  id uuid primary key,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);
create table private.openclaw_leave_receipts (
  key text primary key check (key ~ '^[a-f0-9]{64}$'),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);
alter table private.openclaw_leave_drafts enable row level security;
alter table private.openclaw_leave_receipts enable row level security;
revoke all on private.openclaw_leave_drafts, private.openclaw_leave_receipts from public, anon, authenticated, service_role;
create index on private.openclaw_leave_drafts(created_at);
create index on private.openclaw_leave_receipts(created_at);
create index on private.openclaw_leave_receipts((body->>'personId'),created_at);

-- These are short-lived protocol caches, NOT the HR request/audit ledger.
-- One hour covers the 10-minute confirmation TTL, 60-second signed replay
-- window and per-person ingress quota. A daily authenticated maintenance job
-- physically removes expired rows, including when the bridge is disabled.
create function public.prune_openclaw_leave_state()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare cutoff timestamptz:=clock_timestamp()-interval '1 hour'; drafts integer; receipts integer;
begin
  perform set_config('lock_timeout','3s',true);
  perform pg_advisory_xact_lock(hashtextextended('openclaw_leave_bridge',0));
  delete from private.openclaw_leave_drafts where id in (
    select id from private.openclaw_leave_drafts where created_at<cutoff order by created_at limit 5000
  );
  get diagnostics drafts=row_count;
  delete from private.openclaw_leave_receipts where key in (
    select key from private.openclaw_leave_receipts where created_at<cutoff order by created_at limit 5000
  );
  get diagnostics receipts=row_count;
  return jsonb_build_object('drafts',drafts,'receipts',receipts,'remaining',
    exists(select 1 from private.openclaw_leave_drafts where created_at<cutoff)
    or exists(select 1 from private.openclaw_leave_receipts where created_at<cutoff));
end;
$$;
revoke all on function public.prune_openclaw_leave_state() from public,anon,authenticated,service_role;
grant execute on function public.prune_openclaw_leave_state() to service_role;

create function private.openclaw_leave_people()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'personId',p.id,'userId',p.auth_user_id,'company',p.company_key,
    'active',p.is_active,'nodeKind',p.node_kind,
    'accountActive',case when p.auth_user_id is null then false else private.is_active_portal_account(p.auth_user_id) end,
    'phone',d.phone,'country',d.country,'employmentType',d.employment_type
  ) order by p.id), '[]'::jsonb)
  from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id
  where p.company_key='mam' and p.is_active;
$$;
revoke all on function private.openclaw_leave_people() from public, anon, authenticated, service_role;

create function private.openclaw_leave_snapshot(p_key text,p_draft_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with people as (select private.openclaw_leave_people() as rows),
  draft as (select (select body from private.openclaw_leave_drafts where id=p_draft_id) as body)
  select jsonb_build_object('complete',true,'rows',people.rows,
    'fingerprint',encode(sha256(convert_to(people.rows::text,'UTF8')),'hex'),
    'receipt',(select body from private.openclaw_leave_receipts where key=p_key),
    'draft',draft.body,'draftFingerprint',encode(sha256(convert_to(coalesce(draft.body::text,'null'),'UTF8')),'hex'))
  from people cross join draft;
$$;
revoke all on function private.openclaw_leave_snapshot(text,uuid) from public, anon, authenticated, service_role;

-- Derive a private submit-self implementation from the deployed portal body,
-- replacing only session acquisition with a server-resolved actor. Fail the
-- migration if its known authentication structure has drifted. Never fabricate
-- JWTs or change request.jwt.*. The original function is not replaced.
do $migration$
declare original text; patched text;
begin
  original := pg_get_functiondef('public.submit_my_leave_request(text,date,date,time,time,text)'::regprocedure);
  if position('v_actor_user_id uuid := (select auth.uid());' in original)=0
    or position('v_actor_person_id := private.current_active_portal_employee_id();' in original)=0
    or position('or not private.is_active_portal_account() then' in original)=0
    or position('or coalesce(((select auth.jwt()) ->> ''is_anonymous'')::boolean, false)' in original)=0
    or position('insert into private.leave_request_reviewer_assignments' in original)=0
    or position('insert into public.leave_request_events' in original)=0 then
    raise exception 'Portal submit-self body requires fresh bridge review';
  end if;
  patched := replace(original,'FUNCTION public.submit_my_leave_request(','FUNCTION private.openclaw_submit_self(p_actor_user_id uuid, ');
  patched := replace(patched,'v_actor_user_id uuid := (select auth.uid());','v_actor_user_id uuid := p_actor_user_id;');
  patched := replace(patched,'or coalesce(((select auth.jwt()) ->> ''is_anonymous'')::boolean, false)','');
  patched := replace(patched,'or not private.is_active_portal_account() then','or not private.is_active_portal_account(v_actor_user_id) then');
  patched := replace(patched,'v_actor_person_id := private.current_active_portal_employee_id();',
    'select person.id into strict v_actor_person_id from public.internal_org_people person where person.auth_user_id=v_actor_user_id and person.is_active and person.node_kind=''person'' and person.company_key=''mam'';');
  if patched=original or position('auth.' in patched)>0 then
    raise exception 'Unexpected session dependency in submit-self body';
  end if;
  execute patched;
end;
$migration$;
revoke all on function private.openclaw_submit_self(uuid,text,date,date,time,time,text) from public, anon, authenticated, service_role;

create function private.openclaw_leave_commit(
  p_key text,p_body_fingerprint text,p_source_fingerprint text,p_draft_fingerprint text,
  p_packet jsonb,p_person_id uuid,p_draft jsonb,p_result jsonb,p_submit boolean
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  people jsonb; employee jsonb; old_receipt jsonb; old_draft jsonb; next_draft jsonb;
  result jsonb; operation text:=p_packet->>'operation'; payload jsonb:=p_packet->'payload';
  draft_id uuid; request_id uuid; actor uuid; now_ms bigint;
begin
  if not coalesce((select enabled from private.openclaw_leave_release_gate where singleton),false) then
    raise exception 'Bridge not released' using errcode='42501';
  end if;
  perform set_config('lock_timeout','3s',true);
  perform set_config('statement_timeout','12s',true);
  if p_key !~ '^[a-f0-9]{64}$' or p_body_fingerprint !~ '^[a-f0-9]{64}$'
    or p_packet->>'version' is distinct from '1' or p_packet->>'channel' is distinct from 'whatsapp'
    or operation is null or operation not in ('prepare','shown','confirm')
    or p_packet->>'sender' is null or p_packet->>'sender' !~ '^\+[1-9][0-9]{7,14}$'
    or p_packet->>'session' is null or p_packet->>'account' is null then
    raise exception 'Invalid bridge request' using errcode='22023';
  end if;
  -- Same hierarchy/grant order as portal submission. Table SHARE locks prevent
  -- inserts (new duplicate numbers) as well as changes while checking the CAS.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants',0));
  perform pg_advisory_xact_lock(hashtextextended('openclaw_leave_bridge',0));
  lock table public.profiles, public.internal_org_people, private.employee_directory_details in share mode;
  people := private.openclaw_leave_people();
  if encode(sha256(convert_to(people::text,'UTF8')),'hex') is distinct from p_source_fingerprint then
    raise exception 'Identity snapshot changed' using errcode='40001';
  end if;
  select item into employee from jsonb_array_elements(people) item where item->>'personId'=p_person_id::text;
  if employee is null or employee->>'nodeKind'<>'person' or employee->>'accountActive'<>'true' or employee->>'userId' is null then
    raise exception 'Employee unavailable' using errcode='42501';
  end if;
  actor := (employee->>'userId')::uuid;
  select body into old_receipt from private.openclaw_leave_receipts where key=p_key for update;
  if old_receipt is not null then
    if old_receipt->>'fingerprint' is distinct from p_body_fingerprint or old_receipt->>'personId' is distinct from p_person_id::text or old_receipt->>'userId' is distinct from actor::text then
      raise exception 'Event conflict' using errcode='40001';
    end if;
    return old_receipt->'result';
  end if;
  -- Bounded persistent per-employee ingress limit; exact retries above are free.
  if (select count(*) from private.openclaw_leave_receipts where body->>'personId'=p_person_id::text and created_at>clock_timestamp()-interval '1 hour')>=120 then
    raise exception 'Bridge rate limited' using errcode='54000';
  end if;
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if operation='prepare' then
    if p_submit or p_result->>'code' not in ('prepared','needs_input') then raise exception 'Invalid preparation'; end if;
    if p_result->>'code'='needs_input' then
      if p_draft is not null then raise exception 'Unexpected draft'; end if;
      result:=p_result;
    else
      draft_id:=(p_draft->>'id')::uuid;
      if draft_id is null or p_draft->>'personId' is distinct from p_person_id::text or p_draft->>'userId' is distinct from actor::text
        or p_draft->'identity' is distinct from jsonb_build_object('account',p_packet->>'account','sender',p_packet->>'sender','session',p_packet->>'session')
        or p_draft ? 'result' or p_draft ? 'shownAt' or p_draft ? 'shownMessageId'
        or (p_draft->>'expiresAt')::bigint <= now_ms or (p_draft->>'expiresAt')::bigint > now_ms+605000
        or p_draft->>'digest' is distinct from encode(sha256(convert_to(p_draft->>'summary','UTF8')),'hex')
        or p_result->>'draftId' is distinct from draft_id::text
        or p_result->>'summary' is distinct from p_draft->>'summary'
        or p_result->>'digest' is distinct from p_draft->>'digest' then raise exception 'Invalid draft'; end if;
      -- CAST validates unpredictable confirmation capability; no confirmed flag.
      perform (p_draft->>'challenge')::uuid;
      insert into private.openclaw_leave_drafts(id,body) values(draft_id,p_draft);
      result:=p_result;
    end if;
  else
    draft_id:=(payload->>'draftId')::uuid;
    select body into old_draft from private.openclaw_leave_drafts where id=draft_id for update;
    if old_draft is null
      or old_draft->>'personId' is distinct from p_person_id::text or old_draft->>'userId' is distinct from actor::text
      or old_draft->'identity' is distinct from jsonb_build_object('account',p_packet->>'account','sender',p_packet->>'sender','session',p_packet->>'session')
      or old_draft->>'digest' is distinct from payload->>'digest'
      or ((old_draft->>'expiresAt')::bigint<=now_ms and not(operation='confirm' and old_draft ? 'result')) then raise exception 'Draft conflict' using errcode='40001'; end if;
    -- A different event may have completed this exact confirmation while our
    -- snapshot waited for the lock. Validate identity, immutable fields and
    -- quoted consent below, then return its durable result, never submit twice.
    if encode(sha256(convert_to(old_draft::text,'UTF8')),'hex') is distinct from p_draft_fingerprint
      and not (operation='confirm' and old_draft ? 'result') then
      raise exception 'Draft conflict' using errcode='40001';
    end if;
    if (p_draft - array['shownAt','shownMessageId','result']) is distinct from (old_draft - array['shownAt','shownMessageId','result']) then raise exception 'Immutable draft changed'; end if;
    if operation='shown' then
      if p_submit or old_draft ? 'result' or payload->>'outboundMessageId' is null
        or (old_draft ? 'shownMessageId' and old_draft->>'shownMessageId' is distinct from payload->>'outboundMessageId') then raise exception 'Invalid display receipt'; end if;
      next_draft:=old_draft || jsonb_build_object('shownMessageId',payload->>'outboundMessageId','shownAt',coalesce((old_draft->>'shownAt')::bigint,now_ms));
      result:=jsonb_build_object('code','shown');
    else
      if old_draft->>'shownMessageId' is null or old_draft->>'shownAt' is null or now_ms<=(old_draft->>'shownAt')::bigint
        or payload->>'replyToMessageId' is distinct from old_draft->>'shownMessageId'
        or payload->>'text' is distinct from ('CONFIRM '||(old_draft->>'challenge')) then raise exception 'Confirmation required'; end if;
      if old_draft ? 'result' then
        result:=jsonb_build_object('code','submitted')||(old_draft->'result');
        next_draft:=old_draft;
      else
        if not p_submit then raise exception 'Submission required'; end if;
        -- Prevent simultaneous portal/bridge insert bypass of overlap protection.
        lock table public.leave_requests in share row exclusive mode;
        if exists(select 1 from public.leave_requests r where r.employee_person_id=p_person_id and r.status in ('submitted','approved','changes_requested')
          and r.start_date<=(old_draft->'fields'->>'endDate')::date and r.end_date>=(old_draft->'fields'->>'startDate')::date) then
          raise exception 'Existing leave overlaps' using errcode='23P01';
        end if;
        select s.id into strict request_id from private.openclaw_submit_self(actor,
          old_draft->'fields'->>'leaveType',(old_draft->'fields'->>'startDate')::date,(old_draft->'fields'->>'endDate')::date,
          (old_draft->'fields'->>'startTime')::time,(old_draft->'fields'->>'endTime')::time,old_draft->'fields'->>'employeeNote') s;
        -- The existing insert trigger reads auth.uid() (null for this bridge).
        -- Record the resolved human submitter without changing JWT/session state.
        update public.leave_requests set submitted_by=actor where id=request_id;
        result:=jsonb_build_object('code','submitted','requestId',request_id,'status','Pending');
        next_draft:=old_draft||jsonb_build_object('result',result-'code');
      end if;
    end if;
    update private.openclaw_leave_drafts set body=next_draft where id=draft_id;
  end if;
  insert into private.openclaw_leave_receipts(key,body) values(p_key,jsonb_build_object(
    'fingerprint',p_body_fingerprint,'personId',p_person_id,'userId',actor,'result',result));
  return result;
end;
$$;
revoke all on function private.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean) from public, anon, authenticated, service_role;

-- Only these fixed-path facades are callable by service_role. Their owner
-- invokes private implementations; the caller gets no direct private access.
create function public.openclaw_leave_snapshot(p_key text,p_draft_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$ select private.openclaw_leave_snapshot(p_key,p_draft_id); $$;
create function public.openclaw_leave_commit(p_key text,p_body_fingerprint text,p_source_fingerprint text,p_draft_fingerprint text,p_packet jsonb,p_person_id uuid,p_draft jsonb,p_result jsonb,p_submit boolean)
returns jsonb language sql volatile security definer set search_path = '' as $$ select private.openclaw_leave_commit(p_key,p_body_fingerprint,p_source_fingerprint,p_draft_fingerprint,p_packet,p_person_id,p_draft,p_result,p_submit); $$;
revoke all on function public.openclaw_leave_snapshot(text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_leave_snapshot(text,uuid) to service_role;
grant execute on function public.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean) to service_role;
commit;
