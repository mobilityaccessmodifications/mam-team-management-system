begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:leave-attachment-owner-delete:20260916', 0)
  );

  if to_regclass('public.leave_request_attachments') is null
    or to_regclass('public.leave_request_events') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.can_view_leave_request_attachment(uuid)') is null
    or to_regprocedure('public.list_leave_workspace_attachments()') is null then
    raise exception 'Leave attachment deletion prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Add the uploader-only delete capability to the already-authorised metadata
-- projection. Reviewers and HR may still download files in their request
-- scope, but they never receive a delete control for another user's upload.
drop function public.list_leave_workspace_attachments();

create function public.list_leave_workspace_attachments()
returns table (
  id uuid,
  leave_request_id uuid,
  file_name text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz,
  can_delete boolean
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
    attachment.created_at,
    attachment.uploaded_by = v_actor_user_id
  from public.leave_request_attachments attachment
  where private.can_view_leave_request_attachment(attachment.id)
  order by attachment.created_at asc, attachment.id;
end;
$$;

comment on function public.list_leave_workspace_attachments() is
  'Returns safe attachment metadata plus an uploader-only delete capability for leave requests visible to the current employee, reviewer or HR. Storage paths are never returned.';

-- This is the only authenticated deletion boundary. It rechecks the active
-- session and immutable uploader identity inside PostgreSQL, removes metadata
-- transactionally, and returns the opaque path only to the calling Server
-- Action. The browser receives only the final attachment ID. Object bytes are
-- removed through the server-only Storage API; an outage leaves an
-- inaccessible orphan for the existing bounded maintenance job.
create function public.delete_my_leave_request_attachment(
  p_attachment_id uuid
)
returns table (
  attachment_id uuid,
  storage_path text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_attachment public.leave_request_attachments%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or p_attachment_id is null then
    raise exception 'This supporting file cannot be deleted.' using errcode = '42501';
  end if;

  select attachment.*
  into v_attachment
  from public.leave_request_attachments attachment
  where attachment.id = p_attachment_id
  for update;

  if not found or v_attachment.uploaded_by is distinct from v_actor_user_id then
    -- Deliberately conceal whether another user's attachment exists.
    raise exception 'This supporting file cannot be deleted.' using errcode = '42501';
  end if;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_attachment.leave_request_id,
    v_actor_user_id,
    'updated',
    'Supporting file removed.'
  );

  delete from public.leave_request_attachments attachment
  where attachment.id = v_attachment.id;

  return query
  select v_attachment.id, v_attachment.storage_path;
end;
$$;

comment on function public.delete_my_leave_request_attachment(uuid) is
  'Deletes attachment metadata only for the authenticated original uploader, records an identity-only leave event and returns the opaque path for server-side Storage deletion.';

revoke all on function public.list_leave_workspace_attachments()
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_leave_request_attachment(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_leave_workspace_attachments()
  to authenticated;
grant execute on function public.delete_my_leave_request_attachment(uuid)
  to authenticated;

commit;
