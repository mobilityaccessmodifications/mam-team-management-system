"""Apply the reviewed MAM Leave Change Profile projection via the scoped credential helper."""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260929150000"
NAME = "leave_read_grant_employee_preview"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
PREDECESSOR = ROOT / "supabase" / "migrations" / "20260907033546_fix_leave_preview_employee_person_id.sql"
SIGNATURE = "public.get_leave_workspace_for_preview(uuid)"


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


def query(statement):
    return api("/database/query", {"query": statement})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def verify_function(source):
    rows = query("""select p.prosrc, p.prosecdef, p.proconfig,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as active_allowed,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_allowed
      from pg_proc p where p.oid='public.get_leave_workspace_for_preview(uuid)'::regprocedure""")
    require(len(rows) == 1, "Leave preview function missing")
    row = rows[0]
    require(row["prosrc"] in source and row["prosecdef"]
            and row["proconfig"] == ['search_path=""']
            and row["active_allowed"] and not row["anon_allowed"],
            "Leave preview body or ACL drift")


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")
    require(len(sys.argv) == (2 if operation == "inspect" else 3), "Missing reviewed migration hash")
    statement = MIGRATION.read_text()
    if operation == "apply":
        require(hashlib.sha256(statement.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    project = api("")
    require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
            "MAM Supabase target mismatch")
    predecessor = query("""select version from supabase_migrations.schema_migrations
      where version in ('20260907033546','20260929133000','20260929140000')""")
    require({row["version"] for row in predecessor} == {"20260907033546", "20260929133000", "20260929140000"},
            "Leave preview/read-grant predecessors missing")
    granted = query("""select count(*) as grants,
      count(*) filter (where person.node_kind='person' and person.is_active
        and profile.account_status='active' and profile.login_name is not null
        and profile.app_role='employee' and person.auth_user_id is not null
        and not exists (select 1 from private.leave_approval_grants approval
          where approval.reviewer_user_id=person.auth_user_id
            and approval.revoked_at is null)) as eligible
      from private.leave_register_read_grants access_grant
      left join public.internal_org_people person on person.id=access_grant.person_id
      left join public.profiles profile on profile.id=person.auth_user_id""")
    require(len(granted) == 1 and int(granted[0]["grants"]) == 1
            and int(granted[0]["eligible"]) == 1, "Approved read-only grant identity is absent, ambiguous or ineligible")
    existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
    if existing:
        require(len(existing) == 1 and existing[0]["statements"] == [statement], "Recorded preview migration differs")
        verify_function(statement)
    else:
        verify_function(PREDECESSOR.read_text())
        if operation == "apply":
            require(statement.startswith("begin;\n") and statement.count("\ncommit;") == 1,
                    "Unexpected transaction structure")
            history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(statement) + "]);"
            release = statement.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
            query(release)
            recorded = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
            require(len(recorded) == 1 and recorded[0]["statements"] == [statement], "Applied preview migration ledger differs")
            verify_function(statement)
            existing = recorded
    print(json.dumps({"project": PROJECT, "migrationRecorded": bool(existing), "previewVerified": bool(existing)}))


if __name__ == "__main__":
    main()
