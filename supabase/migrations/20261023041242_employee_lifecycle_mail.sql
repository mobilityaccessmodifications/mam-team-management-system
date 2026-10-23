begin;
set local search_path='';
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
select pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
do $lifecycle_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Lifecycle purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Lifecycle purge baseline differs.' using errcode='55000';
  end if;
end $lifecycle_catalog_lock$;
create temporary table lifecycle_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash,
  (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid='private.notification_event_key_valid(text)'::regprocedure) validator_metadata
from private.confirmed_test_purge_schema where singleton;
create function pg_temp.lifecycle_relation_oids() returns oid[] language sql stable set search_path='' as $$
  select array(select oid from (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname in ('employee_lifecycle_mail_control','employee_lifecycle_mail_recipients','employee_lifecycle_mail_outbox')
    union select i.indexrelid from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname in ('employee_lifecycle_mail_control','employee_lifecycle_mail_recipients','employee_lifecycle_mail_outbox')) relations)
$$;
create temporary table lifecycle_function_spec(signature text primary key) on commit drop;
insert into lifecycle_function_spec values
  ('private.notification_event_key_valid(text)'),
  ('private.employee_lifecycle_mail_recipient_valid(private.employee_lifecycle_mail_recipients)'),
  ('private.employee_lifecycle_mail_payload(private.employee_lifecycle_mail_outbox)'),
  ('private.sync_employee_lifecycle_mail(uuid,text,date,timestamp with time zone)'),
  ('private.queue_employee_lifecycle_mail_person()'),
  ('private.queue_employee_lifecycle_mail_schedule()'),
  ('public.set_employee_lifecycle_mail_enabled(boolean)'),
  ('public.claim_employee_lifecycle_mail(uuid,integer)'),
  ('public.reserve_employee_lifecycle_mail(text,text,text,uuid,text)'),
  ('public.finish_employee_lifecycle_mail(uuid,uuid,boolean)');
do $lifecycle_catalog_projection$
declare query text; anchor text; constraints_anchor text;
begin
  if exists(select 1 from pg_temp.lifecycle_function_spec s where s.signature<>'private.notification_event_key_valid(text)' and to_regprocedure(s.signature) is not null)
    or cardinality(pg_temp.lifecycle_relation_oids())<>0 then
    raise exception 'Lifecycle objects already exist.' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Lifecycle catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if position(anchor in query)=0 then raise exception 'Lifecycle catalog projection anchor differs.' using errcode='55000'; end if;
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'where n.nspname in (''public'',''private'',''storage'')',
    'where c.oid<>all(pg_temp.lifecycle_relation_oids()) and n.nspname in (''public'',''private'',''storage'')');
  constraints_anchor:='where connamespace in (select oid from pg_namespace where nspname in (''public'',''private'',''storage'')) or confrelid=''auth.users''::regclass or confrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid<>all(pg_temp.lifecycle_relation_oids()) and n.nspname in (''public'',''private'',''storage''))';
  query:=replace(query,constraints_anchor,'where conrelid<>all(pg_temp.lifecycle_relation_oids()) and not ((conrelid=''public.internal_org_people''::regclass and conname=''employee_lifecycle_mail_person'') or (conrelid=''private.scheduled_employee_offboarding''::regclass and conname=''employee_lifecycle_mail_schedule'')) and ('||substr(constraints_anchor,7)||')');
  query:=replace(query,'and not t.tgisinternal',
    'and not t.tgisinternal and not ((t.tgrelid=''public.internal_org_people''::regclass and t.tgname=''employee_lifecycle_mail_person'') or (t.tgrelid=''private.scheduled_employee_offboarding''::regclass and t.tgname=''employee_lifecycle_mail_schedule''))');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.lifecycle_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.lifecycle_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $lifecycle_catalog_projection$;
create temporary table lifecycle_preserved_before on commit drop as select * from pg_temp.lifecycle_preserved_catalog();

do $lifecycle_key$
declare body text; anchor text:='|performance-review:';
begin
  select prosrc into body from pg_proc where oid='private.notification_event_key_valid(text)'::regprocedure;
  if encode(extensions.digest(body,'sha256'),'hex') is distinct from '67729cceb5c674725ee3cbcd4b7d9e3c6c92c8c1cff1add34d69d64645a13278' then
    raise exception 'Lifecycle event validator predecessor differs.' using errcode='55000';
  end if;
  body:=replace(body,anchor,'|employee-lifecycle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(onboarding|offboarding)|performance-review:');
  execute 'create or replace function private.notification_event_key_valid(p_key text) returns boolean language sql immutable set search_path='''' as '||quote_literal(body);
end $lifecycle_key$;

create table private.employee_lifecycle_mail_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  activated_at timestamptz,
  check(not enabled or activated_at is not null)
);
insert into private.employee_lifecycle_mail_control(singleton) values(true);
create table private.employee_lifecycle_mail_recipients (
  slot text primary key check(slot in ('hr','accounts','bookkeeper','reporting','it','minor','major','warehouse','equipsy')),
  person_id uuid unique references public.internal_org_people(id) on delete restrict,
  approved_email text not null check(approved_email=private.notification_recipient_set(approved_email,true) and position(',' in approved_email)=0),
  company_key text,
  team_name text,
  check(((slot='it' and person_id is null and company_key is null and team_name is null)
    or (slot in ('hr','accounts','bookkeeper','reporting') and person_id is not null and company_key is null and team_name is null)
    or (slot in ('minor','major','warehouse') and person_id is not null and company_key='mam'
      and team_name=case slot when 'minor' then 'Minor' when 'major' then 'Major' else 'Warehouse' end)
    or (slot='equipsy' and person_id is not null and company_key='equipsy' and team_name='Equipsy')) is true)
);
create table private.employee_lifecycle_mail_outbox (
  delivery_id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id) on delete restrict,
  event text not null check(event in ('onboarding','offboarding')),
  end_date date,
  due_at timestamptz not null,
  state text not null default 'queued' check(state in ('queued','claimed','provider_accepted','needs_review','cancelled')),
  claim_token uuid unique,
  recipient text,
  employee jsonb,
  queued_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  finished_at timestamptz,
  unique(person_id,event),
  check((event='onboarding' and end_date is null) or (event='offboarding' and end_date is not null and isfinite(end_date))),
  check(recipient is null or recipient=private.notification_recipient_set(recipient,true)),
  check((state='queued' and claim_token is null and recipient is null and employee is null and claimed_at is null and finished_at is null)
    or (state in ('claimed','provider_accepted') and claim_token is not null and recipient is not null and employee is not null and claimed_at is not null
      and (state='claimed' and finished_at is null or state='provider_accepted' and finished_at is not null))
    or (state in ('needs_review','cancelled') and finished_at is not null)),
  check(employee is null or (jsonb_typeof(employee)='object' and employee ?& array['name','company','role','department','location','employmentType','startDate','endDate']
    and employee-array['name','company','role','department','location','employmentType','startDate','endDate']='{}'::jsonb))
);
create index employee_lifecycle_mail_due on private.employee_lifecycle_mail_outbox(due_at,delivery_id) where state in ('queued','claimed');
alter table private.employee_lifecycle_mail_control enable row level security;
alter table private.employee_lifecycle_mail_control force row level security;
alter table private.employee_lifecycle_mail_recipients enable row level security;
alter table private.employee_lifecycle_mail_recipients force row level security;
alter table private.employee_lifecycle_mail_outbox enable row level security;
alter table private.employee_lifecycle_mail_outbox force row level security;
revoke all on private.employee_lifecycle_mail_control,private.employee_lifecycle_mail_recipients,private.employee_lifecycle_mail_outbox from public,anon,authenticated,service_role;

create function private.employee_lifecycle_mail_recipient_valid(p_config private.employee_lifecycle_mail_recipients)
returns boolean language sql stable security definer set search_path='' as $$
  select p_config.slot='it' or exists(
    select 1 from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
    left join public.profiles profile on profile.id=p.auth_user_id
    where p.id=p_config.person_id and p.node_kind='person' and p.is_active
      and lower(btrim(d.work_email))=p_config.approved_email and d.work_email !~ '[[:cntrl:]]'
      and (p.auth_user_id is null or profile.account_status='active')
      and (p_config.team_name is null or (p.company_key=p_config.company_key and profile.app_role='manager')))
$$;

create function private.employee_lifecycle_mail_payload(p_delivery private.employee_lifecycle_mail_outbox)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare subject public.internal_org_people%rowtype; detail private.employee_directory_details%rowtype;
  manager private.employee_lifecycle_mail_recipients%rowtype; target text; snapshot jsonb;
begin
  select * into subject from public.internal_org_people where id=p_delivery.person_id and node_kind='person';
  select * into detail from private.employee_directory_details where person_id=p_delivery.person_id;
  if subject.id is null or detail.person_id is null or nullif(btrim(subject.full_name),'') is null
    or subject.company_key not in ('mam','equipsy') or subject.company_key is null
    or (p_delivery.event='onboarding' and (not subject.is_active or subject.started_date is null or not isfinite(subject.started_date)))
    or (p_delivery.event='offboarding' and (detail.scheduled_employment_end_date is distinct from p_delivery.end_date
      or (subject.is_active and not exists(select 1 from private.scheduled_employee_offboarding s where s.person_id=subject.id and s.end_date=p_delivery.end_date)))) then return null; end if;
  if (select count(*) from private.employee_lifecycle_mail_recipients)<>9
    or (select count(*) from private.employee_lifecycle_mail_recipients where team_name is null)<>5
    or exists(select 1 from private.employee_lifecycle_mail_recipients c where c.team_name is null and not private.employee_lifecycle_mail_recipient_valid(c)) then return null; end if;
  with recursive ancestors as (
    select p.id,p.parent_id,1 depth,array[subject.id,p.id] path from public.internal_org_people p where p.id=subject.parent_id and p.id<>subject.id
    union all select p.id,p.parent_id,a.depth+1,a.path||p.id from ancestors a join public.internal_org_people p on p.id=a.parent_id
    where not p.id=any(a.path) and a.depth<100)
  select c.* into manager from ancestors a join private.employee_lifecycle_mail_recipients c on c.person_id=a.id
    where c.team_name is not null and c.company_key=subject.company_key and c.person_id<>subject.id order by a.depth,c.slot limit 1;
  if manager.slot is null and detail.team_name in ('Minor','Major','Warehouse','Equipsy') then
    select c.* into manager from private.employee_lifecycle_mail_recipients c
    where c.company_key=subject.company_key and c.team_name=detail.team_name and c.person_id<>subject.id;
  end if;
  if manager.slot is not null and not private.employee_lifecycle_mail_recipient_valid(manager) then return null; end if;
  select string_agg(address,',' order by address collate "C") into target from (
    select c.approved_email address from private.employee_lifecycle_mail_recipients c where c.team_name is null
    union select manager.approved_email where manager.slot is not null) addresses;
  snapshot:=jsonb_build_object('name',subject.full_name,'company',case subject.company_key when 'mam' then 'MAM' else 'Equipsy' end,
    'role',coalesce(subject.position_title,''),'department',coalesce(detail.team_name,''),'location',coalesce(detail.country,''),
    'employmentType',coalesce(detail.employment_type,''),'startDate',to_char(subject.started_date,'YYYY-MM-DD'),
    'endDate',case when p_delivery.event='offboarding' then to_char(p_delivery.end_date,'YYYY-MM-DD') else null end);
  return jsonb_build_object('event',p_delivery.event,'eventKey','employee-lifecycle:'||p_delivery.delivery_id::text||':'||p_delivery.event,
    'personId',subject.id,'recipient',target,'employee',snapshot);
end $$;

create function private.sync_employee_lifecycle_mail(p_person_id uuid,p_event text,p_end_date date,p_due_at timestamptz)
returns void language plpgsql volatile security definer set search_path='' as $$
declare existing private.employee_lifecycle_mail_outbox%rowtype;
begin
  select * into existing from private.employee_lifecycle_mail_outbox where person_id=p_person_id and event=p_event for update;
  if found and (existing.state in ('provider_accepted','needs_review') or exists(select 1 from private.notification_delivery_receipts r
    where r.event_key='employee-lifecycle:'||existing.delivery_id::text||':'||existing.event)) then return; end if;
  if p_due_at is null then
    update private.employee_lifecycle_mail_outbox set state='cancelled',finished_at=clock_timestamp() where delivery_id=existing.delivery_id and state in ('queued','claimed');
  elsif existing.delivery_id is null then
    insert into private.employee_lifecycle_mail_outbox(person_id,event,end_date,due_at) values(p_person_id,p_event,p_end_date,p_due_at);
  elsif existing.end_date is distinct from p_end_date or existing.state='cancelled' or p_due_at<existing.due_at then
    update private.employee_lifecycle_mail_outbox set end_date=p_end_date,due_at=p_due_at,state='queued',claim_token=null,recipient=null,employee=null,claimed_at=null,finished_at=null
    where delivery_id=existing.delivery_id;
  end if;
end $$;

create function private.queue_employee_lifecycle_mail_person()
returns trigger language plpgsql security definer set search_path='' as $$
declare subject public.internal_org_people%rowtype; final_date date;
begin
  if not (select enabled from private.employee_lifecycle_mail_control where singleton) then return new; end if;
  select * into subject from public.internal_org_people where id=new.id;
  if subject.node_kind is distinct from 'person' then return new; end if;
  if tg_op='INSERT' then
    if new.is_active and subject.is_active then perform private.sync_employee_lifecycle_mail(subject.id,'onboarding',null,clock_timestamp()); end if;
  elsif old.is_active and not new.is_active and not subject.is_active then
    perform private.sync_employee_lifecycle_mail(subject.id,'onboarding',null,null);
    select scheduled_employment_end_date into final_date from private.employee_directory_details where person_id=subject.id;
    if final_date is not null and final_date<=(clock_timestamp() at time zone 'Australia/Melbourne')::date
      and (not exists(select 1 from private.scheduled_employee_offboarding where person_id=subject.id)
        or exists(select 1 from private.employee_lifecycle_mail_outbox where person_id=subject.id and event='offboarding')
        or auth.uid() is not null) then
      perform private.sync_employee_lifecycle_mail(subject.id,'offboarding',final_date,clock_timestamp());
    end if;
  elsif not old.is_active and new.is_active and subject.is_active then
    perform private.sync_employee_lifecycle_mail(subject.id,'offboarding',null,null);
  end if;
  return new;
end $$;
create constraint trigger employee_lifecycle_mail_person after insert or update on public.internal_org_people
  deferrable initially deferred for each row execute function private.queue_employee_lifecycle_mail_person();

create function private.queue_employee_lifecycle_mail_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
declare person uuid; final_date date;
begin
  if not (select enabled from private.employee_lifecycle_mail_control where singleton) then return null; end if;
  if tg_op='UPDATE' and new.end_date is not distinct from old.end_date then return new; end if;
  person:=case when tg_op='DELETE' then old.person_id else new.person_id end;
  if exists(select 1 from public.internal_org_people p where p.id=person and not p.is_active) then return null; end if;
  select s.end_date into final_date from private.scheduled_employee_offboarding s join public.internal_org_people p on p.id=s.person_id where s.person_id=person and p.is_active;
  perform private.sync_employee_lifecycle_mail(person,'offboarding',final_date,(final_date+time '09:00') at time zone 'Australia/Melbourne');
  return null;
end $$;
create constraint trigger employee_lifecycle_mail_schedule after insert or update or delete on private.scheduled_employee_offboarding
  deferrable initially deferred for each row execute function private.queue_employee_lifecycle_mail_schedule();

create function public.set_employee_lifecycle_mail_enabled(p_enabled boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare control private.employee_lifecycle_mail_control%rowtype; schedule record; seeded integer:=0; at_time timestamptz:=clock_timestamp();
begin
  if p_enabled is null then raise exception 'Lifecycle enabled flag required.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
  lock table public.internal_org_people,private.employee_directory_details,private.scheduled_employee_offboarding in share row exclusive mode;
  select * into control from private.employee_lifecycle_mail_control where singleton for update;
  if p_enabled then
    if (select count(*) from private.employee_lifecycle_mail_recipients)<>9 or exists(select 1 from private.employee_lifecycle_mail_recipients c where not private.employee_lifecycle_mail_recipient_valid(c))
      or not (select ready from private.notification_delivery_control where singleton) then
      raise exception 'Lifecycle recipients or receipt store are not ready.' using errcode='55000';
    end if;
    if control.activated_at is null then
      for schedule in select s.person_id,s.end_date from private.scheduled_employee_offboarding s
        join public.internal_org_people p on p.id=s.person_id and p.node_kind='person' and p.is_active
        join private.employee_directory_details d on d.person_id=p.id and d.scheduled_employment_end_date=s.end_date
        where s.end_date>(at_time at time zone 'Australia/Melbourne')::date
      loop
        perform private.sync_employee_lifecycle_mail(schedule.person_id,'offboarding',schedule.end_date,(schedule.end_date+time '09:00') at time zone 'Australia/Melbourne');
        seeded:=seeded+1;
      end loop;
    end if;
  end if;
  update private.employee_lifecycle_mail_control set enabled=p_enabled,activated_at=case when p_enabled then coalesce(activated_at,at_time) else activated_at end where singleton;
  return jsonb_build_object('enabled',p_enabled,'futureSchedulesSeeded',seeded,'activatedAt',case when p_enabled then coalesce(control.activated_at,at_time) else control.activated_at end);
end $$;

create function public.claim_employee_lifecycle_mail(p_person_id uuid default null,p_limit integer default 1)
returns table(delivery_id uuid,person_id uuid,claim_token uuid,payload jsonb)
language plpgsql volatile security definer set search_path='' as $$
declare item private.employee_lifecycle_mail_outbox%rowtype; message jsonb; token uuid; receipt private.notification_delivery_receipts%rowtype; count_claimed integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid lifecycle claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
  if not (select enabled from private.employee_lifecycle_mail_control where singleton for share) then return; end if;
  perform 1 from private.employee_lifecycle_mail_recipients order by slot for share;
  perform 1 from public.internal_org_people p where p.id in (select c.person_id from private.employee_lifecycle_mail_recipients c) order by p.id for share;
  perform 1 from private.employee_directory_details d where d.person_id in (select c.person_id from private.employee_lifecycle_mail_recipients c) order by d.person_id for share;
  perform 1 from public.profiles p where p.id in (select o.auth_user_id from public.internal_org_people o join private.employee_lifecycle_mail_recipients c on c.person_id=o.id) order by p.id for share;
  for item in select n.* from private.employee_lifecycle_mail_outbox n
    where n.due_at<=clock_timestamp() and (p_person_id is null or n.person_id=p_person_id)
      and (n.state='queued' or (n.state='claimed' and n.claimed_at<clock_timestamp()-interval '5 minutes'))
    order by n.due_at,n.delivery_id limit 500 for update skip locked
  loop
    select * into receipt from private.notification_delivery_receipts r where r.event_key='employee-lifecycle:'||item.delivery_id::text||':'||item.event;
    if found then
      update private.employee_lifecycle_mail_outbox n set state=case when receipt.state='sent' and receipt.recipient=item.recipient and receipt.cc='' then 'provider_accepted' else 'needs_review' end,finished_at=clock_timestamp()
      where n.delivery_id=item.delivery_id;
      continue;
    end if;
    perform 1 from public.internal_org_people p where p.id=item.person_id for share;
    perform 1 from private.employee_directory_details d where d.person_id=item.person_id for share;
    message:=private.employee_lifecycle_mail_payload(item);
    if message is null then continue; end if;
    token:=gen_random_uuid();
    update private.employee_lifecycle_mail_outbox n set state='claimed',claim_token=token,recipient=message->>'recipient',employee=message->'employee',claimed_at=clock_timestamp(),finished_at=null where n.delivery_id=item.delivery_id;
    delivery_id:=item.delivery_id;person_id:=item.person_id;claim_token:=token;payload:=message;
    return next;
    count_claimed:=count_claimed+1;
    if count_claimed>=p_limit then return; end if;
  end loop;
end $$;

create function public.reserve_employee_lifecycle_mail(p_event_key text,p_recipient text,p_cc text,p_claim_token uuid,p_legacy_event_key text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare item private.employee_lifecycle_mail_outbox%rowtype; message jsonb;
begin
  if p_event_key is null or p_event_key !~ '^employee-lifecycle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(onboarding|offboarding)$'
    or p_cc is distinct from '' or p_claim_token is null or p_legacy_event_key is not null then
    raise exception 'Invalid lifecycle reservation.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
  perform private.lock_notification_delivery_store();
  if not (select enabled from private.employee_lifecycle_mail_control where singleton for share) then
    return private.notification_delivery_rejection(p_event_key,'lifecycle-disabled',false);
  end if;
  select * into item from private.employee_lifecycle_mail_outbox where delivery_id=split_part(p_event_key,':',2)::uuid
    and event=split_part(p_event_key,':',3) and claim_token=p_claim_token for update;
  if not found or item.recipient is distinct from p_recipient or item.due_at>clock_timestamp() then
    return private.notification_delivery_rejection(p_event_key,'lifecycle-claim-unavailable',false);
  end if;
  if exists(select 1 from private.notification_delivery_receipts where event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  if item.state<>'claimed' then return private.notification_delivery_rejection(p_event_key,'lifecycle-claim-unavailable',false); end if;
  perform 1 from private.employee_lifecycle_mail_recipients order by slot for share;
  perform 1 from public.internal_org_people p where p.id=item.person_id or p.id in (select c.person_id from private.employee_lifecycle_mail_recipients c) order by p.id for share;
  perform 1 from private.employee_directory_details d where d.person_id=item.person_id or d.person_id in (select c.person_id from private.employee_lifecycle_mail_recipients c) order by d.person_id for share;
  perform 1 from public.profiles p where p.id in (select o.auth_user_id from public.internal_org_people o join private.employee_lifecycle_mail_recipients c on c.person_id=o.id) order by p.id for share;
  message:=private.employee_lifecycle_mail_payload(item);
  if message is null or message->>'recipient' is distinct from p_recipient or message->'employee' is distinct from item.employee then
    return private.notification_delivery_rejection(p_event_key,'lifecycle-snapshot-changed',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end $$;

create function public.finish_employee_lifecycle_mail(p_delivery_id uuid,p_claim_token uuid,p_delivered boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare item private.employee_lifecycle_mail_outbox%rowtype; receipt private.notification_delivery_receipts%rowtype;
begin
  if p_delivery_id is null or p_claim_token is null or p_delivered is null then return false; end if;
  perform private.lock_notification_delivery_store();
  select * into item from private.employee_lifecycle_mail_outbox where delivery_id=p_delivery_id and claim_token=p_claim_token for update;
  if not found then return false; end if;
  if item.state='provider_accepted' then return p_delivered; end if;
  select * into receipt from private.notification_delivery_receipts where event_key='employee-lifecycle:'||item.delivery_id::text||':'||item.event;
  if receipt.state='sent' and receipt.recipient=item.recipient and receipt.cc='' then
    update private.employee_lifecycle_mail_outbox set state='provider_accepted',finished_at=clock_timestamp() where delivery_id=item.delivery_id;
    return true;
  end if;
  if p_delivered then return false; end if;
  if receipt.event_key is not null then
    update private.employee_lifecycle_mail_outbox set state='needs_review',finished_at=clock_timestamp() where delivery_id=item.delivery_id;
  elsif item.state='claimed' then
    update private.employee_lifecycle_mail_outbox set state='queued',claim_token=null,recipient=null,employee=null,claimed_at=null,finished_at=null where delivery_id=item.delivery_id;
  else return false;
  end if;
  return true;
end $$;

do $lifecycle_acl$
declare spec record;
begin
  for spec in select signature from pg_temp.lifecycle_function_spec where signature<>'private.notification_event_key_valid(text)' loop
    execute 'revoke all on function '||spec.signature||' from public,anon,authenticated,service_role';
    if spec.signature like 'public.%' then execute 'grant execute on function '||spec.signature||' to service_role'; end if;
  end loop;
end $lifecycle_acl$;

do $lifecycle_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.lifecycle_catalog_before;
  if exists((select definition collate "C" from pg_temp.lifecycle_preserved_before except all select definition collate "C" from pg_temp.lifecycle_preserved_catalog())
    union all (select definition collate "C" from pg_temp.lifecycle_preserved_catalog() except all select definition collate "C" from pg_temp.lifecycle_preserved_before))
    or (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid='private.notification_event_key_valid(text)'::regprocedure) is distinct from baseline.validator_metadata
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash
    or exists(select 1 from private.employee_lifecycle_mail_outbox)
    or exists(select 1 from private.employee_lifecycle_mail_recipients)
    or (select enabled or activated_at is not null from private.employee_lifecycle_mail_control where singleton) then
    raise exception 'Lifecycle unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Lifecycle final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $lifecycle_catalog_after$;
commit;
