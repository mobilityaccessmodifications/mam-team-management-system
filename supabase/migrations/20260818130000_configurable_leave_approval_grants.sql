begin;

-- Leave approval is deliberately modelled as a separate capability.  A job
-- title, an app role, or a live reporting line must never silently grant
-- approval rights.  HR remains the existing database-controlled global
-- capability; all other reviewers require an explicit private grant.
create table private.leave_approval_grants (
  id uuid primary key default gen_random_uuid(),
  reviewer_user_id uuid not null references public.profiles (id) on delete restrict,
  scope_kind text not null check (scope_kind in ('team', 'subtree', 'global')),
  scope_team_name text,
  scope_root_person_id uuid references public.internal_org_people (id) on delete restrict,
  reviewer_label text not null
    check (
      reviewer_label = btrim(reviewer_label)
      and char_length(reviewer_label) between 1 and 160
    ),
  priority smallint not null default 100 check (priority between 0 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  check (
    (scope_kind = 'global' and scope_team_name is null and scope_root_person_id is null)
    or (
      scope_kind = 'team'
      and scope_team_name is not null
      and scope_team_name = btrim(scope_team_name)
      and char_length(scope_team_name) between 1 and 120
      and scope_root_person_id is null
    )
    or (scope_kind = 'subtree' and scope_team_name is null and scope_root_person_id is not null)
  ),
  check ((revoked_at is null) = (revoked_by is null))
);

comment on table private.leave_approval_grants is
  'Private explicit leave-review configuration. Team and subtree scopes are evaluated only when a request is submitted; never expose grants to browser clients.';

alter table private.leave_approval_grants enable row level security;
revoke all on table private.leave_approval_grants from public, anon, authenticated;

create unique index leave_approval_grants_active_scope_unique_idx
  on private.leave_approval_grants (
    reviewer_user_id,
    scope_kind,
    coalesce(lower(scope_team_name), ''),
    coalesce(scope_root_person_id::text, '')
  )
  where revoked_at is null;

create index leave_approval_grants_active_reviewer_idx
  on private.leave_approval_grants (reviewer_user_id, priority)
  where revoked_at is null;

-- This is a private immutable snapshot of the people authorised to review a
-- particular request.  The grant reference lets revoking an explicit grant
-- immediately stop that reviewer while tree edits leave historic request
-- access unchanged.
create table private.leave_request_reviewer_assignments (
  leave_request_id uuid not null references public.leave_requests (id) on delete cascade,
  reviewer_user_id uuid not null references public.profiles (id) on delete restrict,
  source_grant_id uuid references private.leave_approval_grants (id) on delete restrict,
  assignment_kind text not null check (assignment_kind in ('legacy', 'team', 'subtree', 'global')),
  reviewer_label text not null
    check (
      reviewer_label = btrim(reviewer_label)
      and char_length(reviewer_label) between 1 and 160
    ),
  is_primary boolean not null default false,
  assigned_at timestamptz not null default clock_timestamp(),
  primary key (leave_request_id, reviewer_user_id),
  check (
    (assignment_kind = 'legacy' and source_grant_id is null)
    or (assignment_kind <> 'legacy' and source_grant_id is not null)
  )
);

comment on table private.leave_request_reviewer_assignments is
  'Private per-request reviewer snapshot. It stores only opaque IDs, grant provenance and a safe route label; no leave content or personnel contact data.';

alter table private.leave_request_reviewer_assignments enable row level security;
revoke all on table private.leave_request_reviewer_assignments from public, anon, authenticated;

create unique index leave_request_reviewer_assignments_primary_idx
  on private.leave_request_reviewer_assignments (leave_request_id)
  where is_primary;

create index leave_request_reviewer_assignments_reviewer_idx
  on private.leave_request_reviewer_assignments (reviewer_user_id, leave_request_id);

create index leave_request_reviewer_assignments_grant_idx
  on private.leave_request_reviewer_assignments (source_grant_id)
  where source_grant_id is not null;

-- Resolve all currently active non-HR grants that cover a person.  `team`
-- scopes use the HR-private roster field for the confirmed Major/Minor/
-- Warehouse policy; `subtree` is available for a future, intentionally
-- configured reporting-line approval scope.  This helper is called only at
-- submission and never for later read/decision authorisation.
create function private.resolve_leave_approval_grants(p_person_id uuid)
returns table (
  grant_id uuid,
  reviewer_user_id uuid,
  reviewer_label text,
  scope_kind text,
  scope_priority integer,
  scope_depth integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active

    union all

    select parent.id, parent.parent_id, ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on ancestors.parent_id = parent.id
    where parent.is_active
  ),
  employee_team as (
    select lower(btrim(detail.team_name)) as team_key
    from private.employee_directory_details detail
    where detail.person_id = p_person_id
      and detail.team_name is not null
  )
  select
    approval_grant.id,
    approval_grant.reviewer_user_id,
    approval_grant.reviewer_label,
    approval_grant.scope_kind,
    approval_grant.priority::integer,
    coalesce(
      (
        select min(ancestor.depth)
        from ancestors ancestor
        where ancestor.id = approval_grant.scope_root_person_id
      ),
      2147483647
    )
  from private.leave_approval_grants approval_grant
  where approval_grant.revoked_at is null
    and private.is_active_portal_account(approval_grant.reviewer_user_id)
    and (
      approval_grant.scope_kind = 'global'
      or (
        approval_grant.scope_kind = 'team'
        and exists (
          select 1
          from employee_team team
          where team.team_key = lower(approval_grant.scope_team_name)
        )
      )
      or (
        approval_grant.scope_kind = 'subtree'
        and exists (
          select 1
          from ancestors ancestor
          where ancestor.id = approval_grant.scope_root_person_id
        )
      )
    );
$$;

comment on function private.resolve_leave_approval_grants(uuid) is
  'Returns current explicit leave-review grants covering an active employee only at submission time. Later request access uses the immutable assignment snapshot.';

-- A reviewer must still have a current active managed account.  A revoked
-- configuration grant intentionally invalidates its historical assignments;
-- an old hierarchy edit does not.
create function private.is_current_leave_request_reviewer(
  p_leave_request_id uuid,
  p_reviewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_reviewer_user_id is not null
    and private.is_active_portal_account(p_reviewer_user_id)
    and exists (
      select 1
      from private.leave_request_reviewer_assignments assignment
      left join private.leave_approval_grants approval_grant
        on approval_grant.id = assignment.source_grant_id
      where assignment.leave_request_id = p_leave_request_id
        and assignment.reviewer_user_id = p_reviewer_user_id
        and (
          assignment.assignment_kind = 'legacy'
          or (
            approval_grant.id is not null
            and approval_grant.revoked_at is null
            and approval_grant.reviewer_user_id = p_reviewer_user_id
          )
        )
    );
$$;

comment on function private.is_current_leave_request_reviewer(uuid, uuid) is
  'Checks a request-specific reviewer assignment plus live account/grant state. It is private and never accepts a browser-authorised target.';

-- Existing requests already have an immutable named-manager snapshot. Keep it
-- intact as a legacy assignment rather than recomputing their route from the
-- current organisation tree.
insert into private.leave_request_reviewer_assignments (
  leave_request_id,
  reviewer_user_id,
  source_grant_id,
  assignment_kind,
  reviewer_label,
  is_primary
)
select
  request.id,
  request.manager_user_id,
  null,
  'legacy',
  coalesce(nullif(btrim(request.manager_name_snapshot), ''), 'Assigned reviewer'),
  true
from public.leave_requests request
where request.manager_user_id is not null
  and request.manager_user_id is distinct from request.user_id
on conflict (leave_request_id, reviewer_user_id) do nothing;

-- Call this private helper immediately after adding/revoking global grants to
-- route pending work to the current all-company reviewers. It deliberately
-- does not expand access to already decided historic requests.
create function private.snapshot_global_leave_reviewers_for_pending_requests()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  with candidates as (
    select
      request.id as leave_request_id,
      approval_grant.reviewer_user_id,
      approval_grant.id as source_grant_id,
      approval_grant.reviewer_label,
      approval_grant.priority,
      exists (
        select 1
        from private.leave_request_reviewer_assignments existing_primary
        where existing_primary.leave_request_id = request.id
          and existing_primary.is_primary
      ) as has_primary
    from public.leave_requests request
    join private.leave_approval_grants approval_grant
      on approval_grant.scope_kind = 'global'
      and approval_grant.revoked_at is null
      and private.is_active_portal_account(approval_grant.reviewer_user_id)
    where request.status = 'submitted'
      and approval_grant.reviewer_user_id is distinct from request.user_id
      and not exists (
        select 1
        from private.leave_request_reviewer_assignments existing
        where existing.leave_request_id = request.id
          and existing.reviewer_user_id = approval_grant.reviewer_user_id
      )
  ),
  ranked as (
    select
      candidate.*,
      row_number() over (
        partition by candidate.leave_request_id
        order by candidate.priority, candidate.source_grant_id
      ) as reviewer_rank
    from candidates candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id,
    reviewer_user_id,
    source_grant_id,
    assignment_kind,
    reviewer_label,
    is_primary
  )
  select
    candidate.leave_request_id,
    candidate.reviewer_user_id,
    candidate.source_grant_id,
    'global',
    candidate.reviewer_label,
    not candidate.has_primary and candidate.reviewer_rank = 1
  from ranked candidate;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function private.snapshot_global_leave_reviewers_for_pending_requests() is
  'Private configuration helper. Snapshots active explicit global reviewers onto currently pending requests only; no historic decision access is expanded.';

-- All reviewer-facing RLS, evidence and storage policies call this shared
-- helper.  Keep HR as the existing DB-controlled global capability and use a
-- request snapshot for every non-HR reviewer.
create or replace function private.can_review_leave_request(p_leave_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and (
      private.is_internal_org_hr()
      or (
        private.is_internal_org_member()
        and private.is_current_leave_request_reviewer(p_leave_request_id, (select auth.uid()))
      )
    );
$$;

comment on function private.can_review_leave_request(uuid) is
  'Authorizes current HR or a current request-specific reviewer assignment. It is used by leave, evidence and storage RLS policies.';

-- This capability intentionally has no personnel data. It lets explicitly
-- authorised reviewers see an empty Approvals workspace before their first
-- request arrives, without relying on title text or direct reports in React.
create function public.can_review_leave_workspace()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and (
      private.is_internal_org_hr()
      or exists (
        select 1
        from private.leave_approval_grants approval_grant
        where approval_grant.reviewer_user_id = (select auth.uid())
          and approval_grant.revoked_at is null
          and private.is_internal_org_member()
          and private.is_active_portal_account(approval_grant.reviewer_user_id)
      )
      or exists (
        select 1
        from private.leave_request_reviewer_assignments assignment
        where private.is_internal_org_member()
          and private.is_current_leave_request_reviewer(assignment.leave_request_id, (select auth.uid()))
      )
    );
$$;

comment on function public.can_review_leave_workspace() is
  'Returns whether the authenticated account has HR, explicit reviewer-grant, or legacy assigned-reviewer access. It never returns leave records.';

-- `submit_my_leave_request` and the register DTO change their safe reviewer
-- label from the old manager-specific field.  These functions have no SQL
-- dependants, so recreate them with the new explicit approval contract.
drop function public.submit_my_leave_request(
  text,
  date,
  date,
  time without time zone,
  time without time zone,
  text
);

create function public.submit_my_leave_request(
  p_request_type_label text,
  p_start_date date,
  p_end_date date,
  p_start_time time without time zone default null,
  p_end_time time without time zone default null,
  p_employee_note text default null
)
returns table (
  id uuid,
  status text,
  approval_required boolean,
  assigned_reviewer_label text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_leave_type text;
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to submit leave.'
      using errcode = '42501';
  end if;

  v_actor_person_id := private.current_active_portal_employee_id();
  if v_actor_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in (
    'Annual leave',
    'Sick leave',
    'Carer''s leave',
    'Unpaid leave'
  ) then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;

  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  select count(*)::integer
  into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;

  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00'
      or p_start_time >= time '18:00'
      or p_end_time <= time '06:00'
      or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.'
        using errcode = '22023';
    end if;

    select round(sum(
      case
        when day::date = p_start_date and day::date = p_end_date then
          (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
        when day::date = p_start_date then
          (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
        when day::date = p_end_date then
          (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
        else 12::numeric
      end
    ), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;

    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  -- Lock the hierarchy and the grant configuration in one stable order before
  -- deriving the snapshot. Organisation edits and grant changes therefore
  -- affect either this request or a later request, never half of each.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));

  select count(distinct candidate.reviewer_user_id)::integer
  into v_reviewer_count
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id;

  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this request.'
      using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id
  order by
    case candidate.scope_kind
      when 'team' then 0
      when 'subtree' then 1
      else 2
    end,
    candidate.scope_priority,
    candidate.scope_depth,
    candidate.grant_id
  limit 1;

  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
  end;

  insert into public.leave_requests (
    user_id,
    leave_type,
    request_type_label,
    start_date,
    end_date,
    start_time,
    end_time,
    business_days,
    hours,
    approval_required,
    manager_user_id,
    manager_name_snapshot,
    reason,
    status,
    submitted_at,
    decided_at,
    decided_by,
    created_at,
    updated_at
  )
  values (
    v_actor_user_id,
    v_leave_type,
    v_request_type_label,
    p_start_date,
    p_end_date,
    p_start_time,
    p_end_time,
    v_business_days,
    v_hours,
    true,
    v_primary_reviewer_user_id,
    v_primary_reviewer_label,
    v_employee_note,
    'submitted',
    clock_timestamp(),
    null,
    null,
    clock_timestamp(),
    clock_timestamp()
  )
  returning * into v_request;

  with candidates as (
    select candidate.*
    from private.resolve_leave_approval_grants(v_actor_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_actor_user_id
  ),
  distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id)
      candidate.*
    from candidates candidate
    order by
      candidate.reviewer_user_id,
      case candidate.scope_kind
        when 'team' then 0
        when 'subtree' then 1
        else 2
      end,
      candidate.scope_priority,
      candidate.scope_depth,
      candidate.grant_id
  ),
  ranked_reviewers as (
    select
      candidate.*,
      row_number() over (
        order by
          case candidate.scope_kind
            when 'team' then 0
            when 'subtree' then 1
            else 2
          end,
          candidate.scope_priority,
          candidate.scope_depth,
          candidate.grant_id
      ) as route_rank
    from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id,
    reviewer_user_id,
    source_grant_id,
    assignment_kind,
    reviewer_label,
    is_primary
  )
  select
    v_request.id,
    candidate.reviewer_user_id,
    candidate.grant_id,
    candidate.scope_kind,
    candidate.reviewer_label,
    candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values
    (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query
  select
    v_request.id,
    'Pending',
    v_request.approval_required,
    v_primary_reviewer_label;
end;
$$;

comment on function public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text) is
  'Creates a pending leave request for the authenticated linked employee and snapshots only explicitly configured non-HR reviewers. Identity, timing and route never come from the browser.';

create or replace function public.decide_my_managed_leave_request(
  p_request_id uuid,
  p_status text,
  p_manager_note text default null
)
returns table (
  id uuid,
  status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_manager_note text := nullif(btrim(p_manager_note), '');
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to decide leave.'
      using errcode = '42501';
  end if;

  if p_request_id is null or p_status is null or p_status not in ('Approved', 'Declined') then
    raise exception 'Choose a valid leave decision.' using errcode = '22023';
  end if;

  if p_status = 'Declined' and v_manager_note is null then
    raise exception 'A reviewer note is required when declining this request.'
      using errcode = '22023';
  end if;

  if v_manager_note is not null and char_length(v_manager_note) > 2000 then
    raise exception 'Reviewer note is too long.' using errcode = '22001';
  end if;

  select request.*
  into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or not v_request.approval_required
    or v_request.status <> 'submitted' then
    raise exception 'This leave request is not awaiting a decision.' using errcode = '42501';
  end if;

  -- Self-approval is never permitted, including for HR, a global reviewer or
  -- a reviewer who is the root of a configured subtree.
  if v_request.user_id = v_actor_user_id then
    raise exception 'You cannot decide your own leave request.' using errcode = '42501';
  end if;

  if not private.is_internal_org_hr()
    and (
      not private.is_internal_org_member()
      or not private.is_current_leave_request_reviewer(v_request.id, v_actor_user_id)
    ) then
    raise exception 'You are not assigned to decide this leave request.' using errcode = '42501';
  end if;

  update public.leave_requests request
  set status = case when p_status = 'Approved' then 'approved' else 'rejected' end,
      manager_note = coalesce(v_manager_note, 'Coverage checked and confirmed.'),
      decided_at = clock_timestamp(),
      decided_by = v_actor_user_id,
      updated_at = clock_timestamp()
  where request.id = v_request.id
  returning * into v_request;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_request.id,
    v_actor_user_id,
    case when p_status = 'Approved' then 'approved' else 'rejected' end,
    v_request.manager_note
  );

  return query
  select
    v_request.id,
    case v_request.status
      when 'approved' then 'Approved'
      else 'Declined'
    end;
end;
$$;

comment on function public.decide_my_managed_leave_request(uuid, text, text) is
  'Records one final approval or decline only for current HR or a current explicit request reviewer. The target request and reviewer authority are re-read in the database.';

drop function public.list_leave_workspace_requests();

-- Full leave details are returned only to the owner, a current snapshot
-- reviewer, or HR. The browser never sends a person, reviewer, team or role
-- identifier to widen this projection.
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
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr and private.current_active_portal_employee_id() is null then
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
  where request.status in ('submitted', 'approved', 'rejected', 'changes_requested')
    and (
      request.user_id = v_actor_user_id
      or private.can_review_leave_request(request.id)
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$$;

comment on function public.list_leave_workspace_requests() is
  'Returns private leave details only for the authenticated employee, current explicit request reviewers, or HR. Reviewer assignment is an immutable request snapshot, not a live hierarchy lookup.';

-- Keep the calendar projection availability-only for peers. A current request
-- reviewer receives the leave type for their assigned request; all others in
-- the company see only Away. Private notes, attachments and contact data are
-- excluded for every caller.
create or replace function public.list_leave_calendar_entries()
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
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_person_id uuid;
  v_actor_company_key text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view the calendar.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr then
    v_actor_person_id := private.current_active_portal_employee_id();
    if v_actor_person_id is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;

    select person.company_key
    into v_actor_company_key
    from public.internal_org_people person
    where person.id = v_actor_person_id
      and person.auth_user_id = v_actor_user_id
      and person.node_kind = 'person'
      and person.is_active;

    if v_actor_company_key is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    request.id,
    coalesce(employee.full_name, profile.full_name),
    coalesce(employee.company_key, 'mam'),
    case
      when v_actor_is_hr
        or request.user_id = v_actor_user_id
        or private.can_review_leave_request(request.id)
        then request.request_type_label
      else 'Away'
    end,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    case request.status
      when 'approved' then 'Approved'
      else 'Pending'
    end
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
      and person.is_active
    order by person.updated_at desc
    limit 1
  ) employee on true
  where request.status in ('submitted', 'approved')
    and (v_actor_is_hr or employee.company_key = v_actor_company_key)
  order by request.start_date, request.created_at, request.id;
end;
$$;

comment on function public.list_leave_calendar_entries() is
  'Returns an availability-only company calendar. Current HR and request reviewers see their authorised leave type; peers receive Away only.';

-- The private helpers are callable only from security-definer functions. The
-- policy helper retains authenticated execution because existing evidence and
-- storage RLS policies invoke it directly.
revoke all on function private.resolve_leave_approval_grants(uuid)
  from public, anon, authenticated;
revoke all on function private.is_current_leave_request_reviewer(uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.snapshot_global_leave_reviewers_for_pending_requests()
  from public, anon, authenticated;
revoke all on function private.can_review_leave_request(uuid)
  from public, anon, authenticated;
revoke all on function public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text)
  from public, anon, authenticated;
revoke all on function public.decide_my_managed_leave_request(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.list_leave_workspace_requests()
  from public, anon, authenticated;
revoke all on function public.list_leave_calendar_entries()
  from public, anon, authenticated;
revoke all on function public.can_review_leave_workspace()
  from public, anon, authenticated;

grant execute on function private.can_review_leave_request(uuid)
  to authenticated;
grant execute on function public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text)
  to authenticated;
grant execute on function public.decide_my_managed_leave_request(uuid, text, text)
  to authenticated;
grant execute on function public.list_leave_workspace_requests()
  to authenticated;
grant execute on function public.list_leave_calendar_entries()
  to authenticated;
grant execute on function public.can_review_leave_workspace()
  to authenticated;

commit;
