begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table public.leave_requests in access exclusive mode nowait;
create temporary table required_note_function_spec(signature text primary key,before_sha256 text not null,after_sha256 text not null) on commit drop;
insert into required_note_function_spec values
('private.enforce_leave_request_employment_policy()','6535b99e6244c42999825fd79262d29623e109f7af701810dcf4b6b410ff9819','129ff4a64cf0d48c021424e2f95562cee499b9c2baad32586885e6c29f03d4dc');
do $required_note_predecessor$ begin
 if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
 or exists(select 1 from required_note_function_spec s where encode(extensions.digest(pg_get_functiondef(to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.before_sha256) then
  raise exception 'Required-note predecessor differs.' using errcode='55000';
 end if;
end $required_note_predecessor$;
create temporary table required_note_function_before on commit drop as
select pg_get_functiondef(to_regprocedure(signature)) definition from required_note_function_spec;
do $required_note_collector$ declare query text; anchor text; begin
 select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
 anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
 if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
  raise exception 'Required-note collector differs.' using errcode='55000';
 end if;
 execute 'create function pg_temp.required_note_catalog() returns table(definition text) language sql stable set search_path='''' as '
  ||quote_literal(replace(query,anchor,'select definition from ('));
end $required_note_collector$;
create temporary table required_note_catalog_before on commit drop as select * from pg_temp.required_note_catalog();
create function pg_temp.required_note_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not a.attisdropped and a.attnum>0),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'routines',(select jsonb_agg(case when p.oid='private.enforce_leave_request_employment_policy()'::regprocedure then to_jsonb(p)-array['prosrc','prosqlbody'] else to_jsonb(p) end order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')
);
$$;
create function pg_temp.required_note_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'purges',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from private.confirmed_test_identity_purges t),
 'requests',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.leave_requests t),
 'events',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.leave_request_events t),
 'receipts',(select coalesce(jsonb_agg(to_jsonb(t) order by actor_user_id,submission_key),'[]') from private.leave_submission_receipts t),
 'notifications',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from private.leave_notification_outbox t),
 'attachments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.leave_request_attachments t)
);
$$;
create temporary table required_note_security_before on commit drop as select pg_temp.required_note_security() value;
create temporary table required_note_data_before on commit drop as select pg_temp.required_note_data() value;
CREATE OR REPLACE FUNCTION private.enforce_leave_request_employment_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person_id uuid;
  v_person_auth_user_id uuid;
  v_employment_type text;
begin
  if tg_op = 'INSERT' and new.record_origin = 'portal'
    and coalesce(new.reason, '') !~ U&'[^[:space:]\0085\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]' then
    raise exception 'Add a leave note before submitting this request.' using errcode = '22023';
  end if;
  if new.request_type_label='trade school' then
    select person.id,person.auth_user_id,detail.employment_type
    into v_person_id,v_person_auth_user_id,v_employment_type
    from public.internal_org_people person
    join private.employee_directory_details detail on detail.person_id=person.id
    join public.profiles target_profile on target_profile.id=person.auth_user_id
    where ((new.employee_person_id is not null and person.id=new.employee_person_id)
      or (new.employee_person_id is null and person.auth_user_id=new.user_id))
      and person.node_kind='person' and person.is_active
      and target_profile.account_status='active' and detail.trade_school_enabled
      and detail.employment_type in ('full_time','part_time')
    for share of person,detail,target_profile;
    if v_person_id is null or not private.is_active_portal_account(v_person_auth_user_id)
      or (new.user_id is not null and new.user_id is distinct from v_person_auth_user_id)
      or (new.record_origin='portal' and new.user_id is null) then
      raise exception 'Trade-school leave is not enabled for this employee.' using errcode='42501';
    end if;
    new.employee_person_id:=v_person_id;
    new.employment_type_snapshot:=v_employment_type;
    new.pay_treatment:='paid_other';
    new.leave_type:='other';
    return new;
  end if;

  if new.record_origin = 'historical_import' then
    select person.id, person.auth_user_id, detail.employment_type
    into v_person_id, v_person_auth_user_id, v_employment_type
    from public.internal_org_people person
    left join private.employee_directory_details detail
      on detail.person_id = person.id
    where person.id = new.employee_person_id
      and person.node_kind = 'person'
    limit 1;

    if v_person_id is null then
      raise exception 'A retained employee profile is required for historical leave.'
        using errcode = '23503';
    end if;

    if new.user_id is not null and new.user_id is distinct from v_person_auth_user_id then
      raise exception 'The historical leave login does not belong to the selected employee.'
        using errcode = '23503';
    end if;

    new.employment_type_snapshot := coalesce(new.employment_type_snapshot, v_employment_type);
    new.pay_treatment := coalesce(
      new.pay_treatment,
      case
        when new.request_type_label = 'Unpaid leave' then 'unpaid'
        when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
        when v_employment_type in ('abn', 'casual') then 'unpaid'
        else null
      end
    );
    return new;
  end if;

  select person.id, detail.employment_type
  into v_person_id, v_employment_type
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.auth_user_id = new.user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_employment_type is not null and v_employment_type not in ('full_time', 'part_time')
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'This employment type only allows Unpaid leave.'
      using errcode = '22023';
  end if;

  if v_employment_type is null
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'Ask a System Admin to set your employment type before requesting this leave.'
      using errcode = '22023';
  end if;

  new.employee_person_id := v_person_id;
  new.employment_type_snapshot := v_employment_type;
  new.pay_treatment := case
    when new.request_type_label = 'Unpaid leave' then 'unpaid'
    when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
    else 'unpaid'
  end;

  return new;
end;
$function$;

create temporary table required_note_catalog_added on commit drop as
select pg_get_functiondef(to_regprocedure(signature)) definition from required_note_function_spec;
create function pg_temp.required_note_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if exists(select 1 from required_note_function_spec s where encode(extensions.digest(pg_get_functiondef(to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.after_sha256)
 or pg_temp.required_note_security() is distinct from (select value from required_note_security_before)
 or pg_temp.required_note_data() is distinct from (select value from required_note_data_before) then
  raise exception 'Required-note exact delta differs.' using errcode='55000';
 end if;
 if exists((select definition collate "C" from required_note_catalog_before except all
  (select definition collate "C" from pg_temp.required_note_catalog() except all select definition collate "C" from required_note_catalog_added
   union all select definition collate "C" from required_note_function_before))
 union all
 ((select definition collate "C" from pg_temp.required_note_catalog() except all select definition collate "C" from required_note_catalog_added
   union all select definition collate "C" from required_note_function_before)
  except all select definition collate "C" from required_note_catalog_before)) then
  raise exception 'Required-note unknown catalog drift.' using errcode='55000';
 end if;
end $$;
set constraints all immediate;
select pg_temp.required_note_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
create temporary table required_note_catalog_after on commit drop as select private.confirmed_test_purge_schema_hash() value;
set constraints all immediate;
select pg_temp.required_note_assert_delta();
do $required_note_final$ begin
 if private.confirmed_test_purge_schema_hash() is distinct from (select value from required_note_catalog_after)
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from (select value from required_note_catalog_after) then
  raise exception 'Required-note final catalog differs.' using errcode='55000';
 end if;
end $required_note_final$;
commit;
