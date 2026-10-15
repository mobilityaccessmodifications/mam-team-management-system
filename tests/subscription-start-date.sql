\set ON_ERROR_STOP on
begin;
do $$ declare v integer; d text; p jsonb; begin
 assert current_database() ~ '^mam_test_', 'Disposable synthetic database required';
 foreach v in array array[2,3] loop
  foreach d in array array['','0001-01-01','0099-01-01','1900-02-28','2000-02-29','2024-02-29','2026-10-15','9999-12-31'] loop
   perform private.sr_validate(jsonb_build_object('formVersion',v,'startDate',d),false);
  end loop;
  foreach d in array array['2026-02-29','2024-02-30','1900-02-29','2026-04-31','2026-00-01','2026-13-01','2026-01-00','0000-01-01','2026-1-01','26-01-01','2026-01-01T00:00:00Z',' 2026-01-01','2026-01-01 ','infinity','10000-01-01'] loop
   begin perform private.sr_validate(jsonb_build_object('formVersion',v,'startDate',d),false);raise exception 'Invalid calendar date passed: %',d;exception when invalid_parameter_value then null;end;
  end loop;
  foreach p in array array[jsonb_build_object('formVersion',v,'startDate',null),jsonb_build_object('formVersion',v,'startDate',42)] loop
   begin perform private.sr_validate(p,false);raise exception 'Invalid date type passed';exception when invalid_parameter_value then null;end;
  end loop;
 end loop;
 begin perform private.sr_validate('{"startDate":"2026-10-15"}',false);raise exception 'Legacy request accepted new field';exception when invalid_parameter_value then null;end;
end $$;
rollback;
\echo PASS: optional V2/V3 request dates use exact ISO Gregorian dates and reject invalid types, leap days and normalization

begin;
\ir unified-role-fixture.sql
update private.subscription_request_config set enabled=true,request_form_version=2,approver_user_id='a1000000-0000-4000-8000-000000000013',approver_person_id='a1000000-0000-4000-8000-000000000013';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare r jsonb; id uuid; version bigint; begin
 r:=public.create_subscription_v5('Synthetic dated free','Plan','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}','2024-02-29');
 id:=(r->>'subscription_id')::uuid;version:=(r->>'version')::bigint;
 assert r->>'start_date'='2024-02-29' and r->'billing_anchor_date'='null'::jsonb;
 begin perform public.update_subscription_v5(id,version-1,'Stale','Plan','active','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}','2026-10-15');raise exception 'Stale register date update passed';exception when serialization_failure then null;end;
 r:=public.update_subscription_v4(id,version,'Legacy edit','Plan','active','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}');
 assert r->>'start_date'='2024-02-29';
 r:=public.update_subscription_v5(id,(r->>'version')::bigint,'Explicit clear','Plan','active','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}',null);
 assert r->'start_date'='null'::jsonb;
 r:=public.update_subscription_v5(id,(r->>'version')::bigint,'Dated again','Plan','active','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}','2026-10-15');
 assert r->>'start_date'='2026-10-15';
 assert exists(select 1 from jsonb_array_elements(public.list_subscriptions_v2()) item where item->>'subscription_id'=id::text and item->>'start_date'='2026-10-15');
 r:=public.create_subscription_v4('Synthetic legacy free','Plan','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}');
 assert r->'start_date'='null'::jsonb;
 begin perform public.create_subscription_v5('Invalid date rollback','Plan','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}','infinity');raise exception 'Infinite register date passed';exception when invalid_parameter_value then null;end;
 perform public.sr_mutate('b3400000-0000-4000-8000-000000000001',0,'submit','{"formVersion":2,"kind":"new_purchase","service":"Synthetic V2 date","purpose":"Work","company":"mam","duration":"ongoing","billing":"annual","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":10000,"audEstimateCents":10000,"payment":"non_card","intendedUsers":"Team","startDate":"2026-10-01"}');
end $$;
reset role;
do $$ begin
 assert exists(select 1 from private.subscription_audit_events where changed_fields=array['start_date']);
 assert not exists(select 1 from private.subscription_register where service_name='Invalid date rollback');
end $$;
update private.subscription_request_config set request_form_version=3;
set local role authenticated;
select public.sr_mutate('b3400000-0000-4000-8000-000000000002',0,'submit','{"formVersion":3,"kind":"new_purchase","service":"Synthetic V3 date","purpose":"Work","company":"mam","duration":"ongoing","billing":"annual","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":10000,"audEstimateCents":10000,"payment":"direct_debit","intendedUsers":"Team","category":"subscription","startDate":"2026-10-02"}') is not null;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.sr_mutate('b3400000-0000-4000-8000-000000000001',1,'approve');assert r->'payload'->>'startDate'='2026-10-01';
 r:=public.subscription_request_decide_v3('b3400000-0000-4000-8000-000000000002',1,'approve','','{"budgetApproved":true}');assert r->'payload'->>'startDate'='2026-10-02';
 assert r->'events'->0->'payload'->>'startDate'='2026-10-02';
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
do $$ begin
 begin
  insert into private.subscription_register(subscription_code,service_name,subscription_status,pricing_model,billing_cycle,amount_cents,currency_code,start_date,billing_anchor_date,responsible_person_id,company_scope,created_by,updated_by,source_request_id,source_approved_version,mam_credit_card_used)
  values('MAM-SUB-998801','Synthetic V3 date','active','paid','annual',10000,'AUD','2026-10-03','2026-10-21','a1000000-0000-4000-8000-000000000004','mam','a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000004','b3400000-0000-4000-8000-000000000002',2,false);
  raise exception 'Mismatched approved date passed';
 exception when invalid_parameter_value then null; end;
end $$;
set local role authenticated;
do $$ declare r jsonb; id uuid; row jsonb;begin
 r:=public.sr_activate('b3400000-0000-4000-8000-000000000001',2,2,'2026-10-20','2027-10-20','a1000000-0000-4000-8000-000000000004','{}');
 assert r->'payload'->>'startDate'='2026-10-01';
 r:=public.sr_activate('b3400000-0000-4000-8000-000000000002',2,2,'2026-10-21','2027-10-21','a1000000-0000-4000-8000-000000000004','{}');
 id:=(r->>'linkedSubscriptionId')::uuid;
 assert exists(select 1 from jsonb_array_elements(public.list_subscriptions_v2()) item where item->>'subscription_id'=id::text and item->>'start_date'='2026-10-02' and item->>'billing_anchor_date'='2026-10-21');
 select item into strict row from jsonb_array_elements(public.list_subscriptions_v2()) item where item->>'subscription_id'=id::text;
 row:=public.update_subscription_v5(id,(row->>'version')::bigint,'Synthetic V3 date',null,'active','paid','annual',10000,'2027-10-21',2,false,null,'2026-10-21','a1000000-0000-4000-8000-000000000004','mam','{}','2026-10-04');
 assert row->>'start_date'='2026-10-04' and row->>'billing_anchor_date'='2026-10-21' and row->>'renewal_date'='2027-10-21';
 row:=public.update_subscription_v4(id,(row->>'version')::bigint,'Synthetic V3 date',null,'active','paid','annual',10000,'2027-10-21',2,false,null,'2026-10-21','a1000000-0000-4000-8000-000000000004','mam','{}');
 assert row->>'start_date'='2026-10-04';
end $$;
reset role;
do $$ declare k text;begin
 assert exists(select 1 from private.subscription_register where source_request_id='b3400000-0000-4000-8000-000000000001' and start_date='2026-10-01' and billing_anchor_date='2026-10-20' and renewal_date='2027-10-20');
 assert exists(select 1 from private.subscription_register where source_request_id='b3400000-0000-4000-8000-000000000002' and start_date='2026-10-04' and billing_anchor_date='2026-10-21' and renewal_date='2027-10-21');
 foreach k in array array['anon','authenticated','service_role'] loop
  assert has_function_privilege(k,'public.create_subscription_v5(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date)','EXECUTE')=(k='authenticated');
  assert has_function_privilege(k,'public.update_subscription_v5(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date)','EXECUTE')=(k='authenticated');
  assert not has_function_privilege(k,'private.set_subscription_start_date(uuid,date)','EXECUTE');
  assert not has_column_privilege(k,'private.subscription_register','start_date','SELECT');
 end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
 begin perform public.create_subscription_v5('Denied','Plan','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}','2026-10-15');raise exception 'Employee date create passed';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
\echo PASS: free create/edit/clear and legacy preservation, CAS, invalid-write rollback, V2/V3 immutable approval readback, activation copies date independently of billing/renewal and scoped ACLs
