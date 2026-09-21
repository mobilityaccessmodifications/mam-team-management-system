begin;

-- Preparation is read-only. Existing private cache tables hold ONLY successful
-- v3 nonces/receipts, and retain their existing bounded cleanup policy.
create function public.openclaw_leave_v3_snapshot(p_key text,p_draft_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  -- Stateless preparation no longer passes through the old gated commit RPC.
  -- Keep disabled rollouts closed without introducing any preparation writes.
  if not coalesce((select enabled from private.openclaw_leave_release_gate where singleton),false) then
    raise exception 'Bridge not released' using errcode='42501';
  end if;
  return (
  with people as (select private.openclaw_leave_people() as rows)
  select jsonb_build_object('complete',true,'rows',people.rows,
    'fingerprint',encode(sha256(convert_to(people.rows::text,'UTF8')),'hex'),
    'receipt',(select body from private.openclaw_leave_receipts where key=p_key),
    'submitted',(select body from private.openclaw_leave_drafts where id=p_draft_id))
  from people);
end;
$$;
revoke all on function public.openclaw_leave_v3_snapshot(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.openclaw_leave_v3_snapshot(text,uuid) to service_role;

-- Only the authenticated HTTP boundary decrypts tokens and resolves normalized
-- phones. This service-only RPC rechecks that source snapshot under locks, even
-- for successful receipt retrieval. No preparation/display writes exist here.
create function public.openclaw_leave_v3_submit(
  p_key text,p_body_fingerprint text,p_source_fingerprint text,
  p_packet jsonb,p_person_id uuid,p_draft jsonb,p_token_hash text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  people jsonb; employee jsonb; old_receipt jsonb; old_submission jsonb;
  actor uuid; draft_id uuid; request_id uuid; result jsonb; payload jsonb:=p_packet->'payload';
  identity jsonb; now_ms bigint;
begin
  if not coalesce((select enabled from private.openclaw_leave_release_gate where singleton),false) then
    raise exception 'Bridge not released' using errcode='42501';
  end if;
  perform set_config('lock_timeout','3s',true);
  perform set_config('statement_timeout','12s',true);
  if p_key is null or p_key !~ '^[a-f0-9]{64}$'
    or p_body_fingerprint is null or p_body_fingerprint !~ '^[a-f0-9]{64}$'
    or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_packet->>'version' is distinct from '3' or p_packet->>'channel' is distinct from 'whatsapp'
    or p_packet->>'operation' is distinct from 'confirm'
    or jsonb_typeof(payload) is distinct from 'object'
    or not(payload ?& array['draftToken','shownMessageId','replyToMessageId','text'])
    or payload - array['draftToken','shownMessageId','replyToMessageId','text'] <> '{}'::jsonb
    or payload->>'shownMessageId' is null or payload->>'shownMessageId' !~ '^[A-Za-z0-9:_-]{1,128}$'
    or (payload->'replyToMessageId' <> 'null'::jsonb and payload->>'replyToMessageId' is distinct from payload->>'shownMessageId')
    or lower(btrim(payload->>'text',E' \t\r\n')) is distinct from 'confirm'
    or p_token_hash is distinct from encode(sha256(convert_to(payload->>'draftToken','UTF8')),'hex')
    or p_draft->>'consentVersion' is distinct from '3' then
    raise exception 'Invalid confirmation' using errcode='22023';
  end if;
  identity:=jsonb_build_object('account',p_packet->>'account','sender',p_packet->>'sender','session',p_packet->>'session');
  if p_packet->>'account' is null or p_packet->>'account' !~ '^[A-Za-z0-9:_-]{1,128}$'
    or p_packet->>'session' is null or p_packet->>'session' !~ '^[A-Za-z0-9:_-]{1,128}$'
    or p_packet->>'sender' is null or p_packet->>'sender' !~ '^\+[1-9][0-9]{7,14}$'
    or p_draft->'identity' is distinct from identity then
    raise exception 'Identity mismatch' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants',0));
  perform pg_advisory_xact_lock(hashtextextended('openclaw_leave_bridge',0));
  lock table public.profiles,public.internal_org_people,private.employee_directory_details in share mode;
  people:=private.openclaw_leave_people();
  if encode(sha256(convert_to(people::text,'UTF8')),'hex') is distinct from p_source_fingerprint then
    raise exception 'Identity snapshot changed' using errcode='40001';
  end if;
  select item into employee from jsonb_array_elements(people) item where item->>'personId'=p_person_id::text;
  if employee is null or employee->>'nodeKind' is distinct from 'person'
    or employee->>'accountActive' is distinct from 'true' or employee->>'userId' is null
    or p_draft->>'personId' is distinct from p_person_id::text
    or p_draft->>'userId' is distinct from employee->>'userId' then
    raise exception 'Employee unavailable' using errcode='42501';
  end if;
  actor:=(employee->>'userId')::uuid;
  draft_id:=(p_draft->>'id')::uuid;
  if draft_id is null then raise exception 'Draft required'; end if;
  select body into old_receipt from private.openclaw_leave_receipts where key=p_key for update;
  if old_receipt is not null then
    if old_receipt->>'fingerprint' is distinct from p_body_fingerprint
      or old_receipt->>'personId' is distinct from p_person_id::text or old_receipt->>'userId' is distinct from actor::text then
      raise exception 'Event conflict' using errcode='40001';
    end if;
    return old_receipt->'result';
  end if;
  select body into old_submission from private.openclaw_leave_drafts where id=draft_id for update;
  if old_submission is not null then
    if old_submission->>'consentVersion' is distinct from '3' or old_submission->>'tokenHash' is distinct from p_token_hash
      or old_submission->'identity' is distinct from identity or old_submission->>'personId' is distinct from p_person_id::text
      or old_submission->>'userId' is distinct from actor::text or not(old_submission ? 'result') then
      raise exception 'Nonce conflict' using errcode='40001';
    end if;
    result:=jsonb_build_object('code','submitted')||(old_submission->'result');
  else
    now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
    if p_draft->>'issuedAt' is null or p_draft->>'expiresAt' is null
      or (p_draft->>'issuedAt')::bigint>now_ms or (p_draft->>'expiresAt')::bigint<=now_ms
      or (p_draft->>'expiresAt')::bigint-(p_draft->>'issuedAt')::bigint<>600000
      or p_draft->>'digest' is null or p_draft->>'summary' is null
      or p_draft->>'digest' is distinct from encode(sha256(convert_to(p_draft->>'summary','UTF8')),'hex')
      or p_draft->'employmentType' is distinct from employee->'employmentType'
      or p_draft->>'fullName' is distinct from btrim(employee->>'fullName') then
      raise exception 'Expired or changed draft' using errcode='40001';
    end if;
    if (select count(*) from private.openclaw_leave_receipts where body->>'personId'=p_person_id::text
      and created_at>clock_timestamp()-interval '1 hour')>=120 then raise exception 'Rate limited' using errcode='54000'; end if;
    lock table public.leave_requests in share row exclusive mode;
    if exists(select 1 from public.leave_requests r where r.employee_person_id=p_person_id
      and r.status in ('submitted','approved','changes_requested')
      and r.start_date<=(p_draft->'fields'->>'endDate')::date and r.end_date>=(p_draft->'fields'->>'startDate')::date) then
      raise exception 'Existing leave overlaps' using errcode='23P01';
    end if;
    select s.id into strict request_id from private.openclaw_submit_self(actor,
      p_draft->'fields'->>'leaveType',(p_draft->'fields'->>'startDate')::date,(p_draft->'fields'->>'endDate')::date,
      (p_draft->'fields'->>'startTime')::time,(p_draft->'fields'->>'endTime')::time,p_draft->'fields'->>'employeeNote') s;
    update public.leave_requests set submitted_by=actor where id=request_id;
    result:=jsonb_build_object('code','submitted','requestId',request_id,'status','Pending');
    -- Minimal successful nonce record: no token, note or duplicate HR fields.
    insert into private.openclaw_leave_drafts(id,body) values(draft_id,jsonb_build_object(
      'consentVersion',3,'identity',identity,'personId',p_person_id,'userId',actor,'tokenHash',p_token_hash,'result',result-'code'));
  end if;
  insert into private.openclaw_leave_receipts(key,body) values(p_key,jsonb_build_object(
    'fingerprint',p_body_fingerprint,'personId',p_person_id,'userId',actor,'result',result));
  return result;
end;
$$;
revoke all on function public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text) to service_role;

commit;
