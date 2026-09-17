begin;

insert into auth.users (id)
values ('10000000-0000-4000-8000-000000000001');

do $$
declare
  plan jsonb;
  archive_id uuid;
  storage_path text;
  v_batch_id uuid := '20000000-0000-4000-8000-000000000001';
begin
  plan := public.prepare_payroll_balance_source_archive(
    '10000000-0000-4000-8000-000000000001',
    'MAM balances.csv',
    'text/csv',
    128,
    repeat('a', 64)
  );
  archive_id := (plan ->> 'archiveId')::uuid;
  storage_path := plan ->> 'storagePath';

  assert storage_path ~ '^[0-9a-f-]+/[0-9a-f-]+[.]csv$',
    'Archive path is opaque and extension constrained';

  insert into storage.objects (bucket_id, name, metadata)
  values (
    'payroll-balance-archives',
    storage_path,
    jsonb_build_object('size', '128', 'mimetype', 'text/csv')
  );

  perform public.complete_payroll_balance_source_archive(
    '10000000-0000-4000-8000-000000000001',
    archive_id
  );

  assert (
    select uploaded_at is not null
      and retain_until >= uploaded_at + interval '30 days'
    from private.payroll_balance_source_archives archive
    where archive.id = archive_id
  ), 'Successful upload starts a fresh minimum thirty-day retention window';

  perform public.mark_payroll_balance_source_archives_failed(
    '10000000-0000-4000-8000-000000000001',
    array[archive_id]
  );
  assert (
    select parse_status = 'failed'
    from private.payroll_balance_source_archives archive
    where archive.id = archive_id
  ), 'Parser failure retains the archive record';

  insert into private.payroll_balance_import_batches (id, source_files, uploaded_by)
  values (
    v_batch_id,
    jsonb_build_array(jsonb_build_object(
      'name', 'MAM balances.csv',
      'sha256', repeat('a', 64),
      'sizeBytes', 128
    )),
    '10000000-0000-4000-8000-000000000001'
  );

  perform public.link_payroll_balance_source_archives(
    '10000000-0000-4000-8000-000000000001',
    array[archive_id],
    v_batch_id
  );
  assert (
    select parse_status = 'parsed' and archive.batch_id = v_batch_id
    from private.payroll_balance_source_archives archive
    where archive.id = archive_id
  ), 'Parsed archive links only to its matching batch';

  assert not exists (
    select 1 from public.list_expired_payroll_balance_source_archives()
  ), 'Archive is not eligible before thirty days';

  update private.payroll_balance_source_archives archive
  set created_at = clock_timestamp() - interval '32 days',
      uploaded_at = clock_timestamp() - interval '31 days',
      retain_until = clock_timestamp() - interval '1 day'
  where archive.id = archive_id;

  assert (
    select count(*) = 1
    from public.list_expired_payroll_balance_source_archives()
  ), 'Archive becomes eligible only after its retention date';

  assert public.complete_payroll_balance_source_archive_deletion(array[archive_id]) = 1,
    'Server cleanup finalises exactly one due archive';
  assert (
    select deleted_at is not null and parse_status = 'deleted'
    from private.payroll_balance_source_archives archive
    where archive.id = archive_id
  ), 'Cleanup records deletion without exposing the archive';
end;
$$;

do $$
begin
  assert (select not public from storage.buckets where id = 'payroll-balance-archives'),
    'Payroll archive bucket remains private';
  assert not has_table_privilege('authenticated', 'private.payroll_balance_source_archives', 'SELECT'),
    'Authenticated browsers cannot query archive metadata';
  assert not has_function_privilege(
    'authenticated',
    'public.prepare_payroll_balance_source_archive(uuid,text,text,integer,text)',
    'EXECUTE'
  ), 'Authenticated browsers cannot prepare raw archive paths';
  assert has_function_privilege(
    'service_role',
    'public.prepare_payroll_balance_source_archive(uuid,text,text,integer,text)',
    'EXECUTE'
  ), 'Only the trusted server role receives archive preparation access';
end;
$$;

rollback;
