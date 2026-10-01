\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql

do $$ declare tbl text; begin
  foreach tbl in array array['private.payroll_closing_receipts','private.payroll_carryforward_events','private.payroll_closing_write_claims'] loop
    begin
      insert into private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
      values('97abcdef-0000-4000-8002-000000000001','compat-census','91abcdef-0000-4000-8000-000000000001','closing','owner_estimate','Synthetic',
        case when tbl='private.payroll_closing_receipts' then jsonb_build_object('person','91abcdef-0000-4000-8000-000000000002') else '{}'::jsonb end,'{}');
      if tbl='private.payroll_carryforward_events' then
        insert into private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
        values('97abcdef-0000-4000-8002-000000000001','91abcdef-0000-4000-8001-000000000001','91abcdef-0000-4000-8000-000000000002','mam','annual','2026-09-01','2026-09-02',1,0,1,repeat('a',64));
      elsif tbl='private.payroll_closing_write_claims' then
        insert into private.payroll_closing_write_claims values('91abcdef-0000-4000-8000-000000000002',pg_current_xact_id(),'97abcdef-0000-4000-8002-000000000001');
      end if;
      perform private.confirmed_test_purge_census('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002');
      raise exception 'Payroll dependency accepted (%)',tbl;
    exception when foreign_key_violation then
      assert sqlerrm='purge_blocked: unreviewed/shared/immutable reference in '||tbl, 'Wrong payroll census blocker';
    end;
  end loop;
  assert not exists(select 1 from private.payroll_closing_receipts), 'Census evidence was deleted or retained unexpectedly';
  foreach tbl in array array['private.payroll_closing_receipts','private.payroll_carryforward_events','private.payroll_closing_write_claims'] loop
    begin
      if tbl='private.payroll_closing_receipts' then
        insert into private.payroll_closing_receipts(owner_key,actor_user_id,operation,provenance,note,payload,result)
        values('compat-retired','97abcdef-0000-4000-8000-000000000099','closing','owner_estimate','Synthetic','{}','{}');
      elsif tbl='private.payroll_carryforward_events' then
        insert into private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
        values(gen_random_uuid(),'91abcdef-0000-4000-8001-000000000001','97abcdef-0000-4000-8000-000000000099','mam','annual','2026-09-01','2026-09-02',1,0,1,repeat('a',64));
      else
        insert into private.payroll_closing_write_claims values('97abcdef-0000-4000-8000-000000000099',pg_current_xact_id(),gen_random_uuid());
      end if;
      raise exception 'Retired payroll reference accepted (%)',tbl;
    exception when check_violation then
      assert sqlerrm='Retired confirmed-test identity reference is prohibited', 'Wrong future-reference blocker';
    end;
  end loop;
end $$;

select pg_temp.set_test_actor('97abcdef-0000-4000-8000-000000000001');
set local role authenticated;
select public.claim_confirmed_test_identity_auth_delete('97abcdef-0000-4000-8001-000000000002');
reset role;
delete from auth.users where id='97abcdef-0000-4000-8000-000000000002';
do $$ declare tbl text; begin
  foreach tbl in array array['private.payroll_closing_receipts','private.payroll_carryforward_events','private.payroll_closing_write_claims'] loop
    begin
      perform set_config('session_replication_role','replica',true);
      insert into private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
      values('97abcdef-0000-4000-8002-000000000001','compat-post-absence','97abcdef-0000-4000-8000-000000000001','closing','owner_estimate','Synthetic',
        case when tbl='private.payroll_closing_receipts' then jsonb_build_object('person','97abcdef-0000-4000-8000-000000000002') else '{}'::jsonb end,'{}');
      if tbl='private.payroll_carryforward_events' then
        insert into private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
        values('97abcdef-0000-4000-8002-000000000001','91abcdef-0000-4000-8001-000000000001','97abcdef-0000-4000-8000-000000000002','mam','annual','2026-09-01','2026-09-02',1,0,1,repeat('a',64));
      elsif tbl='private.payroll_closing_write_claims' then
        insert into private.payroll_closing_write_claims values('97abcdef-0000-4000-8000-000000000002',pg_current_xact_id(),'97abcdef-0000-4000-8002-000000000001');
      end if;
      perform set_config('session_replication_role','origin',true);
      assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema), 'Synthetic row fault changed the catalog';
      perform public.complete_confirmed_test_identity_purge('97abcdef-0000-4000-8001-000000000002');
      raise exception 'Remaining payroll reference accepted (%)',tbl;
    exception when foreign_key_violation then
      assert sqlerrm='Operational reference remains in '||tbl, 'Wrong post-purge absence blocker';
    end;
  end loop;
  assert (select phase='auth_delete_started' from private.confirmed_test_identity_purges where id='97abcdef-0000-4000-8001-000000000002'), 'Blocked completion changed the receipt';
  assert not exists(select 1 from private.payroll_closing_receipts), 'Post-absence check mutated immutable history';
end $$;
rollback;
