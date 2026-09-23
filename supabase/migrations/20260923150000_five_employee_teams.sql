begin;

lock table private.employee_directory_details in share row exclusive mode;
lock table public.internal_org_people in share mode;

-- Team is a presentation classification. Do not update company, reporting,
-- accounts, grants, leave records or balances during this consolidation.
create temporary table employee_team_mapping on commit drop as
select detail.person_id, detail.team_name as old_team,
  case
    when detail.team_name is null then null
    when person.company_key = 'equipsy' then 'Equipsy'
    when detail.team_name in ('MAM admin', 'Major', 'Minor', 'Warehouse', 'Equipsy') then detail.team_name
    when detail.team_name in ('Major Modifications Admin', 'Major Modifications Trades') then 'Major'
    when detail.team_name in ('Minor Modifications Admin', 'Minor Modifications Trades', 'Minor Mods') then 'Minor'
    when detail.team_name in ('Metal', 'Packing Team', 'Rubber', 'Timber') then 'Warehouse'
    when detail.team_name in ('Finance', 'Projects') then 'MAM admin'
    when detail.team_name = 'Management Team' then
      case person.position_title
        when 'Major Mods Team Leader' then 'Major'
        when 'Minor Mods Team Leader' then 'Minor'
        when 'Warehouse Manager' then 'Warehouse'
        when 'Process Analyst' then 'MAM admin'
        when 'CFO' then 'MAM admin'
        when 'Director' then 'MAM admin'
        when 'HR Manager' then 'MAM admin'
        else null
      end
    else null
  end as new_team
from private.employee_directory_details detail
join public.internal_org_people person on person.id = detail.person_id;

do $$ begin
  if exists (select 1 from employee_team_mapping where old_team is not null and new_team is null) then
    raise exception 'Unmapped employee team; review the mapping before applying.';
  end if;
end $$;

-- This is a label-only backfill: do not reschedule or replay check-in emails.
-- Transactional DDL restores the trigger on rollback; ordinary edits keep it.
alter table private.employee_directory_details disable trigger employee_directory_details_sync_employee_check_in_manager_email;

with changed as (
  update private.employee_directory_details detail
  set team_name = mapping.new_team
  from employee_team_mapping mapping
  where detail.person_id = mapping.person_id
    and detail.team_name is distinct from mapping.new_team
  returning detail.person_id
)
insert into private.employee_directory_audit_events(person_id, event_type, changed_fields)
select person_id, 'updated', array['team_name']::text[] from changed;

alter table private.employee_directory_details enable trigger employee_directory_details_sync_employee_check_in_manager_email;

-- Historical unknown teams stay null; never guess an archived person's team.
-- Existing RPCs retain their authentication, hierarchy and concurrency checks.
alter table private.employee_directory_details
  add constraint employee_directory_details_canonical_team
  check (team_name is null or team_name in ('MAM admin', 'Major', 'Minor', 'Warehouse', 'Equipsy'));

commit;
