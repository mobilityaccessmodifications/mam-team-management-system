begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $invitation_status_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance invitation status purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance invitation status purge baseline differs.' using errcode='55000';
  end if;
end $invitation_status_catalog_lock$;
create temporary table performance_invitation_status_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_invitation_status_function_spec(signature text primary key) on commit drop;
insert into performance_invitation_status_function_spec values
  ('public.performance_review_meeting_invitation_status(uuid,uuid)');
do $invitation_status_catalog_projection$
declare query text; anchor text;
begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance invitation status catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_invitation_status_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_invitation_status_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $invitation_status_catalog_projection$;
create temporary table performance_invitation_status_preserved_before on commit drop as
select * from pg_temp.performance_invitation_status_preserved_catalog();

do $invitation_status_predecessor$
begin
 if current_setting('server_version_num')::integer/10000 not in(16,17)
  or to_regprocedure('public.performance_review_meeting_invitation_status(uuid,uuid)') is not null
  or to_regclass('private.performance_review_meeting_requests') is null
  or exists(select 1 from (values
   ('private.performance_review_actor()','3db27f565923751a94e39948cc04d6f251f6a7dde19bdc277c3072435c020ec6',true,array['search_path=""'],false),
   ('private.performance_review_audience(private.performance_reviews)','fea23a3f42979da4699769c4007fbb0fc71ba03e173e6e7f4ad9e6cf7b776bbb',true,array['search_path=""'],false),
   ('private.performance_review_preview_actor(uuid)','7db25afafa74f515b9a7a6906920d20aa73d338609ea56c9fb6eec7b8ae7814a',true,array['search_path=""'],false),
   ('private.performance_review_preview_audience(private.performance_reviews,uuid,text)','d767fb659bf7c214c4521d366aa15b6cc19141fad45630800f312c05d51363e2',true,array['search_path=""'],false),
   ('public.finish_performance_review_notification(uuid,uuid,boolean)','89292ad173d5fcb232ab18bab282041408994d3897a5f6a08dc71c6776299ec0',true,array['search_path=""'],true),
   ('private.minimize_notification_delivery_receipts(text[],integer)','5f40220f6f30b38ec0062050cdb3add18dcd5d876974e20346535d6deef8f874',false,array['search_path=""']||array['lock_timeout=3s'],false)) expected(signature,body_hash,definer,config,service_enabled)
   left join pg_proc p on p.oid=to_regprocedure(expected.signature)
   where encode(extensions.digest(p.prosrc,'sha256'),'hex') is distinct from expected.body_hash
    or p.prosecdef is distinct from expected.definer or p.proconfig is distinct from expected.config or pg_get_userbyid(p.proowner)<>'postgres'
    or has_function_privilege('service_role',p.oid,'EXECUTE') is distinct from expected.service_enabled
    or exists(select 1 from unnest(array['anon','authenticated']) r where coalesce(has_function_privilege(r,p.oid,'EXECUTE'),true))) then
  raise exception 'Performance invitation status predecessor differs.' using errcode='55000';
 end if;
end $invitation_status_predecessor$;

create function public.performance_review_meeting_invitation_status(p_review_id uuid,p_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; audience text; delivered boolean;
begin
 if p_person_id is null then
  select * into strict actor from private.performance_review_actor();
 else
  select * into strict actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' then raise exception 'Performance review access denied.' using errcode='42501'; end if;
 end if;
 select * into review from private.performance_reviews r where r.id=p_review_id;
 if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
 if p_person_id is null then
  audience:=private.performance_review_audience(review);
  if audience is null or audience not in('manager','admin') then raise exception 'Performance review access denied.' using errcode='42501'; end if;
 else
  audience:=private.performance_review_preview_audience(review,actor.person_id,actor.role);
  if audience is distinct from 'manager' then raise exception 'Performance review access denied.' using errcode='42501'; end if;
 end if;
 select exists(select 1 from private.performance_review_notifications n
  join private.notification_delivery_receipts receipt on receipt.event_key='performance-review:'||review.id::text||':manager-invited'
   and ((receipt.state='sent' and receipt.recipient=n.recipient and receipt.cc=n.cc)
    or (receipt.state='sent_tombstone' and receipt.sent_at is not null and receipt.minimized_at is not null))
  where n.review_id=review.id and n.event='manager-invited' and n.state='provider_accepted') into delivered;
 return jsonb_build_object('reviewId',review.id,'sent',delivered);
end $$;
revoke all on function public.performance_review_meeting_invitation_status(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.performance_review_meeting_invitation_status(uuid,uuid) to authenticated;

do $invitation_status_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_invitation_status_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_invitation_status_preserved_before
      except all select definition collate "C" from pg_temp.performance_invitation_status_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_invitation_status_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_invitation_status_preserved_before))
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance invitation status unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance invitation status final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $invitation_status_catalog_after$;

commit;
