import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startCluster, createDatabase, stopCluster, sql } from "../scripts/local-test-postgres.mjs";

test("existing import is exact, backend-only, audited and idempotent", () => {
  const socket = startCluster();
  const database = "mam_test_existing_subscriptions";
  try {
    createDatabase(socket, database);
    sql(socket, database, `
      create role anon; create role authenticated; create role service_role;
      create schema private;
      create table public.internal_org_people(id uuid primary key,full_name text,is_active boolean,node_kind text);
      insert into public.internal_org_people values('00000000-0000-0000-0000-000000000001','Synthetic Owner',true,'person');
      create sequence private.subscription_code_sequence;
      create table private.subscription_register(
        id uuid primary key,subscription_code text,service_name text,plan_name text,subscription_status text,
        pricing_model text,billing_cycle text,amount_cents integer,currency_code text,renewal_date date,
        next_review_on date,responsible_person_id uuid,created_by uuid,updated_by uuid,
        created_at timestamptz,updated_at timestamptz,version bigint,seat_count integer,
        mam_credit_card_used boolean,billing_anchor_date date,credit_card_holder text,company_scope text,
        source_request_id uuid,source_approved_version bigint,start_date date);
      create table private.subscription_audit_events(subscription_id uuid,event_type text,changed_fields text[]);
      create function private.next_paid_subscription_quarter_review_on() returns date language sql as $$ select current_date+90 $$;
      create function private.sr_register_gate() returns trigger language plpgsql as $$
      begin
        if tg_op='UPDATE' and old.source_request_id is distinct from new.source_request_id then
          raise exception 'immutable provenance';
        end if;
  if tg_op='INSERT' and (new.source_request_id is not null) then return new; end if;
        if new.pricing_model='paid' then raise exception 'approval required'; end if;
        return new;
      end; $$;
      create trigger subscription_request_register_gate before insert or update
        on private.subscription_register for each row execute function private.sr_register_gate();
    `);
    const originalGate = sql(socket, database, "select pg_get_functiondef('private.sr_register_gate()'::regprocedure)");
    sql(socket, database, readFileSync(new URL("../supabase/migrations/20261026233543_existing_subscription_import.sql", import.meta.url), "utf8"));
    const patchedGate = sql(socket, database, "select pg_get_functiondef('private.sr_register_gate()'::regprocedure)");
    assert.equal(patchedGate.replace("  if private.consume_existing_subscription_import(to_jsonb(new), tg_op) then return new; end if;\n", ""), originalGate);
    const makeImport = (amount) => {
      const data = { approvalReference: "synthetic test approval", responsiblePerson: "Synthetic Owner", subscriptions: [
        { service: "Synthetic Service", company: "equipsy", amountCents: amount },
      ] };
      const result = spawnSync("python3", ["-c", "import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(m['import_sql'](json.loads(sys.argv[2])))",
        new URL("../scripts/import-existing-subscriptions.py", import.meta.url).pathname, JSON.stringify(data)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    sql(socket, database, makeImport(22000));
    sql(socket, database, makeImport(22000));
    assert.equal(sql(socket, database, "select count(*)||':'||min(amount_cents) from private.subscription_register").trim(), "1:22000");
    assert.equal(sql(socket, database, "select count(*) from private.existing_subscription_imports where consumed_at is not null").trim(), "1");
    sql(socket, database, makeImport(25000));
    assert.equal(sql(socket, database, "select count(*)||':'||min(amount_cents) from private.subscription_register").trim(), "1:25000");
    assert.equal(sql(socket, database, "select count(*) from private.subscription_audit_events").trim(), "2");
    assert.equal(sql(socket, database, `select bool_and(not has_table_privilege(r,'private.existing_subscription_imports','INSERT')
      and not has_function_privilege(r,'private.consume_existing_subscription_import(jsonb,text)','EXECUTE'))
      from unnest(array['anon','authenticated','service_role']) r`).trim(), "t");
    assert.equal(sql(socket, database, "select relrowsecurity from pg_class where oid='private.existing_subscription_imports'::regclass").trim(), "t");
    assert.throws(() => sql(socket, database, "update private.subscription_register set amount_cents=1"), /approval required/);
    assert.throws(() => sql(socket, database, "update private.subscription_register set source_request_id=gen_random_uuid()"), /immutable provenance/);
    sql(socket, database, `insert into private.existing_subscription_imports(approval_reference,operation,expected_record)
      select 'expired synthetic approval','UPDATE',to_jsonb(s)-array['version','updated_at','next_review_on'] from private.subscription_register s`);
    assert.throws(() => sql(socket, database, "update private.subscription_register set amount_cents=25000"), /approval required/);
    sql(socket, database, `begin;
      insert into private.existing_subscription_imports(approval_reference,operation,expected_record)
        select 'mismatched synthetic approval','UPDATE',to_jsonb(s)-array['version','updated_at','next_review_on'] from private.subscription_register s;
      do $$ begin
        begin update private.subscription_register set amount_cents=123; raise exception 'unexpected success';
        exception when raise_exception then if sqlerrm<>'approval required' then raise; end if; end;
      end $$; rollback;`);
  } finally {
    stopCluster(socket);
  }
});
