\set ON_ERROR_STOP on
DO $$ BEGIN
  ASSERT current_database() ~ '^mam_test_', 'Synthetic database only';
  ASSERT inet_server_addr() IS NULL, 'Local Unix socket only';
  ASSERT current_user='postgres', 'Actual approved operator role required';
  ASSERT to_regprocedure('private.adopt_leave_bank_sources(text,text,jsonb)') IS NOT NULL;
END $$;
BEGIN;
\ir sql-test-auth.sql
CREATE FUNCTION pg_temp.adoption_person(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('99700000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.adoption_identity(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('99600000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.adoption_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(extensions.digest(coalesce(j,'null'::jsonb)::text,'sha256'),'hex');
$$;
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT pg_temp.adoption_person(n),'adoption-'||n||'@example.test',now() FROM generate_series(1,28) n
UNION ALL SELECT pg_temp.adoption_person(900),'adoption-admin@example.test',now();
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
SELECT pg_temp.adoption_person(n),'Synthetic Adoption '||n,'employee','adoption-'||n,now()-interval '1 day' FROM generate_series(1,28) n
UNION ALL SELECT pg_temp.adoption_person(900),'Synthetic Adoption Admin','system_admin','adoption-admin',now()-interval '1 day';
INSERT INTO private.portal_account_admins(auth_user_id) VALUES(pg_temp.adoption_person(900));
INSERT INTO public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
SELECT pg_temp.adoption_person(n),'person',CASE WHEN n BETWEEN 25 AND 26 THEN 'equipsy' ELSE 'mam' END,
  'Synthetic Adoption '||n,'Tester',pg_temp.adoption_person(n),'2026-08-01',true FROM generate_series(1,28) n;
INSERT INTO private.employee_directory_details(person_id,first_name,employment_type,working_weekdays)
SELECT pg_temp.adoption_person(n),'Synthetic','full_time',ARRAY[1,2,3,4,5]::smallint[] FROM generate_series(1,28) n;
SELECT pg_temp.set_test_actor(pg_temp.adoption_person(900));
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
SELECT pg_temp.adoption_person(n),50+n,'2026-09-10',false,pg_temp.adoption_person(900) FROM generate_series(1,28) n;
INSERT INTO private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
SELECT pg_temp.adoption_person(n),40,'2026-09-10',pg_temp.adoption_person(900) FROM generate_series(1,28) n;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
SELECT pg_temp.adoption_person(n),'2026-09-11',38,ARRAY[1,2,3,4,5],4,2,true,'Synthetic ordinary hours',pg_temp.adoption_person(900) FROM generate_series(1,28) n;
INSERT INTO private.leave_payroll_calendars(person_id,calendar_key)
SELECT pg_temp.adoption_person(n),'none' FROM generate_series(1,28) n;
INSERT INTO private.payroll_balance_import_batches(id,source_digest,source_files,uploaded_by,row_count,comparison_only)
VALUES('99500000-0000-4000-8000-000000000001',repeat('a',64),'["synthetic-mam.csv"]',pg_temp.adoption_person(900),24,true),
 ('99500000-0000-4000-8000-000000000002',repeat('b',64),'["synthetic-equipsy.csv"]',pg_temp.adoption_person(900),3,true);
INSERT INTO private.payroll_balance_source_archives(id,storage_path,original_file_name,content_type,size_bytes,source_sha256,uploaded_by,batch_id,parse_status,uploaded_at)
SELECT ('99400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 pg_temp.adoption_person(900)::text||'/99400000-0000-4000-8000-'||lpad(n::text,12,'0')||'.csv',
 CASE WHEN n=1 THEN 'synthetic-mam.csv' ELSE 'synthetic-equipsy.csv' END,'text/csv',100,
 encode(extensions.digest('raw synthetic payroll archive '||n,'sha256'),'hex'),pg_temp.adoption_person(900),
 ('99500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'parsed',now() FROM generate_series(1,2) n;
INSERT INTO private.payroll_balance_imports(id,company_key,employee_name,annual_hours,sick_hours,as_of,source_file,source_sha256,person_id,match_status)
SELECT pg_temp.adoption_identity(n),CASE WHEN n<=24 THEN 'mam' ELSE 'equipsy' END,'Synthetic Adoption '||n,50+n,40,'2026-09-10',
 'synthetic-first.csv',encode(extensions.digest('first stable identity '||n,'sha256'),'hex'),pg_temp.adoption_person(n),'linked' FROM generate_series(1,27) n;
INSERT INTO private.payroll_balance_import_stage_rows(batch_id,company_key,employee_name,normalised_employee_name,annual_hours,sick_hours,as_of,source_file,source_sha256,person_id,match_status)
SELECT a.batch_id,CASE WHEN n<=24 THEN 'mam' ELSE 'equipsy' END,'Synthetic Adoption '||n,private.normalise_payroll_employee_name('Synthetic Adoption '||n),
 100+n::numeric/100,40,'2026-10-01',a.original_file_name,encode(extensions.digest(a.source_sha256,'sha256'),'hex'),
 CASE WHEN n=27 THEN NULL ELSE pg_temp.adoption_person(n) END,CASE WHEN n=27 THEN 'company_mismatch' ELSE 'linked' END
FROM generate_series(1,27) n JOIN private.payroll_balance_source_archives a ON a.id=('99400000-0000-4000-8000-'||lpad((CASE WHEN n<=24 THEN 1 ELSE 2 END)::text,12,'0'))::uuid;
CREATE FUNCTION pg_temp.adoption_payload() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_agg(payload ORDER BY n) FROM (
 SELECT n,jsonb_build_object('personId',p.id,'kind','annual','hours',s.annual_hours,'reportDate',s.as_of,
  'coveredThrough',NULL,'sourceKind','payroll_report','archiveId',a.id,'stageRowId',s.id,'identityImportId',i.id,
  'fileSha256',a.source_sha256,'expectedLegacyHash',pg_temp.adoption_hash(to_jsonb(b)),
  'expectedStageHash',pg_temp.adoption_hash(to_jsonb(s)),'expectedIdentityHash',pg_temp.adoption_hash(to_jsonb(i)),
  'expectedArchiveHash',pg_temp.adoption_hash(to_jsonb(a)),'sourceFingerprint',pg_temp.adoption_hash(to_jsonb(s)),
  'note','Synthetic verified archived payroll row, with unknown service cutoff') AS payload
 FROM generate_series(1,27) n JOIN public.internal_org_people p ON p.id=pg_temp.adoption_person(n)
 JOIN private.employee_annual_leave_balances b ON b.person_id=p.id
 JOIN private.payroll_balance_imports i ON i.id=pg_temp.adoption_identity(n)
 JOIN private.payroll_balance_import_stage_rows s ON s.employee_name=p.full_name AND s.as_of='2026-10-01'
 JOIN private.payroll_balance_source_archives a ON a.batch_id=s.batch_id
 UNION ALL SELECT 28,jsonb_build_object('personId',b.person_id,'kind','annual','hours',32.5545,'reportDate','2026-10-02',
  'coveredThrough','2026-10-02','sourceKind','payslip','expectedLegacyHash',pg_temp.adoption_hash(to_jsonb(b)),
  'sourceFingerprint',encode(extensions.digest('Synthetic user-confirmed payslip: coverage 9/28-10/2; received 10/7; 7.6 already deducted','sha256'),'hex'),
  'note','Synthetic user confirmation of payslip coverage through 10/2; received 10/7 separately; annual 7.6 included')
 FROM private.employee_annual_leave_balances b WHERE b.person_id=pg_temp.adoption_person(1)
 ) t;
$$;
CREATE TEMP TABLE adoption_payload_frozen AS SELECT pg_temp.adoption_payload() AS rows;
CREATE TEMP TABLE adoption_baseline AS
SELECT name,pg_temp.adoption_hash(payload) AS fingerprint FROM (
 SELECT 'legacyAnnual'::text name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY person_id),'[]') payload FROM private.employee_annual_leave_balances t
 UNION ALL SELECT 'legacyPersonal',coalesce(jsonb_agg(to_jsonb(t) ORDER BY person_id),'[]') FROM private.employee_sick_leave_balances t
 UNION ALL SELECT 'requests',coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.leave_requests t
 UNION ALL SELECT 'reviews',coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM private.leave_accrual_day_reviews t
 UNION ALL SELECT 'carry',coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM private.payroll_carryforward_events t
) values;
CREATE FUNCTION pg_temp.expect_adoption_error(p_label text,p_rows jsonb,p_code text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text; receipts_before bigint; sources_before bigint; BEGIN
 SELECT count(*) INTO receipts_before FROM private.leave_bank_adoption_receipts;
 SELECT count(*) INTO sources_before FROM private.leave_bank_sources;
 BEGIN
  PERFORM private.adopt_leave_bank_sources('synthetic-failure-'||p_label,encode(extensions.digest(p_label,'sha256'),'hex'),p_rows);
  RAISE EXCEPTION 'Expected adoption failure: %',p_label USING errcode='P0001';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;
  IF actual<>p_code THEN RAISE EXCEPTION 'Unexpected state for %: %, expected %',p_label,actual,p_code; END IF;
 END;
 ASSERT (SELECT count(*) FROM private.leave_bank_adoption_receipts)=receipts_before, 'Failure rolled back its receipt';
 ASSERT (SELECT count(*) FROM private.leave_bank_sources)=sources_before, 'Failure rolled back all source rows';
END $$;
DO $$ DECLARE p jsonb:=pg_temp.adoption_payload(); BEGIN
 ASSERT jsonb_array_length(p)=28;
 PERFORM pg_temp.expect_adoption_error('wrong-kind',jsonb_set(p,'{27,kind}','"personal"'),'22023');
 PERFORM pg_temp.expect_adoption_error('stale-legacy',jsonb_set(p,'{27,expectedLegacyHash}',to_jsonb(repeat('0',64))),'40001');
 PERFORM pg_temp.expect_adoption_error('wrong-archive-sha',jsonb_set(p,'{0,fileSha256}',to_jsonb(repeat('0',64))),'55000');
 PERFORM pg_temp.expect_adoption_error('stale-stage',jsonb_set(p,'{0,expectedStageHash}',to_jsonb(repeat('0',64))),'55000');
 PERFORM pg_temp.expect_adoption_error('stale-identity',jsonb_set(p,'{0,expectedIdentityHash}',to_jsonb(repeat('0',64))),'55000');
 PERFORM pg_temp.expect_adoption_error('stale-archive',jsonb_set(p,'{0,expectedArchiveHash}',to_jsonb(repeat('0',64))),'55000');
 PERFORM pg_temp.expect_adoption_error('wrong-quantity',jsonb_set(p,'{0,hours}','100.99'),'55000');
 PERFORM pg_temp.expect_adoption_error('wrong-report-date',jsonb_set(p,'{0,reportDate}','"2026-10-02"'),'55000');
 PERFORM pg_temp.expect_adoption_error('wrong-person',jsonb_set(p,'{0,identityImportId}',to_jsonb(pg_temp.adoption_identity(2)::text)),'55000');
 PERFORM pg_temp.expect_adoption_error('missing-payslip-cutoff',p #- '{27,coveredThrough}','22023');
 PERFORM pg_temp.expect_adoption_error('payslip-cutoff-after-report',jsonb_set(p,'{27,coveredThrough}','"2026-10-03"'),'23514');
END $$;
\echo PASS: 11 evidence/CAS failures; late-row failures roll back all earlier rows and receipts
SAVEPOINT wrong_source_company;
UPDATE private.payroll_balance_imports SET company_key='equipsy' WHERE id=pg_temp.adoption_identity(1);
SELECT pg_temp.expect_adoption_error('source-company',pg_temp.adoption_payload(),'55000');
ROLLBACK TO wrong_source_company;
SAVEPOINT wrong_stage_person;
UPDATE private.payroll_balance_import_stage_rows SET person_id=pg_temp.adoption_person(2) WHERE employee_name='Synthetic Adoption 1';
SELECT pg_temp.expect_adoption_error('stage-person',pg_temp.adoption_payload(),'55000');
ROLLBACK TO wrong_stage_person;
SAVEPOINT wrong_parser_fingerprint;
UPDATE private.payroll_balance_import_stage_rows SET source_sha256=repeat('f',64) WHERE employee_name='Synthetic Adoption 1';
SELECT pg_temp.expect_adoption_error('parser-fingerprint',pg_temp.adoption_payload(),'55000');
ROLLBACK TO wrong_parser_fingerprint;
SAVEPOINT wrong_archive_batch;
UPDATE private.payroll_balance_source_archives SET batch_id='99500000-0000-4000-8000-000000000002' WHERE id='99400000-0000-4000-8000-000000000001';
DO $$ DECLARE p jsonb; hash text; BEGIN
 SELECT rows INTO p FROM adoption_payload_frozen;
 SELECT pg_temp.adoption_hash(to_jsonb(a)) INTO hash FROM private.payroll_balance_source_archives a WHERE id='99400000-0000-4000-8000-000000000001';
 p:=jsonb_set(p,'{0,expectedArchiveHash}',to_jsonb(hash));
 PERFORM pg_temp.expect_adoption_error('archive-batch',p,'55000');
END $$;
ROLLBACK TO wrong_archive_batch;
\echo PASS: same-name identity does not cross source companies; stage identity and parser fingerprint enforced
DO $$ DECLARE app text; state text; denied boolean; BEGIN
 FOREACH app IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  ASSERT NOT has_function_privilege(app,'private.adopt_leave_bank_sources(text,text,jsonb)','EXECUTE');
  ASSERT NOT has_table_privilege(app,'private.leave_bank_sources','SELECT');
  ASSERT NOT has_table_privilege(app,'private.leave_bank_adoption_receipts','SELECT');
  denied:=false;
  BEGIN
   EXECUTE 'SET LOCAL ROLE '||quote_ident(app);
   PERFORM private.adopt_leave_bank_sources('synthetic-app-role',repeat('e',64),'[]');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  EXECUTE 'RESET ROLE';
  ASSERT denied, 'Actual application role invocation is denied';
 END LOOP;
END $$;
\echo PASS: all three application roles denied by real invocations and ACLs
CREATE TEMP TABLE adoption_receipt AS SELECT private.adopt_leave_bank_sources('synthetic-adoption-28',repeat('c',64),pg_temp.adoption_payload()) AS id;
DO $$ DECLARE n integer; bank jsonb; calculation jsonb; immutable boolean; receipt uuid; BEGIN
 SELECT id INTO receipt FROM adoption_receipt;
 ASSERT (SELECT count(*) FROM private.leave_bank_sources WHERE adoption_receipt_id=receipt)=28;
 ASSERT (SELECT source_count=28 AND operator_role='postgres' FROM private.leave_bank_adoption_receipts WHERE id=receipt);
 FOR n IN 2..27 LOOP
  bank:=private.leave_bank_basis(pg_temp.adoption_person(n),'annual');
  ASSERT (bank->>'bankHours')::numeric=100+n::numeric/100;
  ASSERT (bank->>'reportDate')::date='2026-10-01';
  ASSERT bank->>'coveredThrough' IS NULL;
  ASSERT bank->>'status'='coverage_unconfirmed';
  ASSERT bank->>'sourceKind'='payroll_report';
 END LOOP;
 ASSERT (SELECT company_key='mam' FROM public.internal_org_people WHERE id=pg_temp.adoption_person(27)), 'Current company preserved';
 ASSERT (SELECT company_key='equipsy' FROM private.payroll_balance_imports WHERE id=pg_temp.adoption_identity(27)), 'Stable source company preserved';
 ASSERT (SELECT count(*) FROM private.leave_bank_sources WHERE person_id=pg_temp.adoption_person(1) AND adoption_receipt_id=receipt)=2, 'Same person retains report fact and later payslip fact';
 ASSERT (SELECT hours=100.01 AND report_date='2026-10-01' AND covered_service_through IS NULL FROM private.leave_bank_sources WHERE person_id=pg_temp.adoption_person(1) AND source_kind='payroll_report'), 'Historical source row retained without inferred cutoff';
 ASSERT NOT EXISTS(SELECT 1 FROM private.leave_bank_sources WHERE person_id=pg_temp.adoption_person(28)), 'Person absent from source is not assigned zero';
 bank:=private.leave_bank_basis(pg_temp.adoption_person(1),'annual');
 ASSERT (bank->>'bankHours')::numeric=32.5545;
 ASSERT (bank->>'reportDate')::date='2026-10-02';
 ASSERT (bank->>'coveredThrough')::date='2026-10-02';
 ASSERT bank->>'status'='current';
 calculation:=private.calculate_leave_entitlement(pg_temp.adoption_person(1),'annual','2026-10-07');
 ASSERT abs((calculation->>'earned')::numeric-22.8/13)<0.000000000001;
 ASSERT abs((calculation->>'exactHours')::numeric-(32.5545+22.8/13))<0.000000000001;
 immutable:=false;
 BEGIN UPDATE private.leave_bank_sources SET hours=0 WHERE adoption_receipt_id=receipt; EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable;
 immutable:=false;
 BEGIN DELETE FROM private.leave_bank_sources WHERE adoption_receipt_id=receipt; EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable;
 immutable:=false;
 BEGIN UPDATE private.leave_bank_adoption_receipts SET source_count=1 WHERE id=receipt; EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable;
 immutable:=false;
 BEGIN DELETE FROM private.leave_bank_adoption_receipts WHERE id=receipt; EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable;
 immutable:=false;
 BEGIN UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id=pg_temp.adoption_person(1); EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable, 'Canonical source blocks older balance writer';
 immutable:=false;
 BEGIN DELETE FROM private.employee_annual_leave_balances WHERE person_id=pg_temp.adoption_person(1); EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable, 'Canonical source blocks legacy delete';
 immutable:=false;
 BEGIN
  PERFORM public.set_employee_annual_leave_balance(pg_temp.adoption_person(1),1,'2026-10-02',false);
 EXCEPTION WHEN SQLSTATE '55000' THEN immutable:=true; END;
 ASSERT immutable, 'Existing public balance setter also blocks stale legacy writes';
 BEGIN
  PERFORM private.adopt_leave_bank_sources('synthetic-adoption-28',repeat('d',64),pg_temp.adoption_payload());
  RAISE EXCEPTION 'Expected duplicate owner failure';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 BEGIN
  PERFORM private.adopt_leave_bank_sources('synthetic-adoption-different-owner',repeat('c',64),pg_temp.adoption_payload());
  RAISE EXCEPTION 'Expected duplicate plan failure';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 ASSERT (SELECT count(*) FROM private.leave_bank_sources WHERE adoption_receipt_id=receipt)=28;
 ASSERT (SELECT count(*) FROM private.leave_bank_adoption_receipts WHERE owner_key LIKE 'synthetic-adoption%')=1;
END $$;
\echo PASS: real adoption writes 28 exact banks; company move retained; payroll cutoff unknown; payslip cutoff known; immutable receipts/sources; duplicate plans rejected
DO $$ DECLARE current_hash text; item record; BEGIN
 FOR item IN SELECT * FROM adoption_baseline LOOP
  CASE item.name
  WHEN 'legacyAnnual' THEN SELECT pg_temp.adoption_hash(coalesce(jsonb_agg(to_jsonb(t) ORDER BY person_id),'[]')) INTO current_hash FROM private.employee_annual_leave_balances t;
  WHEN 'legacyPersonal' THEN SELECT pg_temp.adoption_hash(coalesce(jsonb_agg(to_jsonb(t) ORDER BY person_id),'[]')) INTO current_hash FROM private.employee_sick_leave_balances t;
  WHEN 'requests' THEN SELECT pg_temp.adoption_hash(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]')) INTO current_hash FROM public.leave_requests t;
  WHEN 'reviews' THEN SELECT pg_temp.adoption_hash(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]')) INTO current_hash FROM private.leave_accrual_day_reviews t;
  WHEN 'carry' THEN SELECT pg_temp.adoption_hash(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]')) INTO current_hash FROM private.payroll_carryforward_events t;
  END CASE;
  ASSERT current_hash=item.fingerprint, 'Adoption does not mutate legacy balance, personal balance, requests, usage reviews, or carryforward';
 END LOOP;
END $$;
\echo PASS: all five protected data inventories remain exact
ROLLBACK;
\echo PASS: entire synthetic adoption test rolled back

BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ DECLARE denied boolean:=false; BEGIN
 BEGIN
  PERFORM private.adopt_leave_bank_sources('synthetic-wrong-isolation',repeat('a',64),'[{}]');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 ASSERT denied, 'Source adoption rejects an isolation level that violates its lock/CAS contract';
END $$;
ROLLBACK;
\echo PASS: actual invocation requires READ COMMITTED isolation
