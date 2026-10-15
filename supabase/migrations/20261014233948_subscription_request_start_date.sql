begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema,private.subscription_register,private.subscription_audit_events,private.subscription_requests,private.subscription_request_events,private.subscription_request_config in share row exclusive mode nowait;
do $$ declare signature text; expected text; begin
 if (select count(*) from private.confirmed_test_purge_schema)<>1 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then raise exception 'Subscription start date requires the reviewed predecessor.' using errcode='55000'; end if;
 for signature,expected in select * from (values
  ('private.sr_validate(jsonb,boolean)','d6276ed145199f73326a413b32586f09853c00730f0171ab3884e525e4f50d5f'),
  ('private.sr_register_gate()','d9e602a96d192b4f1f3cf9c14282007882cc623465f77799bf5c92f3d5471885'),
  ('public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[])','9a6070a9586327e9cae0e62ad5e14e703bd0cf4200c8266bec7502d30716c617'),
  ('private.subscription_register_v2_projection(uuid)','8dbac36da7e6ca3ec77e7f61f1b912f1acce250ce85990ca69f5b064c75448e8')
 ) reviewed(signature,expected) loop
  if encode(extensions.digest(pg_get_functiondef(to_regprocedure(signature)),'sha256'),'hex') is distinct from expected then raise exception 'Subscription start date function predecessor differs: %',signature using errcode='55000'; end if;
 end loop;
end $$;
alter table private.subscription_register add column start_date date,
 add constraint subscription_start_date_valid check(start_date is null or (isfinite(start_date) and start_date between date '0001-01-01' and date '9999-12-31'));
alter table private.subscription_audit_events drop constraint subscription_audit_changed_fields_valid;
alter table private.subscription_audit_events add constraint subscription_audit_changed_fields_valid check(changed_fields <@ array['service_name','plan_name','subscription_status','pricing_model','billing_cycle','amount_cents','currency_code','renewal_date','next_review_on','responsible_person_id','member_person_ids','seat_count','mam_credit_card_used','credit_card_used','credit_card_holder','billing_anchor_date','company_scope','start_date']::text[]);
do $$ declare definition text; anchor text:='''company_scope'', subscription.company_scope,'; begin
 select pg_get_functiondef('private.subscription_register_v2_projection(uuid)'::regprocedure) into definition;
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Subscription date projection predecessor differs.' using errcode='55000'; end if;
 execute replace(definition,anchor,'''start_date'', subscription.start_date, '||anchor);
end $$;

create or replace function private.sr_validate(p jsonb, submitting boolean) returns void language plpgsql set search_path='' as $$
declare field text; value jsonb; chosen text; alternative text; v2 boolean:=p->'formVersion'='2'::jsonb; v3 boolean:=p->'formVersion'='3'::jsonb; begin
  if p is null or jsonb_typeof(p)<>'object' or pg_column_size(p)>100000 then raise exception 'Request fields are invalid.' using errcode='22023'; end if;
  for field,value in select * from jsonb_each(p) loop
    if field not in ('kind','service','plan','purpose','company','payer','duration','billing','currency','tax','quoteCents','noQuoteReason','audEstimateCents','payment','cardLabel','cardHolder','responsiblePersonId','intendedUsers','formVersion','monthlyCostCents','annualCostCents','comparisonUnavailableReason','websiteUrl','category','usageFrequency','oneOffCostCents','invoiceEmail','invoiceContact','startDate') then raise exception 'Unsupported request field.' using errcode='22023'; end if;
    if field in ('websiteUrl','category','usageFrequency','oneOffCostCents','invoiceEmail','invoiceContact') and not coalesce(v3,false) then raise exception 'Unsupported request field for this version.' using errcode='22023'; end if;
    if field='startDate' then
      if not (coalesce(v2,false) or coalesce(v3,false)) or jsonb_typeof(value)<>'string' then raise exception 'Start date is invalid for this request.' using errcode='22023'; end if;
      if p->>field<>'' then
        begin
          if p->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(p->>field,4)='0000' or not isfinite((p->>field)::date) or to_char((p->>field)::date,'YYYY-MM-DD')<>p->>field then raise exception 'Start date is invalid.' using errcode='22023'; end if;
        exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Start date is invalid.' using errcode='22023'; end;
      end if;
    elsif field='formVersion' then
      if value not in ('2'::jsonb,'3'::jsonb) then raise exception 'Request form version is invalid.' using errcode='22023'; end if;
    elsif field in ('quoteCents','audEstimateCents','monthlyCostCents','annualCostCents','oneOffCostCents') then
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'number' or value::text !~ '^\d+$' or (value::text)::numeric>100000000) then raise exception 'Enter a valid amount in cents.' using errcode='22023'; end if;
    elsif field='responsiblePersonId' then
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'string' or p->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'Responsible person is invalid.' using errcode='22023'; end if;
    elsif jsonb_typeof(value)<>'string' or length(p->>field)>4000 then raise exception 'Request text is invalid.' using errcode='22023'; end if;
  end loop;
  if (p ? 'kind' and p->>'kind' not in ('new_purchase','renewal','added_seats','plan_change')) or
    (p ? 'company' and p->>'company' not in ('mam','equipsy','both')) or
    (p ? 'billing' and p->>'billing' not in ('monthly','annual','one_off','other')) or
    (p ? 'payment' and p->>'payment' not in ('card','non_card','invoice','direct_debit')) or
    (p ? 'currency' and p->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Request selection is invalid.' using errcode='22023'; end if;
  if (coalesce(v2,false) or coalesce(v3,false)) and ((p ? 'billing' and p->>'billing' not in ('monthly','annual','one_off')) or
    (p ? 'duration' and p->>'duration' not in ('ongoing','3_months','12_months')) or
    (p ? 'currency' and p->>'currency'<>'AUD') or length(coalesce(p->>'service',''))>160 or length(coalesce(p->>'plan',''))>160 or
    length(coalesce(p->>'cardLabel',''))>160 or length(coalesce(p->>'cardHolder',''))>160) then raise exception 'Request selection is invalid.' using errcode='22023'; end if;
  if (coalesce(v2,false) and p->>'billing'='one_off') or
    (coalesce(v3,false) and p ? 'kind' and p->>'kind'<>'new_purchase') or
    (coalesce(v3,false) and p ? 'payment' and p->>'payment' not in ('card','invoice','direct_debit')) or
    (not coalesce(v3,false) and p ? 'payment' and p->>'payment' not in ('card','non_card')) or
    (coalesce(v3,false) and p ? 'category' and p->>'category' not in ('software_app','hardware','subscription','one_off_service')) or
    length(coalesce(p->>'websiteUrl',''))>2048 or length(coalesce(p->>'invoiceEmail',''))>254 or length(coalesce(p->>'invoiceContact',''))>160 or
    (nullif(btrim(p->>'websiteUrl'),'') is not null and (p->>'websiteUrl' !~* '^https?://[^[:space:][:cntrl:]/?#@]+([/?#][^[:space:][:cntrl:]]*)?$' or p->>'websiteUrl' ~ '[<>]')) or
    (nullif(btrim(p->>'invoiceEmail'),'') is not null and p->>'invoiceEmail' !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Request template selection or contact is invalid.' using errcode='22023';
  end if;
  if submitting then
    foreach field in array case when coalesce(v2,false) or coalesce(v3,false) then array['kind','service','purpose','company','duration','billing','currency','payment','intendedUsers'] else array['kind','service','purpose','company','payer','duration','billing','currency','tax','payment','intendedUsers'] end loop
      if nullif(btrim(p->>field),'') is null then raise exception 'Complete the required request fields.' using errcode='22023'; end if;
    end loop;
    if coalesce(v3,false) and (nullif(btrim(p->>'category'),'') is null or (p->>'category'='one_off_service' and p->>'billing'<>'one_off')) then raise exception 'Choose the request category.' using errcode='22023'; end if;
    if coalesce(v3,false) and p->>'billing'='one_off' then
      if p->>'oneOffCostCents' is null or (p->>'oneOffCostCents')::integer<=0 or p->'quoteCents' is distinct from p->'oneOffCostCents' or p->'audEstimateCents' is distinct from p->'oneOffCostCents' or p->>'monthlyCostCents' is not null or p->>'annualCostCents' is not null then raise exception 'Provide the one-off cost without recurring prices.' using errcode='22023'; end if;
    elsif coalesce(v2,false) or coalesce(v3,false) then
      chosen:=case when p->>'billing'='monthly' then 'monthlyCostCents' else 'annualCostCents' end;
      alternative:=case when p->>'billing'='monthly' then 'annualCostCents' else 'monthlyCostCents' end;
      if p->>chosen is null or (p->>alternative is null and nullif(btrim(p->>'comparisonUnavailableReason'),'') is null)
        or p->'quoteCents' is distinct from p->chosen or p->'audEstimateCents' is distinct from p->chosen then
        raise exception 'Provide the selected price and comparison or explain why it is unavailable.' using errcode='22023';
      end if;
    else
      if (p->>'quoteCents') is null and nullif(btrim(p->>'noQuoteReason'),'') is null then raise exception 'Provide a quote or explain why it is missing.' using errcode='22023'; end if;
      if (p->>'audEstimateCents') is null then raise exception 'Provide the AUD estimate.' using errcode='22023'; end if;
    end if;
    if p->>'payment'='card' and (nullif(btrim(p->>'cardLabel'),'') is null or nullif(btrim(p->>'cardHolder'),'') is null) then raise exception 'Provide the card label and holder, not card numbers.' using errcode='22023'; end if;
  end if;
end $$;
create or replace function private.sr_register_gate() returns trigger language plpgsql security definer set search_path='' as $$
declare r private.subscription_requests%rowtype; approved jsonb; config private.subscription_request_config%rowtype; begin
  if tg_op='UPDATE' and (old.source_request_id is distinct from new.source_request_id or old.source_approved_version is distinct from new.source_approved_version) then raise exception 'Subscription approval provenance is immutable.' using errcode='55000'; end if;
  if tg_op='INSERT' and (new.source_request_id is not null or new.source_approved_version is not null) then
    if new.source_request_id is null or new.source_approved_version is null or new.pricing_model<>'paid' or not private.lock_subscription_role_authority(false) then raise exception 'Approved subscription permission is required.' using errcode='42501'; end if;
    select * into strict config from private.subscription_request_config where singleton for share;
    perform pg_advisory_xact_lock(hashtextextended('mam:subscription-request:'||new.source_request_id::text,0));
    select * into r from private.subscription_requests where id=new.source_request_id for update;
    select e.payload into approved from private.subscription_request_events e where e.request_id=r.id and e.version=new.source_approved_version and e.operation='approve';
    if not config.enabled or r.id is null or r.status<>'approved' or r.version<>new.source_approved_version or approved is null or approved is distinct from r.payload
      or coalesce(approved->'formVersion' in ('2'::jsonb,'3'::jsonb),false) is not true or approved->>'billing' not in ('monthly','annual') or approved->>'kind' is distinct from 'new_purchase' then raise exception 'The approved subscription request changed.' using errcode='PT409'; end if;
    perform private.sr_validate(approved,true);
    if approved->'formVersion'='3'::jsonb and not exists(select 1 from private.subscription_request_decisions d where d.request_id=r.id and d.version=new.source_approved_version and d.budget_approved) then raise exception 'Budget approval is required.' using errcode='55000'; end if;
    if new.service_name is distinct from btrim(approved->>'service') or new.plan_name is distinct from nullif(btrim(coalesce(approved->>'plan','')),'') or
      new.company_scope is distinct from approved->>'company' or new.billing_cycle is distinct from approved->>'billing' or
      new.start_date is distinct from nullif(approved->>'startDate','')::date or
      new.amount_cents is distinct from (approved->>'audEstimateCents')::integer or new.currency_code<>'AUD' or
      new.mam_credit_card_used is distinct from (approved->>'payment'='card') or
      new.credit_card_holder is distinct from (case when approved->>'payment'='card' then btrim(approved->>'cardHolder') else null end) or
      new.subscription_status<>'active' or new.created_by is distinct from (select auth.uid()) or new.updated_by is distinct from (select auth.uid()) then raise exception 'The subscription does not match the approved request.' using errcode='22023'; end if;
    return new;
  end if;
  if (select enabled from private.subscription_request_config where singleton) and (new.pricing_model='paid' or (tg_op='UPDATE' and old.pricing_model='paid')) and
    (tg_op='INSERT' or old.pricing_model is distinct from new.pricing_model or old.service_name is distinct from new.service_name or old.billing_anchor_date is distinct from new.billing_anchor_date or old.plan_name is distinct from new.plan_name or old.seat_count is distinct from new.seat_count or old.renewal_date is distinct from new.renewal_date or old.billing_cycle is distinct from new.billing_cycle or old.amount_cents is distinct from new.amount_cents
      or (old.subscription_status='cancelled' and new.subscription_status in ('active','paused'))) then raise exception 'Paid procurement and activation require an approved request.' using errcode='55000'; end if;
  return new;
end $$;
create or replace function public.sr_activate(p_request_id uuid,p_expected_request_version bigint,p_seat_count integer,p_billing_anchor_date date,p_renewal_date date,p_responsible_person_id uuid,p_member_person_ids uuid[] default array[]::uuid[])
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r private.subscription_requests%rowtype; config private.subscription_request_config%rowtype; s private.subscription_register%rowtype; members uuid[]; approved jsonb; begin
  if not private.lock_subscription_role_authority(false) then raise exception 'Subscription register permission is required.' using errcode='42501'; end if;
  if p_request_id is null or p_expected_request_version is null or p_expected_request_version<1 or p_seat_count is null or p_seat_count not between 1 and 100000 or p_billing_anchor_date is null or not isfinite(p_billing_anchor_date) or (p_renewal_date is not null and (not isfinite(p_renewal_date) or p_renewal_date<p_billing_anchor_date)) or p_responsible_person_id is null or cardinality(coalesce(p_member_person_ids,array[]::uuid[]))>1000 or array_position(p_member_person_ids,null) is not null then raise exception 'Subscription procurement details are invalid.' using errcode='22023'; end if;
  select * into strict config from private.subscription_request_config where singleton for share;
  if not config.enabled then raise exception 'Subscription requests are not enabled.' using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-request:'||p_request_id::text,0));
  select * into r from private.subscription_requests where id=p_request_id for update;
  if r.id is null or r.version<>p_expected_request_version or r.status<>'approved' or exists(select 1 from private.subscription_register target where target.source_request_id=r.id) then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
  if coalesce(r.payload->'formVersion' in ('2'::jsonb,'3'::jsonb),false) is not true or r.payload->>'billing' not in ('monthly','annual') or r.payload->>'kind' is distinct from 'new_purchase' then raise exception 'This request does not support activation.' using errcode='55000'; end if;
  select e.payload into approved from private.subscription_request_events e where e.request_id=r.id and e.version=r.version and e.operation='approve';
  if approved is null or approved is distinct from r.payload then raise exception 'Request approval changed.' using errcode='PT409'; end if;
  perform private.sr_validate(approved,true);
  if approved->'formVersion'='3'::jsonb and not exists(select 1 from private.subscription_request_decisions d where d.request_id=r.id and d.version=r.version and d.budget_approved) then raise exception 'Budget approval is required.' using errcode='55000'; end if;
  select coalesce(array_agg(id order by id),array[]::uuid[]) into members from (select distinct unnest(coalesce(p_member_person_ids,array[]::uuid[])) id) chosen;
  perform person.id from public.internal_org_people person where person.id=any(array_append(members,p_responsible_person_id)) order by person.id for share;
  if not private.is_active_subscription_person(p_responsible_person_id) or (select count(*) from public.internal_org_people person where person.id=any(members) and person.node_kind='person' and person.is_active)<>cardinality(members) then raise exception 'Choose active employees for this subscription.' using errcode='23503'; end if;
  insert into private.subscription_register(subscription_code,service_name,plan_name,subscription_status,pricing_model,billing_cycle,amount_cents,currency_code,renewal_date,seat_count,mam_credit_card_used,credit_card_holder,start_date,billing_anchor_date,next_review_on,responsible_person_id,company_scope,created_by,updated_by,source_request_id,source_approved_version)
  values('MAM-SUB-'||lpad(nextval('private.subscription_code_sequence'::regclass)::text,6,'0'),btrim(approved->>'service'),nullif(btrim(coalesce(approved->>'plan','')),''),'active','paid',approved->>'billing',(approved->>'audEstimateCents')::integer,'AUD',p_renewal_date,p_seat_count,approved->>'payment'='card',case when approved->>'payment'='card' then btrim(approved->>'cardHolder') else null end,nullif(approved->>'startDate','')::date,p_billing_anchor_date,private.next_paid_subscription_quarter_review_on(),p_responsible_person_id,approved->>'company',actor,actor,r.id,r.version) returning * into s;
  insert into private.subscription_memberships(subscription_id,person_id,created_by) select s.id,id,actor from unnest(members) id;
  insert into private.subscription_audit_events(subscription_id,actor_user_id,event_type,changed_fields)
  values(s.id,actor,'created',array['service_name','plan_name','pricing_model','billing_cycle','amount_cents','renewal_date','seat_count','mam_credit_card_used','credit_card_holder','start_date','billing_anchor_date','next_review_on','responsible_person_id','company_scope','member_person_ids']);
  update private.subscription_requests set version=version+1,updated_at=clock_timestamp() where id=r.id;
  insert into private.subscription_request_events(request_id,version,operation,actor,payload,reason,evidence,private_evidence)
  values(r.id,r.version+1,'activate',actor,approved,s.id::text,(select evidence from private.subscription_request_events where request_id=r.id and version=r.version),r.evidence);
  return private.sr_read(r.id);
end $$;
revoke all on function public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[]) to authenticated;

create function private.set_subscription_start_date(p_subscription_id uuid,p_start_date date)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
 if not private.lock_subscription_role_authority(false) then raise exception 'Subscription register permission is required.' using errcode='42501'; end if;
 if p_start_date is not null and (not isfinite(p_start_date) or p_start_date not between date '0001-01-01' and date '9999-12-31') then raise exception 'Start date is invalid.' using errcode='22023'; end if;
 update private.subscription_register set start_date=p_start_date,updated_by=(select auth.uid()) where id=p_subscription_id and start_date is distinct from p_start_date;
 if found then insert into private.subscription_audit_events(subscription_id,actor_user_id,event_type,changed_fields) values(p_subscription_id,(select auth.uid()),'updated',array['start_date']); end if;
end $$;
create function public.create_subscription_v5(p_service_name text,p_plan_name text,p_pricing_model text,p_billing_cycle text,p_amount_cents integer,p_renewal_date date,p_seat_count integer,p_credit_card_used boolean,p_credit_card_holder text,p_billing_anchor_date date,p_responsible_person_id uuid,p_company_scope text,p_member_person_ids uuid[] default array[]::uuid[],p_start_date date default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; target_id uuid; begin
 result:=public.create_subscription_v4(p_service_name,p_plan_name,p_pricing_model,p_billing_cycle,p_amount_cents,p_renewal_date,p_seat_count,p_credit_card_used,p_credit_card_holder,p_billing_anchor_date,p_responsible_person_id,p_company_scope,p_member_person_ids);
 target_id:=(result->>'subscription_id')::uuid;
 perform private.set_subscription_start_date(target_id,p_start_date);
 return (select item from private.subscription_register_v2_projection(target_id) projection(item));
end $$;
create function public.update_subscription_v5(p_subscription_id uuid,p_expected_version bigint,p_service_name text,p_plan_name text,p_subscription_status text,p_pricing_model text,p_billing_cycle text,p_amount_cents integer,p_renewal_date date,p_seat_count integer,p_credit_card_used boolean,p_credit_card_holder text,p_billing_anchor_date date,p_responsible_person_id uuid,p_company_scope text,p_member_person_ids uuid[] default array[]::uuid[],p_start_date date default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform public.update_subscription_v4(p_subscription_id,p_expected_version,p_service_name,p_plan_name,p_subscription_status,p_pricing_model,p_billing_cycle,p_amount_cents,p_renewal_date,p_seat_count,p_credit_card_used,p_credit_card_holder,p_billing_anchor_date,p_responsible_person_id,p_company_scope,p_member_person_ids);
 perform private.set_subscription_start_date(p_subscription_id,p_start_date);
 return (select item from private.subscription_register_v2_projection(p_subscription_id) projection(item));
end $$;
revoke all on function private.set_subscription_start_date(uuid,date),public.create_subscription_v5(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date),public.update_subscription_v5(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date) from public,anon,authenticated,service_role;
grant execute on function public.create_subscription_v5(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date),public.update_subscription_v5(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date) to authenticated;
set constraints all immediate;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
commit;
