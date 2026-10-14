begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema,
  private.subscription_register,private.subscription_audit_events,private.subscription_requests,private.subscription_request_events,private.subscription_request_config,private.subscription_memberships in share row exclusive mode nowait;
do $subscription_activation_predecessor$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or (select count(*) from private.confirmed_test_purge_schema)<>1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription activation require the reviewed predecessor catalog.' using errcode='55000';
  end if;
end $subscription_activation_predecessor$;
create temporary table subscription_activation_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into subscription_activation_function_spec values
('private.sr_validate(jsonb,boolean)',true,'624bda44dc234a8dfe9bd23b3e8724a865e586efce471ebae6586f063ea1483b','77e0e3b4c859c38f136454e82d4e08ab65d0c7ef3960ea442e7458b7c6e7e5e0',null),
('private.sr_read(uuid)',true,'3967c1bdcc609ef1a55f64545217e0a071c063f4239bfa1121e97aeb22dc4b49','6a7506b0ea6124058a035fd5a732023731849ea7b01bfddb9ef68bf195762cc9',null),
('public.sr_workspace()',true,'165701353ebeee23a7b288159359d18ec09ab526bba784c8a0d5d774fea15394','4d865eb58eb30f24b7c7b73936155f9e2c336c4f5692594cb2342a572fa11691',null),
('public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb)',true,'407a2f9e3d4b3f7986f7d764219811d44e5a4c1e8058dde30f498592d16e4dfe','2ea1c13cd8c355a7c2e409199370bf5e9210a84bab34a861f02aae7b338559bb',null),
('private.sr_register_gate()',true,'dc03916527f45db9640e3602f4372123f7845d1ad748934122dbdbeae947bf79','0cc3ecf27dd167bcc6d5cb125da48b0e38d0225c7e27392bf8f18f9b5a61f346',null),
('public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[])',false,null,'df23ce6b4bd1dedc2ec8249d899e1d12fa3c125636212e9225d5a3c63a997042','{"acl": "{postgres=X/postgres,authenticated=X/postgres}", "owner": "postgres", "config": ["search_path=\"\""], "security_definer": true}'::jsonb);
do $subscription_activation_before$ declare item record; begin
  for item in select * from subscription_activation_function_spec loop
    if item.is_existing then
      if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
        raise exception 'Subscription activation predecessor differs: %',item.signature using errcode='55000';
      end if;
    elsif to_regprocedure(item.signature) is not null then
      raise exception 'Subscription activation function already exists: %',item.signature using errcode='55000';
    end if;
  end loop;
end $subscription_activation_before$;
create temporary table subscription_activation_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition
from subscription_activation_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $subscription_activation_collector$ declare query text; anchor text; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Subscription activation collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.subscription_activation_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end $subscription_activation_collector$;
create temporary table subscription_activation_catalog_before on commit drop as select * from pg_temp.subscription_activation_catalog();
create function pg_temp.subscription_activation_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
  'role_memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor,m.oid) from pg_auth_members m),
  'role_database_settings',(select jsonb_agg(to_jsonb(s) order by s.setdatabase,s.setrole) from pg_db_role_setting s),
  'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
  'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w join pg_class c on c.oid=w.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not (c.oid='private.subscription_register'::regclass and a.attname in ('source_request_id','source_approved_version')) and not(n.nspname='private' and c.relname='subscription_source_request_unique')),
  'relations',(select jsonb_agg(case when c.oid='private.subscription_register'::regclass then to_jsonb(c)-array['relnatts','relchecks','reltuples'] else to_jsonb(c) end order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not(n.nspname='private' and c.relname='subscription_source_request_unique')),
  'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not exists(select 1 from pg_constraint k where k.oid=t.tgconstraint and k.conrelid='private.subscription_register'::regclass and k.conname='subscription_source_approval')),
  'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not(k.conrelid='private.subscription_register'::regclass and k.conname in ('subscription_source_pair','subscription_source_request_unique','subscription_source_approval'))),
  'defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'routines',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'
    and not exists(select 1 from subscription_activation_function_spec s where p.oid=to_regprocedure(s.signature)))
);
$$;
create temporary table subscription_activation_security_before on commit drop as select pg_temp.subscription_activation_security() value;
create function pg_temp.subscription_activation_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'subscriptions',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s)-array['source_request_id','source_approved_version'] order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_register s),
  'requests',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_requests s),
  'request_events',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.request_id,s.version),'[]')::text,'sha256'),'hex') from private.subscription_request_events s),
  'request_config',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s)),'[]')::text,'sha256'),'hex') from private.subscription_request_config s),
  'memberships',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.subscription_id,s.person_id),'[]')::text,'sha256'),'hex') from private.subscription_memberships s),
  'audit',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_audit_events s),
  'purge_receipts',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges s)
);
$$;
create temporary table subscription_activation_data_before on commit drop as select pg_temp.subscription_activation_data() value;

create temporary table subscription_activation_relation_before on commit drop as select relnatts,relchecks from pg_class where oid='private.subscription_register'::regclass;
alter table private.subscription_register
  add column source_request_id uuid,
  add column source_approved_version bigint,
  add constraint subscription_source_pair check ((source_request_id is null)=(source_approved_version is null) and (source_approved_version is null or source_approved_version>0)),
  add constraint subscription_source_request_unique unique(source_request_id),
  add constraint subscription_source_approval foreign key(source_request_id,source_approved_version) references private.subscription_request_events(request_id,version) on delete restrict;

create or replace function private.sr_validate(p jsonb, submitting boolean) returns void language plpgsql set search_path='' as $$
declare field text; value jsonb; chosen text; alternative text; v2 boolean:=p->'formVersion'='2'::jsonb; begin
  if p is null or jsonb_typeof(p)<>'object' or pg_column_size(p)>100000 then raise exception 'Request fields are invalid.' using errcode='22023'; end if;
  for field,value in select * from jsonb_each(p) loop
    if field not in ('kind','service','plan','purpose','company','payer','duration','billing','currency','tax','quoteCents','noQuoteReason','audEstimateCents','payment','cardLabel','cardHolder','responsiblePersonId','intendedUsers','formVersion','monthlyCostCents','annualCostCents','comparisonUnavailableReason') then raise exception 'Unsupported request field.' using errcode='22023'; end if;
    if field='formVersion' then
      if value is distinct from '2'::jsonb then raise exception 'Request form version is invalid.' using errcode='22023'; end if;
    elsif field in ('quoteCents','audEstimateCents','monthlyCostCents','annualCostCents') then
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'number' or value::text !~ '^\d+$' or (value::text)::numeric>100000000) then raise exception 'Enter a valid amount in cents.' using errcode='22023'; end if;
    elsif field='responsiblePersonId' then
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'string' or p->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'Responsible person is invalid.' using errcode='22023'; end if;
    elsif jsonb_typeof(value)<>'string' or length(p->>field)>4000 then raise exception 'Request text is invalid.' using errcode='22023'; end if;
  end loop;
  if (p ? 'kind' and p->>'kind' not in ('new_purchase','renewal','added_seats','plan_change')) or
    (p ? 'company' and p->>'company' not in ('mam','equipsy','both')) or
    (p ? 'billing' and p->>'billing' not in ('monthly','annual','one_off','other')) or
    (p ? 'payment' and p->>'payment' not in ('card','non_card')) or
    (p ? 'currency' and p->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Request selection is invalid.' using errcode='22023'; end if;
  if coalesce(v2,false) and ((p ? 'billing' and p->>'billing' not in ('monthly','annual')) or
    (p ? 'duration' and p->>'duration' not in ('ongoing','3_months','12_months')) or
    (p ? 'currency' and p->>'currency'<>'AUD') or length(coalesce(p->>'service',''))>160 or length(coalesce(p->>'plan',''))>160 or
    length(coalesce(p->>'cardLabel',''))>160 or length(coalesce(p->>'cardHolder',''))>160) then raise exception 'Request selection is invalid.' using errcode='22023'; end if;
  if submitting then
    foreach field in array case when coalesce(v2,false) then array['kind','service','purpose','company','duration','billing','currency','payment','intendedUsers'] else array['kind','service','purpose','company','payer','duration','billing','currency','tax','payment','intendedUsers'] end loop
      if nullif(btrim(p->>field),'') is null then raise exception 'Complete the required request fields.' using errcode='22023'; end if;
    end loop;
    if coalesce(v2,false) then
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
  'evidence',chosen.evidence,'evidenceVersion',chosen.version,
  'linkedSubscriptionId',(select s.id from private.subscription_register s where s.source_request_id=r.id),
  'events',(select coalesce(jsonb_agg(to_jsonb(e)-array['request_id','private_evidence'] order by e.version),'[]') from private.subscription_request_events e where e.request_id=r.id and (e.operation<>'save' or r.applicant=(select auth.uid()))),
  'canEdit',r.applicant=(select auth.uid()) and public.can_manage_subscriptions() and r.status in ('draft','returned'),
  'canDecide',private.sr_approver() and r.status='submitted',
  'canActivate',public.can_manage_subscriptions() and r.status='approved' and coalesce(r.payload->'formVersion'='2'::jsonb,false) and r.payload->>'kind'='new_purchase' and not exists(select 1 from private.subscription_register s where s.source_request_id=r.id),
  'canWithdraw',r.applicant=(select auth.uid()) and public.can_manage_subscriptions() and r.status in ('draft','submitted','returned','approved') and not exists(select 1 from private.subscription_register s where s.source_request_id=r.id))
from private.subscription_requests r cross join lateral (
  select e.payload,e.evidence,e.version from private.subscription_request_events e where e.request_id=r.id
    and (r.applicant=(select auth.uid()) or e.operation<>'save') order by e.version desc limit 1
) chosen where r.id=p_id and private.sr_visible(r.id);
$$;

create or replace function public.sr_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare viewer uuid; name text; begin
  select policy.person_id into viewer from private.portal_role_policy() policy;
  if not found then raise exception 'An active portal account is required.' using errcode='42501'; end if;
  select coalesce((select full_name from public.internal_org_people where id=viewer),(select login_name from public.profiles where id=(select auth.uid())),'Administrator') into name;
  return jsonb_build_object('enabled',(select enabled from private.subscription_request_config where singleton),
    'viewerName',name,'viewerPersonId',viewer,'canApply',public.can_manage_subscriptions(),'canManageCredentials',private.is_current_subscription_credential_manager(),
    'requests',(select coalesce(jsonb_agg(private.sr_read(r.id) order by r.updated_at desc,r.id),'[]') from private.subscription_requests r where private.sr_visible(r.id)),
    'people',case when public.can_manage_subscriptions() then (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) order by p.full_name,p.id),'[]') from public.internal_org_people p where p.node_kind='person' and p.is_active) else '[]'::jsonb end);
end $$;

do $sr_withdraw$ declare definition text; anchor text:='(p_operation=''withdraw'' and r.status not in (''draft'',''submitted'',''returned'',''approved''))'; begin
  select pg_get_functiondef('public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb)'::regprocedure) into definition;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Request withdrawal predecessor differs.' using errcode='55000'; end if;
  execute replace(definition,anchor,'(p_operation=''withdraw'' and (r.status not in (''draft'',''submitted'',''returned'',''approved'') or exists(select 1 from private.subscription_register s where s.source_request_id=r.id)))');
end $sr_withdraw$;

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
      or approved->'formVersion' is distinct from '2'::jsonb or approved->>'kind' is distinct from 'new_purchase' then raise exception 'The approved subscription request changed.' using errcode='PT409'; end if;
    perform private.sr_validate(approved,true);
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

create function public.sr_activate(p_request_id uuid,p_expected_request_version bigint,p_seat_count integer,p_billing_anchor_date date,p_renewal_date date,p_responsible_person_id uuid,p_member_person_ids uuid[] default array[]::uuid[])
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r private.subscription_requests%rowtype; config private.subscription_request_config%rowtype; s private.subscription_register%rowtype; members uuid[]; approved jsonb; begin
  if not private.lock_subscription_role_authority(false) then raise exception 'Subscription register permission is required.' using errcode='42501'; end if;
  if p_request_id is null or p_expected_request_version is null or p_expected_request_version<1 or p_seat_count is null or p_seat_count not between 1 and 100000 or p_billing_anchor_date is null or not isfinite(p_billing_anchor_date) or (p_renewal_date is not null and (not isfinite(p_renewal_date) or p_renewal_date<p_billing_anchor_date)) or p_responsible_person_id is null or cardinality(coalesce(p_member_person_ids,array[]::uuid[]))>1000 or array_position(p_member_person_ids,null) is not null then raise exception 'Subscription procurement details are invalid.' using errcode='22023'; end if;
  select * into strict config from private.subscription_request_config where singleton for share;
  if not config.enabled then raise exception 'Subscription requests are not enabled.' using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-request:'||p_request_id::text,0));
  select * into r from private.subscription_requests where id=p_request_id for update;
  if r.id is null or r.version<>p_expected_request_version or r.status<>'approved' or exists(select 1 from private.subscription_register target where target.source_request_id=r.id) then raise exception 'Request changed. Reload before retrying.' using errcode='PT409'; end if;
  if r.payload->'formVersion' is distinct from '2'::jsonb or r.payload->>'kind' is distinct from 'new_purchase' then raise exception 'This request does not support activation.' using errcode='55000'; end if;
  select e.payload into approved from private.subscription_request_events e where e.request_id=r.id and e.version=r.version and e.operation='approve';
  if approved is null or approved is distinct from r.payload then raise exception 'Request approval changed.' using errcode='PT409'; end if;
  perform private.sr_validate(approved,true);
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

create temporary table subscription_activation_function_after on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition,
  jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable
from subscription_activation_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table subscription_activation_catalog_after on commit drop as select * from pg_temp.subscription_activation_catalog();
create temporary table subscription_activation_catalog_extra(definition text primary key) on commit drop;
insert into subscription_activation_catalog_extra values
('private.subscription_register:CHECK ((((source_request_id IS NULL) = (source_approved_version IS NULL)) AND ((source_approved_version IS NULL) OR (source_approved_version > 0))))'),
('private.subscription_register:FOREIGN KEY (source_request_id, source_approved_version) REFERENCES private.subscription_request_events(request_id, version) ON DELETE RESTRICT'),
('private.subscription_register:UNIQUE (source_request_id)'),
('private.subscription_register:source_approved_version:bigint:false'),
('private.subscription_register:source_request_id:uuid:false'),
('private.subscription_source_request_unique:source_request_id:uuid:false');
create temporary table subscription_activation_catalog_normalized on commit drop as
select definition from subscription_activation_catalog_after
except all (select definition from subscription_activation_function_after union all select acl_definition from subscription_activation_function_after union all select definition from subscription_activation_catalog_extra);
insert into subscription_activation_catalog_normalized
select definition from subscription_activation_function_before union all select acl_definition from subscription_activation_function_before;
create function pg_temp.subscription_activation_fk() returns jsonb language sql stable set search_path='' as $$
select jsonb_agg((to_jsonb(t)-array['oid','tgname','tgconstraint','tgrelid','tgconstrrelid','tgfoid','tgconstrindid'])||jsonb_build_object('relation',t.tgrelid::regclass::text,'referencedRelation',t.tgconstrrelid::regclass::text,'function',t.tgfoid::regprocedure::text,'referencedIndex',t.tgconstrindid::regclass::text) order by t.tgfoid::regprocedure::text) from pg_trigger t where t.tgconstraint=(select oid from pg_constraint where conrelid='private.subscription_register'::regclass and conname='subscription_source_approval');
$$;
create function pg_temp.subscription_activation_assert_delta() returns void language plpgsql set search_path='' as $$
begin
  if (select count(*) from subscription_activation_function_after)<>6
    or exists(select 1 from subscription_activation_function_spec s join subscription_activation_function_after a using(signature)
      where encode(extensions.digest(a.definition,'sha256'),'hex') is distinct from s.after_sha256
        or (not s.is_existing and a.portable is distinct from s.new_metadata))
    or exists(select 1 from subscription_activation_function_before b join subscription_activation_function_after a using(signature)
      where b.metadata is distinct from a.metadata or b.acl_definition is distinct from a.acl_definition)
    or exists((select definition collate "C" from subscription_activation_catalog_before except all select definition collate "C" from subscription_activation_catalog_normalized)
      union all (select definition collate "C" from subscription_activation_catalog_normalized except all select definition collate "C" from subscription_activation_catalog_before))
    or exists((select definition collate "C" from pg_temp.subscription_activation_catalog() except all select definition collate "C" from subscription_activation_catalog_after)
      union all (select definition collate "C" from subscription_activation_catalog_after except all select definition collate "C" from pg_temp.subscription_activation_catalog()))
    or exists(select 1 from subscription_activation_function_after a join pg_proc p on p.oid=to_regprocedure(a.signature)
      where a.metadata is distinct from (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))
    or exists(select 1 from private.subscription_register where source_request_id is not null or source_approved_version is not null)
    or (select relnatts from pg_class where oid='private.subscription_register'::regclass)<>(select relnatts+2 from subscription_activation_relation_before)
    or (select relchecks from pg_class where oid='private.subscription_register'::regclass)<>(select relchecks+1 from subscription_activation_relation_before)
    or not (select indisunique and indisvalid and indisready and indimmediate and not indisprimary and not indisclustered and not indisreplident and not indnullsnotdistinct and indnkeyatts=1 and indnatts=1 and indpred is null and indexprs is null from pg_index where indexrelid='private.subscription_source_request_unique'::regclass)
    or pg_get_indexdef('private.subscription_source_request_unique'::regclass) is distinct from 'CREATE UNIQUE INDEX subscription_source_request_unique ON private.subscription_register USING btree (source_request_id)'
    or exists(select 1 from pg_class where oid='private.subscription_source_request_unique'::regclass and (relowner<>(select oid from pg_roles where rolname='postgres') or relacl is not null))
    or exists(select 1 from pg_attribute where attrelid='private.subscription_register'::regclass and attname in ('source_request_id','source_approved_version') and (attacl is not null or attnotnull or atthasdef or attisdropped or attidentity<>'' or attgenerated<>'' or attcollation<>0 or attnum<>(select relnatts+case when attname='source_request_id' then 1 else 2 end from subscription_activation_relation_before)))
    or pg_temp.subscription_activation_fk() is distinct from '[{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":5,"tgnargs":0,"function":"\"RI_FKey_check_ins\"()","relation":"private.subscription_register","tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"referencedRelation":"private.subscription_request_events","referencedIndex":"private.subscription_request_events_pkey"},{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":17,"tgnargs":0,"function":"\"RI_FKey_check_upd\"()","relation":"private.subscription_register","tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"referencedRelation":"private.subscription_request_events","referencedIndex":"private.subscription_request_events_pkey"},{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":17,"tgnargs":0,"function":"\"RI_FKey_noaction_upd\"()","relation":"private.subscription_request_events","tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"referencedRelation":"private.subscription_register","referencedIndex":"private.subscription_request_events_pkey"},{"tgargs":"\\x","tgattr":[],"tgqual":null,"tgtype":9,"tgnargs":0,"function":"\"RI_FKey_restrict_del\"()","relation":"private.subscription_request_events","tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":false,"tgisinternal":true,"tginitdeferred":false,"referencedRelation":"private.subscription_register","referencedIndex":"private.subscription_request_events_pkey"}]'::jsonb
    or pg_temp.subscription_activation_security() is distinct from (select value from subscription_activation_security_before)
    or pg_temp.subscription_activation_data() is distinct from (select value from subscription_activation_data_before) then
    raise exception 'Subscription activation contain changes outside the reviewed delta.' using errcode='55000';
  end if;
end;
$$;
set constraints all immediate;
select pg_temp.subscription_activation_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
select pg_temp.subscription_activation_assert_delta();
do $subscription_activation_final$ begin
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription activation final fingerprint differs.' using errcode='55000';
  end if;
end $subscription_activation_final$;
commit;
