begin;

-- Membership is configured from verified active portal identities at release;
-- employee identity data does not belong in version-controlled migrations.
create table private.manager_leave_reviewers (
  reviewer_user_id uuid primary key references public.profiles(id),
  priority integer not null check(priority between 1 and 1000)
);
alter table private.manager_leave_reviewers enable row level security;
revoke all on private.manager_leave_reviewers from public,anon,authenticated,service_role;

create function private.is_manager_leave_person(p_person_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.internal_org_people p
    join public.profiles a on a.id=p.auth_user_id
    where p.id=p_person_id and p.node_kind='person' and a.app_role='manager');
$$;
revoke all on function private.is_manager_leave_person(uuid) from public,anon,authenticated,service_role;


create or replace function private.resolve_leave_approval_grants(p_person_id uuid)
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
      not private.is_manager_leave_person(p_person_id)
      or (approval_grant.scope_kind = 'global' and exists(
        select 1 from private.manager_leave_reviewers configured
        where configured.reviewer_user_id=approval_grant.reviewer_user_id))
    )
    and approval_grant.reviewer_user_id is distinct from
      (select p.auth_user_id from public.internal_org_people p where p.id=p_person_id)
    and (
      approval_grant.scope_kind = 'global'
      or (
        approval_grant.scope_kind = 'subtree'
        and exists (
          select 1
          from public.internal_org_people root_person
          join public.profiles manager_profile
            on manager_profile.id = root_person.auth_user_id
          where root_person.id = approval_grant.scope_root_person_id
            and root_person.node_kind = 'person'
            and root_person.is_active
            and root_person.auth_user_id = approval_grant.reviewer_user_id
            and manager_profile.app_role = 'manager'
            and manager_profile.account_status = 'active'
            and manager_profile.login_name is not null
        )
        and exists (
          select 1
          from ancestors ancestor
          where ancestor.id = approval_grant.scope_root_person_id
        )
      )
    );
$$;

create or replace function private.is_current_leave_request_reviewer(
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
      select 1 from public.leave_requests request
      where request.id=p_leave_request_id
        and request.user_id is distinct from p_reviewer_user_id
        and (not private.is_manager_leave_person(request.employee_person_id)
          or exists(select 1 from private.manager_leave_reviewers configured
            where configured.reviewer_user_id=p_reviewer_user_id))
    )
    and exists (
      select 1
      from private.leave_request_reviewer_assignments assignment
      left join private.leave_approval_grants approval_grant
        on approval_grant.id = assignment.source_grant_id
      where assignment.leave_request_id = p_leave_request_id
        and assignment.reviewer_user_id = p_reviewer_user_id
        and (
          (
            assignment.assignment_kind = 'legacy'
            and (
              exists (
                select 1
                from public.profiles manager_profile
                where manager_profile.id = p_reviewer_user_id
                  and manager_profile.app_role = 'manager'
                  and manager_profile.account_status = 'active'
              )
              or exists (
                select 1
                from private.leave_approval_grants global_grant
                where global_grant.reviewer_user_id = p_reviewer_user_id
                  and global_grant.scope_kind = 'global'
                  and global_grant.revoked_at is null
              )
            )
          )
          or (
            approval_grant.id is not null
            and approval_grant.revoked_at is null
            and approval_grant.reviewer_user_id = p_reviewer_user_id
            and approval_grant.scope_kind = assignment.assignment_kind
            and (
              approval_grant.scope_kind = 'global'
              or exists (
                select 1
                from public.profiles manager_profile
                where manager_profile.id = p_reviewer_user_id
                  and manager_profile.app_role = 'manager'
                  and manager_profile.account_status = 'active'
              )
            )
          )
        )
    );
$$;

create or replace function private.reroute_pending_leave_requests_to_current_manager()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  v_updated integer := 0;
begin
  for candidate in
    select
      request.id as request_id,
      manager.grant_id,
      manager.scope_kind,
      manager.reviewer_user_id,
      manager.reviewer_label
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.auth_user_id = request.user_id
      and employee.node_kind = 'person'
      and employee.is_active
    cross join lateral (
      select resolved.*
      from private.resolve_leave_approval_grants(employee.id) resolved
      order by case resolved.scope_kind when 'subtree' then 0 else 1 end,
        resolved.scope_depth, resolved.scope_priority, resolved.grant_id
      limit 1
    ) manager
    where request.status = 'submitted'
      and request.approval_required
      and not private.is_manager_leave_person(employee.id)
  loop
    update public.leave_requests request
    set manager_user_id = candidate.reviewer_user_id,
        manager_name_snapshot = candidate.reviewer_label,
        updated_at = clock_timestamp()
    where request.id = candidate.request_id;

    delete from private.leave_request_reviewer_assignments assignment
    where assignment.leave_request_id = candidate.request_id
      and assignment.assignment_kind <> 'global';

    update private.leave_request_reviewer_assignments assignment
    set is_primary = false
    where assignment.leave_request_id = candidate.request_id;

    insert into private.leave_request_reviewer_assignments (
      leave_request_id,
      reviewer_user_id,
      source_grant_id,
      assignment_kind,
      reviewer_label,
      is_primary
    )
    values (
      candidate.request_id,
      candidate.reviewer_user_id,
      candidate.grant_id,
      candidate.scope_kind,
      candidate.reviewer_label,
      true
    )
    on conflict (leave_request_id, reviewer_user_id) do update
      set source_grant_id = excluded.source_grant_id,
          assignment_kind = excluded.assignment_kind,
          reviewer_label = excluded.reviewer_label,
          is_primary = true,
          assigned_at = clock_timestamp();

    v_updated := v_updated + 1;
  end loop;

  -- Manager-owned requests bypass the reporting chain. All configured global
  -- reviewers get the same request, with one primary display label only.
  for candidate in
    select r.id as request_id,r.employee_person_id from public.leave_requests r
    where r.status='submitted' and r.approval_required
      and private.is_manager_leave_person(r.employee_person_id)
  loop
    -- Fail closed if configuration is missing; never leave an old manager
    -- assignment looking like a valid route.
    delete from private.leave_request_reviewer_assignments a
      where a.leave_request_id=candidate.request_id;
    insert into private.leave_request_reviewer_assignments
      (leave_request_id,reviewer_user_id,source_grant_id,assignment_kind,reviewer_label,is_primary)
    select candidate.request_id,g.reviewer_user_id,g.grant_id,g.scope_kind,g.reviewer_label,
      row_number() over(order by g.scope_priority,g.grant_id)=1
    from private.resolve_leave_approval_grants(candidate.employee_person_id) g;
    update public.leave_requests r set
      manager_user_id=(select a.reviewer_user_id from private.leave_request_reviewer_assignments a
        where a.leave_request_id=r.id and a.is_primary),
      manager_name_snapshot=(select a.reviewer_label from private.leave_request_reviewer_assignments a
        where a.leave_request_id=r.id and a.is_primary),updated_at=clock_timestamp()
      where r.id=candidate.request_id;
    v_updated:=v_updated+1;
  end loop;
  return v_updated;
end;
$$;

create or replace function public.resolve_leave_notification_manager(p_request_id uuid)
returns table(manager_user_id uuid,manager_name text,manager_email text)
language sql stable security definer set search_path='' as $$
  with request_route as (
    select r.*,private.is_manager_leave_person(r.employee_person_id) as manager_owned
    from public.leave_requests r where r.id=p_request_id
  ), group_recipients as (
    select ap.id,ap.full_name,lower(nullif(btrim(d.work_email),'')) email,c.priority
    from request_route r
    join private.manager_leave_reviewers c on r.manager_owned
    join public.profiles ap on ap.id=c.reviewer_user_id
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  ), candidates as (
    select mp.auth_user_id,mp.full_name,d.work_email,0 priority
    from request_route r
    join lateral private.resolve_internal_org_employee_manager(r.employee_person_id) m on true
    join public.internal_org_people mp on mp.id=m.manager_id and mp.is_active
    join public.profiles ap on ap.id=mp.auth_user_id and ap.app_role in ('manager','system_admin')
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and not r.manager_owned and mp.auth_user_id is distinct from r.user_id
      and private.is_active_portal_account(mp.auth_user_id)
      and private.is_current_leave_request_reviewer(r.id,mp.auth_user_id)
    union all
    select ap.id,coalesce(mp.full_name,ap.full_name),d.work_email,case when a.is_primary then 1 else 2 end
    from request_route r join private.leave_request_reviewer_assignments a on a.leave_request_id=r.id
    join public.profiles ap on ap.id=a.reviewer_user_id and ap.app_role in ('manager','system_admin')
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and not r.manager_owned and ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  )
  (select c.auth_user_id,c.full_name,lower(nullif(btrim(c.work_email),'')) from candidates c
    order by c.priority,c.auth_user_id limit 1)
  union all
  select (array_agg(g.id order by g.priority,g.id))[1],
    string_agg(g.full_name,', ' order by g.priority,g.id),
    -- A missing address must not silently drop one of the required reviewers.
    case when bool_and(g.email is not null) then string_agg(g.email,',' order by g.priority,g.id) end
  from group_recipients g having count(*)>0;
$$;

create function private.valid_leave_email_recipients(p_emails text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(length(p_emails) between 3 and 2550
    and (select count(*) between 1 and 10
      and bool_and(length(e) between 3 and 254
        and e ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$')
      from unnest(string_to_array(p_emails,',')) e),false);
$$;
revoke all on function private.valid_leave_email_recipients(text) from public,anon,authenticated,service_role;

create or replace function public.claim_leave_notification_outbox(p_request_id uuid default null,p_limit integer default 50)
returns table(delivery_id uuid,claim_token uuid,payload jsonb)
language plpgsql security definer set search_path='' as $$
declare r private.leave_notification_outbox%rowtype; v_manager text; v_emails text[]; v_payload jsonb; v_token uuid;
begin
  for r in
    select q.* from private.leave_notification_outbox q
    where q.delivered_at is null and q.next_attempt_at<=clock_timestamp()
      and (q.claimed_until is null or q.claimed_until<clock_timestamp())
      and (p_request_id is null or q.request_id=p_request_id)
      and not exists(select 1 from private.leave_notification_outbox older
        where older.request_id=q.request_id and older.delivered_at is null
          and (older.created_at,older.id)<(q.created_at,q.id))
    order by q.created_at,q.id limit greatest(1,least(coalesce(p_limit,50),50))
    for update of q skip locked
  loop
    v_payload:=r.delivery_payload;
    if v_payload is null then
      select m.manager_email into v_manager from public.resolve_leave_notification_manager(r.request_id) m;
      select e.employee_emails into v_emails from public.resolve_leave_notification_employee_recipients(r.request_id) e;
      v_manager:=lower(nullif(btrim(v_manager),''));
      if not private.valid_leave_email_recipients(v_manager) then v_manager:=null; end if;
      v_emails:=array(select distinct lower(btrim(e.address)) from unnest(coalesce(v_emails,array[]::text[])) e(address)
        where btrim(e.address) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' order by 1);
      -- Missing address can be repaired before the next attempt. Once sent,
      -- the immutable payload and stable event key also govern retries.
      if (r.event in ('leave-submitted','leave-cancelled') and not private.valid_leave_email_recipients(v_manager))
        or (r.event in ('leave-approved','leave-declined','leave-conditionally-approved') and cardinality(v_emails)=0) then
        update private.leave_notification_outbox q set attempts=q.attempts+1,
          last_error='missing_recipient',next_attempt_at=clock_timestamp()+interval '21 minutes' where q.id=r.id;
        -- Surface a failed item to the worker's aggregate/HTTP health signal,
        -- without reserving or freezing an incomplete recipient snapshot.
        return query select r.id,null::uuid,null::jsonb;
        continue;
      end if;
      v_payload:=r.payload || jsonb_build_object('managerEmail',v_manager,
        'employeeEmail',nullif(array_to_string(v_emails,','),''),'employeeEmails',to_jsonb(v_emails));
    end if;
    v_token:=gen_random_uuid();
    update private.leave_notification_outbox q set delivery_payload=v_payload,claim_token=v_token,
      claimed_until=clock_timestamp()+interval '5 minutes',attempts=q.attempts+1 where q.id=r.id;
    return query select r.id,v_token,v_payload;
  end loop;
end;
$$;

-- Keep pending snapshots aligned with account, hierarchy and explicit grant
-- changes. The zz row triggers run after manager-grant synchronisation.
-- Rerouting changes requests/assignments only, so these triggers cannot recurse.
create function private.reroute_leave_after_eligibility_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.reroute_pending_leave_requests_to_current_manager();
  return null;
end;
$$;
revoke all on function private.reroute_leave_after_eligibility_change() from public,anon,authenticated,service_role;
create trigger profiles_zz_reroute_manager_leave
  after update of app_role,account_status,login_name on public.profiles
  for each row when ((old.app_role,old.account_status,old.login_name) is distinct from (new.app_role,new.account_status,new.login_name))
  execute function private.reroute_leave_after_eligibility_change();
create trigger internal_org_people_zz_reroute_manager_leave
  after insert or update of auth_user_id,is_active,parent_id on public.internal_org_people
  for each row execute function private.reroute_leave_after_eligibility_change();
create trigger manager_leave_reviewers_reroute
  after insert or update or delete on private.manager_leave_reviewers
  for each statement execute function private.reroute_leave_after_eligibility_change();
create trigger leave_approval_grants_reroute
  after insert or update or delete on private.leave_approval_grants
  for each statement execute function private.reroute_leave_after_eligibility_change();

-- No backfill runs before the verified reviewer membership is installed.
-- The release transaction configures membership and reroutes pending requests.
commit;
