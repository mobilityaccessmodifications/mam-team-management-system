begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema,
 private.subscription_register,private.subscription_requests,private.subscription_request_events,private.subscription_request_config,
 private.subscription_request_notifications,private.subscription_request_mail_deliveries in share row exclusive mode nowait;
do $$ begin
 if (select count(*) from private.confirmed_test_purge_schema)<>1 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then raise exception 'Subscription template requires the reviewed predecessor.' using errcode='55000'; end if;
end $$;
alter table private.subscription_request_config add column request_form_version integer not null default 2, add constraint subscription_request_form_version_check check(request_form_version in (2,3));
create table private.subscription_request_decisions (
 request_id uuid not null,
 version bigint not null check(version>0),
 budget_approved boolean not null,
 invoice_email text not null check(length(invoice_email)<=254 and (invoice_email='' or invoice_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
 invoice_contact text not null check(length(invoice_contact)<=160),
 primary key(request_id,version),
 foreign key(request_id,version) references private.subscription_request_events(request_id,version) on delete restrict
);
alter table private.subscription_request_decisions enable row level security;
alter table private.subscription_request_decisions force row level security;
revoke all on private.subscription_request_decisions from public,anon,authenticated,service_role;
create trigger subscription_request_decisions_immutable before update or delete on private.subscription_request_decisions for each row execute function private.sr_immutable();

create or replace function private.sr_validate(p jsonb, submitting boolean) returns void language plpgsql set search_path='' as $$
declare field text; value jsonb; chosen text; alternative text; v2 boolean:=p->'formVersion'='2'::jsonb; v3 boolean:=p->'formVersion'='3'::jsonb; begin
  if p is null or jsonb_typeof(p)<>'object' or pg_column_size(p)>100000 then raise exception 'Request fields are invalid.' using errcode='22023'; end if;
  for field,value in select * from jsonb_each(p) loop
    if field not in ('kind','service','plan','purpose','company','payer','duration','billing','currency','tax','quoteCents','noQuoteReason','audEstimateCents','payment','cardLabel','cardHolder','responsiblePersonId','intendedUsers','formVersion','monthlyCostCents','annualCostCents','comparisonUnavailableReason','websiteUrl','category','usageFrequency','oneOffCostCents','invoiceEmail','invoiceContact') then raise exception 'Unsupported request field.' using errcode='22023'; end if;
    if field in ('websiteUrl','category','usageFrequency','oneOffCostCents','invoiceEmail','invoiceContact') and not coalesce(v3,false) then raise exception 'Unsupported request field for this version.' using errcode='22023'; end if;
    if field='formVersion' then
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

create or replace function private.sr_read(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object('id',r.id,'applicant',r.applicant,'applicantName',coalesce((select max(person.full_name) from public.internal_org_people person where person.auth_user_id=r.applicant having count(*)=1),(select login_name from public.profiles where id=r.applicant),'Administrator'),'status',r.status,'version',r.version,'revision',r.revision,'payload',chosen.payload,
  'requestedAt',(select min(e.at) from private.subscription_request_events e where e.request_id=r.id and e.operation='submit'),
  'finance',(select jsonb_build_object('budgetApproved',d.budget_approved,'invoiceEmail',d.invoice_email,'invoiceContact',d.invoice_contact,'approvedByName',coalesce((select max(person.full_name) from public.internal_org_people person where person.auth_user_id=e.actor having count(*)=1),(select login_name from public.profiles where id=e.actor),'Administrator'),'approvedAt',e.at) from private.subscription_request_decisions d join private.subscription_request_events e on e.request_id=d.request_id and e.version=d.version where d.request_id=r.id and e.operation='approve' and d.version>coalesce((select max(s.version) from private.subscription_request_events s where s.request_id=r.id and s.operation='submit'),0) order by d.version desc limit 1),
  'completedAt',(select e.at from private.subscription_request_events e where e.request_id=r.id and e.operation='complete_purchase' order by e.version desc limit 1),
  'completedByName',(select coalesce((select max(person.full_name) from public.internal_org_people person where person.auth_user_id=e.actor having count(*)=1),(select login_name from public.profiles where id=e.actor),'Administrator') from private.subscription_request_events e where e.request_id=r.id and e.operation='complete_purchase' order by e.version desc limit 1),
  'canCompletePurchase',public.can_manage_subscriptions() and r.status='approved' and coalesce(r.payload->'formVersion'='3'::jsonb,false) and r.payload->>'kind'='new_purchase' and r.payload->>'billing'='one_off' and not exists(select 1 from private.subscription_request_events e where e.request_id=r.id and e.operation='complete_purchase'),
  'evidence',chosen.evidence,'evidenceVersion',chosen.version,
  'linkedSubscriptionId',(select s.id from private.subscription_register s where s.source_request_id=r.id),
  'events',(select coalesce(jsonb_agg((to_jsonb(e)-array['request_id','private_evidence'])||jsonb_build_object('actorName',coalesce((select max(person.full_name) from public.internal_org_people person where person.auth_user_id=e.actor having count(*)=1),(select login_name from public.profiles where id=e.actor),'Administrator'),'finance',(select jsonb_build_object('budgetApproved',d.budget_approved,'invoiceEmail',d.invoice_email,'invoiceContact',d.invoice_contact) from private.subscription_request_decisions d where d.request_id=e.request_id and d.version=e.version)) order by e.version),'[]') from private.subscription_request_events e where e.request_id=r.id and (e.operation<>'save' or r.applicant=(select auth.uid()))),
  'canEdit',r.applicant=(select auth.uid()) and public.can_manage_subscriptions() and r.status in ('draft','returned'),
  'canDecide',private.sr_approver() and r.status='submitted',
  'canActivate',public.can_manage_subscriptions() and r.status='approved' and coalesce(r.payload->'formVersion' in ('2'::jsonb,'3'::jsonb),false) and r.payload->>'billing' in ('monthly','annual') and r.payload->>'kind'='new_purchase' and not exists(select 1 from private.subscription_register s where s.source_request_id=r.id),
  'canWithdraw',r.applicant=(select auth.uid()) and public.can_manage_subscriptions() and r.status in ('draft','submitted','returned','approved') and not exists(select 1 from private.subscription_register s where s.source_request_id=r.id) and not exists(select 1 from private.subscription_request_events e where e.request_id=r.id and e.operation='complete_purchase'))
from private.subscription_requests r cross join lateral (
  select e.payload,e.evidence,e.version from private.subscription_request_events e where e.request_id=r.id
    and (r.applicant=(select auth.uid()) or e.operation<>'save') order by e.version desc limit 1
) chosen where r.id=p_id and private.sr_visible(r.id);
$$;

do $sr_template_workspace$ declare definition text; anchor text:=E'return jsonb_build_object(''enabled'',(select enabled from private.subscription_request_config where singleton),'; begin
 select pg_get_functiondef('public.sr_workspace()'::regprocedure) into definition;
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Subscription workspace predecessor differs.' using errcode='55000'; end if;
 execute replace(definition,anchor,anchor||'''requestFormVersion'',(select request_form_version from private.subscription_request_config where singleton),');
end $sr_template_workspace$;

do $sr_template_mutate$ declare definition text; anchor text:='  contents:=r.payload; attachments:=r.evidence;'; begin
 select pg_get_functiondef('public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb)'::regprocedure) into definition;
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Subscription mutation predecessor differs.' using errcode='55000'; end if;
 definition:=replace(definition,anchor,E'  if p_operation in (''save'',''submit'') and p_payload->''formVersion''=''3''::jsonb and config.request_form_version<3 then raise exception ''The new request form is not yet enabled.'' using errcode=''55000''; end if;\n'||anchor);
 definition:=replace(definition,anchor,E'  if p_operation in (''save'',''submit'') and ((r.version=0 and config.request_form_version=3 and p_payload->''formVersion'' is distinct from ''3''::jsonb) or (r.version>0 and r.payload->''formVersion'' is distinct from p_payload->''formVersion'')) then raise exception ''The request form version changed. Reload before retrying.'' using errcode=''22023''; end if;\n'||anchor);
 definition:=replace(definition,anchor,E'  if r.payload->''formVersion''=''3''::jsonb and p_operation in (''approve'',''return'',''reject'') then raise exception ''Use the versioned finance decision.'' using errcode=''55000''; end if;\n'||anchor);
 anchor:='or exists(select 1 from private.subscription_register s where s.source_request_id=r.id)';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Subscription withdrawal predecessor differs.' using errcode='55000'; end if;
 execute replace(definition,anchor,anchor||' or exists(select 1 from private.subscription_request_events e where e.request_id=r.id and e.operation=''complete_purchase'')');
end $sr_template_mutate$;

create function public.subscription_request_decide_v3(p_id uuid,p_version bigint,p_operation text,p_reason text,p_finance jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r private.subscription_requests%rowtype; config private.subscription_request_config%rowtype; invoice_email text; invoice_contact text; begin
 if actor is null or not private.sr_approver() then raise exception 'Only the designated approver may decide.' using errcode='42501'; end if;
 if p_id is null or p_version is null or p_version<1 or p_version>=9007199254740991 or p_operation is null or p_operation not in ('approve','return','reject') or p_reason is null or length(p_reason)>4000 or p_finance is null or jsonb_typeof(p_finance)<>'object' or pg_column_size(p_finance)>5000 or jsonb_typeof(p_finance->'budgetApproved') is distinct from 'boolean' or exists(select 1 from jsonb_object_keys(p_finance) k where k not in ('budgetApproved','invoiceEmail','invoiceContact')) or (p_finance ? 'invoiceEmail' and jsonb_typeof(p_finance->'invoiceEmail') is distinct from 'string') or (p_finance ? 'invoiceContact' and jsonb_typeof(p_finance->'invoiceContact') is distinct from 'string') then raise exception 'Finance decision is invalid.' using errcode='22023'; end if;
 invoice_email:=btrim(coalesce(p_finance->>'invoiceEmail','')); invoice_contact:=btrim(coalesce(p_finance->>'invoiceContact',''));
 if length(invoice_email)>254 or length(invoice_contact)>160 or (invoice_email<>'' and invoice_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or (p_operation='approve' and p_finance->'budgetApproved' is distinct from 'true'::jsonb) or (p_operation in ('return','reject') and nullif(btrim(p_reason),'') is null) then raise exception 'Confirm the budget and provide valid finance details.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
 perform 1 from public.profiles where id=actor for share;
 select * into strict config from private.subscription_request_config where singleton for share;
 if not config.enabled or not private.sr_approver() then raise exception 'Only the designated approver may decide.' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('mam:subscription-request:'||p_id::text,0));
 select * into r from private.subscription_requests where id=p_id for update;
 if r.id is null or r.version<>p_version or r.status<>'submitted' then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
 if not private.sr_approver() then raise exception 'Only the designated approver may decide.' using errcode='42501'; end if;
 if r.payload->'formVersion' is distinct from '3'::jsonb then raise exception 'This request requires the legacy decision.' using errcode='55000'; end if;
 perform private.sr_validate(r.payload,true);
 if p_operation='approve' and r.payload->>'payment'='invoice' and invoice_email='' and invoice_contact='' then raise exception 'Provide the invoice email or contact.' using errcode='22023'; end if;
 update private.subscription_requests set status=case p_operation when 'approve' then 'approved' when 'return' then 'returned' else 'rejected' end,version=version+1,updated_at=clock_timestamp() where id=r.id;
 insert into private.subscription_request_events(request_id,version,operation,actor,payload,reason,evidence,private_evidence) values(r.id,r.version+1,p_operation,actor,r.payload,p_reason,(select evidence from private.subscription_request_events where request_id=r.id and version=r.version),r.evidence);
 insert into private.subscription_request_decisions(request_id,version,budget_approved,invoice_email,invoice_contact) values(r.id,r.version+1,(p_finance->>'budgetApproved')::boolean,invoice_email,invoice_contact);
 insert into private.subscription_request_notifications(request_id,version,event,to_user_id) values(r.id,r.version+1,p_operation,r.applicant);
 return private.sr_read(r.id);
end $$;
create function public.subscription_request_complete_purchase_v3(p_id uuid,p_version bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r private.subscription_requests%rowtype; approved jsonb; config private.subscription_request_config%rowtype; begin
 if not private.lock_subscription_role_authority(false) then raise exception 'Subscription register permission is required.' using errcode='42501'; end if;
 if p_id is null or p_version is null or p_version<1 or p_version>=9007199254740991 then raise exception 'Purchase details are invalid.' using errcode='22023'; end if;
 select * into strict config from private.subscription_request_config where singleton for share;
 if not config.enabled then raise exception 'Subscription requests are not enabled.' using errcode='55000'; end if;
 perform pg_advisory_xact_lock(hashtextextended('mam:subscription-request:'||p_id::text,0));
 select * into r from private.subscription_requests where id=p_id for update;
 if r.id is null or r.version<>p_version or r.status<>'approved' or exists(select 1 from private.subscription_request_events e where e.request_id=r.id and e.operation='complete_purchase') then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
 select e.payload into approved from private.subscription_request_events e join private.subscription_request_decisions d on d.request_id=e.request_id and d.version=e.version and d.budget_approved where e.request_id=r.id and e.version=r.version and e.operation='approve';
 if approved is null or approved is distinct from r.payload then raise exception 'Request approval changed.' using errcode='PT409'; end if;
 if approved->'formVersion' is distinct from '3'::jsonb or approved->>'kind'<>'new_purchase' or approved->>'billing'<>'one_off' then raise exception 'This request is not a one-off purchase.' using errcode='55000'; end if;
 perform private.sr_validate(approved,true);
 update private.subscription_requests set version=version+1,updated_at=clock_timestamp() where id=r.id;
 insert into private.subscription_request_events(request_id,version,operation,actor,payload,reason,evidence,private_evidence) values(r.id,r.version+1,'complete_purchase',actor,approved,'',(select evidence from private.subscription_request_events where request_id=r.id and version=r.version),r.evidence);
 return private.sr_read(r.id);
end $$;
revoke all on function public.subscription_request_decide_v3(uuid,bigint,text,text,jsonb),public.subscription_request_complete_purchase_v3(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.subscription_request_decide_v3(uuid,bigint,text,text,jsonb),public.subscription_request_complete_purchase_v3(uuid,bigint) to authenticated;

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
  insert into private.subscription_register(subscription_code,service_name,plan_name,subscription_status,pricing_model,billing_cycle,amount_cents,currency_code,renewal_date,seat_count,mam_credit_card_used,credit_card_holder,billing_anchor_date,next_review_on,responsible_person_id,company_scope,created_by,updated_by,source_request_id,source_approved_version)
  values('MAM-SUB-'||lpad(nextval('private.subscription_code_sequence'::regclass)::text,6,'0'),btrim(approved->>'service'),nullif(btrim(coalesce(approved->>'plan','')),''),'active','paid',approved->>'billing',(approved->>'audEstimateCents')::integer,'AUD',p_renewal_date,p_seat_count,approved->>'payment'='card',case when approved->>'payment'='card' then btrim(approved->>'cardHolder') else null end,p_billing_anchor_date,private.next_paid_subscription_quarter_review_on(),p_responsible_person_id,approved->>'company',actor,actor,r.id,r.version) returning * into s;
  insert into private.subscription_memberships(subscription_id,person_id,created_by) select s.id,id,actor from unnest(members) id;
  insert into private.subscription_audit_events(subscription_id,actor_user_id,event_type,changed_fields)
  values(s.id,actor,'created',array['service_name','plan_name','pricing_model','billing_cycle','amount_cents','renewal_date','seat_count','mam_credit_card_used','credit_card_holder','billing_anchor_date','next_review_on','responsible_person_id','company_scope','member_person_ids']);
  update private.subscription_requests set version=version+1,updated_at=clock_timestamp() where id=r.id;
  insert into private.subscription_request_events(request_id,version,operation,actor,payload,reason,evidence,private_evidence)
  values(r.id,r.version+1,'activate',actor,approved,s.id::text,(select evidence from private.subscription_request_events where request_id=r.id and version=r.version),r.evidence);
  return private.sr_read(r.id);
end $$;
revoke all on function public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[]) to authenticated;

create or replace function public.claim_subscription_request_mail(p_request_id uuid default null,p_limit integer default 25)
returns table(request_id uuid,version bigint,claim_token uuid,payload jsonb)
language plpgsql security definer set search_path='' as $$
declare item record; token uuid; previous private.subscription_request_mail_deliveries;
begin
  if p_limit is null or p_limit<1 or p_limit>25 then raise exception 'Invalid claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform 1 from private.subscription_request_config c where c.singleton for share;
  if not exists(select 1 from private.subscription_request_config c where c.singleton and c.enabled) then return; end if;
  if not exists(select 1 from private.subscription_request_config c
    join public.internal_org_people person on person.id=c.approver_person_id and person.auth_user_id=c.approver_user_id
    join private.employee_directory_details details on details.person_id=person.id
    cross join lateral private.portal_role_policy(c.approver_user_id) policy
    where c.singleton and c.enabled and policy.person_id=person.id
      and (select count(*) from public.internal_org_people p where p.auth_user_id=c.approver_user_id)=1
      and length(btrim(details.work_email))<=254 and lower(btrim(details.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
      and (select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=lower(btrim(details.work_email)))=1) then
    raise exception 'Subscription request approver is unavailable.' using errcode='55000';
  end if;
  for item in
    select n.request_id,n.version,e.payload,recipients.applicant_name,recipients.applicant_email,recipients.approver_email
    from private.subscription_request_notifications n
    join private.subscription_requests r on r.id=n.request_id and r.version=n.version and r.status='submitted'
    join private.subscription_request_events e on e.request_id=n.request_id and e.version=n.version and e.operation='submit'
    cross join lateral private.sr_mail_recipients(r.id) recipients
    left join private.subscription_request_mail_deliveries d on d.request_id=n.request_id and d.version=n.version
    where n.event='submit' and (p_request_id is null or n.request_id=p_request_id)
      and d.delivered_at is null and (d.claimed_at is null or d.claimed_at<clock_timestamp()-interval '15 minutes')
      and not exists(select 1 from private.notification_delivery_receipts receipt
        where receipt.event_key='subscription-request:'||n.request_id::text||':'||n.version::text)
    order by n.created_at,n.request_id limit p_limit for update of r skip locked
  loop
    insert into private.subscription_request_mail_deliveries(request_id,version) values(item.request_id,item.version) on conflict do nothing;
    select * into previous from private.subscription_request_mail_deliveries d where d.request_id=item.request_id and d.version=item.version for update;
    if previous.delivered_at is not null or previous.claimed_at>clock_timestamp()-interval '15 minutes' then continue; end if;
    token:=extensions.gen_random_uuid();
    update private.subscription_request_mail_deliveries d set claim_token=token,claimed_at=clock_timestamp() where d.request_id=item.request_id and d.version=item.version;
    return query select item.request_id,item.version,token,jsonb_build_object(
      'version',case when item.payload->'formVersion'='3'::jsonb then 3 else 2 end,'event','subscription-request-submitted','deliveryId','subscription-request:'||item.request_id::text||':'||item.version::text,
      'applicantName',item.applicant_name,'applicantWorkEmail',item.applicant_email,'approverWorkEmail',item.approver_email,
      'request',jsonb_build_object('service',item.payload->>'service','plan',item.payload->>'plan','purpose',item.payload->>'purpose',
        'company',item.payload->>'company','duration',item.payload->>'duration','billing',item.payload->>'billing',
        'currency',item.payload->>'currency','quoteCents',item.payload->'quoteCents','audEstimateCents',item.payload->'audEstimateCents',
        'noQuoteReason',item.payload->>'noQuoteReason','intendedUsers',item.payload->>'intendedUsers','formVersion',item.payload->'formVersion',
        'monthlyCostCents',item.payload->'monthlyCostCents','annualCostCents',item.payload->'annualCostCents',
        'comparisonUnavailableReason',item.payload->>'comparisonUnavailableReason','payment',item.payload->>'payment',
        'cardLabel',case when item.payload->>'payment'='card' then item.payload->>'cardLabel' end,
        'cardHolder',case when item.payload->>'payment'='card' then item.payload->>'cardHolder' end)||case when item.payload->'formVersion'='3'::jsonb then jsonb_build_object('websiteUrl',item.payload->>'websiteUrl','category',item.payload->>'category','usageFrequency',item.payload->>'usageFrequency','oneOffCostCents',item.payload->'oneOffCostCents','invoiceEmail',item.payload->>'invoiceEmail','invoiceContact',item.payload->>'invoiceContact') else '{}'::jsonb end);
  end loop;
end $$;

set constraints all immediate;
do $$ begin if exists(select 1 from private.subscription_request_decisions) then raise exception 'Finance decisions must not be backfilled.' using errcode='55000'; end if; end $$;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
commit;
