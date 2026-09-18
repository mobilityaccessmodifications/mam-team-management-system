"""Apply the reviewed, backwards-compatible login schema through MAM's wrapper.

This script changes schema only, never account logins or passwords. Employee
renames are a separate, explicitly scoped and audited production operation.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260918110000"
NAME = "employee_email_login"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"


def api(path, body=None):
    request = urllib.request.Request(
        "https://api.supabase.com/v1/projects/" + PROJECT + path,
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json", "User-Agent": "supabase-cli/2.54.11"},
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"MAM Supabase request failed: HTTP {error.code}") from None


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def verify_schema():
    status = query("""
select private.is_valid_portal_login('admin') as admin_supported,
  private.is_valid_portal_login('system_admin') as system_admin_supported,
  private.is_valid_portal_login('person@company.example') as email_supported,
  not private.is_valid_portal_login('invalid@@company.example') as malformed_denied,
  exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relname='profiles_login_name_unique_idx' and i.indisunique and i.indisvalid)
    as unique_login_index,
  not has_function_privilege('anon','public.resolve_portal_login_auth_email(text)','execute')
    as anon_resolver_denied,
  not has_function_privilege('authenticated','public.resolve_portal_login_auth_email(text)','execute')
    as employee_resolver_denied,
  has_function_privilege('service_role','public.resolve_portal_login_auth_email(text)','execute')
    as service_resolver_allowed,
  position('private.is_valid_portal_login' in pg_get_functiondef(
    'public.create_portal_account(uuid,uuid,text,text,bigint)'::regprocedure))>0
    as creation_validates_login,
  position('private.is_valid_portal_login' in pg_get_functiondef(
    'public.update_portal_login(uuid,uuid,text,bigint)'::regprocedure))>0
    as rename_validates_login
""")[0]
    require(all(status.values()), "Email login schema verification failed")
    print(json.dumps(status))


project = api("")
require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
        "MAM Supabase target mismatch")
print("Verified MAM project", PROJECT)
operation = sys.argv[1] if len(sys.argv) > 1 else ""
existing = query("select version from supabase_migrations.schema_migrations where version=" + literal(VERSION))
if operation == "inspect":
    print(json.dumps({"migration_recorded": bool(existing)}))
    if existing:
        verify_schema()
elif operation == "apply":
    require(len(sys.argv) == 3, "Use apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    require(hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    if not existing:
        require(sql.count("\ncommit;") == 1, "Unexpected migration transaction")
        history = "insert into supabase_migrations.schema_migrations(version,name,statements) values("
        history += literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
        release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='45s';", 1)
        release = release.replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release)
        print("Applied reviewed email login schema; account identities and passwords unchanged")
    verify_schema()
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
