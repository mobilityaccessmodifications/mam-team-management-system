\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
do $$ declare p jsonb:='{"formVersion":2,"kind":"new_purchase","service":"Synthetic simple service","plan":"Business","purpose":"Project drawings","company":"equipsy","duration":"ongoing","billing":"annual","currency":"AUD","monthlyCostCents":1500,"annualCostCents":12000,"quoteCents":12000,"audEstimateCents":12000,"payment":"card","cardLabel":"Synthetic business card","cardHolder":"Synthetic accounts","intendedUsers":"Design team"}'; r jsonb; begin
  r:=public.sr_mutate('b2000000-0000-4000-8000-000000000001',0,'submit',p);
  assert r->>'status'='submitted' and length(r->>'applicantName')>0 and r->'linkedSubscriptionId'='null'::jsonb and not (r->>'canActivate')::boolean;
  assert length(public.sr_workspace()->>'viewerName')>0;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000001',1,2,current_date,null,'a1000000-0000-4000-8000-000000000013','{}'); raise exception 'Unapproved activation succeeded'; exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
select public.sr_mutate('b2000000-0000-4000-8000-000000000001',1,'approve');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
do $$ declare r jsonb; id uuid; begin
  select value into strict r from jsonb_array_elements(public.sr_workspace()->'requests') where value->>'id'='b2000000-0000-4000-8000-000000000001';
  assert (r->>'canActivate')::boolean;
end $$;
reset role;
set local role authenticated;
do $$ declare r jsonb; id uuid; begin
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000001',1,2,current_date,null,'a1000000-0000-4000-8000-000000000013','{}'); raise exception 'Stale activation succeeded'; exception when sqlstate 'PT409' then null; end;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000001',2,2,current_date,null,'a1000000-0000-4000-8000-000000000013',array['a1000000-0000-4000-8000-000000000011']::uuid[]); raise exception 'Inactive member activation succeeded'; exception when foreign_key_violation then null; end;
  r:=public.sr_activate('b2000000-0000-4000-8000-000000000001',2,2,current_date,null,'a1000000-0000-4000-8000-000000000013',array['a1000000-0000-4000-8000-000000000001']::uuid[]);
  assert r->>'status'='approved' and (r->>'version')::bigint=3 and not (r->>'canActivate')::boolean and not (r->>'canWithdraw')::boolean;
  id:=(r->>'linkedSubscriptionId')::uuid;
  assert id is not null;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000001',2,2,current_date,null,'a1000000-0000-4000-8000-000000000013','{}'); raise exception 'Duplicate activation succeeded'; exception when sqlstate 'PT409' then null; end;
  begin perform public.sr_mutate('b2000000-0000-4000-8000-000000000001',3,'withdraw'); raise exception 'Activated request withdrawn'; exception when sqlstate 'PT409' then null; end;
  begin perform public.create_subscription_v4('Synthetic bypass',null,'paid','annual',12000,null,1,false,null,current_date,'a1000000-0000-4000-8000-000000000013','mam','{}'); raise exception 'Direct paid bypass succeeded'; exception when object_not_in_prerequisite_state then null; end;
  perform public.create_subscription_v4('Synthetic direct free',null,'free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000013','mam','{}');
end $$;
reset role;
do $$ declare s private.subscription_register%rowtype; begin
  select * into strict s from private.subscription_register where source_request_id='b2000000-0000-4000-8000-000000000001';
  assert s.source_approved_version=2 and s.amount_cents=12000 and s.billing_cycle='annual' and s.company_scope='equipsy' and s.credit_card_holder='Synthetic accounts';
  assert s.next_review_on=private.next_paid_subscription_quarter_review_on();
  assert (select count(*)=1 from private.subscription_memberships where subscription_id=s.id);
  assert (select count(*)=1 from private.subscription_request_events where request_id=s.source_request_id and operation='activate');
  assert not exists(select 1 from private.subscription_credential_vault where subscription_id=s.id);
  begin update private.subscription_register set source_request_id=null,source_approved_version=null where id=s.id; raise exception 'Provenance removed'; exception when object_not_in_prerequisite_state then null; end;
  begin update private.subscription_request_events set reason='Tampered' where request_id=s.source_request_id; raise exception 'History changed'; exception when object_not_in_prerequisite_state then null; end;
end $$;
rollback;
\echo PASS: V2 submit, human requester, sole approval, exact approved activation, shared register, immutable provenance, duplicate/CAS/withdraw denial, no vault side effects and free direct add

begin;
\ir unified-role-fixture.sql
do $$ declare p jsonb:='{"formVersion":2,"kind":"new_purchase","service":"Synthetic prices","purpose":"Work","company":"mam","duration":"3_months","billing":"monthly","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":1000,"audEstimateCents":1000,"payment":"non_card","intendedUsers":"Team"}'; changed jsonb; k text; begin
  perform private.sr_validate(p,true);
  perform private.sr_validate(p-'annualCostCents'||'{"comparisonUnavailableReason":"No annual plan"}',true);
  foreach k in array array['monthlyCostCents','quoteCents','audEstimateCents'] loop
    changed:=p||jsonb_build_object(k,1100);
    begin perform private.sr_validate(changed,true); raise exception 'Mismatched approved cost passed'; exception when invalid_parameter_value then null; end;
  end loop;
  begin perform private.sr_validate(p-'annualCostCents',true); raise exception 'Missing comparison passed'; exception when invalid_parameter_value then null; end;
  begin perform private.sr_validate(p||'{"formVersion":3}',true); raise exception 'Wrong form version passed'; exception when invalid_parameter_value then null; end;
  begin perform private.sr_validate(p||'{"currency":"USD"}',true); raise exception 'NonAUD V2 passed'; exception when invalid_parameter_value then null; end;
  begin perform private.sr_validate(p||'{"duration":"Year"}',true); raise exception 'Unknown usage passed'; exception when invalid_parameter_value then null; end;
  begin perform private.sr_validate(p||'{"billing":"one_off"}',true); raise exception 'Unsupported simple cycle passed'; exception when invalid_parameter_value then null; end;
  begin perform private.sr_validate(p||jsonb_build_object('service',repeat('s',161)),true); raise exception 'Overlong service passed'; exception when invalid_parameter_value then null; end;
  perform private.sr_validate('{"kind":"renewal","service":"Legacy","purpose":"Work","company":"mam","payer":"MAM","duration":"Year","billing":"one_off","currency":"USD","tax":"Inclusive","quoteCents":1000,"audEstimateCents":1500,"payment":"non_card","intendedUsers":"Team"}',true);
end $$;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    assert has_function_privilege(role_name,'public.sr_activate(uuid,bigint,integer,date,date,uuid,uuid[])','EXECUTE')=(role_name='authenticated');
    assert not has_function_privilege(role_name,'private.sr_register_gate()','EXECUTE');
    assert not has_table_privilege(role_name,'private.subscription_requests','UPDATE');
  end loop;
end $$;
rollback;
\echo PASS: V2 monthly/annual comparison, missing-alternative reason, derived amounts, safe text/choice validation, legacy validation and exact ACLs
begin;
\ir unified-role-fixture.sql
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000001']::uuid[]);
select public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000008']::uuid[]);
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.sr_mutate('b2000000-0000-4000-8000-000000000002',0,'submit','{"formVersion":2,"kind":"new_purchase","service":"Synthetic monthly service","purpose":"Design","company":"mam","duration":"12_months","billing":"monthly","currency":"AUD","monthlyCostCents":1400,"quoteCents":1400,"audEstimateCents":1400,"comparisonUnavailableReason":"No annual plan","payment":"non_card","intendedUsers":"Team"}');
select public.sr_mutate('b2000000-0000-4000-8000-000000000003',0,'submit','{"kind":"renewal","service":"Legacy request","purpose":"Work","company":"mam","payer":"MAM","duration":"Year","billing":"annual","currency":"USD","tax":"Inclusive","quoteCents":1000,"audEstimateCents":1500,"payment":"non_card","intendedUsers":"Team"}');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
select public.sr_mutate('b2000000-0000-4000-8000-000000000002',1,'approve');
select public.sr_mutate('b2000000-0000-4000-8000-000000000003',1,'approve');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000008');
set local role authenticated;
do $$ begin
  assert (public.sr_workspace()->>'canManageCredentials')::boolean and not (public.sr_workspace()->>'canApply')::boolean;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000002',2,1,current_date,null,'a1000000-0000-4000-8000-000000000001','{}'); raise exception 'Vault-only activation succeeded'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
  assert not (public.sr_workspace()->>'canManageCredentials')::boolean;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000003',2,1,current_date,null,'a1000000-0000-4000-8000-000000000001','{}'); raise exception 'Legacy amendment activation succeeded'; exception when object_not_in_prerequisite_state then null; end;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000002',2,1,current_date,current_date-1,'a1000000-0000-4000-8000-000000000001','{}'); raise exception 'Past renewal succeeded'; exception when invalid_parameter_value then null; end;
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000002',2,1,'infinity',null,'a1000000-0000-4000-8000-000000000001','{}'); raise exception 'Infinite date succeeded'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
create function pg_temp.activation_audit_fault() returns trigger language plpgsql as $$begin raise exception 'Synthetic audit fault' using errcode='22023'; end$$;
create trigger activation_audit_fault before insert on private.subscription_audit_events for each row execute function pg_temp.activation_audit_fault();
set local role authenticated;
do $$ begin
  begin perform public.sr_activate('b2000000-0000-4000-8000-000000000002',2,1,current_date,null,'a1000000-0000-4000-8000-000000000001',array['a1000000-0000-4000-8000-000000000002']::uuid[]); raise exception 'Audit fault did not stop activation'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from private.subscription_register where source_request_id='b2000000-0000-4000-8000-000000000002');
  assert (select version=2 and status='approved' from private.subscription_requests where id='b2000000-0000-4000-8000-000000000002');
  assert not exists(select 1 from private.subscription_request_events where request_id='b2000000-0000-4000-8000-000000000002' and operation='activate');
end $$;
drop trigger activation_audit_fault on private.subscription_audit_events;
set local role authenticated;
select public.sr_activate('b2000000-0000-4000-8000-000000000002',2,1,current_date,null,'a1000000-0000-4000-8000-000000000001','{}');
reset role;
do $$ begin assert (select amount_cents=1400 and billing_cycle='monthly' and credit_card_holder is null and not mam_credit_card_used from private.subscription_register where source_request_id='b2000000-0000-4000-8000-000000000002'); end $$;
rollback;
\echo PASS: authorized Register delegate, isolated Vault authority, legacy amendment refusal, date checks, audit-fault atomic rollback and monthly/no-comparison activation
