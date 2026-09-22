"""Hash-pinned MAM subscription release. Run through credential exec supabase.

inspect/apply verify the exact target and unique active manager identities.
Only aggregate/schema evidence is printed, never employee or subscription rows.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260922160000"
NAME = "subscription_company_and_managers"
MIGRATION = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def api(path, body=None):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}{path}",
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json", "User-Agent": "supabase-cli/2.54.11"},
        data=None if body is None else json.dumps(body).encode(),
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def verify():
    state = query("""select
      exists(select 1 from pg_attribute where attrelid='private.subscription_register'::regclass
        and attname='company_scope' and not attisdropped) as company_column,
      (select relrowsecurity from pg_class where oid='private.subscription_management_grants'::regclass) as grants_rls,
      not has_table_privilege('authenticated','private.subscription_management_grants','INSERT') as grants_private,
      not has_function_privilege('authenticated','private.set_subscription_company(uuid,text)','EXECUTE') as helper_private,
      has_function_privilege('authenticated','public.create_subscription_v4(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[])','EXECUTE') as create_granted,
      has_function_privilege('authenticated','public.update_subscription_v4(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[])','EXECUTE') as update_granted,
      (select count(*)=2 from private.subscription_management_grants g
        join public.internal_org_people p on p.id=g.person_id
        join public.profiles a on a.id=p.auth_user_id
        where lower(btrim(p.full_name)) in ('europe karki','luke symes') and p.is_active
          and a.account_status='active' and a.login_name is not null) as both_managers_granted,
      position('company_scope' in pg_get_functiondef('private.subscription_register_v2_projection(uuid)'::regprocedure))>0 as company_projected
    """)[0]
    require(all(state.values()), "Deployed subscription schema verification failed")
    print(json.dumps(state))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply", "advisors"), "Use inspect, advisors or apply <reviewed-sha256>")
project = api("")
require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION, "MAM target mismatch")
print(json.dumps({"verifiedProject": PROJECT}))
if operation == "advisors":
    for category in ("security", "performance"):
        data = api("/advisors/" + category)
        counts = {}
        for lint in data.get("lints", []):
            key = lint.get("name", "unknown") + ":" + lint.get("level", "unknown")
            counts[key] = counts.get(key, 0) + 1
        print(json.dumps({"category": category, "counts": counts}))
    sys.exit(0)
sql = MIGRATION.read_text()
if operation == "apply":
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
base = query("select version from supabase_migrations.schema_migrations where version in ('20260915160000','20260917123501')")
require(len(base) == 2, "Subscription/access predecessor migration missing")
identity = query("""select count(*)=2 and bool_and(matches=1) as uniquely_resolved
  from (select desired.name,count(p.id) as matches
    from (values ('europe karki'),('luke symes')) desired(name)
    left join (public.internal_org_people p join public.profiles a on a.id=p.auth_user_id)
      on lower(btrim(p.full_name))=desired.name and p.is_active and p.node_kind='person'
        and a.account_status='active' and a.login_name is not null
    group by desired.name) targets""")[0]
require(identity["uniquely_resolved"], "Manager identities did not resolve uniquely")
existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
if existing:
    require(existing[0]["statements"] == [sql], "Recorded migration differs")
print(json.dumps({"managersUniquelyResolved": True, "migrationRecorded": bool(existing)}))
if operation == "apply" and not existing:
    require(sql.count("\ncommit;") == 1, "Unexpected transaction structure")
    history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
    release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
    query(release)
if existing or operation == "apply":
    verify()
