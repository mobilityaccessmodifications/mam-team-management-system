-- Exact synthetic CI readback in the same connection as the original migration.
\set ON_ERROR_STOP on
do $$ declare plan jsonb; item jsonb; receipt jsonb; begin
  assert current_database() ~ '^mam_test_' and auth.uid() is null;
  select p.plan into strict plan from ci_role_release_plan p;
  assert plan->>'synthetic_ci_only'='true';
  for item in select value from jsonb_array_elements(plan->'targets') loop
    assert (select app_role=item->>'after_role' from public.profiles where id=(item->>'user_id')::uuid);
    assert (select raw_app_meta_data->>'org_role'=item->>'after_role' from auth.users where id=(item->>'user_id')::uuid);
  end loop;
  for item in select value from jsonb_array_elements(plan->'p0') loop
    assert (select to_jsonb(p)=item from public.profiles p where id=(item->>'id')::uuid), 'P0 complete row unchanged';
  end loop;
  select statements[1]::jsonb into strict receipt from supabase_migrations.schema_migrations where version='20261006103000';
  assert receipt->>'actor_kind'='release_migration' and receipt->>'database_actor'='postgres';
  assert receipt->>'target_count'='6' and receipt->>'admin_count'='4' and receipt->>'account_count'='2';
  assert receipt->>'plan_sha256'=encode(extensions.digest(plan::text,'sha256'),'hex');
  assert (select count(*)=6 from private.employee_directory_audit_events e
    where e.id in (select value::bigint from jsonb_array_elements_text(receipt->'directory_audit_ids'))
      and e.actor_user_id is null and e.event_type='updated' and e.changed_fields=array['app_role']);
end $$;
select 'PASS: synthetic CI six-role conversion, complete P0 rows, six audits and unique migration-actor receipt';
