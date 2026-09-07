begin;

-- Repair installations missing the previously released private evidence API.
-- Do not replay its obsolete leave-workspace projection.
do $repair$
begin
  if to_regprocedure('public.prepare_my_leave_request_attachment_upload(uuid,text,text,bigint)') is null then
    execute $evidence$
-- Keep the original evidence bucket private. The application never creates a
-- public URL or exposes Storage object paths in its leave workspace DTOs.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'leave-evidence',
  'leave-evidence',
  false,
  5242880,
  array[
    'application/pdf',
    'image/heic',
    'image/heif',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The pre-existing attachment metadata table remains the durable record. It
-- is deliberately not exposed through PostgREST; the narrowly scoped RPCs
-- below return a safe metadata DTO only after current access is re-checked.
alter table public.leave_request_attachments enable row level security;
alter table public.leave_request_attachments force row level security;

create table private.leave_attachment_upload_intents (
  storage_path text primary key
    check (char_length(storage_path) between 38 and 500),
  leave_request_id uuid not null references public.leave_requests (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id) on delete restrict,
  file_name text not null
    check (
      char_length(file_name) between 1 and 255
      and file_name !~ '[/\\]'
    ),
  mime_type text not null
    check (mime_type in (
      'application/pdf',
      'image/heic',
      'image/heif',
      'image/jpeg',
      'image/png',
      'image/webp'
    )),
  size_bytes bigint not null check (size_bytes between 1 and 5242880),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > created_at),
  check (storage_path like leave_request_id::text || '/%')
);

create index leave_attachment_upload_intents_request_expiry_idx
  on private.leave_attachment_upload_intents (leave_request_id, expires_at);

alter table private.leave_attachment_upload_intents enable row level security;
revoke all on table private.leave_attachment_upload_intents from public, anon, authenticated;

-- This is a deliberately minimal anti-abuse/audit record. It survives an
-- intent discard or expiry so an actor cannot manufacture unbounded private
-- objects by repeatedly reserving, uploading and abandoning paths. It stores
-- neither a file name, Storage path, MIME type, byte count nor file content.
create table private.leave_attachment_upload_attempts (
  id uuid primary key default gen_random_uuid(),
  attempted_by uuid not null references public.profiles (id) on delete restrict,
  leave_request_id uuid not null references public.leave_requests (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);

create index leave_attachment_upload_attempts_actor_created_idx
  on private.leave_attachment_upload_attempts (attempted_by, created_at desc);
create index leave_attachment_upload_attempts_created_idx
  on private.leave_attachment_upload_attempts (created_at);

alter table private.leave_attachment_upload_attempts enable row level security;
revoke all on table private.leave_attachment_upload_attempts from public, anon, authenticated;

comment on table private.leave_attachment_upload_attempts is
  'Private rolling upload-plan quota/audit data. It retains only actor ID, leave request ID and time for 35 days; it never stores a file name, Storage path, MIME type, byte count or content.';

-- An active linked employee may add a new file to their own current request.
-- A real System Admin may do the same while testing an employee through
-- Change Profile; the request ID is still re-authorised server-side and the
-- immutable upload actor remains the real System Admin account.
create function private.can_add_my_leave_request_attachment(p_leave_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_leave_request_id is not null
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_current_portal_access()
    and (
      private.current_active_portal_employee_id() is not null
      or (
        private.is_portal_account_admin()
        and exists (
          select 1
          from public.profiles profile
          where profile.id = (select auth.uid())
            and profile.app_role = 'system_admin'
            and profile.login_name is not null
            and profile.account_status = 'active'
        )
      )
    )
    and exists (
      select 1
      from public.leave_requests request
      where request.id = p_leave_request_id
        and (
          request.user_id = (select auth.uid())
          or (
            private.is_portal_account_admin()
            and exists (
              select 1
              from public.profiles profile
              where profile.id = (select auth.uid())
                and profile.app_role = 'system_admin'
                and profile.login_name is not null
                and profile.account_status = 'active'
            )
          )
        )
        and request.status in ('submitted', 'approved')
    );
$$;

comment on function private.can_add_my_leave_request_attachment(uuid) is
  'Authorizes an active linked employee for their own current request, or a real System Admin exercising Change Profile without impersonating the employee.';

-- This broader predicate applies only to already registered metadata/files.
-- Owners retain access to their historical evidence; current reviewers and HR
-- retain only the same request-level access that protects leave details.
create function private.can_view_leave_request_attachment(p_attachment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_attachment_id is not null
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_current_portal_access()
    and exists (
      select 1
      from public.leave_request_attachments attachment
      join public.leave_requests request
        on request.id = attachment.leave_request_id
      where attachment.id = p_attachment_id
        and (
          (
            request.user_id = (select auth.uid())
            and private.current_active_portal_employee_id() is not null
          )
          or private.can_review_leave_request(request.id)
        )
    );
$$;

comment on function private.can_view_leave_request_attachment(uuid) is
  'Authorizes only the owning active employee, a current request reviewer, or HR to read private leave attachment metadata or bytes.';

-- Storage policies cannot safely query private tables directly as the caller.
-- These small security-definer predicates provide the intended policy checks
-- without granting browser roles any table access or file listing capability.
create function private.can_insert_leave_attachment_storage_object(
  p_bucket_id text,
  p_storage_path text
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select p_bucket_id = 'leave-evidence'
    and p_storage_path is not null
    and (select auth.uid()) is not null
    and exists (
      select 1
      from private.leave_attachment_upload_intents intent
      where intent.storage_path = p_storage_path
        and intent.uploaded_by = (select auth.uid())
        and intent.expires_at > clock_timestamp()
        and private.can_add_my_leave_request_attachment(intent.leave_request_id)
    );
$$;

drop policy if exists leave_attachments_insert_owner on public.leave_request_attachments;
drop policy if exists leave_attachments_select_reviewer on public.leave_request_attachments;
drop policy if exists leave_evidence_insert_owner on storage.objects;
drop policy if exists leave_evidence_select_reviewer on storage.objects;
drop policy if exists leave_evidence_select_authorized_request_participant on storage.objects;

create policy leave_evidence_insert_planned_owner
  on storage.objects for insert
  to authenticated
  with check (
    private.can_insert_leave_attachment_storage_object(bucket_id, name)
  );

-- A browser first receives one opaque, short-lived path for one validated
-- file. The intent prevents arbitrary object names from being written to the
-- private bucket and serializes the per-request attachment cap.
create function public.prepare_my_leave_request_attachment_upload(
  p_request_id uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint
)
returns table (
  storage_path text,
  file_name text,
  mime_type text,
  size_bytes bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role = 'system_admin'
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_request public.leave_requests%rowtype;
  v_file_name text := nullif(btrim(p_file_name), '');
  v_mime_type text := lower(nullif(btrim(p_mime_type), ''));
  v_extension text;
  v_existing_count integer;
  v_intent_count integer;
  v_actor_attempt_count integer;
  v_global_attempt_count integer;
  v_storage_path text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    ) then
    raise exception 'An active linked portal account is required to attach a supporting file.'
      using errcode = '42501';
  end if;

  if p_request_id is null
    or v_file_name is null
    or char_length(v_file_name) > 255
    or v_file_name ~ '[/\\]'
    or v_file_name ~ '[[:cntrl:]]'
    or v_mime_type is null
    or v_mime_type not in (
      'application/pdf',
      'image/heic',
      'image/heif',
      'image/jpeg',
      'image/png',
      'image/webp'
    )
    or p_size_bytes is null
    or p_size_bytes < 1
    or p_size_bytes > 5242880 then
    raise exception 'Choose a PDF or supported image up to 5 MB.' using errcode = '22023';
  end if;

  -- Lock the request before calculating remaining slots, so concurrent tabs
  -- cannot allocate more than ten active/registered files for one request.
  select request.*
  into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or (
      v_request.user_id is distinct from v_actor_user_id
      and not v_actor_is_system_admin
    )
    or v_request.status not in ('submitted', 'approved') then
    raise exception 'This supporting file cannot be attached to that leave request.'
      using errcode = '42501';
  end if;

  -- Serialize the rolling quota across requests and browser tabs. The per-
  -- account cap permits the normal ten-file request plus reasonable retries;
  -- the portal-wide cap remains below one cleanup run's object capacity.
  perform pg_advisory_xact_lock(739110, 19);

  select count(*)::integer
  into v_actor_attempt_count
  from private.leave_attachment_upload_attempts attempt
  where attempt.attempted_by = v_actor_user_id
    and attempt.created_at > clock_timestamp() - interval '24 hours';

  select count(*)::integer
  into v_global_attempt_count
  from private.leave_attachment_upload_attempts attempt
  where attempt.created_at > clock_timestamp() - interval '24 hours';

  if v_actor_attempt_count >= 15 or v_global_attempt_count >= 750 then
    -- Deliberately do not reveal whether the actor or the portal-wide cap was
    -- reached, nor any history/count that could expose other employee use.
    raise exception 'Supporting-file uploads are temporarily limited. Please try again later or contact HR.'
      using errcode = '22023';
  end if;

  delete from private.leave_attachment_upload_intents intent
  where intent.leave_request_id = v_request.id
    and intent.expires_at <= clock_timestamp();

  select count(*)::integer
  into v_existing_count
  from public.leave_request_attachments attachment
  where attachment.leave_request_id = v_request.id;

  select count(*)::integer
  into v_intent_count
  from private.leave_attachment_upload_intents intent
  where intent.leave_request_id = v_request.id
    and intent.expires_at > clock_timestamp();

  if v_existing_count + v_intent_count >= 10 then
    raise exception 'A leave request can have up to 10 supporting files.' using errcode = '22023';
  end if;

  insert into private.leave_attachment_upload_attempts (
    attempted_by,
    leave_request_id
  )
  values (
    v_actor_user_id,
    v_request.id
  );

  v_extension := case v_mime_type
    when 'application/pdf' then '.pdf'
    when 'image/heic' then '.heic'
    when 'image/heif' then '.heif'
    when 'image/jpeg' then '.jpg'
    when 'image/png' then '.png'
    when 'image/webp' then '.webp'
  end;
  v_storage_path := v_request.id::text || '/' || gen_random_uuid()::text || v_extension;

  insert into private.leave_attachment_upload_intents (
    storage_path,
    leave_request_id,
    uploaded_by,
    file_name,
    mime_type,
    size_bytes,
    expires_at
  )
  values (
    v_storage_path,
    v_request.id,
    v_actor_user_id,
    v_file_name,
    v_mime_type,
    p_size_bytes,
    clock_timestamp() + interval '20 minutes'
  );

  return query
  select v_storage_path, v_file_name, v_mime_type, p_size_bytes;
end;
$$;

comment on function public.prepare_my_leave_request_attachment_upload(uuid, text, text, bigint) is
  'Creates one opaque twenty-minute Storage upload intent for the authenticated owner or a real System Admin testing Change Profile.';

comment on table private.leave_attachment_upload_intents is
  'Short-lived upload plans. Expired plans are removed during a later prepare for the same request. A browser-abandoned uploaded object remains inaccessible because no Storage select policy exists; the CRON_SECRET-protected server cleanup route removes eligible orphans through the Storage API, never direct SQL deletion from storage.objects.';

-- A client calls this only after an upload or completion failure. Clearing the
-- intent immediately releases the attachment slot so the employee can retry;
-- it intentionally does not expose a Storage delete policy. If bytes were
-- already written, they remain inaccessible orphaned data for the staged
-- server-side Storage cleanup route. Downloads remain forced, private and
-- allowlisted; this release does not claim to provide malware scanning.
create function public.discard_my_leave_request_attachment_upload(
  p_storage_path text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role = 'system_admin'
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_intent private.leave_attachment_upload_intents%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    )
    or p_storage_path is null
    or char_length(p_storage_path) > 500 then
    raise exception 'This supporting file upload cannot be cleared.' using errcode = '42501';
  end if;

  select intent.*
  into v_intent
  from private.leave_attachment_upload_intents intent
  where intent.storage_path = p_storage_path
  for update;

  if not found
    or v_intent.uploaded_by is distinct from v_actor_user_id
    or not private.can_add_my_leave_request_attachment(v_intent.leave_request_id) then
    raise exception 'This supporting file upload cannot be cleared.' using errcode = '42501';
  end if;

  delete from private.leave_attachment_upload_intents intent
  where intent.storage_path = v_intent.storage_path;
end;
$$;

comment on function public.discard_my_leave_request_attachment_upload(text) is
  'Releases only the authenticated actor''s failed private attachment upload intent so the selected file can be retried. It never grants Storage object deletion.';

-- Commit only a planned object whose Storage metadata agrees with the server
-- validated intent. The client cannot choose a target request, saved name,
-- MIME type, size or object path at completion time.
create function public.complete_my_leave_request_attachment_upload(
  p_storage_path text
)
returns table (
  id uuid,
  leave_request_id uuid,
  file_name text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role = 'system_admin'
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_intent private.leave_attachment_upload_intents%rowtype;
  v_request public.leave_requests%rowtype;
  v_object_metadata jsonb;
  v_object_size_text text;
  v_attachment public.leave_request_attachments%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    )
    or p_storage_path is null
    or char_length(p_storage_path) > 500 then
    raise exception 'This supporting file could not be attached. Refresh and try again.'
      using errcode = '42501';
  end if;

  select intent.*
  into v_intent
  from private.leave_attachment_upload_intents intent
  where intent.storage_path = p_storage_path
  for update;

  if not found
    or v_intent.uploaded_by is distinct from v_actor_user_id
    or v_intent.expires_at <= clock_timestamp() then
    raise exception 'This supporting file could not be attached. Refresh and try again.'
      using errcode = '42501';
  end if;

  select request.*
  into v_request
  from public.leave_requests request
  where request.id = v_intent.leave_request_id
  for update;

  if not found
    or (
      v_request.user_id is distinct from v_actor_user_id
      and not v_actor_is_system_admin
    )
    or v_request.status not in ('submitted', 'approved') then
    raise exception 'This supporting file could not be attached. Refresh and try again.'
      using errcode = '42501';
  end if;

  select object.metadata
  into v_object_metadata
  from storage.objects object
  where object.bucket_id = 'leave-evidence'
    and object.name = v_intent.storage_path;

  if not found then
    raise exception 'The supporting file upload was not found. Please try again.'
      using errcode = '42501';
  end if;

  v_object_size_text := coalesce(v_object_metadata ->> 'size', '');
  if (
    case
      when v_object_size_text ~ '^[0-9]+$' then v_object_size_text::bigint
      else -1
    end
  ) <> v_intent.size_bytes
    or lower(coalesce(v_object_metadata ->> 'mimetype', '')) <> v_intent.mime_type then
    raise exception 'The uploaded file did not match the approved file details.'
      using errcode = '22023';
  end if;

  insert into public.leave_request_attachments (
    leave_request_id,
    uploaded_by,
    storage_path,
    file_name,
    mime_type,
    size_bytes
  )
  values (
    v_intent.leave_request_id,
    v_actor_user_id,
    v_intent.storage_path,
    v_intent.file_name,
    v_intent.mime_type,
    v_intent.size_bytes
  )
  returning * into v_attachment;

  delete from private.leave_attachment_upload_intents intent
  where intent.storage_path = v_intent.storage_path;

  -- Retain only the fact of the update, never a sensitive file name or path.
  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_request.id,
    v_actor_user_id,
    'updated',
    'Supporting file added.'
  );

  return query
  select
    v_attachment.id,
    v_attachment.leave_request_id,
    v_attachment.file_name,
    v_attachment.mime_type,
    v_attachment.size_bytes,
    v_attachment.created_at;
end;
$$;

comment on function public.complete_my_leave_request_attachment_upload(text) is
  'Registers one successfully uploaded planned file after re-checking the current owner or System Admin actor, request state and Storage metadata.';

-- Attachment metadata has no object path in its browser projection. The caller
-- must already be able to see the relevant leave request; peers never receive
-- it through the availability calendar or this function.
create function public.list_leave_workspace_attachments()
returns table (
  id uuid,
  leave_request_id uuid,
  file_name text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access() then
    raise exception 'An active portal account is required to view leave attachments.'
      using errcode = '42501';
  end if;

  if not private.is_internal_org_hr()
    and private.current_active_portal_employee_id() is null then
    raise exception 'An active linked employee account is required to view leave attachments.'
      using errcode = '42501';
  end if;

  return query
  select
    attachment.id,
    attachment.leave_request_id,
    attachment.file_name,
    attachment.mime_type,
    attachment.size_bytes,
    attachment.created_at
  from public.leave_request_attachments attachment
  where private.can_view_leave_request_attachment(attachment.id)
  order by attachment.created_at asc, attachment.id;
end;
$$;

comment on function public.list_leave_workspace_attachments() is
  'Returns safe metadata for attachments on leave requests visible to the current employee, reviewer or HR. Storage paths are never returned.';

-- The browser-facing RPC returns a boolean only. The authenticated Next.js
-- route then uses its server-only admin client to read the Storage path after
-- this user-scoped check succeeds, so no browser RPC can return an object path.
create function public.can_download_leave_request_attachment(
  p_attachment_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or not private.can_view_leave_request_attachment(p_attachment_id) then
    return false;
  end if;

  return exists (
    select 1
    from public.leave_request_attachments attachment
    where attachment.id = p_attachment_id
  );
end;
$$;

comment on function public.can_download_leave_request_attachment(uuid) is
  'Returns only whether the current user may download a private leave attachment. The server route reads the Storage target separately with its server-only admin client after this check; no browser RPC returns an object path.';

-- These maintenance RPCs grant EXECUTE only to the native service_role. This
-- avoids depending on a JWT-shaped `auth.role()` when the app uses Supabase's
-- current `sb_secret_` API-key transport. The scheduled server route removes
-- the returned paths through the Storage API; this function only lists up to
-- one bounded batch that is old enough and not protected by a durable
-- attachment row or a currently valid upload intent. The two-hour grace
-- window is deliberately longer than the twenty-minute upload intent.
create function public.list_stale_leave_attachment_orphans()
returns table (storage_path text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select object.name
  from storage.objects object
  where object.bucket_id = 'leave-evidence'
    -- Delete only paths issued by the upload-intent RPC. This prevents a
    -- future unrelated object in the existing private bucket being removed.
    and object.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|heic|heif|jpg|png|webp)$'
    and object.created_at <= clock_timestamp() - interval '2 hours'
    and not exists (
      select 1
      from public.leave_request_attachments attachment
      where attachment.storage_path = object.name
    )
    and not exists (
      select 1
      from private.leave_attachment_upload_intents intent
      where intent.storage_path = object.name
        and intent.expires_at > clock_timestamp()
    )
  order by object.created_at, object.name
  limit 100;
end;
$$;

comment on function public.list_stale_leave_attachment_orphans() is
  'Server-only maintenance projection for one bounded batch. It returns only two-hour-old generated paths with no registered attachment and no unexpired intent; caller must delete through the Storage API.';

create function public.prune_expired_leave_attachment_upload_intents()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.leave_attachment_upload_intents intent
  where intent.expires_at <= clock_timestamp();

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.prune_expired_leave_attachment_upload_intents() is
  'Server-only cleanup of expired private upload-intent rows. It never deletes Storage objects.';

create function public.prune_expired_leave_attachment_upload_attempts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.leave_attachment_upload_attempts attempt
  where attempt.created_at < clock_timestamp() - interval '35 days';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.prune_expired_leave_attachment_upload_attempts() is
  'Server-only retention cleanup of minimal private upload-plan quota/audit rows older than 35 days.';

-- Extend the existing private leave DTO with one database-derived control
-- flag. It is false for reviewers/HR accessing someone else’s request and for
-- cancelled/declined history; React never determines this boundary itself.
revoke all on table public.leave_request_attachments from anon, authenticated;

revoke all on function private.can_add_my_leave_request_attachment(uuid)
  from public, anon, authenticated;
revoke all on function private.can_view_leave_request_attachment(uuid)
  from public, anon, authenticated;
revoke all on function private.can_insert_leave_attachment_storage_object(text, text)
  from public, anon, authenticated;
revoke all on function public.prepare_my_leave_request_attachment_upload(uuid, text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.discard_my_leave_request_attachment_upload(text)
  from public, anon, authenticated;
revoke all on function public.complete_my_leave_request_attachment_upload(text)
  from public, anon, authenticated;
revoke all on function public.list_leave_workspace_attachments()
  from public, anon, authenticated;
revoke all on function public.can_download_leave_request_attachment(uuid)
  from public, anon, authenticated;
revoke all on function public.list_stale_leave_attachment_orphans()
  from public, anon, authenticated;
revoke all on function public.prune_expired_leave_attachment_upload_intents()
  from public, anon, authenticated;
revoke all on function public.prune_expired_leave_attachment_upload_attempts()
  from public, anon, authenticated;

-- This private predicate is invoked by Storage RLS itself. It exposes only a
-- boolean and is not a metadata or file-listing interface. Downloading always
-- goes through the authenticated server route and a short-lived signed URL.
grant execute on function private.can_insert_leave_attachment_storage_object(text, text)
  to authenticated;
grant execute on function public.prepare_my_leave_request_attachment_upload(uuid, text, text, bigint)
  to authenticated;
grant execute on function public.discard_my_leave_request_attachment_upload(text)
  to authenticated;
grant execute on function public.complete_my_leave_request_attachment_upload(text)
  to authenticated;
grant execute on function public.list_leave_workspace_attachments()
  to authenticated;
grant execute on function public.can_download_leave_request_attachment(uuid)
  to authenticated;
grant execute on function public.list_stale_leave_attachment_orphans()
  to service_role;
grant execute on function public.prune_expired_leave_attachment_upload_intents()
  to service_role;
grant execute on function public.prune_expired_leave_attachment_upload_attempts()
  to service_role;
$evidence$;
  end if;
end;
$repair$;


-- A coverage approval can remain pending for payroll balance confirmation.
-- Keep the underlying request submitted until a final approval so existing
-- payroll consumers cannot mistake a conditional approval for paid leave.
create table private.leave_balance_approvals (
  request_id uuid primary key references public.leave_requests(id) on delete cascade,
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now()
);
alter table private.leave_balance_approvals enable row level security;
revoke all on private.leave_balance_approvals from public, anon, authenticated;

create table private.employee_annual_leave_balances (
  person_id uuid primary key references public.internal_org_people(id) on delete cascade,
  hours numeric(9,2) not null check (hours between -10000 and 100000),
  as_of date not null,
  is_example boolean not null default true,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now()
);
alter table private.employee_annual_leave_balances enable row level security;
revoke all on private.employee_annual_leave_balances from public, anon, authenticated;

create table private.annual_leave_balance_history (
  id bigint generated always as identity primary key,
  person_id uuid not null references public.internal_org_people(id),
  hours numeric(9,2) not null,
  as_of date not null,
  is_example boolean not null,
  actor_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table private.annual_leave_balance_history enable row level security;
revoke all on private.annual_leave_balance_history from public, anon, authenticated;

alter table public.leave_requests add column submitted_by uuid references public.profiles(id);
alter table public.leave_requests add column evidence_due_date date;

create function private.can_submit_team_leave(p_person_id uuid, p_actor uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select p_actor is not null and private.is_active_portal_account(p_actor)
    and exists (
      select 1 from public.internal_org_people employee
      join public.profiles actor on actor.id = p_actor
      left join lateral private.resolve_internal_org_employee_manager(employee.id) manager on true
      left join public.internal_org_people manager_person on manager_person.id = manager.manager_id
      where employee.id = p_person_id and employee.is_active and employee.node_kind = 'person'
        and employee.auth_user_id is distinct from p_actor
        and (actor.app_role = 'system_admin'
          or (actor.app_role = 'manager' and manager_person.auth_user_id = p_actor))
    );
$$;
revoke all on function private.can_submit_team_leave(uuid,uuid) from public, anon, authenticated;

create function private.set_leave_submission_details()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.record_origin <> 'historical_import' then
    new.submitted_by := auth.uid();
    if new.request_type_label = 'Sick leave' then
      new.evidence_due_date := new.end_date + (8 - extract(isodow from new.end_date)::integer);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.set_leave_submission_details() from public, anon, authenticated;
create trigger leave_submission_details before insert on public.leave_requests
for each row execute function private.set_leave_submission_details();

update public.leave_requests set evidence_due_date=end_date+(8-extract(isodow from end_date)::integer)
where record_origin='portal' and request_type_label='Sick leave' and status in ('submitted','approved') and evidence_due_date is null;

-- Retain the established validation, duration, reviewer snapshot and audit
-- implementation, changing only the selected-person permission guard.
do $$
declare definition text; original text;
begin
  original := pg_get_functiondef('public.submit_selected_employee_leave_request(uuid,text,date,date,time,time,text)'::regprocedure);
  definition := replace(original,
    'or not private.is_system_portal_account_admin() then',
    'or not (private.is_system_portal_account_admin() or private.can_submit_team_leave(p_person_id)) then');
  if definition = original then raise exception 'Selected leave guard differs from reviewed baseline'; end if;
  execute definition;
end;
$$;

-- Managers can attach evidence for their current direct reports. Every upload
-- phase and the storage policy rechecks scope, including a mid-upload transfer.
do $$
declare signature text; definition text; original text;
begin
  foreach signature in array array[
    'public.prepare_my_leave_request_attachment_upload(uuid,text,text,bigint)',
    'public.complete_my_leave_request_attachment_upload(text)'
  ] loop
    original := pg_get_functiondef(signature::regprocedure);
    definition := replace(original,
      'v_request.user_id is distinct from v_actor_user_id' || chr(10) || '      and not v_actor_is_system_admin',
      'v_request.user_id is distinct from v_actor_user_id' || chr(10) || '      and not v_actor_is_system_admin and not private.can_submit_team_leave(v_request.employee_person_id)');
    if definition = original then raise exception 'Attachment guard differs from reviewed baseline: %', signature; end if;
    execute definition;
  end loop;
  original := pg_get_functiondef('private.can_add_my_leave_request_attachment(uuid)'::regprocedure);
  definition := replace(original, 'request.user_id = (select auth.uid())',
    '(request.user_id = (select auth.uid()) or private.can_submit_team_leave(request.employee_person_id))');
  if definition = original then raise exception 'Storage attachment guard differs from reviewed baseline'; end if;
  execute definition;
end;
$$;

create function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); scope_actor uuid; scope_person uuid; scope_admin boolean; requests jsonb; calendar_ids uuid[];
begin
  if actor is null or not private.is_active_portal_account(actor)
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  scope_actor := actor;
  scope_person := private.current_active_portal_employee_id();
  if p_preview_person_id is not null then
    if not private.is_system_portal_account_admin() then raise exception 'Only Super Admin can change profile.' using errcode = '42501'; end if;
    select auth_user_id into scope_actor from public.internal_org_people
    where id = p_preview_person_id and is_active and node_kind = 'person';
    if scope_actor is null or not private.is_active_portal_account(scope_actor) then
      raise exception 'An active linked employee is required.' using errcode = '42501';
    end if;
    scope_person := p_preview_person_id;
    requests := public.get_leave_workspace_for_preview(p_preview_person_id)->'requests';
  else
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into requests from public.list_leave_workspace_requests() r;
  end if;
  select app_role = 'system_admin' into scope_admin from public.profiles where id = scope_actor;
  select array_agg(c.id) into calendar_ids from public.list_leave_calendar_entries() c;
  return jsonb_build_object(
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'personId', p.id, 'name', p.full_name,
        'canSubmit', private.can_submit_team_leave(p.id,scope_actor) and p.auth_user_id is not null and private.is_active_portal_account(p.auth_user_id),
        'paidLeave', coalesce(d.employment_type in ('full_time','part_time'),false),
        'hours', case when d.employment_type in ('full_time','part_time') then coalesce(b.hours,80) else null end,
        'asOf', b.as_of, 'isExample', coalesce(b.is_example,true)
      ) order by lower(p.full_name)), '[]'::jsonb)
      from public.internal_org_people p
      left join private.employee_directory_details d on d.person_id = p.id
      left join private.employee_annual_leave_balances b on b.person_id = p.id
      where p.is_active and p.node_kind = 'person'
        and (p.id = scope_person or scope_admin or private.can_submit_team_leave(p.id,scope_actor))
    ),
    'canManageBalances', private.is_system_portal_account_admin(),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'pendingBalance', r.status = 'submitted' and a.request_id is not null,
        'evidenceDueDate', r.evidence_due_date,
        'canAttach', private.can_add_my_leave_request_attachment(r.id)
      )), '[]'::jsonb)
      from public.leave_requests r left join private.leave_balance_approvals a on a.request_id = r.id
      where r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
    ),
    'pendingBalanceCalendarIds', (
      select coalesce(jsonb_agg(r.id),'[]'::jsonb)
      from public.leave_requests r join private.leave_balance_approvals a on a.request_id = r.id
      where r.status = 'submitted' and (
        (p_preview_person_id is null and r.id = any(calendar_ids)
          and (r.user_id=actor or private.can_review_leave_request(r.id)))
        or r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
      )
    )
  );
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public, anon, authenticated;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

create function public.set_employee_annual_leave_balance(p_person_id uuid, p_hours numeric, p_as_of date, p_is_example boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_system_portal_account_admin() then raise exception 'Only System Admin can update balances.' using errcode='42501'; end if;
  if p_hours is null or p_hours::text in ('NaN','Infinity','-Infinity') or p_hours not between -10000 and 100000
    or p_as_of is null or p_as_of > (now() at time zone 'Australia/Melbourne')::date or p_is_example is null
    or not exists (select 1 from public.internal_org_people where id=p_person_id and is_active and node_kind='person') then
    raise exception 'Choose a valid employee, balance and balance date.' using errcode='22023';
  end if;
  insert into private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
  values(p_person_id,p_hours,p_as_of,p_is_example,auth.uid())
  on conflict(person_id) do update set hours=excluded.hours,as_of=excluded.as_of,is_example=excluded.is_example,updated_by=excluded.updated_by,updated_at=now();
  insert into private.annual_leave_balance_history(person_id,hours,as_of,is_example,actor_user_id)
  values(p_person_id,p_hours,p_as_of,p_is_example,auth.uid());
end;
$$;
revoke all on function public.set_employee_annual_leave_balance(uuid,numeric,date,boolean) from public, anon, authenticated;
grant execute on function public.set_employee_annual_leave_balance(uuid,numeric,date,boolean) to authenticated;

create function public.decide_leave_with_balance(p_request_id uuid, p_status text, p_manager_note text default null)
returns table(id uuid,status text) language plpgsql security definer set search_path = '' as $$
declare r public.leave_requests%rowtype;
begin
  if auth.uid() is null or not private.is_active_portal_account() or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'An active portal account is required.' using errcode='42501';
  end if;
  if p_status is distinct from 'Approved – pending leave balance' then
    return query select * from public.decide_my_managed_leave_request(p_request_id,p_status,p_manager_note);
    return;
  end if;
  select * into r from public.leave_requests where leave_requests.id = p_request_id for update;
  if not found or r.status <> 'submitted' or r.request_type_label <> 'Annual leave'
    or r.user_id = auth.uid() or not private.can_review_leave_request(r.id) then
    raise exception 'This annual leave request is not available for your decision.' using errcode='42501';
  end if;
  if length(coalesce(p_manager_note,'')) > 2000 then raise exception 'Reviewer note is too long.' using errcode='22023'; end if;
  if exists(select 1 from private.leave_balance_approvals where request_id=r.id) then
    raise exception 'Coverage is already approved; confirm the balance to approve paid leave.' using errcode='22023';
  end if;
  insert into private.leave_balance_approvals(request_id,approved_by) values(r.id,auth.uid());
  update public.leave_requests set manager_note=nullif(btrim(p_manager_note),''),updated_at=now() where leave_requests.id=r.id;
  insert into public.leave_request_events(leave_request_id,actor_user_id,event_type,note)
  values(r.id,auth.uid(),'updated','Coverage approved; paid annual leave awaits balance confirmation.');
  return query select r.id, 'Approved – pending leave balance'::text;
end;
$$;
revoke all on function public.decide_leave_with_balance(uuid,text,text) from public, anon, authenticated;
grant execute on function public.decide_leave_with_balance(uuid,text,text) to authenticated;

-- Top-level employees use the explicitly assigned reviewer when there is no
-- eligible manager above them. Never infer an email or send to an employee-role account.
create or replace function public.resolve_leave_notification_manager(p_request_id uuid)
returns table(manager_user_id uuid,manager_name text,manager_email text)
language sql stable security definer set search_path='' as $$
  with candidates as (
    select mp.auth_user_id,mp.full_name,d.work_email,0 priority
    from public.leave_requests r
    join lateral private.resolve_internal_org_employee_manager(r.employee_person_id) m on true
    join public.internal_org_people mp on mp.id=m.manager_id and mp.is_active
    join public.profiles ap on ap.id=mp.auth_user_id and ap.app_role in ('manager','system_admin')
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and mp.auth_user_id is distinct from r.user_id
      and private.is_active_portal_account(mp.auth_user_id)
      and private.is_current_leave_request_reviewer(r.id,mp.auth_user_id)
    union all
    select ap.id,coalesce(mp.full_name,ap.full_name),d.work_email,case when a.is_primary then 1 else 2 end
    from public.leave_requests r join private.leave_request_reviewer_assignments a on a.leave_request_id=r.id
    join public.profiles ap on ap.id=a.reviewer_user_id and ap.app_role in ('manager','system_admin')
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  )
  select c.auth_user_id,c.full_name,lower(nullif(btrim(c.work_email),'')) from candidates c
  order by c.priority,c.auth_user_id limit 1;
$$;
revoke all on function public.resolve_leave_notification_manager(uuid) from public,anon,authenticated;
grant execute on function public.resolve_leave_notification_manager(uuid) to service_role;

-- A minimal durable daily delivery ledger. Neither notes nor addresses are
-- persisted here; every claim resolves the current reporting line again.
create table private.leave_priority_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('leave-reminder','team-birthday')),
  source_id uuid not null,
  notify_date date not null,
  claim_token uuid,
  claimed_until timestamptz,
  sent_at timestamptz,
  unique(kind,source_id,notify_date)
);
alter table private.leave_priority_reminder_deliveries enable row level security;
revoke all on private.leave_priority_reminder_deliveries from public,anon,authenticated;

create function public.claim_leave_priority_reminders(p_limit integer default 100)
returns table(delivery_id uuid,claim_token uuid,event text,source_id uuid,employee_name text,
  manager_email text,company text,leave_type text,start_date date,end_date date,status text)
language plpgsql security definer set search_path='' as $$
declare today date := (now() at time zone 'Australia/Melbourne')::date;
begin
  if extract(isodow from today)>5 then return; end if;
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'leave-reminder',r.id,today from public.leave_requests r
  where r.status='submitted' and r.record_origin='portal' and r.approval_required
    and exists(select 1 from public.internal_org_people p where p.id=r.employee_person_id and p.is_active)
    and (select count(*) from generate_series((r.submitted_at at time zone 'Australia/Melbourne')::date+1,today,interval '1 day') d
      where extract(isodow from d) between 1 and 5)>=2
  on conflict do nothing;
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'team-birthday',p.id,today
  from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
  where p.is_active and p.node_kind='person' and d.date_of_birth is not null
    and exists(select 1 from generate_series(today,case when extract(isodow from today)=5 then today+2 else today end,interval '1 day') occurrence
      where extract(month from occurrence)=extract(month from d.date_of_birth)
      and extract(day from occurrence)=extract(day from d.date_of_birth))
  on conflict do nothing;
  return query
  with candidates as (
    select q.id from private.leave_priority_reminder_deliveries q
    where q.notify_date=today and q.sent_at is null and (q.claimed_until is null or q.claimed_until<now())
    order by q.id for update skip locked limit greatest(1,least(coalesce(p_limit,100),100))
  ), claimed as (
    update private.leave_priority_reminder_deliveries q set claim_token=gen_random_uuid(),claimed_until=now()+interval '25 minutes'
    from candidates c where c.id=q.id returning q.*
  )
  select q.id,q.claim_token,q.kind,q.source_id,p.full_name,
    case when q.kind='leave-reminder' then lm.manager_email else md.work_email end,
    p.company_key,coalesce(r.request_type_label,'Birthday'),
    case when q.kind='leave-reminder' then r.start_date else birthday.occurrence end,
    case when q.kind='leave-reminder' then r.end_date else birthday.occurrence end,
    case when a.request_id is not null then 'Approved – pending leave balance' else 'Pending' end
  from claimed q
  left join public.leave_requests r on q.kind='leave-reminder' and r.id=q.source_id
  join public.internal_org_people p on p.id=case when q.kind='team-birthday' then q.source_id else r.employee_person_id end and p.is_active
  left join private.leave_balance_approvals a on a.request_id=r.id
  left join lateral public.resolve_leave_notification_manager(r.id) lm on q.kind='leave-reminder'
  left join lateral private.resolve_internal_org_employee_manager(p.id) bm on q.kind='team-birthday'
  left join private.employee_directory_details md on md.person_id=bm.manager_id
  left join private.employee_directory_details pd on pd.person_id=p.id
  left join lateral (
    select occurrence::date from generate_series(today,today+2,interval '1 day') occurrence
    where extract(month from occurrence)=extract(month from pd.date_of_birth)
      and extract(day from occurrence)=extract(day from pd.date_of_birth) limit 1
  ) birthday on q.kind='team-birthday'
  where q.kind='team-birthday' or r.status='submitted';
end;
$$;
revoke all on function public.claim_leave_priority_reminders(integer) from public,anon,authenticated;
grant execute on function public.claim_leave_priority_reminders(integer) to service_role;

create function public.complete_leave_priority_reminder(p_delivery_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update private.leave_priority_reminder_deliveries set sent_at=now(),claimed_until=null
  where id=p_delivery_id and claim_token=p_claim_token and sent_at is null and claimed_until>now();
  return found;
end;
$$;
revoke all on function public.complete_leave_priority_reminder(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_leave_priority_reminder(uuid,uuid) to service_role;

create function public.leave_notification_was_approved(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.leave_request_events where leave_request_id=p_request_id and event_type='approved')
    or exists(select 1 from private.leave_balance_approvals where request_id=p_request_id);
$$;
revoke all on function public.leave_notification_was_approved(uuid) from public,anon,authenticated;
grant execute on function public.leave_notification_was_approved(uuid) to service_role;

commit;
