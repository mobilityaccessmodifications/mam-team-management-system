import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261026233543_existing_subscription_import.sql"


def api(path, body=None):
    request = urllib.request.Request(
        "https://api.supabase.com/v1/projects/" + PROJECT + path,
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json"},
        data=None if body is None else json.dumps(body).encode(),
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql, read_only=False):
    return api("/database/query", {"query": sql, "read_only": read_only})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def import_sql(data):
    return """begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(hashtextextended('mam:existing-subscription-import',0));
do $import$
declare payload jsonb := %s::jsonb; item jsonb; s private.subscription_register%%rowtype;
  owner_id uuid; matches integer; existing boolean; op text;
begin
  if jsonb_array_length(payload->'subscriptions') not between 1 and 100
    or char_length(btrim(payload->>'approvalReference')) not between 1 and 500 then
    raise exception 'Invalid import manifest';
  end if;
  select count(*), min(id::text)::uuid into matches, owner_id
    from public.internal_org_people where is_active and node_kind='person'
      and lower(btrim(full_name))=lower(btrim(payload->>'responsiblePerson'));
  if matches<>1 then raise exception 'Responsible person must resolve uniquely'; end if;
  for item in select value from jsonb_array_elements(payload->'subscriptions') loop
    if item->>'company' not in ('mam','equipsy','both') or item->>'company' is null
      or char_length(btrim(item->>'service')) not between 1 and 160 or item->>'service' is null
      or jsonb_typeof(item->'amountCents') is distinct from 'number'
      or (item->>'amountCents')::integer not between 0 and 100000000 then
      raise exception 'Invalid subscription';
    end if;
    perform 1 from private.subscription_register
      where lower(regexp_replace(service_name,'[^a-zA-Z]','','g')) =
        lower(regexp_replace(item->>'service','[^a-zA-Z]','','g'))
        and (company_scope=item->>'company' or company_scope='both' or item->>'company'='both')
      for update;
    select count(*) into matches from private.subscription_register
      where lower(regexp_replace(service_name,'[^a-zA-Z]','','g')) =
        lower(regexp_replace(item->>'service','[^a-zA-Z]','','g'))
        and (company_scope=item->>'company' or company_scope='both' or item->>'company'='both');
    if matches>1 then raise exception 'Ambiguous existing subscription'; end if;
    existing := matches=1;
    if existing then
      select * into strict s from private.subscription_register
        where lower(regexp_replace(service_name,'[^a-zA-Z]','','g')) =
          lower(regexp_replace(item->>'service','[^a-zA-Z]','','g'))
          and (company_scope=item->>'company' or company_scope='both' or item->>'company'='both');
      if s.company_scope is distinct from item->>'company' or s.source_request_id is not null
        or s.subscription_status<>'active' then
        raise exception 'Existing subscription needs separate reconciliation';
      end if;
      if s.amount_cents=(item->>'amountCents')::integer and s.responsible_person_id=owner_id
        and s.billing_cycle='monthly' and s.pricing_model='paid' then continue; end if;
    else
      s := jsonb_populate_record(null::private.subscription_register,jsonb_build_object(
        'id',gen_random_uuid(),'subscription_code','MAM-SUB-' || lpad(nextval('private.subscription_code_sequence')::text,6,'0'),
        'service_name',btrim(item->>'service'),'subscription_status','active',
        'currency_code','AUD','created_at',clock_timestamp(),'updated_at',clock_timestamp(),
        'version',1,'next_review_on',private.next_paid_subscription_quarter_review_on(),
        'company_scope',item->>'company'));
    end if;
    s.pricing_model := 'paid'; s.billing_cycle := 'monthly';
    s.amount_cents := (item->>'amountCents')::integer; s.responsible_person_id := owner_id;
    if not existing then s.plan_name := nullif(btrim(item->>'plan'),''); end if;
    op := case when existing then 'UPDATE' else 'INSERT' end;
    insert into private.existing_subscription_imports(approval_reference,operation,expected_record)
      values(payload->>'approvalReference',op,to_jsonb(s)-array['version','updated_at','next_review_on']);
    if existing then
      update private.subscription_register set pricing_model=s.pricing_model,billing_cycle=s.billing_cycle,
        amount_cents=s.amount_cents,responsible_person_id=s.responsible_person_id where id=s.id;
    else
      insert into private.subscription_register select (s).*;
    end if;
    if exists(select 1 from private.existing_subscription_imports
      where transaction_id=txid_current() and consumed_at is null) then
      raise exception 'Import authorisation was not consumed';
    end if;
    insert into private.subscription_audit_events(subscription_id,event_type,changed_fields)
      values(s.id,case when existing then 'updated' else 'created' end,
        array['service_name','company_scope','pricing_model','billing_cycle','amount_cents','responsible_person_id']);
  end loop;
end;
$import$;
commit;
""" % literal(json.dumps(data))


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ("schema", "inspect", "apply"):
        raise SystemExit("Use schema <reviewed-sha256> | inspect <manifest.json> | apply <manifest.json> <reviewed-sha256>")
    operation = sys.argv[1]
    project = api("")
    if project["id"] != PROJECT or project["organization_id"] != ORGANISATION:
        raise SystemExit("MAM target mismatch")
    if operation == "schema":
        sql = MIGRATION.read_text()
        if hashlib.sha256(sql.encode()).hexdigest() != sys.argv[2]:
            raise SystemExit("Reviewed migration differs")
        version, name = MIGRATION.stem.split("_", 1)
        recorded = query("select statements from supabase_migrations.schema_migrations where version=" + literal(version), True)
        if recorded:
            if recorded[0]["statements"] != [sql]:
                raise SystemExit("Recorded migration differs")
        else:
            history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(version) + "," + literal(name) + ",ARRAY[" + literal(sql) + "]);"
            query(sql.replace("\ncommit;", "\n" + history + "\ncommit;"))
        state = query("""select
          (select relrowsecurity from pg_class where oid='private.existing_subscription_imports'::regclass) as rls,
          (select enabled from private.subscription_request_config where singleton) as approvals_enabled,
          position('consume_existing_subscription_import' in pg_get_functiondef('private.sr_register_gate()'::regprocedure))>0 as gate_installed,
          (select bool_and(not has_table_privilege(r,'private.existing_subscription_imports','INSERT')
            and not has_function_privilege(r,'private.consume_existing_subscription_import(jsonb,text)','EXECUTE'))
            from unnest(array['anon','authenticated','service_role']) r) as backend_only
        """, True)[0]
        if not all(value is True for value in state.values()):
            raise SystemExit("Import schema verification failed")
        print(json.dumps({"schemaVerified": True, "project": PROJECT}))
        return
    raw = Path(sys.argv[2]).read_bytes()
    data = json.loads(raw)
    digest = hashlib.sha256(raw).hexdigest()
    if operation == "apply":
        if len(sys.argv) != 4 or sys.argv[3] != digest:
            raise SystemExit("Reviewed manifest differs")
        query(import_sql(data))
    rows = query("select service_name,amount_cents,billing_cycle,subscription_status,company_scope,p.full_name as responsible from private.subscription_register s join public.internal_org_people p on p.id=s.responsible_person_id where company_scope in ('equipsy','both') and lower(regexp_replace(service_name,'[^a-zA-Z]','','g')) in (" + ",".join(literal("".join(c for c in item["service"].lower() if c.isascii() and c.isalpha())) for item in data["subscriptions"]) + ")", True)
    if operation == "apply":
        expected = {(item["service"].lower(), item["amountCents"], "monthly", "active", item["company"], data["responsiblePerson"]) for item in data["subscriptions"]}
        actual = {(r["service_name"].lower(), r["amount_cents"], r["billing_cycle"], r["subscription_status"], r["company_scope"], r["responsible"]) for r in rows}
        if actual != expected or len(rows) != len(expected):
            raise SystemExit("Saved-record verification failed")
    print(json.dumps({"operation": operation, "manifestSha256": digest, "matchingRecords": len(rows), "requestedRecords": len(data["subscriptions"])}))


if __name__ == "__main__":
    main()
