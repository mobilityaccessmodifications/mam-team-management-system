begin;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 120),
  preferred_name text check (preferred_name is null or char_length(preferred_name) <= 80),
  app_role text not null default 'employee'
    check (app_role in ('employee', 'manager', 'hr', 'system_admin')),
  timezone text not null default 'Australia/Melbourne',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now()
);

create table public.team_memberships (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  team_role text not null default 'member'
    check (team_role in ('member', 'team_lead', 'manager')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  leave_type text not null
    check (leave_type in ('annual', 'personal', 'unpaid', 'other')),
  start_date date not null,
  end_date date not null,
  reason text check (reason is null or char_length(reason) <= 2000),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (
    (status = 'draft' and submitted_at is null)
    or (status <> 'draft' and submitted_at is not null)
  )
);

create table public.leave_request_events (
  id bigint generated always as identity primary key,
  leave_request_id uuid not null references public.leave_requests (id) on delete cascade,
  actor_user_id uuid not null references public.profiles (id) on delete restrict,
  event_type text not null
    check (event_type in ('created', 'submitted', 'updated', 'approved', 'rejected', 'changes_requested', 'cancelled')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now()
);

create index leave_requests_user_dates_idx
  on public.leave_requests (user_id, start_date, end_date);
create index leave_requests_status_idx
  on public.leave_requests (status, start_date);
create index leave_request_events_request_idx
  on public.leave_request_events (leave_request_id, created_at);

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_memberships enable row level security;
alter table public.leave_requests enable row level security;
alter table public.leave_request_events enable row level security;

alter table public.profiles force row level security;
alter table public.teams force row level security;
alter table public.team_memberships force row level security;
alter table public.leave_requests force row level security;
alter table public.leave_request_events force row level security;

create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id and app_role = 'employee');

create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy memberships_select_own
  on public.team_memberships for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy teams_select_for_member
  on public.teams for select
  to authenticated
  using (
    exists (
      select 1
      from public.team_memberships membership
      where membership.team_id = teams.id
        and membership.user_id = (select auth.uid())
    )
  );

create policy leave_requests_select_own
  on public.leave_requests for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy leave_requests_insert_own
  on public.leave_requests for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and status in ('draft', 'submitted')
    and decided_by is null
    and decided_at is null
  );

create policy leave_requests_update_own_open
  on public.leave_requests for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and status in ('draft', 'changes_requested')
  )
  with check (
    (select auth.uid()) = user_id
    and status in ('draft', 'submitted', 'cancelled')
    and decided_by is null
    and decided_at is null
  );

create policy leave_requests_delete_own_draft
  on public.leave_requests for delete
  to authenticated
  using ((select auth.uid()) = user_id and status = 'draft');

create policy leave_events_select_own_request
  on public.leave_request_events for select
  to authenticated
  using (
    exists (
      select 1
      from public.leave_requests request
      where request.id = leave_request_events.leave_request_id
        and request.user_id = (select auth.uid())
    )
  );

create policy leave_events_insert_own_request
  on public.leave_request_events for insert
  to authenticated
  with check (
    actor_user_id = (select auth.uid())
    and event_type in ('created', 'submitted', 'updated', 'cancelled')
    and exists (
      select 1
      from public.leave_requests request
      where request.id = leave_request_events.leave_request_id
        and request.user_id = (select auth.uid())
    )
  );

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.teams from anon, authenticated;
revoke all on table public.team_memberships from anon, authenticated;
revoke all on table public.leave_requests from anon, authenticated;
revoke all on table public.leave_request_events from anon, authenticated;

grant usage on schema public to authenticated;
grant select, insert on table public.profiles to authenticated;
grant update (full_name, preferred_name, timezone, updated_at)
  on table public.profiles to authenticated;
grant select on table public.teams to authenticated;
grant select on table public.team_memberships to authenticated;
grant select, insert, delete on table public.leave_requests to authenticated;
grant update (leave_type, start_date, end_date, reason, status, submitted_at, updated_at)
  on table public.leave_requests to authenticated;
grant select, insert on table public.leave_request_events to authenticated;
grant usage, select on sequence public.leave_request_events_id_seq to authenticated;

commit;
