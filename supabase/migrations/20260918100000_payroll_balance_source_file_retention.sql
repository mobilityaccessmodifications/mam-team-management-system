begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:payroll-balance-source-file-retention:20260918', 0)
  );
  if to_regclass('private.payroll_balance_import_batches') is null
    or to_regprocedure('private.has_payroll_balance_import_access_for(uuid)') is null then
    raise exception 'Payroll balance source archive prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Payroll exports are confidential source records. They stay in a dedicated
-- private bucket and are never exposed through a browser Storage policy.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'payroll-balance-archives',
  'payroll-balance-archives',
  false,
  500000,
  array[
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table private.payroll_balance_source_archives (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](csv|xlsx)$'
  ),
  original_file_name text not null check (
    char_length(original_file_name) between 1 and 180
    and original_file_name ~* '[.](csv|xlsx)$'
    and original_file_name !~ '[[:cntrl:]/\\]'
  ),
  content_type text not null check (
    content_type in (
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  ),
  size_bytes integer not null check (size_bytes between 1 and 500000),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid not null references auth.users (id) on delete restrict,
  batch_id uuid references private.payroll_balance_import_batches (id) on delete set null,
  parse_status text not null default 'pending' check (parse_status in ('pending', 'failed', 'parsed', 'deleted')),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  retain_until timestamptz not null default (now() + interval '30 days'),
  deleted_at timestamptz,
  check (retain_until >= created_at + interval '30 days'),
  check ((deleted_at is null) = (parse_status <> 'deleted'))
);

comment on table private.payroll_balance_source_archives is
  'Private raw payroll CSV/XLSX archive. Every prepared upload is retained for at least thirty days, including files whose parsing later fails; browser DTOs never expose this table or its Storage paths.';
comment on table private.payroll_balance_import_batches is
  'Server-parsed payroll upload batches. Raw bytes are retained separately in private Storage for at least thirty days; this table keeps bounded source metadata and reconciled rows.';

alter table private.payroll_balance_source_archives enable row level security;
revoke all on table private.payroll_balance_source_archives from public, anon, authenticated, service_role;

create index payroll_balance_source_archives_retention_idx
  on private.payroll_balance_source_archives (retain_until, id)
  where deleted_at is null;
create index payroll_balance_source_archives_batch_idx
  on private.payroll_balance_source_archives (batch_id)
  where batch_id is not null;

create function public.prepare_payroll_balance_source_archive(
  p_actor_user_id uuid,
  p_original_file_name text,
  p_content_type text,
  p_size_bytes integer,
  p_source_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid := gen_random_uuid();
  v_object_id uuid := gen_random_uuid();
  v_extension text;
  v_storage_path text;
begin
  if p_actor_user_id is null
    or not private.has_payroll_balance_import_access_for(p_actor_user_id) then
    raise exception 'You do not have permission to archive payroll balance files.'
      using errcode = '42501';
  end if;

  if p_original_file_name is null
    or char_length(p_original_file_name) not between 1 and 180
    or p_original_file_name !~* '[.](csv|xlsx)$'
    or p_original_file_name ~ '[[:cntrl:]/\\]'
    or p_size_bytes not between 1 and 500000
    or p_content_type is null
    or p_source_sha256 is null
    or p_source_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The payroll source file archive details are invalid.'
      using errcode = '22023';
  end if;

  v_extension := lower(substring(p_original_file_name from '[.]([^.]+)$'));
  if (v_extension = 'csv' and p_content_type <> 'text/csv')
    or (
      v_extension = 'xlsx'
      and p_content_type <> 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) then
    raise exception 'The payroll source file type is invalid.'
      using errcode = '22023';
  end if;

  v_storage_path := v_archive_id::text || '/' || v_object_id::text || '.' || v_extension;

  insert into private.payroll_balance_source_archives (
    id,
    storage_path,
    original_file_name,
    content_type,
    size_bytes,
    source_sha256,
    uploaded_by
  )
  values (
    v_archive_id,
    v_storage_path,
    p_original_file_name,
    p_content_type,
    p_size_bytes,
    p_source_sha256,
    p_actor_user_id
  );

  return jsonb_build_object(
    'archiveId', v_archive_id,
    'storagePath', v_storage_path
  );
end;
$$;

create function public.complete_payroll_balance_source_archive(
  p_actor_user_id uuid,
  p_archive_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_archive private.payroll_balance_source_archives%rowtype;
  v_metadata jsonb;
  v_size_text text;
  v_uploaded_at timestamptz := clock_timestamp();
begin
  select archive.*
  into v_archive
  from private.payroll_balance_source_archives archive
  where archive.id = p_archive_id
    and archive.uploaded_by = p_actor_user_id
    and archive.deleted_at is null
  for update;

  if not found then
    raise exception 'The payroll source archive could not be completed.'
      using errcode = '42501';
  end if;

  select object.metadata
  into v_metadata
  from storage.objects object
  where object.bucket_id = 'payroll-balance-archives'
    and object.name = v_archive.storage_path;

  if not found then
    raise exception 'The payroll source file upload was not found.'
      using errcode = 'P0002';
  end if;

  v_size_text := coalesce(v_metadata ->> 'size', '');
  if (
    case when v_size_text ~ '^[0-9]+$' then v_size_text::bigint else -1 end
  ) <> v_archive.size_bytes
    or lower(coalesce(v_metadata ->> 'mimetype', '')) <> v_archive.content_type then
    raise exception 'The archived payroll source file did not match its approved details.'
      using errcode = '22023';
  end if;

  if v_archive.uploaded_at is null then
    update private.payroll_balance_source_archives archive
    set uploaded_at = v_uploaded_at,
        retain_until = greatest(archive.retain_until, v_uploaded_at + interval '30 days')
    where archive.id = v_archive.id;
  end if;
end;
$$;

create function public.mark_payroll_balance_source_archives_failed(
  p_actor_user_id uuid,
  p_archive_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expected integer := cardinality(coalesce(p_archive_ids, array[]::uuid[]));
  v_updated integer;
begin
  if v_expected not between 1 and 4
    or v_expected <> (select count(distinct id) from unnest(p_archive_ids) item(id)) then
    raise exception 'The payroll source archive list is invalid.' using errcode = '22023';
  end if;

  update private.payroll_balance_source_archives archive
  set parse_status = 'failed'
  where archive.id = any(p_archive_ids)
    and archive.uploaded_by = p_actor_user_id
    and archive.uploaded_at is not null
    and archive.deleted_at is null;

  get diagnostics v_updated = row_count;
  if v_updated <> v_expected then
    raise exception 'The payroll source archives could not be updated.' using errcode = '42501';
  end if;
end;
$$;

create function public.link_payroll_balance_source_archives(
  p_actor_user_id uuid,
  p_archive_ids uuid[],
  p_batch_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch private.payroll_balance_import_batches%rowtype;
  v_expected integer := cardinality(coalesce(p_archive_ids, array[]::uuid[]));
  v_matching integer;
begin
  if v_expected not between 1 and 4
    or v_expected <> (select count(distinct id) from unnest(p_archive_ids) item(id)) then
    raise exception 'The payroll source archive list is invalid.' using errcode = '22023';
  end if;

  select batch.*
  into v_batch
  from private.payroll_balance_import_batches batch
  where batch.id = p_batch_id
    and batch.uploaded_by = p_actor_user_id;

  if not found then
    raise exception 'The payroll import batch could not be linked.' using errcode = '42501';
  end if;

  select count(*)
  into v_matching
  from private.payroll_balance_source_archives archive
  where archive.id = any(p_archive_ids)
    and archive.uploaded_by = p_actor_user_id
    and archive.uploaded_at is not null
    and archive.deleted_at is null
    and exists (
      select 1
      from jsonb_array_elements(v_batch.source_files) source
      where source ->> 'name' = archive.original_file_name
        and source ->> 'sha256' = archive.source_sha256
        and (source ->> 'sizeBytes')::integer = archive.size_bytes
    );

  if v_matching <> v_expected then
    raise exception 'The payroll source archives do not match this import batch.' using errcode = '22023';
  end if;

  update private.payroll_balance_source_archives archive
  set batch_id = v_batch.id,
      parse_status = 'parsed'
  where archive.id = any(p_archive_ids)
    and archive.uploaded_by = p_actor_user_id
    and archive.deleted_at is null;
end;
$$;

create function public.list_expired_payroll_balance_source_archives()
returns table (
  archive_id uuid,
  storage_path text,
  was_uploaded boolean
)
language sql
volatile
security definer
set search_path = ''
as $$
  select archive.id, archive.storage_path, archive.uploaded_at is not null
  from private.payroll_balance_source_archives archive
  where archive.deleted_at is null
    and archive.retain_until <= clock_timestamp()
  order by archive.retain_until, archive.id
  limit 50;
$$;

create function public.complete_payroll_balance_source_archive_deletion(
  p_archive_ids uuid[]
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if cardinality(coalesce(p_archive_ids, array[]::uuid[])) not between 1 and 50
    or cardinality(p_archive_ids) <> (select count(distinct id) from unnest(p_archive_ids) item(id)) then
    raise exception 'The payroll source archive deletion list is invalid.' using errcode = '22023';
  end if;

  update private.payroll_balance_source_archives archive
  set deleted_at = clock_timestamp(),
      parse_status = 'deleted'
  where archive.id = any(p_archive_ids)
    and archive.deleted_at is null
    and archive.retain_until <= clock_timestamp();

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.prepare_payroll_balance_source_archive(uuid, text, text, integer, text) is
  'Service-only upload plan for one private payroll source file. The row is created before Storage upload so even a later parser failure retains the object for at least thirty days.';
comment on function public.complete_payroll_balance_source_archive(uuid, uuid) is
  'Service-only completion that verifies private Storage size and type, then starts a fresh minimum thirty-day retention window.';
comment on function public.list_expired_payroll_balance_source_archives() is
  'Service-only bounded list of raw payroll source objects whose minimum thirty-day retention window has ended.';

revoke all on function public.prepare_payroll_balance_source_archive(uuid, text, text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_payroll_balance_source_archive(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_payroll_balance_source_archives_failed(uuid, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.link_payroll_balance_source_archives(uuid, uuid[], uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_expired_payroll_balance_source_archives()
  from public, anon, authenticated, service_role;
revoke all on function public.complete_payroll_balance_source_archive_deletion(uuid[])
  from public, anon, authenticated, service_role;

grant execute on function public.prepare_payroll_balance_source_archive(uuid, text, text, integer, text)
  to service_role;
grant execute on function public.complete_payroll_balance_source_archive(uuid, uuid)
  to service_role;
grant execute on function public.mark_payroll_balance_source_archives_failed(uuid, uuid[])
  to service_role;
grant execute on function public.link_payroll_balance_source_archives(uuid, uuid[], uuid)
  to service_role;
grant execute on function public.list_expired_payroll_balance_source_archives()
  to service_role;
grant execute on function public.complete_payroll_balance_source_archive_deletion(uuid[])
  to service_role;

commit;
