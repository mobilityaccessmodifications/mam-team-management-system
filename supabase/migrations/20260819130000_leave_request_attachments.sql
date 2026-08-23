begin;

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
drop function public.list_leave_workspace_requests();

create function public.list_leave_workspace_requests()
returns table (
  id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  approval_required boolean,
  status text,
  submitted_at timestamptz,
  assigned_reviewer_label text,
  can_decide boolean,
  can_cancel boolean,
  can_attach boolean,
  employee_note text,
  manager_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_melbourne_today date := (current_timestamp at time zone 'Australia/Melbourne')::date;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  -- HR may retain its existing cross-employee workspace even when the account
  -- is not itself rostered. All other callers must be active linked employees.
  if not v_actor_is_hr and v_actor_person_id is null then
    raise exception 'An active linked employee account is required to view leave.'
      using errcode = '42501';
  end if;

  return query
  select
    request.id,
    coalesce(employee.full_name, profile.full_name),
    coalesce(employee.company_key, 'mam'),
    request.request_type_label,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    request.approval_required,
    case request.status
      when 'approved' then 'Approved'
      when 'rejected' then 'Declined'
      when 'cancelled' then 'Cancelled'
      else 'Pending'
    end,
    request.submitted_at,
    coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot),
    (
      request.user_id is distinct from v_actor_user_id
      and request.approval_required
      and request.status = 'submitted'
      and private.can_review_leave_request(request.id)
    ),
    (
      request.user_id = v_actor_user_id
      and v_actor_person_id is not null
      and request.status = 'approved'
      and request.start_date > v_melbourne_today
    ),
    (
      request.user_id = v_actor_user_id
      and v_actor_person_id is not null
      and request.status in ('submitted', 'approved')
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
    order by person.is_active desc, person.updated_at desc
    limit 1
  ) employee on true
  left join lateral (
    select assignment.reviewer_label
    from private.leave_request_reviewer_assignments assignment
    where assignment.leave_request_id = request.id
      and assignment.is_primary
    limit 1
  ) primary_assignment on true
  where request.status in ('submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')
    and (
      request.user_id = v_actor_user_id
      or private.can_review_leave_request(request.id)
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$$;

comment on function public.list_leave_workspace_requests() is
  'Returns private leave details plus database-derived decide, cancel and attachment controls only for the current employee, current reviewer or HR.';

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
revoke all on function public.list_leave_workspace_requests()
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
grant execute on function public.list_leave_workspace_requests()
  to authenticated;

commit;
