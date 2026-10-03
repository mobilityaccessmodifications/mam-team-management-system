begin;
set local search_path='';
set local lock_timeout='3s';
set local statement_timeout='75s';
do $operator_proof_before$
declare
  baseline text;
  collector text;
  definitions text[];
  expected jsonb;
  signature text;
  actual jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Concurrent purge; defer session-proof migration' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema,private.confirmed_test_identity_purges in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Exact protected-schema predecessor required' using errcode='55000';
  end if;
  select schema_hash into baseline from private.confirmed_test_purge_schema where singleton for update nowait;
  if private.confirmed_test_purge_schema_hash() is distinct from baseline
    or encode(sha256(convert_to(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'UTF8')),'hex')
      <> '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54' then
    raise exception 'Unreviewed protected-schema predecessor' using errcode='55000';
  end if;
  if to_regprocedure('private.verify_payroll_operator_session(uuid)') is not null
    or to_regprocedure('public.verify_current_payroll_operator_session()') is not null then
    raise exception 'Session proof already exists; read-only reconciliation required' using errcode='55000';
  end if;
  for signature,expected in select key,value from jsonb_each('{"private.payroll_closing_lock()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"bb684529912c708a04205df47e8b89dccc3bb06ba3d1cec908dc484d1701ced0","securityDefiner":true},"private.is_portal_account_admin()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"abf3859afab0412f48b0d6bbf8ddfbd500f00971bebd2f295e84bbd294b447ba","securityDefiner":true},"private.payroll_closing_immutable()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"11be86ce1c1df90c08ef68ab20a174105f81661e445df52c21433f552575e094","securityDefiner":true},"private.payroll_request_money(jsonb)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"82cc51f45ad281342bbd563a87642cdc591386cc14a99cbbcce574c1ac748fcc","securityDefiner":false},"public.can_import_payroll_balances()":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"1d35d10ac71a7848d39b425eac49577836fc0e3e9b7be86a328ffa25be405db9","securityDefiner":true},"private.payroll_comparison_only(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"c2ba637c9778e05821211019154ba88095dc04e4273be74dd7bb2afe6f7c713d","securityDefiner":true},"private.is_active_portal_account(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"74010df8b26b47824015fac948200decaa58ece32e39453dbe539df3f08f88a5","securityDefiner":true},"private.payroll_closing_assert_actor()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"46fedb5c96bd26289271fd8f0daf18453c028f1d0ee82afcfad08ebc6600895a","securityDefiner":true},"private.is_system_portal_account_admin()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"5bfe267f05d59c56ddb497788a91fe336f1aef90802dee581bac07a0e09ada77","securityDefiner":true},"private.payroll_closing_snapshot_guard()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"4e3e5456cd55475f72145dbfc800c0ead367092392ddb6b6dda27d3b478532a1","securityDefiner":true},"private.payroll_closing_fingerprint(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"fcb3cd13d50f90db2d48d99b2fe894a1e8a1d276acec44a89636e4ede393f664","securityDefiner":true},"private.payroll_retained_hours(uuid,text)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"20291b8a1c2d78212cc0a957dd95bef847d02404ecf2f51e42070b81fb3583eb","securityDefiner":true},"public.get_leave_priority_workspace(uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"14f3fab427dcf668cea958a12c5f63420a2a213a1f042e8ac96d33eb28c8010a","securityDefiner":true},"private.confirmed_test_purge_schema_hash()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54","securityDefiner":true},"private.payroll_request_fingerprint(jsonb)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"8484cb8932f3f62f9621f253f336c88ad023e639972a76251b4d859fb09578bf","securityDefiner":true},"private.has_payroll_balance_import_access()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"44817e23dac0540580ae5c4ff15f61596cacfd63a15c7085065da3b01c575530","securityDefiner":true},"private.payroll_carryforward_review_guard()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"119995d2c9ae476d30b7eda7fc5cc24a9c713613746e9bb43e67f01f6079680a","securityDefiner":true},"private.payroll_carryforward_request_guard()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"64723760a9656849c5c02e4ed71d96a3b09407b0d3f8d20bb3f8cd880c3dd4dd","securityDefiner":true},"public.reconcile_payroll_closing(text,jsonb)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"4d2b30bf9f95b65ecfb72b7e76190d9109211c67bba45d08aafec7337397b518","securityDefiner":true},"private.enforce_banked_annual_leave_request()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"1bb3697fa52dd3c7b7ad6edab3896c926ae6d91eb9d25fba9dc95a67a3ed057c","securityDefiner":true},"private.confirmed_test_purge_census(uuid,uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"3e22a29dd6f6c60828803afc1dbd74833552c8c72f44659bc0cb37c9298ae5e2","securityDefiner":true},"private.leave_payroll_balance_sufficient(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"c38b9655a39149fc1d8b6c4d1f538f1cca22cf248ea61c2b9ba18f0022c56814","securityDefiner":true},"private.payroll_request_hours_after(uuid,date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"3f4505db5271b025109f00cb7915435e852c5fa46fa20aabdd499e17786cf541","securityDefiner":true},"public.get_confirmed_test_identity_purge(uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"1368d80d28761e7cf7fbef42f7904d6a904958bc99168f1bb713965bcde37ac3","securityDefiner":true},"public.settle_payroll_carryforward(text,jsonb)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"7a610c4455c7d5190a3d2fe2eed32f7db03c8db3847c2b0dc0ca0f73ce0cd54c","securityDefiner":true},"private.project_annual_leave_balance(uuid,date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"ee185baa6a8dfa834b77cdfeb60339e70d39f42915ec00112142536126c4de4a","securityDefiner":true},"private.reject_retired_test_identity_reference()":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb","securityDefiner":true},"public.decide_leave_with_balance(uuid,text,text)":{"acl":"{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"d8de791bb59d7511ed7fc7a822c52a7b5c9323f37785bb165708a9d34d9639af","securityDefiner":true},"public.commit_payroll_balance_import(uuid,bigint)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"8afa261076d880d057abc3a1cc74140b94065c08ddcce771e6720a54018b7f81","securityDefiner":true},"private.confirmed_test_has_reference(jsonb,uuid[])":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"efa6a40e67ac616a36dd6820ad204e474277d54e175dff28891e9e11d8ba7094","securityDefiner":false},"private.calculate_employee_leave_accrual(uuid,date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"1006d839cb1f2019acea176d2b0e16ee6a0d923a81c9bdc0f46284797338b1ee","securityDefiner":true},"private.has_payroll_balance_import_access_for(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"86b8e54d28b3365808d9ac9e3d5a4e9145262f7f697f25979e243728bc4b0fd7","securityDefiner":true},"public.complete_confirmed_test_identity_purge(uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"c2c7a425a73ad12c093f10b9e2527e2bcd404c613fe2f408387e17e2da6c5186","securityDefiner":true},"public.preview_annual_leave_balance(uuid,date,uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"297e0f241dfcb7b592e98d0e91ca76649888bb391c0a6aa98ea54e08d6001b77","securityDefiner":true},"public.preview_payroll_closing_reconciliation(uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"25a70dc8133395f81a0b535190697f62078a32ca9711d4ce3a6bcaff50b575e2","securityDefiner":true},"private.approved_leave_hours_after(uuid,text[],date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"251bfea3140b47d8067928c2daf65801555b118a612c3cfa5989fae52141648b","securityDefiner":true},"private.confirmed_test_retained_leave_receipt(jsonb)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"09b0d3b2a30787f9e2cbbef1c5d2b4b41368d10b85faead97ef4672d7f2b691d","securityDefiner":true},"private.leave_accrual_request_fingerprint(uuid,date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"6cd5214494cfdca6e70517998c76b8297295951d5c048ce435392d9c17c8cc84","securityDefiner":true},"private.reconcile_payroll_balance_import_batch(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"f2c57a2bf1fbe01294ad228e00337c8c1f51673a2ccccc0ca9c818029ce42555","securityDefiner":true},"public.can_import_payroll_balances_for_preview(uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"0faa6cbe8b8c032ed0d25993433f5759d56dc7b158dfee99c1eb40b9223f0a03","securityDefiner":true},"private.payroll_balance_import_batch_projection(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"408ac43058f98096b845a1283d60309709b79e4c46815111665e40db02e36417","securityDefiner":true},"public.claim_confirmed_test_identity_auth_delete(uuid)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"c8b1235d105e225aa53ffb231cacd651f7273702a3462309d0a7c56e55edb5f6","securityDefiner":true},"private.payroll_request_unconsumed_hours(uuid,date,date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"89a010fb374fd93dff5e5e3a6f0be23039a8e3946c31189c71d1696d225375bf","securityDefiner":true},"public.set_employee_sick_leave_balance(uuid,numeric,date)":{"acl":"{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"81ccce13fb37d1bf5718627120155e6879d8d2319e293144cd075f5ebd2b0ea5","securityDefiner":true},"public.stage_payroll_balance_import(uuid,text,jsonb,jsonb)":{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"a2b05e9f238439a989dd57b34e8ce19b58ce349687f57a3f30adae33a1fe0457","securityDefiner":true},"public.get_leave_priority_workspace_before_carryforward(uuid)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"bf4994d3bfe0dd8a6fa6d05389b41d273cf59b03bf0541b0f83c212cbf3e73c1","securityDefiner":true},"private.project_annual_leave_balance_before_carryforward(uuid,date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"204ba442ebdbf785f79349f6f265389d1bfecba0035a8807362bc13320beb5b1","securityDefiner":true},"public.commit_payroll_balance_import_before_comparison(uuid,bigint)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"9212347194268006e426132d147dba5722fe185f14b397b86ec85d82b4d39a2c","securityDefiner":true},"public.set_employee_annual_leave_balance(uuid,numeric,date,boolean)":{"acl":"{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"4d022cbf672c497f677e527caabd2cc43220947ce1ef3c461def95755aedb830","securityDefiner":true},"private.approved_leave_hours_after_before_carryforward(uuid,text[],date)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"4f97d5808c0bcef94a31dd75a3c2a39df3288f44713b6064b8b2be05bd2196fd","securityDefiner":true},"public.stage_payroll_balance_import_before_comparison(uuid,text,jsonb,jsonb)":{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"65779a072a505f226ad9db43f5e1848cc2ecb09515058a60b1d2bfe8d51b45d9","securityDefiner":true},"public.preview_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"52c988842bce043fc8c857970eeb1ddd50e44ea4eec95bd400e74b5893f8c3ab","securityDefiner":true},"public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text)":{"acl":"{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"ba2a2a3fc4dcbab37ec9ed8d4d633f4017b9d014beaaa716980147057b9c2d8a","securityDefiner":true},"public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)":{"acl":"{postgres=X/postgres,authenticated=X/postgres}","owner":"postgres","config":["search_path=\"\""],"sha256":"07294ec1a4342ae89d4c83feb18f2f7f11f9492e2c3fc205ed0d2f364c0ef084","securityDefiner":true}}'::jsonb) loop
    select jsonb_build_object('sha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig)
      into actual from pg_proc p where p.oid=to_regprocedure(signature);
    if actual is distinct from expected then
      raise exception 'Original approved function changed (%)',signature using errcode='55000';
    end if;
  end loop;
  select prosrc into collector from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(sha256(convert_to(collector,'UTF8')),'hex') <> 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Protected-schema collector changed' using errcode='55000';
  end if;
  collector:=replace(collector,'select encode(extensions.digest(coalesce(string_agg(definition,E''\n'' order by definition),''''),''sha256''),''hex'')','select definition');
  execute 'select array_agg(definition order by definition collate "C") from ('||regexp_replace(collector,';[[:space:]]*$','')||') definitions' into definitions;
  create temporary table operator_proof_transition on commit drop as select
    baseline as schema_hash,collector as collector,definitions as definitions,NULL::text as after_hash,
    (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'UTF8')),'hex') from private.confirmed_test_identity_purges p) as receipts_hash,
    (select jsonb_build_object(
    'column_acls',(select coalesce(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attname,a.attacl::text) order by a.attrelid,a.attnum),'[]') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped and a.attacl is not null),
    'schema_acls',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl::text) order by nspname) from pg_namespace where nspname in ('public','private','storage','auth')),
    'default_acls',(select coalesce(jsonb_agg(to_jsonb(d) order by oid),'[]') from pg_default_acl d),
    'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid) from pg_roles))) as extra_catalog;
end $operator_proof_before$;

create function private.verify_payroll_operator_session(p_actor uuid) returns boolean
language plpgsql stable security definer set search_path='' as $operator_private$
declare
  claims jsonb;
  issued_at timestamptz;
  expires_at timestamptz;
begin
  claims := auth.jwt();
  if p_actor is null or auth.uid() is distinct from p_actor
    or claims->>'sub' is distinct from p_actor::text
    or claims->>'role' is distinct from 'authenticated'
    or auth.role() is distinct from 'authenticated'
    or claims->'is_anonymous' is distinct from 'false'::jsonb
    or jsonb_typeof(claims->'session_id') is distinct from 'string'
    or (claims->>'session_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(claims->'iat') is distinct from 'number'
    or jsonb_typeof(claims->'exp') is distinct from 'number'
    or (claims->>'iat') !~ '^-?(0|[1-9][0-9]*)$'
    or (claims->>'exp') !~ '^-?(0|[1-9][0-9]*)$'
    or (claims->>'iat')::numeric >= (claims->>'exp')::numeric then
    return false;
  end if;
  issued_at := to_timestamp((claims->>'iat')::double precision);
  expires_at := to_timestamp((claims->>'exp')::double precision);
  -- Retain the original native P0 assertion, not merely a capability check.
  perform private.payroll_closing_assert_actor();
  return exists (
    select 1 from auth.users u
    join public.profiles p on p.id = u.id
    join private.portal_account_admins a on a.auth_user_id = u.id
    join auth.sessions s on s.user_id = u.id
    where u.id = p_actor and s.id = (claims->>'session_id')::uuid
      and s.created_at <= issued_at and issued_at <= clock_timestamp()
      and clock_timestamp() < expires_at
      and (to_jsonb(u)->>'deleted_at') is null
      and (s.not_after is null or s.not_after > clock_timestamp())
      and a.revoked_at is null and p.account_status = 'active'
      and p.login_name is not null
      -- Raw timestamp: do not use the ordinary helper's second truncation.
      and p.credentials_valid_after <= issued_at
      and u.is_anonymous is false
      and (u.banned_until is null or u.banned_until <= clock_timestamp())
  );
exception when others then
  return false;
end;
$operator_private$;
revoke all on function private.verify_payroll_operator_session(uuid) from public,anon,authenticated,service_role;

create function public.verify_current_payroll_operator_session() returns boolean
language plpgsql stable security definer set search_path='' as $operator_public$
begin
  -- Opaque, immutable binding to the original approved operator, not a new
  -- selected profile or a caller-provided actor. No identity data is exported.
  if encode(sha256(convert_to(auth.jwt()->>'sub','UTF8')),'hex')
    is distinct from '43571e2b619180aa9a5e0dab8625b245b3659189231657cb0ad3d2f8e4741da0' then
    return false;
  end if;
  return private.verify_payroll_operator_session(auth.uid());
exception when others then
  return false;
end;
$operator_public$;
revoke all on function public.verify_current_payroll_operator_session() from public,anon,authenticated,service_role;
grant execute on function public.verify_current_payroll_operator_session() to authenticated;

do $operator_proof_after$
declare
  baseline record;
  definitions text[];
  added text[];
  normalized text[];
  next_hash text;
  entry record;
  expected_body text;
  expected_acl text;
begin
  select * into strict baseline from pg_temp.operator_proof_transition;
  for entry in select * from (values
    ('private.verify_payroll_operator_session(uuid)','
declare
  claims jsonb;
  issued_at timestamptz;
  expires_at timestamptz;
begin
  claims := auth.jwt();
  if p_actor is null or auth.uid() is distinct from p_actor
    or claims->>''sub'' is distinct from p_actor::text
    or claims->>''role'' is distinct from ''authenticated''
    or auth.role() is distinct from ''authenticated''
    or claims->''is_anonymous'' is distinct from ''false''::jsonb
    or jsonb_typeof(claims->''session_id'') is distinct from ''string''
    or (claims->>''session_id'') !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
    or jsonb_typeof(claims->''iat'') is distinct from ''number''
    or jsonb_typeof(claims->''exp'') is distinct from ''number''
    or (claims->>''iat'') !~ ''^-?(0|[1-9][0-9]*)$''
    or (claims->>''exp'') !~ ''^-?(0|[1-9][0-9]*)$''
    or (claims->>''iat'')::numeric >= (claims->>''exp'')::numeric then
    return false;
  end if;
  issued_at := to_timestamp((claims->>''iat'')::double precision);
  expires_at := to_timestamp((claims->>''exp'')::double precision);
  -- Retain the original native P0 assertion, not merely a capability check.
  perform private.payroll_closing_assert_actor();
  return exists (
    select 1 from auth.users u
    join public.profiles p on p.id = u.id
    join private.portal_account_admins a on a.auth_user_id = u.id
    join auth.sessions s on s.user_id = u.id
    where u.id = p_actor and s.id = (claims->>''session_id'')::uuid
      and s.created_at <= issued_at and issued_at <= clock_timestamp()
      and clock_timestamp() < expires_at
      and (to_jsonb(u)->>''deleted_at'') is null
      and (s.not_after is null or s.not_after > clock_timestamp())
      and a.revoked_at is null and p.account_status = ''active''
      and p.login_name is not null
      -- Raw timestamp: do not use the ordinary helper''s second truncation.
      and p.credentials_valid_after <= issued_at
      and u.is_anonymous is false
      and (u.banned_until is null or u.banned_until <= clock_timestamp())
  );
exception when others then
  return false;
end;
','{postgres=X/postgres}','9fb10ca7987f46b7ea4d5bbede378405f716ab202ab5e553d117fa2a6806a2a2'),
    ('public.verify_current_payroll_operator_session()','
begin
  -- Opaque, immutable binding to the original approved operator, not a new
  -- selected profile or a caller-provided actor. No identity data is exported.
  if encode(sha256(convert_to(auth.jwt()->>''sub'',''UTF8'')),''hex'')
    is distinct from ''43571e2b619180aa9a5e0dab8625b245b3659189231657cb0ad3d2f8e4741da0'' then
    return false;
  end if;
  return private.verify_payroll_operator_session(auth.uid());
exception when others then
  return false;
end;
','{postgres=X/postgres,authenticated=X/postgres}','e64e65cbe7c6e78f76c834dae7a843ebba1224144d58dc235ee495b66d2387fa')
  ) expected(signature,body,acl,sha256) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(entry.signature)
      and p.prosrc=entry.body and p.proowner=(select oid from pg_roles where rolname='postgres')
      and encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=entry.sha256
      and p.proacl::text=entry.acl and p.prosecdef and p.provolatile='s'
      and not p.proleakproof and p.proconfig=array['search_path=""']::text[]
      and p.prorettype='boolean'::regtype and p.prolang=(select oid from pg_language where lanname='plpgsql')) then
      raise exception 'New session-proof definition or permissions differ (%)',entry.signature using errcode='55000';
    end if;
  end loop;
  select array_agg(definition order by definition collate "C") into added from (
    select pg_get_functiondef(p.oid) as definition from pg_proc p where p.oid=any(array[
      'private.verify_payroll_operator_session(uuid)'::regprocedure,'public.verify_current_payroll_operator_session()'::regprocedure])
    union all
    select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from pg_proc p where p.oid=any(array[
      'private.verify_payroll_operator_session(uuid)'::regprocedure,'public.verify_current_payroll_operator_session()'::regprocedure])
  ) entries;
  if cardinality(added)<>4 then raise exception 'Exact two-function delta required' using errcode='55000'; end if;
  execute 'select array_agg(definition order by definition collate "C") from ('||regexp_replace(baseline.collector,';[[:space:]]*$','')||') definitions' into definitions;
  if (select count(*) from unnest(definitions) d where d=any(added))<>4 then
    raise exception 'Admitted metadata entries missing or duplicated' using errcode='55000';
  end if;
  select array_agg(d order by d collate "C") into normalized from unnest(definitions) d where not d=any(added);
  if normalized is distinct from baseline.definitions
    or (select jsonb_build_object(
    'column_acls',(select coalesce(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attname,a.attacl::text) order by a.attrelid,a.attnum),'[]') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped and a.attacl is not null),
    'schema_acls',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl::text) order by nspname) from pg_namespace where nspname in ('public','private','storage','auth')),
    'default_acls',(select coalesce(jsonb_agg(to_jsonb(d) order by oid),'[]') from pg_default_acl d),
    'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid) from pg_roles))) is distinct from baseline.extra_catalog
    or (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'UTF8')),'hex') from private.confirmed_test_identity_purges p)
      is distinct from baseline.receipts_hash then
    raise exception 'Unapproved catalog/security/receipt delta' using errcode='55000';
  end if;
  next_hash:=private.confirmed_test_purge_schema_hash();
  update private.confirmed_test_purge_schema set schema_hash=next_hash where singleton and schema_hash=baseline.schema_hash;
  if not found or private.confirmed_test_purge_schema_hash() is distinct from next_hash then
    raise exception 'Protected-schema transition CAS failed' using errcode='55000';
  end if;
  update pg_temp.operator_proof_transition set after_hash=next_hash;
end $operator_proof_after$;

-- The release envelope repeats complete schema/security/receipt checks after
-- ledger insertion and deferred-constraint draining. No business rows change.
commit;
