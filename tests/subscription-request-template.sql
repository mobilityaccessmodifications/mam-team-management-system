\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000013',approver_person_id='a1000000-0000-4000-8000-000000000013';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare p jsonb:='{"formVersion":3,"kind":"new_purchase","service":"Synthetic gate","purpose":"Work","company":"mam","duration":"ongoing","billing":"monthly","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":1000,"audEstimateCents":1000,"payment":"card","cardLabel":"Company card","cardHolder":"Holder","intendedUsers":"Team","category":"subscription"}'; begin
 assert public.sr_workspace()->>'requestFormVersion'='2';
 begin perform public.sr_mutate('b3300000-0000-4000-8000-000000000099',0,'submit',p);raise exception 'Disabled V3 gate bypassed';exception when object_not_in_prerequisite_state then null;end;
 perform public.sr_mutate('b3300000-0000-4000-8000-000000000098',0,'save',p-'category'||'{"formVersion":2}');
end $$;
reset role;
update private.subscription_request_config set request_form_version=3;
set local role authenticated;
do $$ declare p jsonb:='{"formVersion":3,"kind":"new_purchase","service":"Synthetic gate","purpose":"Work","company":"mam","duration":"ongoing","billing":"monthly","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":1000,"audEstimateCents":1000,"payment":"card","cardLabel":"Company card","cardHolder":"Holder","intendedUsers":"Team","category":"subscription"}'; begin
 begin perform public.sr_mutate('b3300000-0000-4000-8000-000000000099',0,'submit',p-'category'||'{"formVersion":2}');raise exception 'New V2 request bypassed V3 gate';exception when invalid_parameter_value then null;end;
 perform public.sr_mutate('b3300000-0000-4000-8000-000000000099',0,'save',p);
 begin perform public.sr_mutate('b3300000-0000-4000-8000-000000000099',1,'submit',p-'category'||'{"formVersion":2}');raise exception 'V3 request downgraded';exception when invalid_parameter_value then null;end;
 perform public.sr_mutate('b3300000-0000-4000-8000-000000000098',1,'submit',p-'category'||'{"formVersion":2}');
end $$;
reset role;
rollback;
\echo PASS: staged form release blocks premature V3, new legacy bypass and immutable-version downgrade while preserving legacy draft submission

begin;
do $$ begin assert current_database() ~ '^mam_test_', 'Disposable synthetic database required'; end $$;
\ir unified-role-fixture.sql
update private.subscription_request_config set request_form_version=3,enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000013',approver_person_id='a1000000-0000-4000-8000-000000000013';
insert into private.employee_directory_details(person_id,first_name,work_email) values('a1000000-0000-4000-8000-000000000004','Synthetic','applicant@example.test'),('a1000000-0000-4000-8000-000000000013','Synthetic','approver@example.test');
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
select public.sr_mutate('b3300000-0000-4000-8000-000000000001',0,'submit','{"formVersion":3,"kind":"new_purchase","service":"Synthetic recurring","purpose":"Design","company":"equipsy","duration":"ongoing","billing":"annual","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"oneOffCostCents":5000,"quoteCents":10000,"audEstimateCents":10000,"payment":"invoice","intendedUsers":"Team","category":"software_app","websiteUrl":"https://example.test/product","usageFrequency":"Daily","invoiceContact":"Applicant contact"}');
select public.sr_mutate('b3300000-0000-4000-8000-000000000002',0,'submit','{"formVersion":3,"kind":"new_purchase","service":"Synthetic one-off","purpose":"Installation","company":"mam","duration":"3_months","billing":"one_off","currency":"AUD","oneOffCostCents":30000,"quoteCents":30000,"audEstimateCents":30000,"payment":"direct_debit","intendedUsers":"Team","category":"one_off_service"}');
do $$ begin
 begin perform public.subscription_request_decide_v3('b3300000-0000-4000-8000-000000000001',1,'approve','','{"budgetApproved":true}');raise exception 'Applicant approved';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role service_role;
do $$ declare item record;begin
 select * into strict item from public.claim_subscription_request_mail('b3300000-0000-4000-8000-000000000001',1);
 assert item.payload->>'version'='3';
 assert (select count(*)=24 from jsonb_object_keys(item.payload->'request'));
 assert item.payload->'request'->>'category'='software_app' and item.payload->'request'->>'oneOffCostCents'='5000';
 assert item.payload->'request'->>'websiteUrl'='https://example.test/product';
 assert item.payload->'request'->>'invoiceContact'='Applicant contact';
 assert not (item.payload->'request' ? 'budgetApproved');
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
do $$ declare r jsonb;begin
 begin perform public.sr_mutate('b3300000-0000-4000-8000-000000000001',1,'approve');raise exception 'Legacy decision bypassed finance';exception when object_not_in_prerequisite_state then null;end;
 begin perform public.subscription_request_decide_v3('b3300000-0000-4000-8000-000000000001',99,'approve','','{"budgetApproved":true,"invoiceContact":"Accounts"}');raise exception 'Stale decision passed';exception when sqlstate 'PT409' then null;end;
 begin perform public.subscription_request_decide_v3('b3300000-0000-4000-8000-000000000001',1,'approve','','{"budgetApproved":false,"invoiceContact":"Accounts"}');raise exception 'Unapproved budget passed';exception when invalid_parameter_value then null;end;
 begin perform public.subscription_request_decide_v3('b3300000-0000-4000-8000-000000000001',1,'approve','','{"budgetApproved":true}');raise exception 'Missing invoice contact passed';exception when invalid_parameter_value then null;end;
 r:=public.subscription_request_decide_v3('b3300000-0000-4000-8000-000000000001',1,'approve','','{"budgetApproved":true,"invoiceEmail":"accounts@example.test","invoiceContact":"Finance owner"}');
 assert r->'finance'->>'budgetApproved'='true' and r->'finance'->>'invoiceEmail'='accounts@example.test';
 assert r->'payload'->>'invoiceContact'='Applicant contact';
 assert r->'finance'->>'approvedByName'='Synthetic role 13';
 assert r->'requestedAt' <> 'null'::jsonb and r->'finance'->'approvedAt'<>'null'::jsonb;
 assert (r->'events'->1)->>'actorName'='Synthetic role 13';
 r:=public.subscription_request_decide_v3('b3300000-0000-4000-8000-000000000002',1,'approve','','{"budgetApproved":true}');
 assert (r->>'canCompletePurchase')::boolean and not (r->>'canActivate')::boolean;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.sr_activate('b3300000-0000-4000-8000-000000000001',2,2,current_date,current_date+365,'a1000000-0000-4000-8000-000000000004','{}');
 assert (r->>'version')::bigint=3 and r->>'linkedSubscriptionId' is not null;
 assert r->'payload'->>'oneOffCostCents'='5000';
 r:=public.subscription_request_complete_purchase_v3('b3300000-0000-4000-8000-000000000002',2);
 assert (r->>'version')::bigint=3 and r->'completedAt'<>'null'::jsonb;
 assert r->>'completedByName'='Synthetic role 04' and not (r->>'canWithdraw')::boolean and not (r->>'canCompletePurchase')::boolean;
 assert r->'linkedSubscriptionId'='null'::jsonb;
 begin perform public.subscription_request_complete_purchase_v3('b3300000-0000-4000-8000-000000000002',3);raise exception 'Duplicate completion passed';exception when sqlstate 'PT409' then null;end;
 begin perform public.sr_mutate('b3300000-0000-4000-8000-000000000002',3,'withdraw');raise exception 'Completed purchase withdrawn';exception when sqlstate 'PT409' then null;end;
end $$;
reset role;
do $$ declare p jsonb:='{"formVersion":3,"kind":"new_purchase","service":"Synthetic","purpose":"Work","company":"mam","duration":"ongoing","billing":"monthly","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":1000,"audEstimateCents":1000,"payment":"card","cardLabel":"Test company card","cardHolder":"Test holder","intendedUsers":"Team","category":"subscription","websiteUrl":"https://example.test"}';k text;bad jsonb;begin
 assert (select amount_cents=10000 and billing_cycle='annual' and not mam_credit_card_used from private.subscription_register where source_request_id='b3300000-0000-4000-8000-000000000001');
 assert not exists(select 1 from private.subscription_register where source_request_id='b3300000-0000-4000-8000-000000000002');
 assert not exists(select 1 from private.subscription_credential_vault);
 assert not exists(select 1 from private.subscription_password_tasks);
 begin update private.subscription_request_decisions set budget_approved=false;raise exception 'Finance audit changed';exception when object_not_in_prerequisite_state then null;end;
 perform private.sr_validate(p,true);
 foreach bad in array array[p||'{"websiteUrl":"javascript:alert(1)"}',p||'{"websiteUrl":"https://example.test/<tag>"}',p||'{"websiteUrl":"https://name:secret@example.test"}',p||'{"category":"one_off_service"}',p||'{"kind":"renewal"}',p||'{"kind":"added_seats"}',p||'{"kind":"plan_change"}',p||'{"payment":"non_card"}',p||'{"invoiceEmail":"invalid"}',p||'{"oneOffCostCents":-1}',p||'{"oneOffCostCents":100000001}',p||'{"formVersion":2}',p-'formVersion',p||'{"budgetApproved":true}']::jsonb[] loop
  begin perform private.sr_validate(bad,true);raise exception 'Invalid template passed';exception when invalid_parameter_value then null;end;
 end loop;
 foreach k in array array['anon','authenticated','service_role'] loop
  assert has_function_privilege(k,'public.subscription_request_decide_v3(uuid,bigint,text,text,jsonb)','EXECUTE')=(k='authenticated');
  assert not has_table_privilege(k,'private.subscription_request_decisions','SELECT');
 end loop;
end $$;
rollback;
\echo PASS: V3 required template fields, independent setup and recurring amounts, canonical mail, versioned budget and invoice approval, immutable finance, one-off completion without register/vault/tasks, negative validation and scoped ACLs
