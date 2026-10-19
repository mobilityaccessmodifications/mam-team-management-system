begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $notification_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance notification purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance notification purge baseline differs.' using errcode='55000';
  end if;
end $notification_catalog_lock$;
create temporary table performance_notification_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash,
  (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid='private.notification_event_key_valid(text)'::regprocedure) validator_metadata
from private.confirmed_test_purge_schema where singleton;
create function pg_temp.performance_notification_relation_oids() returns oid[] language sql stable set search_path='' as $$
  select array(select oid from (select to_regclass('private.performance_review_notifications')::oid oid
    union select indexrelid from pg_index where indrelid=to_regclass('private.performance_review_notifications')) relations where oid is not null)
$$;
create temporary table performance_notification_function_spec(signature text primary key) on commit drop;
insert into performance_notification_function_spec values
  ('private.notification_event_key_valid(text)'),
  ('private.queue_performance_review_notification()'),
  ('private.performance_review_notification_payload(private.performance_reviews,text)'),
  ('public.claim_performance_review_notifications(uuid,integer)'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)'),
  ('public.finish_performance_review_notification(uuid,uuid,boolean)');
do $notification_catalog_projection$
declare query text; anchor text; constraints_anchor text;
begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance notification catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'where n.nspname in (''public'',''private'',''storage'')',
    'where c.oid<>all(pg_temp.performance_notification_relation_oids()) and n.nspname in (''public'',''private'',''storage'')');
  constraints_anchor:='where connamespace in (select oid from pg_namespace where nspname in (''public'',''private'',''storage'')) or confrelid=''auth.users''::regclass or confrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid<>all(pg_temp.performance_notification_relation_oids()) and n.nspname in (''public'',''private'',''storage''))';
  query:=replace(query,constraints_anchor,'where conrelid<>all(pg_temp.performance_notification_relation_oids()) and ('||substr(constraints_anchor,7)||')');
  query:=replace(query,'and not t.tgisinternal',
    'and not t.tgisinternal and c.oid<>all(pg_temp.performance_notification_relation_oids()) and not (t.tgrelid=''private.performance_reviews''::regclass and t.tgname in (''performance_review_started_notification'',''performance_review_self_submitted_notification''))');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_notification_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_notification_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $notification_catalog_projection$;
create temporary table performance_notification_preserved_before on commit drop as
select * from pg_temp.performance_notification_preserved_catalog();

do $$
begin
  if encode(extensions.digest((select prosrc from pg_proc where oid='private.notification_event_key_valid(text)'::regprocedure),'sha256'),'hex')
    is distinct from '17da7950ef991aa2384d175d72a219c8227074cb71a9a64dcab679c50ed2284e' then
    raise exception 'Performance notification event validator predecessor differs.' using errcode='55000';
  end if;
end $$;

create or replace function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(length(p_key)<=160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live)' ||
    '|checkin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(2-week|1-month|2-month|3-month|5-month|6-month|6-month-casual):initial:(test|live)' ||
    '|checkin-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:hr:[1-9][0-9]*:(test|live)' ||
    '|onboarding-credential:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*' ||
    '|subscription-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due)' ||
    '|performance-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(started|self-submitted))$'
  ),false)
$$;

create table private.performance_review_notifications (
  delivery_id uuid primary key default gen_random_uuid(),
  review_id uuid not null references private.performance_reviews(id) on delete restrict,
  event text not null check(event in ('started','self-submitted')),
  state text not null default 'queued' check(state in ('queued','claimed','provider_accepted','needs_review')),
  claim_token uuid unique,
  recipient text,
  queued_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  finished_at timestamptz,
  unique(review_id,event),
  check((state='queued' and claim_token is null and recipient is null and claimed_at is null and finished_at is null)
    or (state='claimed' and claim_token is not null and recipient is not null and claimed_at is not null and finished_at is null)
    or (state='provider_accepted' and claim_token is not null and recipient is not null and claimed_at is not null and finished_at is not null)
    or (state='needs_review' and finished_at is not null and ((claim_token is null and recipient is null and claimed_at is null)
      or (claim_token is not null and recipient is not null and claimed_at is not null))))
);
create index performance_review_notifications_queued on private.performance_review_notifications(queued_at,delivery_id) where state='queued';
alter table private.performance_review_notifications enable row level security;
alter table private.performance_review_notifications force row level security;
revoke all on private.performance_review_notifications from public,anon,authenticated,service_role;

create function private.queue_performance_review_notification()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into private.performance_review_notifications(review_id,event)
    values(new.id,case when tg_op='INSERT' then 'started' else 'self-submitted' end)
    on conflict(review_id,event) do nothing;
  return new;
end $$;
revoke all on function private.queue_performance_review_notification() from public,anon,authenticated,service_role;
create trigger performance_review_started_notification after insert on private.performance_reviews
  for each row execute function private.queue_performance_review_notification();
create trigger performance_review_self_submitted_notification after update of self_submitted_at on private.performance_reviews
  for each row when(old.self_submitted_at is null and new.self_submitted_at is not null)
  execute function private.queue_performance_review_notification();

create function private.performance_review_notification_payload(p_review private.performance_reviews,p_event text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'event',p_event,'eventKey','performance-review:'||p_review.id::text||':'||p_event,
    'reviewId',p_review.id,'reviewCode','PR-'||p_review.cycle||'-'||p_review.review_no,
    'cycle',p_review.cycle,'dueDate',p_review.due_date,'recipient',lower(btrim(detail.work_email)),
    'employeeName',p_review.employee_identity->>'name','managerName',p_review.manager_identity->>'name')
  from public.internal_org_people employee
  join public.internal_org_people manager on manager.id=p_review.assigned_manager_person_id and manager.company_key=employee.company_key
  cross join lateral private.portal_role_policy(employee.auth_user_id) ep
  cross join lateral private.portal_role_policy(manager.auth_user_id) mp
  join private.employee_directory_details detail on detail.person_id=case when p_event='started' then employee.id else manager.id end
  where employee.id=p_review.employee_person_id and employee.id<>manager.id
    and employee.node_kind='person' and employee.is_active and manager.node_kind='person' and manager.is_active
    and ep.person_id=employee.id and ep.app_role in ('employee','manager','account')
    and mp.person_id=manager.id and mp.app_role='manager'
    and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=manager.id::text
    and private.performance_review_text(p_review.employee_identity->'name') and btrim(p_review.employee_identity->>'name')<>''
    and private.performance_review_text(p_review.manager_identity->'name') and btrim(p_review.manager_identity->>'name')<>''
    and ((p_event='started' and p_review.self_submitted_at is null)
      or (p_event='self-submitted' and p_review.self_submitted_at is not null and p_review.manager_completed_at is null and p_review.finalised_at is null))
    and detail.work_email is not null and length(lower(btrim(detail.work_email)))<=254
    and detail.work_email !~ '[[:cntrl:]]'
    and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=lower(btrim(detail.work_email)))=1
$$;
revoke all on function private.performance_review_notification_payload(private.performance_reviews,text) from public,anon,authenticated,service_role;

create function public.claim_performance_review_notifications(p_review_id uuid default null,p_limit integer default 1)
returns table(delivery_id uuid,review_id uuid,claim_token uuid,payload jsonb)
language plpgsql volatile security definer set search_path='' as $$
declare item record; review private.performance_reviews%rowtype; message jsonb; token uuid;
begin
  if p_limit is null or p_limit<1 or p_limit>10 then raise exception 'Invalid notification claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  for item in select n.delivery_id,n.review_id,n.event from private.performance_review_notifications n
    join private.performance_reviews r on r.id=n.review_id
    where n.state='queued' and (p_review_id is null or n.review_id=p_review_id)
    order by n.queued_at,n.delivery_id limit p_limit for update of n,r skip locked
  loop
    select r.* into review from private.performance_reviews r where r.id=item.review_id;
    perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
    perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id) order by d.person_id for share;
    message:=private.performance_review_notification_payload(review,item.event);
    if message is null then
      update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=item.delivery_id;
      continue;
    end if;
    token:=gen_random_uuid();
    update private.performance_review_notifications n set state='claimed',claim_token=token,recipient=message->>'recipient',claimed_at=clock_timestamp() where n.delivery_id=item.delivery_id;
    delivery_id:=item.delivery_id;review_id:=item.review_id;claim_token:=token;payload:=message;
    return next;
  end loop;
end $$;
revoke all on function public.claim_performance_review_notifications(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_performance_review_notifications(uuid,integer) to service_role;

create function public.reserve_performance_review_notification_mail(
  p_event_key text,p_recipient text,p_cc text,p_claim_token uuid,p_legacy_event_key text default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare delivery private.performance_review_notifications%rowtype; review private.performance_reviews%rowtype; message jsonb;
begin
  if p_event_key is null or p_event_key !~ '^performance-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(started|self-submitted)$'
    or p_cc is distinct from '' or p_claim_token is null or p_legacy_event_key is not null then
    raise exception 'Invalid performance notification reservation.' using errcode='22023';
  end if;
  perform private.lock_notification_delivery_store();
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  select r.* into review from private.performance_reviews r where r.id=split_part(p_event_key,':',2)::uuid for update;
  select n.* into delivery from private.performance_review_notifications n where n.review_id=review.id
    and n.event=split_part(p_event_key,':',3) and n.claim_token=p_claim_token for update;
  if not found or delivery.recipient is distinct from p_recipient then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  if exists(select 1 from private.notification_delivery_receipts r where r.event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  if delivery.state<>'claimed' then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
  perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id) order by d.person_id for share;
  message:=private.performance_review_notification_payload(review,delivery.event);
  if message is null or message->>'recipient' is distinct from p_recipient then
    update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=delivery.delivery_id;
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end $$;
revoke all on function public.reserve_performance_review_notification_mail(text,text,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_performance_review_notification_mail(text,text,text,uuid,text) to service_role;

create function public.finish_performance_review_notification(p_delivery_id uuid,p_claim_token uuid,p_delivered boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare delivery private.performance_review_notifications%rowtype;
begin
  if p_delivery_id is null or p_claim_token is null or p_delivered is null then return false; end if;
  perform private.lock_notification_delivery_store();
  select n.* into delivery from private.performance_review_notifications n
    where n.delivery_id=p_delivery_id and n.claim_token=p_claim_token for update;
  if not found then return false; end if;
  if delivery.state='provider_accepted' then return p_delivered; end if;
  if delivery.state='needs_review' then return not p_delivered; end if;
  if delivery.state<>'claimed' then return false; end if;
  if p_delivered and not exists(select 1 from private.notification_delivery_receipts r
    where r.event_key='performance-review:'||delivery.review_id::text||':'||delivery.event
      and r.state='sent' and r.recipient=delivery.recipient and r.cc='') then return false; end if;
  update private.performance_review_notifications n set state=case when p_delivered then 'provider_accepted' else 'needs_review' end,
    finished_at=clock_timestamp() where n.delivery_id=delivery.delivery_id;
  return true;
end $$;
revoke all on function public.finish_performance_review_notification(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.finish_performance_review_notification(uuid,uuid,boolean) to service_role;

do $notification_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_notification_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_notification_preserved_before
      except all select definition collate "C" from pg_temp.performance_notification_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_notification_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_notification_preserved_before))
    or (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid='private.notification_event_key_valid(text)'::regprocedure) is distinct from baseline.validator_metadata
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance notification unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance notification final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $notification_catalog_after$;

commit;
