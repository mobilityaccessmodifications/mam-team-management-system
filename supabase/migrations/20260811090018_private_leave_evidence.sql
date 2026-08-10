begin;

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

create table public.leave_request_attachments (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null references public.leave_requests (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id) on delete restrict,
  storage_path text not null unique
    check (char_length(storage_path) between 38 and 500),
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
  size_bytes bigint not null
    check (size_bytes between 1 and 5242880),
  created_at timestamptz not null default now(),
  check (storage_path like leave_request_id::text || '/%')
);

create index leave_request_attachments_request_idx
  on public.leave_request_attachments (leave_request_id, created_at);

create function private.can_review_leave_request(p_leave_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles viewer
      join public.leave_requests request
        on request.id = p_leave_request_id
      where viewer.id = (select auth.uid())
        and (
          viewer.app_role in ('hr', 'system_admin')
          or exists (
            select 1
            from public.team_memberships reviewer_membership
            join public.team_memberships employee_membership
              on employee_membership.team_id = reviewer_membership.team_id
            where reviewer_membership.user_id = viewer.id
              and reviewer_membership.team_role in ('team_lead', 'manager')
              and employee_membership.user_id = request.user_id
          )
        )
    );
$$;

alter table public.leave_request_attachments enable row level security;
alter table public.leave_request_attachments force row level security;

create policy leave_requests_select_reviewer
  on public.leave_requests for select
  to authenticated
  using (private.can_review_leave_request(id));

create policy leave_attachments_insert_owner
  on public.leave_request_attachments for insert
  to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and exists (
      select 1
      from public.leave_requests request
      where request.id = leave_request_attachments.leave_request_id
        and request.user_id = (select auth.uid())
        and request.status in ('draft', 'submitted', 'changes_requested')
    )
  );

create policy leave_attachments_select_reviewer
  on public.leave_request_attachments for select
  to authenticated
  using (private.can_review_leave_request(leave_request_id));

create policy leave_evidence_insert_owner
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'leave-evidence'
    and exists (
      select 1
      from public.leave_requests request
      where request.id::text = (storage.foldername(name))[1]
        and request.user_id = (select auth.uid())
        and request.status in ('draft', 'submitted', 'changes_requested')
    )
  );

create policy leave_evidence_select_reviewer
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'leave-evidence'
    and exists (
      select 1
      from public.leave_request_attachments attachment
      where attachment.storage_path = storage.objects.name
        and private.can_review_leave_request(attachment.leave_request_id)
    )
  );

revoke all on table public.leave_request_attachments from anon, authenticated;
grant select, insert on table public.leave_request_attachments to authenticated;

revoke all on function private.can_review_leave_request(uuid) from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.can_review_leave_request(uuid) to authenticated;

commit;
