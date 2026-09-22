"""Hash-pinned narrow subscription-patch release; run via credential exec supabase."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
VERSION = "20260922200000"
NAME = "subscription_bulk_edit"
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
SIGNATURE = "public.patch_subscription_v1(uuid,bigint,jsonb)"
spec = importlib.util.spec_from_file_location("release", ROOT / "scripts" / "deploy-reliability-migrations.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def verify(sql):
    expected_body = re.search(r"as \$\$(.*?)\$\$;", sql, re.S).group(1)
    state = release.query("""select
      exists(select 1 from supabase_migrations.schema_migrations where version='20260922200000') as migration_recorded,
      (select prosrc = """ + release.literal(expected_body) + """ and prosecdef and proconfig = array['search_path=""']
        from pg_proc where oid=to_regprocedure('public.patch_subscription_v1(uuid,bigint,jsonb)')) as definition_matches,
      has_function_privilege('authenticated',to_regprocedure('public.patch_subscription_v1(uuid,bigint,jsonb)'),'EXECUTE') as authenticated_granted,
      not has_function_privilege('anon',to_regprocedure('public.patch_subscription_v1(uuid,bigint,jsonb)'),'EXECUTE') as anon_denied,
      not has_function_privilege('service_role',to_regprocedure('public.patch_subscription_v1(uuid,bigint,jsonb)'),'EXECUTE') as service_denied,
      not has_table_privilege('authenticated','private.subscription_register','UPDATE') as table_private
    """)[0]
    print(json.dumps(state))
    return all(value is True for value in state.values())


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in ("inspect", "apply", "advisors"), "Use inspect, advisors or apply <reviewed-sha256>")
    project = release.api("")
    require(project["id"] == release.PROJECT and project["organization_id"] == release.ORG, "MAM target mismatch")
    print(json.dumps({"verifiedProject": release.PROJECT}))
    if operation == "advisors":
        for category in ("security", "performance"):
            counts = {}
            for lint in release.api("/advisors/" + category).get("lints", []):
                key = lint.get("name", "unknown") + ":" + lint.get("level", "unknown")
                counts[key] = counts.get(key, 0) + 1
            print(json.dumps({"category": category, "counts": counts}))
        return
    sql = MIGRATION.read_text()
    recorded = release.query("select statements from supabase_migrations.schema_migrations where version=" + release.literal(VERSION))
    if recorded:
        require(recorded[0]["statements"] == [sql], "Recorded migration differs")
    if operation == "inspect":
        verify(sql)
        return
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    require(release.query("select exists(select 1 from supabase_migrations.schema_migrations where version='20260922160000') as ready")[0]["ready"], "Subscription company predecessor missing")
    if not recorded:
        require(sql.count("\ncommit;") == 1 and sql.startswith("begin;"), "Unexpected transaction structure")
        history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + release.literal(VERSION) + "," + release.literal(NAME) + ",ARRAY[" + release.literal(sql) + "]);"
        release_sql = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        release.query(release_sql)
    require(verify(sql), "Subscription patch deployment verification failed")


if __name__ == "__main__":
    main()
