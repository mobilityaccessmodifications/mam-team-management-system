-- Synthetic acceptance tests; safe on the full local replay, changes rolled back.
begin;
do $$ begin
  assert current_database() ~ '^mam_test_', 'Disposable synthetic database required';
end $$;
create function pg_temp.expect_notification_error(p_sql text, p_state text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE %', p_state;
end;
$$;

do $$
declare
  role_name text; object_name text; signature text; privilege text;
begin
  foreach object_name in array array['notification_delivery_receipts','notification_delivery_control'] loop
    assert (select relrowsecurity from pg_class where oid = ('private.' || object_name)::regclass), 'RLS required';
    foreach role_name in array array['anon','authenticated','service_role'] loop
      foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        assert not has_table_privilege(role_name,'private.' || object_name,privilege), 'No table grants';
      end loop;
    end loop;
  end loop;
  for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.proname in
      ('reserve_notification_delivery','confirm_notification_delivery','notification_delivery_store_status') loop
    assert has_function_privilege('service_role',signature,'EXECUTE'), 'Service API grant required';
    foreach role_name in array array['anon','authenticated'] loop
      assert not has_function_privilege(role_name,signature,'EXECUTE'), 'Browser cannot invoke receipt API';
    end loop;
  end loop;
  for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname in
      ('notification_event_key_valid','notification_recipient_set','notification_provider_receipt_valid',
       'lock_notification_delivery_store','notification_delivery_rejection','minimize_notification_delivery_receipts',
       'import_notification_delivery_legacy','set_notification_delivery_ready') loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      assert not has_function_privilege(role_name,signature,'EXECUTE'), 'No integration/operator escalation';
    end loop;
  end loop;
  assert not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where n.nspname in ('public','private') and p.proname like '%notification_delivery%'
      and a.grantee=0 and a.privilege_type='EXECUTE'), 'No PUBLIC function grants';
end;
$$;
set local role anon;
select pg_temp.expect_notification_error('select public.notification_delivery_store_status()', '42501');
reset role;
set local role authenticated;
select pg_temp.expect_notification_error('select public.notification_delivery_store_status()', '42501');
reset role;
set local role service_role;
select pg_temp.expect_notification_error('select * from private.notification_delivery_receipts', '42501');
select pg_temp.expect_notification_error('select private.set_notification_delivery_ready(true)', '42501');
select pg_temp.expect_notification_error('select private.import_notification_delivery_legacy(''[]''::jsonb)', '42501');
select pg_temp.expect_notification_error('select private.minimize_notification_delivery_receipts()', '42501');
do $$ declare r jsonb; k text := 'payroll-comparison:00000000-0000-0000-0000-000000000001'; begin
  assert public.notification_delivery_store_status() = '{"version":1,"ready":false}'::jsonb;
  r := public.reserve_notification_delivery(k,'one@example.test','');
  assert r = jsonb_build_object('outcome','rejected','ok',false,'sent',false,'alreadySent',false,
    'eventKey',k,'rejectionCode','receipt-store-not-ready','reconciliationRequired',false);
  assert public.confirm_notification_delivery(k,gen_random_uuid(),'one@example.test','',
    '{"accepted":true,"messageId":null,"requestId":null,"statusCode":null}') = r;
end $$;
reset role;
do $$ begin assert not exists(select 1 from private.notification_delivery_receipts); end $$;
select pg_temp.expect_notification_error('select private.set_notification_delivery_ready(true)', '23514');
select pg_temp.expect_notification_error($q$update private.notification_delivery_control set legacy_import_count=0$q$, '23514');
select pg_temp.expect_notification_error($q$update private.notification_delivery_control set legacy_import_count=-1,
 legacy_import_sha256=repeat('a',64),legacy_imported_at=clock_timestamp()$q$, '23514');
select pg_temp.expect_notification_error($q$update private.notification_delivery_control set legacy_import_count=0,
 legacy_import_sha256=repeat('A',64),legacy_imported_at=clock_timestamp()$q$, '23514');
-- A verified empty frozen snapshot is a valid cutover input.
update private.notification_delivery_control set legacy_import_count=0,
  legacy_import_sha256=repeat('a',64),legacy_imported_at=clock_timestamp();
select private.set_notification_delivery_ready(true);
select pg_temp.expect_notification_error($q$update private.notification_delivery_control set legacy_import_count=null,
 legacy_import_sha256=null,legacy_imported_at=null$q$, '23514');
select private.set_notification_delivery_ready(false);

-- RLS still denies reads if a table grant is accidentally added later.
grant usage on schema private to anon;
grant select on private.notification_delivery_control to anon;
set local role anon;
do $$ begin assert not exists(select 1 from private.notification_delivery_control); end $$;
reset role;
revoke select on private.notification_delivery_control from anon;

select private.import_notification_delivery_legacy('[
 {"eventKey":"leave:00000000-0000-0000-0000-000000000001:leave-submitted:aaaaaaaaaaaaaaaaaaaaaaaa","state":"legacy_sent","at":1790070000123},
 {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000002","state":"legacy_unknown","at":1790070000456}
]');
select pg_temp.expect_notification_error($q$select private.import_notification_delivery_legacy('[
 {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000002","state":"legacy_sent","at":1790070000456}]')$q$, '40001');
select pg_temp.expect_notification_error($q$select private.import_notification_delivery_legacy('[
 {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000002","state":"legacy_unknown","at":1790070000457}]')$q$, '40001');
select pg_temp.expect_notification_error($q$select private.import_notification_delivery_legacy('[
 {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000003","state":"legacy_sent","at":1790070000123},
 {"eventKey":"invalid","state":"legacy_sent","at":1790070000123}]')$q$, '22023');
select pg_temp.expect_notification_error($q$select private.import_notification_delivery_legacy('[
 {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000003","state":null,"at":1790070000123}]')$q$, '22023');
select pg_temp.expect_notification_error($q$select private.import_notification_delivery_legacy('[
 {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000003","state":"legacy_sent"}]')$q$, '22023');
do $$ declare bad jsonb; entry jsonb; begin
  foreach bad in array array['null'::jsonb,'"NaN"'::jsonb,'"Infinity"'::jsonb,'"1790070000123"'::jsonb,
    '-1'::jsonb,'253402300800000'::jsonb,'8640000000000000'::jsonb,'true'::jsonb,'{}'::jsonb] loop
    entry := jsonb_build_array(jsonb_build_object('eventKey','payroll-comparison:00000000-0000-0000-0000-000000000003',
      'state','legacy_sent','at',bad));
    perform pg_temp.expect_notification_error(format('select private.import_notification_delivery_legacy(%L::jsonb)',entry),'22023');
  end loop;
  -- Valid edges are checked inside a subtransaction so fixture counts stay fixed.
  begin
    perform private.import_notification_delivery_legacy('[
      {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000003","state":"legacy_sent","at":0},
      {"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000004","state":"legacy_unknown","at":253402300799999}]');
    assert (select created_at = to_timestamp(0) from private.notification_delivery_receipts where event_key like '%000003');
    assert (select created_at = to_timestamp(253402300799999::numeric / 1000) from private.notification_delivery_receipts where event_key like '%000004');
    raise exception 'rollback synthetic time edges' using errcode='P0002';
  exception when no_data_found then null;
  end;
end $$;
do $$ begin
  assert not exists(select 1 from private.notification_delivery_receipts where event_key like '%000003'), 'Import batch atomic';
  assert private.import_notification_delivery_legacy('[{"eventKey":"payroll-comparison:00000000-0000-0000-0000-000000000002","state":"legacy_unknown","at":1790070000456}]')
    = '{"inserted":0,"existing":1}'::jsonb;
  assert (select created_at = to_timestamp(1790070000456::numeric / 1000)
    from private.notification_delivery_receipts where event_key='payroll-comparison:00000000-0000-0000-0000-000000000002'), 'Original millis retained';
  assert private.notification_delivery_store_status() = '{"version":1,"ready":false}'::jsonb;
  assert (select legacy_import_sha256 is null from private.notification_delivery_control), 'New import invalidates old proof';
end $$;
update private.notification_delivery_control set legacy_import_count=2,
  legacy_import_sha256=repeat('b',64),legacy_imported_at=clock_timestamp();
select private.set_notification_delivery_ready(true);
select pg_temp.expect_notification_error('select private.import_notification_delivery_legacy(''[]''::jsonb)', '55000');

do $$
declare
  k text := 'leave:00000000-0000-0000-0000-000000000001:leave-submitted:bbbbbbbbbbbbbbbbbbbbbbbb';
  legacy text := 'leave:00000000-0000-0000-0000-000000000001:leave-submitted:aaaaaaaaaaaaaaaaaaaaaaaa';
  r jsonb; confirmation jsonb; token uuid;
  proof jsonb := '{"accepted":true,"messageId":"synthetic-message","requestId":"synthetic-request","statusCode":202}';
begin
  set local role service_role;
  r := public.reserve_notification_delivery(k,'one@example.test','',legacy);
  assert r->>'rejectionCode' = 'legacy-receipt-reconciliation';
  assert r->>'receiptEventKey' = legacy and not r ? 'actualRecipient' and not r ? 'deliveryToken';
  r := public.reserve_notification_delivery(replace(k,'bbbbbbbbbbbbbbbbbbbbbbbb','cccccccccccccccccccccccc'),'two@example.test','',legacy);
  assert r->>'rejectionCode' = 'legacy-receipt-reconciliation', 'Both split copies blocked';
  r := public.reserve_notification_delivery(legacy,'one@example.test','');
  assert r->>'rejectionCode' = 'receipt-evidence-unavailable';
  r := public.reserve_notification_delivery('payroll-comparison:00000000-0000-0000-0000-000000000002','one@example.test','');
  assert r->>'rejectionCode' = 'receipt-delivery-unknown';
  -- Synthetic prior own receipt precedes the shared key. No send occurs here.
  r := public.reserve_notification_delivery(k,' Two@Example.test,one@example.test,ONE@example.test ',' CC@example.test ');
  assert r->>'outcome' = 'send' and (select count(*) from jsonb_object_keys(r)) = 3;
  token := (r->>'deliveryToken')::uuid;
  r := public.reserve_notification_delivery(k,'one@example.test,two@example.test','cc@example.test');
  assert r->>'rejectionCode' = 'delivery-in-flight' and r->>'reconciliationRequired' = 'false';
  assert not r ? 'deliveryToken' and not r ? 'actualRecipient', 'Lost reserve response never regrants';
  r := public.reserve_notification_delivery(k,'replacement@example.test','cc@example.test');
  assert r->>'rejectionCode' = 'receipt-recipient-mismatch' and not r ? 'actualRecipient';
  r := public.confirm_notification_delivery(k,gen_random_uuid(),'one@example.test,two@example.test','cc@example.test',proof);
  assert r->>'rejectionCode' = 'receipt-token-mismatch';
  r := public.confirm_notification_delivery(k,token,'replacement@example.test','cc@example.test',proof);
  assert r->>'rejectionCode' = 'receipt-recipient-mismatch';
  r := public.confirm_notification_delivery(k,token,'one@example.test,two@example.test','replacement@example.test',proof);
  assert r->>'rejectionCode' = 'receipt-recipient-mismatch';
  reset role;
  update private.notification_delivery_receipts set created_at = clock_timestamp()-interval '21 minutes' where event_key=k;
  set local role service_role;
  r := public.reserve_notification_delivery(k,'one@example.test,two@example.test','cc@example.test');
  assert r->>'rejectionCode' = 'receipt-delivery-unknown' and r->>'reconciliationRequired' = 'true';
  assert not r ? 'deliveryToken';
  confirmation := public.confirm_notification_delivery(k,token,'one@example.test,two@example.test','cc@example.test',proof);
  assert confirmation = jsonb_build_object('ok',true,'sent',true,'alreadySent',false,'eventKey',k,
    'actualRecipient','one@example.test,two@example.test','actualCcRecipients','cc@example.test','providerReceipt',proof), 'Late confirm';
  assert public.confirm_notification_delivery(k,token,'two@example.test,one@example.test','cc@example.test',proof) = confirmation, 'Exact repeat idempotent';
  r := public.confirm_notification_delivery(k,token,'one@example.test,two@example.test','cc@example.test',proof || '{"messageId":"different"}');
  assert r->>'rejectionCode' = 'receipt-confirmation-mismatch' and r->'providerReceipt' = proof;
  r := public.reserve_notification_delivery(k,'one@example.test,two@example.test','cc@example.test',legacy);
  assert r->>'outcome' = 'duplicate' and r->>'alreadySent' = 'true' and r->>'sent' = 'false', 'Own sent precedence';
  assert r->'providerReceipt' = proof and r->>'actualRecipient' = 'one@example.test,two@example.test';
  r := public.reserve_notification_delivery(k,'replacement@example.test','cc@example.test');
  assert r->>'rejectionCode' = 'receipt-recipient-mismatch' and r->>'actualRecipient' = 'one@example.test,two@example.test';
  r := public.reserve_notification_delivery(k,'one@example.test,two@example.test','replacement@example.test');
  assert r->>'rejectionCode' = 'receipt-recipient-mismatch' and r->>'actualCcRecipients' = 'cc@example.test';
  reset role;
  update private.notification_delivery_receipts set sent_at=clock_timestamp()-interval '91 days' where event_key=k;
  assert private.minimize_notification_delivery_receipts(array[k,legacy]) = 0, 'Protect current/legacy key';
  assert private.minimize_notification_delivery_receipts() = 1;
  assert exists(select 1 from private.notification_delivery_receipts where event_key=k and state='sent_tombstone'
    and delivery_token is null and recipient is null and cc is null and provider_receipt is null);
  set local role service_role;
  r := public.reserve_notification_delivery(k,'replacement@example.test','');
  assert r->>'rejectionCode' = 'receipt-evidence-unavailable' and not r ? 'actualRecipient';
  r := public.confirm_notification_delivery(k,token,'one@example.test,two@example.test','cc@example.test',proof);
  assert r->>'rejectionCode' = 'receipt-evidence-unavailable', 'Cannot resurrect expired evidence';
  reset role;
end;
$$;

-- Seven leave events plus two payroll families accept the generic UUID shape.
do $$ declare event_name text; k text; r jsonb; invalid text; bad jsonb; begin
  set local role service_role;
  foreach event_name in array array['leave-submitted','leave-approved','leave-declined',
    'leave-cancelled','leave-conditionally-approved','leave-reminder','team-birthday'] loop
    k := 'leave:00000000-0000-0000-0000-000000000009:' || event_name || ':dddddddddddddddddddddddd';
    r := public.reserve_notification_delivery(k,'a@example.test','');
    assert r->>'outcome' = 'send';
  end loop;
  k := 'payroll-balance:00000000-0000-0000-0000-000000000009:2026-09';
  assert public.reserve_notification_delivery(k,'a@example.test','')->>'outcome' = 'send';
  foreach invalid in array array['','bad',' a@example.test,','a@example.test;;b@example.test','a@example.test;bad',
    E'a@example.test\nBcc:other@example.test','Name <a@example.test>',repeat('a',255)||'@example.test',
    repeat('a@example.test,',32)||'b@example.test',repeat('a',8193)] loop
    perform pg_temp.expect_notification_error(format('select public.reserve_notification_delivery(%L,%L,%L)',k,invalid,''),'22023');
  end loop;
  foreach invalid in array array['invalid',replace(k,'2026-09','2026-13'),replace(k,'payroll-balance','other'),
    'leave:00000000-0000-0000-0000-000000000009:not-an-event:dddddddddddddddddddddddd'] loop
    perform pg_temp.expect_notification_error(format('select public.reserve_notification_delivery(%L,%L,%L)',invalid,'a@example.test',''),'22023');
  end loop;
  foreach bad in array array[
    'null'::jsonb,'{}'::jsonb,'{"accepted":false,"messageId":null,"requestId":null,"statusCode":202}'::jsonb,
    '{"accepted":true,"messageId":null,"requestId":null,"statusCode":400}'::jsonb,
    '{"accepted":true,"messageId":null,"requestId":null,"statusCode":199}'::jsonb,
    '{"accepted":true,"messageId":null,"requestId":null,"statusCode":202.5}'::jsonb,
    '{"accepted":true,"messageId":null,"requestId":null,"statusCode":"202"}'::jsonb,
    '{"accepted":true,"messageId":"","requestId":null,"statusCode":202}'::jsonb,
    '{"accepted":true,"messageId":null,"requestId":null,"statusCode":202,"body":"forbidden"}'::jsonb,
    jsonb_build_object('accepted',true,'messageId',E'id\r\n','requestId',null,'statusCode',202),
    jsonb_build_object('accepted',true,'messageId',repeat('x',1025),'requestId',null,'statusCode',202)] loop
    perform pg_temp.expect_notification_error(format('select public.confirm_notification_delivery(%L,%L,%L,%L,%L::jsonb)',
      k,gen_random_uuid(),'a@example.test','',bad),'22023');
  end loop;
  reset role;
  assert exists(select 1 from private.notification_delivery_receipts where event_key=k and state='processing'), 'Bad provider retains processing';
  assert private.minimize_notification_delivery_receipts()=0, 'Processing retained';
end $$;

-- No 5000-key cache ceiling. Import remains evidence-less and does not reset rows.
select private.set_notification_delivery_ready(false);
select private.import_notification_delivery_legacy((select jsonb_agg(jsonb_build_object(
  'eventKey','payroll-comparison:10000000-0000-0000-0000-' || lpad(i::text,12,'0'),'state','legacy_sent','at',1790070000123))
  from generate_series(1,5001) i));
update private.notification_delivery_control set legacy_import_count=5003,
  legacy_import_sha256=repeat('c',64),legacy_imported_at=clock_timestamp();
select private.set_notification_delivery_ready(true);
set local role service_role;
do $$ begin
  assert public.reserve_notification_delivery('payroll-comparison:ffffffff-ffff-ffff-ffff-ffffffffffff','a@example.test','')->>'outcome' = 'send';
end $$;
reset role;
-- The actual retention predicate can use its purpose-built partial index.
set local enable_seqscan = off;
do $$ declare plan json; begin
  execute $q$explain (format json) select event_key from private.notification_delivery_receipts
    where state='sent' and sent_at < '2020-01-01'::timestamptz
    order by sent_at,event_key limit 1000$q$ into plan;
  assert plan::text like '%notification_delivery_retention_idx%', 'Retention index usable';
end $$;
rollback;
\echo PASS notification SQL contract, privileges, retention and legacy tests
