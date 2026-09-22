begin;
create table private.payroll_comparison_only_importers (person_id uuid primary key references public.internal_org_people(id));
alter table private.payroll_comparison_only_importers enable row level security;
revoke all on private.payroll_comparison_only_importers from public,anon,authenticated,service_role;
alter table private.payroll_balance_import_batches add column comparison_only boolean not null default false;
create table private.payroll_balance_comparisons (
  batch_id uuid primary key references private.payroll_balance_import_batches(id),
  rows jsonb not null,
  difference_count integer not null,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  claim_token uuid,
  retry_at timestamptz not null default clock_timestamp()
);
alter table private.payroll_balance_comparisons enable row level security;
revoke all on private.payroll_balance_comparisons from public, anon, authenticated, service_role;

create function private.payroll_comparison_only(p_actor uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.payroll_comparison_only_importers g join public.internal_org_people p on p.id=g.person_id
 where p.auth_user_id=p_actor);
$$;
revoke all on function private.payroll_comparison_only(uuid) from public,anon,authenticated,service_role;

alter function private.payroll_balance_import_batch_projection(uuid) rename to payroll_balance_import_batch_projection_before_comparison;
create function private.payroll_balance_import_batch_projection(p_batch_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.payroll_balance_import_batch_projection_before_comparison(b.id) || jsonb_build_object(
 'comparisonOnly', b.comparison_only,
 'differenceCount', coalesce(c.difference_count,0),
 'comparisonRows',coalesce(c.rows,'[]'::jsonb))
 from private.payroll_balance_import_batches b left join private.payroll_balance_comparisons c on c.batch_id=b.id where b.id=p_batch_id;
$$;
revoke all on function private.payroll_balance_import_batch_projection(uuid) from public,anon,authenticated,service_role;

alter function public.stage_payroll_balance_import(uuid,text,jsonb,jsonb) rename to stage_payroll_balance_import_before_comparison;
revoke all on function public.stage_payroll_balance_import_before_comparison(uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.stage_payroll_balance_import(p_actor_user_id uuid,p_source_digest text,p_files jsonb,p_rows jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; bid uuid; comparison jsonb; differences integer;
begin
 result:=public.stage_payroll_balance_import_before_comparison(p_actor_user_id,p_source_digest,p_files,p_rows);
 bid:=(result->>'batchId')::uuid;
 if private.payroll_comparison_only(p_actor_user_id) then
  perform 1 from private.payroll_balance_import_batches where id=bid for update;
  update private.payroll_balance_import_batches set comparison_only=true where id=bid;
  if not exists(select 1 from private.payroll_balance_comparisons where batch_id=bid) then
   with values_to_compare as (
    select s.id,s.employee_name,s.company_key,s.as_of,s.match_status,
     v.kind,v.uploaded,v.system_hours,v.system_as_of
    from private.payroll_balance_import_stage_rows s
    left join private.employee_annual_leave_balances a on a.person_id=s.person_id
    left join private.employee_sick_leave_balances k on k.person_id=s.person_id
    cross join lateral (values
      ('annual',s.annual_hours,case when not a.is_example then a.hours-private.approved_leave_hours_after(s.person_id,array['Annual leave'],a.as_of) end,a.as_of),
      ('sick',s.sick_hours,k.hours-private.approved_leave_hours_after(s.person_id,array['Sick leave','Carer''s leave'],k.as_of),k.as_of)
    ) v(kind,uploaded,system_hours,system_as_of)
    where s.batch_id=bid and v.uploaded is not null
   ), compared as (
    select *,match_status<>'linked' or system_hours is null or round(uploaded,2) is distinct from round(system_hours,2) as different
    from values_to_compare
   )
   select jsonb_agg(jsonb_build_object('rowId',id,'employeeName',employee_name,'company',company_key,'kind',kind,
     'uploadedHours',uploaded,'systemHours',system_hours,'fileAsOf',as_of,'systemAsOf',system_as_of,
     'matchStatus',match_status,'different',different) order by company_key,employee_name,kind),count(*) filter(where different)
   into comparison,differences from compared;
   insert into private.payroll_balance_comparisons(batch_id,rows,difference_count) values(bid,coalesce(comparison,'[]'),differences);
  end if;
 end if;
 return private.payroll_balance_import_batch_projection(bid);
end;
$$;
revoke all on function public.stage_payroll_balance_import(uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.stage_payroll_balance_import(uuid,text,jsonb,jsonb) to service_role;

alter function public.commit_payroll_balance_import(uuid,bigint) rename to commit_payroll_balance_import_before_comparison;
revoke all on function public.commit_payroll_balance_import_before_comparison(uuid,bigint) from public,anon,authenticated,service_role;
create function public.commit_payroll_balance_import(p_batch_id uuid,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_payroll_balance_import_access() then raise exception 'Not authorised' using errcode='42501'; end if;
 perform 1 from private.payroll_balance_import_batches where id=p_batch_id for update;
 if private.payroll_comparison_only(auth.uid()) or exists(select 1 from private.payroll_balance_import_batches where id=p_batch_id and comparison_only) then
  raise exception 'This upload is comparison only. Existing balances have not changed.' using errcode='42501';
 end if;
 return public.commit_payroll_balance_import_before_comparison(p_batch_id,p_expected_version);
end;
$$;
revoke all on function public.commit_payroll_balance_import(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.commit_payroll_balance_import(uuid,bigint) to authenticated;

create function public.claim_payroll_comparison_alerts() returns table(batch_id uuid,claim_token uuid,difference_count integer)
language sql security definer set search_path='' as $$
 with due as(select c.batch_id from private.payroll_balance_comparisons c where c.difference_count>0 and c.delivered_at is null and c.retry_at<=clock_timestamp() order by c.created_at limit 10 for update skip locked)
 update private.payroll_balance_comparisons c set claim_token=gen_random_uuid(),retry_at=clock_timestamp()+interval '5 minutes'
 from due where c.batch_id=due.batch_id returning c.batch_id,c.claim_token,c.difference_count;
$$;
create function public.finish_payroll_comparison_alert(p_batch_id uuid,p_claim_token uuid,p_delivered boolean) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update private.payroll_balance_comparisons set delivered_at=case when p_delivered then clock_timestamp() else null end,
 claim_token=null,retry_at=clock_timestamp()+interval '5 minutes'
 where batch_id=p_batch_id and claim_token=p_claim_token and delivered_at is null;
 return found;
end;
$$;
revoke all on function public.claim_payroll_comparison_alerts() from public,anon,authenticated,service_role;
revoke all on function public.finish_payroll_comparison_alert(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.claim_payroll_comparison_alerts() to service_role;
grant execute on function public.finish_payroll_comparison_alert(uuid,uuid,boolean) to service_role;
alter function private.payroll_balance_missing_companies(date) rename to payroll_balance_missing_companies_before_comparison;
create function private.payroll_balance_missing_companies(p_reminder_month date) returns text[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(company),'{}'::text[]) from unnest(private.payroll_balance_missing_companies_before_comparison(p_reminder_month)) company
 where not exists(select 1 from private.payroll_balance_comparisons c join private.payroll_balance_import_stage_rows s on s.batch_id=c.batch_id
 where s.company_key=company and s.match_status='linked' and s.as_of>=p_reminder_month);
$$;
revoke all on function private.payroll_balance_missing_companies(date) from public,anon,authenticated,service_role;
create or replace function private.payroll_balance_monthly_reminder_projection()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with local_date as (
    select (clock_timestamp() at time zone 'Australia/Melbourne')::date as today
  ), cycle as (
    select
      local_date.today,
      date_trunc('month', local_date.today::timestamp)::date as reminder_month
    from local_date
  ), latest as (
    select
      max(imported.as_of) filter (where imported.company_key = 'mam' and imported.match_status = 'linked') as mam_as_of,
      max(imported.as_of) filter (where imported.company_key = 'equipsy' and imported.match_status = 'linked') as equipsy_as_of
    from (
      select company_key,match_status,as_of from private.payroll_balance_imports
      union all
      select s.company_key,s.match_status,s.as_of from private.payroll_balance_import_stage_rows s
      join private.payroll_balance_comparisons c on c.batch_id=s.batch_id
    ) imported
  )
  select jsonb_build_object(
    'dueOn', private.next_victorian_business_day(cycle.reminder_month),
    'mamAsOf', latest.mam_as_of,
    'equipsyAsOf', latest.equipsy_as_of,
    'mamComplete', latest.mam_as_of >= cycle.reminder_month,
    'equipsyComplete', latest.equipsy_as_of >= cycle.reminder_month,
    'complete', latest.mam_as_of >= cycle.reminder_month
      and latest.equipsy_as_of >= cycle.reminder_month
  )
  from cycle, latest;
$$;


commit;
