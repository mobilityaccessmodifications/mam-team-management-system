-- Runs AFTER every application migration; no replacement application functions.
begin;
do $$ declare obj record; signature text; role_name text; begin
  assert current_database() ~ '^mam_test_';
  assert inet_server_addr() is null, 'Replay must use a UNIX socket';
  assert current_setting('listen_addresses') = '', 'Replay must not listen on TCP';
  assert not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind='r' and not c.relrowsecurity
  ), 'Every application table must have RLS';
  foreach signature in array array[
    'public.openclaw_leave_v3_snapshot(text,uuid)',
    'public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text)',
    'public.openclaw_self_profile_snapshot()',
    'public.claim_leave_notification_outbox(uuid,integer)',
    'public.finish_leave_notification_outbox(uuid,uuid,boolean)',
    'public.resolve_portal_login_auth_email(text)'
  ] loop
    assert to_regprocedure(signature) is not null, 'Missing final RPC: ' || signature;
    assert has_function_privilege('service_role',signature,'execute'), 'Service RPC lost its grant: ' || signature;
    assert not has_function_privilege('anon',signature,'execute'), 'Anonymous service RPC: ' || signature;
    assert not has_function_privilege('authenticated',signature,'execute'), 'User-accessible service RPC: ' || signature;
  end loop;
  foreach signature in array array[
    'public.performance_review_workspace_for_preview(uuid)',
    'public.get_performance_review_document_for_preview(uuid,uuid)'
  ] loop
    assert to_regprocedure(signature) is not null, 'Missing Performance preview RPC: '||signature;
    assert has_function_privilege('authenticated',signature,'execute');
    assert not has_function_privilege('anon',signature,'execute');
    assert not has_function_privilege('service_role',signature,'execute');
    assert (select prosecdef and provolatile='s' and proconfig=array['search_path=""'] from pg_proc where oid=signature::regprocedure);
  end loop;
  foreach signature in array array[
    'private.performance_review_preview_actor(uuid)',
    'private.performance_review_preview_audience(private.performance_reviews,uuid,text)',
    'private.performance_review_preview_project(private.performance_reviews,uuid,text,uuid)'
  ] loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      assert not has_function_privilege(role_name,signature,'execute'), 'Direct preview helper access: '||role_name;
    end loop;
  end loop;
  foreach signature in array array[
    'public.performance_review_workspace_for_delegate(uuid)',
    'public.start_performance_review_for_delegate(uuid,uuid,uuid,text,text)',
    'public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)',
    'public.get_performance_review_operation_for_delegate(uuid,uuid,uuid)'
  ] loop
    assert to_regprocedure(signature) is not null, 'Missing Performance delegate RPC: '||signature;
    assert has_function_privilege('authenticated',signature,'execute');
    assert not has_function_privilege('anon',signature,'execute');
    assert not has_function_privilege('service_role',signature,'execute');
    assert (select prosecdef and proconfig=array['search_path=""'] and provolatile=case
      when proname in ('performance_review_workspace_for_delegate','get_performance_review_operation_for_delegate') then 's'::"char" else 'v'::"char" end
      from pg_proc where oid=signature::regprocedure);
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    assert not has_function_privilege(role_name,'private.performance_review_delegate_project(private.performance_reviews,uuid,uuid)','execute'), 'Direct delegate helper access: '||role_name;
  end loop;
  assert has_function_privilege('authenticated','public.patch_subscription_v1(uuid,bigint,jsonb)','execute');
  assert not has_function_privilege('anon','public.patch_subscription_v1(uuid,bigint,jsonb)','execute');
  assert to_regclass('private.portal_account_status_change_claims') is not null;
  assert to_regclass('private.leave_notification_outbox') is not null;
  assert to_regclass('private.subscription_register') is not null;
  foreach signature in array array['private.openclaw_phone_identities','private.openclaw_phone_identity_events'] loop
    assert to_regclass(signature) is not null, 'Missing verified phone registry: '||signature;
    assert (select relrowsecurity from pg_class where oid=to_regclass(signature)), 'Phone registry requires RLS';
    foreach role_name in array array['anon','authenticated','service_role'] loop
      assert not has_table_privilege(role_name,signature,'select,insert,update,delete'), 'Direct phone registry access: '||role_name;
    end loop;
  end loop;
  assert has_function_privilege('authenticated','public.set_openclaw_phone_identity(uuid,uuid,text,text)','execute');
  assert not has_function_privilege('anon','public.set_openclaw_phone_identity(uuid,uuid,text,text)','execute');
  assert not has_function_privilege('service_role','public.set_openclaw_phone_identity(uuid,uuid,text,text)','execute');
  assert exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='leave_requests' and column_name='hours');
  for obj in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relkind='r'
  loop
    assert not has_table_privilege('anon',obj.oid,'select,insert,update,delete'), 'Anonymous private table: '||obj.relname;
  end loop;
end $$;

-- Exercise effective grants AND authorization, rather than matching SQL text.
set local role anon;
do $$ begin
  begin
    perform public.openclaw_leave_v3_snapshot(repeat('a',64),null);
    raise exception 'anon accessed OpenClaw' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    assert (select count(*)=0 from public.profiles), 'Unauthenticated JWT saw profiles';
  exception when insufficient_privilege then null; end;
  begin
    perform public.performance_review_workspace_for_preview(gen_random_uuid());
    raise exception 'missing actor used Performance preview' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.get_performance_review_document_for_preview(gen_random_uuid(),gen_random_uuid());
    raise exception 'missing actor downloaded Performance preview' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.performance_review_workspace_for_delegate(gen_random_uuid());
    raise exception 'missing actor used Performance delegate' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.start_performance_review_for_delegate(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'2031','2031-12-31');
    raise exception 'missing actor started Performance delegate review' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.mutate_performance_review_for_delegate(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'manager:0:0','save_manager','{}');
    raise exception 'missing actor mutated Performance delegate review' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.get_performance_review_operation_for_delegate(gen_random_uuid(),gen_random_uuid(),null);
    raise exception 'missing actor read Performance delegate operation' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.patch_subscription_v1(gen_random_uuid(),1,'{"subscription_status":"paused"}');
    raise exception 'missing actor changed subscription' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.set_openclaw_phone_identity(gen_random_uuid(),null,'+61400000001','synthetic:unauthorised');
    raise exception 'missing actor enrolled phone identity' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set app_role='system_admin';
    raise exception 'users may write role column' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_leave_notification_outbox(null,1);
    raise exception 'user claimed notifications' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ begin
  -- The full chain must leave the explicit OpenClaw release switch off.
  begin
    perform public.openclaw_leave_v3_snapshot(repeat('b',64),null);
    raise exception 'OpenClaw release gate was enabled by replay' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
