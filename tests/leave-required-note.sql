\set ON_ERROR_STOP on
DO $$ BEGIN
 ASSERT current_database() ~ '^mam_test_', 'Owned synthetic database required';
 ASSERT inet_server_addr() IS NULL AND current_setting('listen_addresses')='';
END $$;
BEGIN;
\ir sql-test-auth.sql
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT ('e1000000-0000-4000-8000-00000000000'||n)::uuid,'required-note-'||n||'@example.test',now() FROM generate_series(1,4) n;
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
SELECT ('e1000000-0000-4000-8000-00000000000'||n)::uuid,'Synthetic Note '||n,
 CASE n WHEN 1 THEN 'system_admin' WHEN 3 THEN 'manager' ELSE 'employee' END,
 'required-note-'||n,now()-interval '1 day' FROM generate_series(1,4) n;
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
SELECT id,full_name,'mam','Synthetic role',id,CASE WHEN app_role='employee' THEN 'e1000000-0000-4000-8000-000000000003'::uuid END
FROM public.profiles WHERE login_name LIKE 'required-note-%' ORDER BY app_role<>'manager';
INSERT INTO private.employee_directory_details(person_id,employment_type)
SELECT id,'full_time' FROM public.profiles WHERE login_name LIKE 'required-note-%';
SELECT pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE r uuid; note text; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
 SELECT id INTO r FROM public.submit_my_leave_request('Sick leave',day,day,NULL,NULL,'Synthetic employee note');
 ASSERT r IS NOT NULL, 'Nonblank self note must still submit';
 FOREACH note IN ARRAY ARRAY[NULL::text,'',' ',E'\t\r\n',U&'\00a0\2003\202f\feff'] LOOP
  BEGIN
   PERFORM public.submit_my_leave_request('Sick leave',day,day,NULL,NULL,note);
   RAISE EXCEPTION 'RN01: blank self note was accepted' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN
   ASSERT SQLERRM='Add a leave note before submitting this request.';
  END;
 END LOOP;
 BEGIN
  PERFORM public.submit_my_leave_request('Sick leave',day,day);
  RAISE EXCEPTION 'RN01: missing self note was accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Add a leave note before submitting this request.'; END;
END $$;
RESET ROLE;
\echo PASS RN01 self missing null empty whitespace denied and nonblank accepted
DO $$ DECLARE actor uuid; note text; r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
 FOREACH actor IN ARRAY ARRAY['e1000000-0000-4000-8000-000000000001'::uuid,'e1000000-0000-4000-8000-000000000003'::uuid] LOOP
  PERFORM pg_temp.set_test_actor(actor);
  EXECUTE 'set local role authenticated';
  SELECT id INTO r FROM public.submit_selected_employee_leave_request('e1000000-0000-4000-8000-000000000002','Sick leave',day,day,NULL,NULL,'Synthetic on-behalf note');
  ASSERT r IS NOT NULL;
  FOREACH note IN ARRAY ARRAY[NULL::text,'',' ',E'\t\n',U&'\00a0\2003\feff'] LOOP
   BEGIN
    PERFORM public.submit_selected_employee_leave_request('e1000000-0000-4000-8000-000000000002','Sick leave',day,day,NULL,NULL,note);
    RAISE EXCEPTION 'RN02: blank on-behalf note was accepted' USING ERRCODE='ZX001';
   EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Add a leave note before submitting this request.'; END;
  END LOOP;
  EXECUTE 'reset role';
 END LOOP;
 PERFORM pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000004');
 EXECUTE 'set local role authenticated';
 BEGIN
  PERFORM public.submit_selected_employee_leave_request('e1000000-0000-4000-8000-000000000002','Sick leave',day,day,NULL,NULL,'Synthetic forbidden note');
  RAISE EXCEPTION 'RN02: unauthorized employee gained submission' USING ERRCODE='ZX001';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 EXECUTE 'reset role';
END $$;
\echo PASS RN02 authorized P0 and manager on-behalf require notes and unauthorized employee denied
SELECT pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE k uuid:=gen_random_uuid(); r uuid; replay uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
 BEGIN
  PERFORM public.submit_leave_request_once(k,NULL,'Sick leave',day,day);
  RAISE EXCEPTION 'RN03: new idempotent missing-note submission was accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Add a leave note before submitting this request.'; END;
 SELECT id INTO r FROM public.submit_leave_request_once(k,NULL,'Sick leave',day,day,NULL,NULL,repeat('x',2000));
 SELECT id INTO replay FROM public.submit_leave_request_once(k,NULL,'Sick leave',day,day,NULL,NULL,repeat('x',2000));
 ASSERT replay=r;
 BEGIN
  PERFORM public.submit_leave_request_once(k,NULL,'Sick leave',day,day,NULL,NULL,'Changed note');
  RAISE EXCEPTION 'RN03: changed note reused committed key' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='This submission was already used for different details.'; END;
 BEGIN
  PERFORM public.submit_my_leave_request('Sick leave',day,day,NULL,NULL,repeat('x',2001));
  RAISE EXCEPTION 'RN03: note limit bypassed' USING ERRCODE='ZX001';
 EXCEPTION WHEN string_data_right_truncation THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 ASSERT (SELECT count(*)=1 FROM private.leave_submission_receipts WHERE actor_user_id='e1000000-0000-4000-8000-000000000002');
 ASSERT NOT EXISTS(SELECT 1 FROM public.leave_requests WHERE employee_person_id::text LIKE 'e1000000-%' AND coalesce(reason,'') !~ '[^[:space:]]');
END $$;
\echo PASS RN03 new idempotent failures leave no receipt valid retry is unique and size limit unchanged
SELECT pg_temp.set_test_actor('e1000000-0000-4000-8000-000000000001');
SET LOCAL ROLE authenticated;
SELECT public.set_openclaw_phone_identity('e1000000-0000-4000-8000-000000000002',NULL,'+61400000002','synthetic:required-note') IS NOT NULL;
RESET ROLE;
UPDATE private.openclaw_leave_release_gate SET enabled=true WHERE singleton;
CREATE FUNCTION pg_temp.required_note_bridge(note text,day date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p uuid:='e1000000-0000-4000-8000-000000000002'; snapshot jsonb; employee jsonb; draft jsonb; packet jsonb; identity jsonb;
 key text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'); t bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 snapshot:=public.openclaw_leave_v3_snapshot(key,NULL);
 SELECT item INTO STRICT employee FROM jsonb_array_elements(snapshot->'rows') item WHERE item->>'personId'=p::text;
 identity:=jsonb_build_object('account','synthetic','sender',employee->>'phone','session','required-note');
 draft:=jsonb_build_object('id',gen_random_uuid(),'consentVersion',3,'identity',identity,'personId',p,'userId',employee->>'userId','phoneIdentityVersion',employee->>'phoneIdentityVersion',
 'employmentType',employee->>'employmentType','fullName',employee->>'fullName','issuedAt',t,'expiresAt',t+600000,'summary','Synthetic note boundary','digest',encode(sha256(convert_to('Synthetic note boundary','UTF8')),'hex'),
 'fields',jsonb_build_object('leaveType','Sick leave','startDate',day,'endDate',day,'startTime',NULL,'endTime',NULL,'employeeNote',note));
 packet:=identity||jsonb_build_object('version',3,'channel','whatsapp','eventId',gen_random_uuid(),'operation','confirm','payload',jsonb_build_object('draftToken','synthetic-token','shownMessageId','synthetic-receipt','replyToMessageId',NULL,'text','Confirm'));
 RETURN public.openclaw_leave_v3_submit(key,repeat('b',64),snapshot->>'fingerprint',packet,p,draft,encode(sha256(convert_to('synthetic-token','UTF8')),'hex'));
END $$;
SET LOCAL ROLE service_role;
DO $$ DECLARE note text; day date:=(current_date+28)-(extract(isodow FROM current_date+28)::integer-1); BEGIN
 FOREACH note IN ARRAY ARRAY[NULL::text,'',' ',E'\t\n',U&'\00a0\2003\feff'] LOOP
  BEGIN
   PERFORM pg_temp.required_note_bridge(note,day);
   RAISE EXCEPTION 'RN04: native assistant accepted blank note' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Add a leave note before submitting this request.'; END;
 END LOOP;
 ASSERT pg_temp.required_note_bridge('Synthetic native assistant note',day)->>'code'='submitted';
END $$;
RESET ROLE;
DO $$ BEGIN
 ASSERT (SELECT count(*)=1 FROM private.openclaw_leave_receipts WHERE body->>'personId'='e1000000-0000-4000-8000-000000000002');
 ASSERT (SELECT count(*)=1 FROM private.openclaw_leave_drafts WHERE body->>'personId'='e1000000-0000-4000-8000-000000000002');
 ASSERT NOT has_function_privilege('authenticated','public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text)','execute');
 ASSERT NOT has_function_privilege('anon','public.submit_leave_request_once(uuid,uuid,text,date,date,time,time,text)','execute');
END $$;
\echo PASS RN04 native assistant service submit enforces note with atomic failures and existing ACLs
ROLLBACK;
