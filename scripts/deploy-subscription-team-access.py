import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
HELPER = Path(__file__).resolve()
TRANSPORT = ROOT / "scripts/deploy-reliability-migrations.py"
MIGRATION = ROOT / "supabase/migrations/20261027011041_subscription_team_access.sql"
PREDECESSOR = ROOT / "supabase/migrations/20261026233543_existing_subscription_import.sql"
VERSION = "20261027011041"
NAME = "subscription_team_access"
PREDECESSOR_VERSION = "20261026233543"
SIGNATURE = "public.update_subscription_members_v1(uuid,bigint,uuid[])"
COLLECTOR_SHA = "c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16"
TABLES = (
    "private.subscription_register", "private.subscription_memberships",
    "private.subscription_audit_events", "private.existing_subscription_imports",
    "private.subscription_request_config", "private.subscription_management_grants",
    "private.subscription_credential_access_grants", "private.subscription_credential_vault",
    "public.internal_org_people",
)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def state_expression(source, predecessor, collector):
    require(sha(collector.encode()) == COLLECTOR_SHA, "Catalog collector differs")
    normalized = collector.strip().removesuffix(";").replace(
        "where n.nspname in ('public','private') and p.prokind='f'",
        "where n.nspname in ('public','private') and p.prokind='f' and p.oid is distinct from to_regprocedure(" + literal(SIGNATURE) + ")",
    )
    body = source.split("as $$\n", 1)[1].split("\n$$;", 1)[0]
    data = " union all ".join(
        "select " + literal(table) + " as name, encode(extensions.digest(coalesce("
        "jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate \"C\"),'[]')::text,'sha256'),'hex') as hash from " + table + " t"
        for table in TABLES
    )
    return f"""jsonb_build_object(
 'major',current_setting('server_version_num')::integer/10000,
 'catalogHash',private.confirmed_test_purge_schema_hash(),
 'existingCatalogHash',({normalized}),
 'catalogMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
 'storedHash',(select schema_hash from private.confirmed_test_purge_schema where singleton),
 'dataHash',(select encode(extensions.digest(jsonb_agg(to_jsonb(t) order by name)::text,'sha256'),'hex') from ({data}) t),
 'approvalsEnabled',(select enabled from private.subscription_request_config where singleton),
 'predecessorExact',coalesce((select name='existing_subscription_import' and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(predecessor)}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
 'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
 'rpcPresent',to_regprocedure({literal(SIGNATURE)}) is not null,
 'rpcExact',coalesce((select prosrc={literal(chr(10) + body + chr(10))}
   and prosecdef and provolatile='v' and prokind='f' and prorettype='jsonb'::regtype
   and proconfig=array['search_path=""'] and pg_get_userbyid(proowner)='postgres'
   and has_function_privilege('authenticated',oid,'EXECUTE')
   and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
     where a.grantee not in (proowner,'authenticated'::regrole) or a.privilege_type<>'EXECUTE'
       or (a.grantee<>proowner and a.is_grantable))
   from pg_proc where oid=to_regprocedure({literal(SIGNATURE)})),false),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'dimensions',array_dims(statements),
   'sourceSha256',encode(extensions.digest(coalesce(statements::text,'<NULL>'),'sha256'),'hex')) order by version),'[]') from supabase_migrations.schema_migrations)
)"""


def read_state(expression, query):
    rows = query("begin read only;set local search_path='';set local statement_timeout='30s';select " + expression + " as state;rollback;")
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0].get("state"), dict), "Invalid metadata response")
    return rows[0]["state"]


def validate_before(state):
    versions = [row["version"] for row in state["ledger"]]
    require(state["major"] in (16, 17) and state["predecessorExact"] and state["approvalsEnabled"], "MAM predecessor or approval configuration differs")
    require(versions and len(versions) <= 512 and versions == sorted(set(versions)), "Unsupported migration ledger")
    require(versions[-1] == PREDECESSOR_VERSION and not state["targetExact"] and not state["rpcPresent"], "Latest predecessor or absent target differs")
    require(state["existingCatalogHash"] == state["catalogHash"], "Unexpected pre-existing team RPC catalog")


def validate_target(state):
    require(state["major"] in (16, 17) and state["predecessorExact"] and state["targetExact"]
            and state["catalogMatches"] and state["rpcExact"] and state["approvalsEnabled"], "Released source, RPC, ACL or catalog readback differs; do not retry")


def transaction(source, expression, before):
    require(source.startswith("begin;\n") and source.endswith("\ncommit;\n") and source.count("\ncommit;") == 1, "Unsupported migration boundaries")
    expected = literal(json.dumps(before, separators=(",", ":"), allow_nan=False)) + "::jsonb"
    ledger_row = f"jsonb_build_object('version',{literal(VERSION)},'name',{literal(NAME)},'dimensions','[1:1]','sourceSha256',encode(extensions.digest((ARRAY[{literal(source)}]::text[])::text,'sha256'),'hex'))"
    return f"""begin;
set local search_path='';set local lock_timeout='5s';set local statement_timeout='75s';
lock table supabase_migrations.schema_migrations in access exclusive mode nowait;
do $release_before$ begin
 if ({expression}) is distinct from {expected} then
   raise exception 'Subscription release predecessor changed' using errcode='55000';
 end if;
end $release_before$;
{source[len('begin;'):-len('commit;' + chr(10))]}
insert into supabase_migrations.schema_migrations(version,name,statements)
values({literal(VERSION)},{literal(NAME)},ARRAY[{literal(source)}]::text[]);
set constraints all immediate;
do $release_final$ declare actual jsonb; expected jsonb:={expected}; begin
 actual:={expression};
 if actual->>'existingCatalogHash' is distinct from expected->>'catalogHash'
 or actual->>'dataHash' is distinct from expected->>'dataHash'
 or actual->'major' is distinct from expected->'major'
 or actual->'catalogMatches' is distinct from 'true'::jsonb
 or actual->'predecessorExact' is distinct from 'true'::jsonb
 or actual->'targetExact' is distinct from 'true'::jsonb
 or actual->'rpcExact' is distinct from 'true'::jsonb
 or actual->'approvalsEnabled' is distinct from 'true'::jsonb
 or actual->'ledger' is distinct from (expected->'ledger')||jsonb_build_array({ledger_row}) then
   raise exception 'Subscription release final state differs' using errcode='55000';
 end if;
end $release_final$;
select private.confirmed_test_purge_schema_hash() as "resultingCatalogSha256";
notify pgrst,'reload schema';
commit;
"""


def main():
    args = sys.argv[1:]
    require(len(args) == 6 and args[0] in ("inspect", "apply"), "Use inspect|apply <reviewed-head> <helper-sha256> <transport-sha256> <migration-sha256> <predecessor-sha256>")
    require(re.fullmatch("[0-9a-f]{40}", args[1]) and all(re.fullmatch("[0-9a-f]{64}", value) for value in args[2:]), "Explicit reviewed source pins required")
    held = {path: path.read_bytes() for path in (HELPER, TRANSPORT, MIGRATION, PREDECESSOR)}
    require([sha(raw) for raw in held.values()] == args[2:], "Reviewed release bytes differ")

    def custody():
        def git(*values):
            return subprocess.check_output(["git", "-c", "core.fsmonitor=false", *values], cwd=ROOT).decode().strip()
        require(Path.cwd().resolve() == ROOT and git("rev-parse", "HEAD") == args[1] and not git("status", "--porcelain"), "Clean reviewed release HEAD required")
        require(git("remote", "get-url", "origin") == "https://github.com/mobilityaccessmodifications/mam-team-management-system.git", "Wrong source repository")
        require(git("show", "-s", "--format=%an <%ae>", "HEAD") == "mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>", "Wrong MAM commit author")
        for path, raw in held.items():
            committed = subprocess.check_output(["git", "show", "HEAD:" + str(path.relative_to(ROOT))], cwd=ROOT)
            require(path.read_bytes() == raw == committed, "Reviewed release source changed")

    custody()
    transport = runpy.run_path(str(TRANSPORT))
    target = transport["api"]("")
    require(target["id"] == "xtwlrjqbusadghavchqm" and target["organization_id"] == "fwlmbmospuwoaosffvmw", "Wrong MAM Supabase target")
    collector = transport["query"]("begin read only;select prosrc as source from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;rollback;")[0]["source"]
    source = held[MIGRATION].decode()
    expression = state_expression(source, held[PREDECESSOR].decode(), collector)
    before = read_state(expression, transport["query"])
    custody()
    if any(row["version"] == VERSION for row in before["ledger"]):
        validate_target(before)
        print(json.dumps({"readOnly": True, "readbackVerified": True, "version": VERSION}))
        return
    validate_before(before)
    if args[0] == "inspect":
        print(json.dumps({"readOnly": True, "targetVerified": True, "predecessorVerified": True, "catalogMatches": before["catalogMatches"], "version": VERSION}))
        return
    release = transaction(source, expression, before)
    custody()
    try:
        result = transport["query"](release)
        custody()
        require(isinstance(result, list) and len(result) == 1 and re.fullmatch("[0-9a-f]{64}", result[0].get("resultingCatalogSha256", "")), "Missing COMMIT attestation")
        after = read_state(expression, transport["query"])
        validate_target(after)
        require(after["catalogHash"] == result[0]["resultingCatalogSha256"]
                and after["existingCatalogHash"] == before["catalogHash"] and after["dataHash"] == before["dataHash"]
                and after["ledger"][:-1] == before["ledger"], "Preserved state readback differs")
        custody()
    except BaseException:
        raise SystemExit("Release outcome unverified. Reconcile read-only with inspect; never blindly retry.") from None
    print(json.dumps({"committed": True, "readbackVerified": True, "writeCount": 1, "version": VERSION, "catalogSha256": after["catalogHash"]}))


if __name__ == "__main__":
    main()
