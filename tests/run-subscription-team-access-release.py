import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
socket, predecessor = sys.argv[1:3]
marker = json.loads((Path(socket) / "mam-test-cluster.json").read_text())
assert marker == {"owner": "mam-local-tests-v1", "socket": str(Path(socket).resolve()), "port": 55439}
assert Path(socket).parent.resolve() == Path(os.environ["TMPDIR"]).resolve()
assert re.fullmatch("mam_test_[a-z0-9_]+", predecessor)
env = {key: value for key, value in os.environ.items() if not key.startswith(("PG", "GIT_"))}
env.update(PGPASSFILE="/dev/null", PGSERVICEFILE="/dev/null", PYTHONDONTWRITEBYTECODE="1")


def command(args):
    return subprocess.check_output(args, env=env, stderr=subprocess.PIPE).decode().strip()


def sql(database, value):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", dir=socket) as handle:
        handle.write(value)
        handle.flush()
        result = subprocess.run(
            ["psql", "-X", "-h", socket, "-p", "55439", "-U", "postgres", "-d", database,
             "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-Atq", "-f", handle.name],
            env=env, capture_output=True, text=True,
        )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


prefix = "mam_test_team_release_" + uuid.uuid4().hex[:6]


def clone(label, template=predecessor):
    database = prefix + "_" + label
    command(["createdb", "-h", socket, "-p", "55439", "-U", "postgres", "--template=" + template, database])
    return database


helper = runpy.run_path(str(ROOT / "scripts/deploy-subscription-team-access.py"))
source = helper["MIGRATION"].read_text()
literal = helper["literal"]
locale_database = prefix + "_locale"
command(["createdb", "-h", socket, "-p", "55439", "-U", "postgres",
         "--template=template0", "--locale-provider=icu", "--icu-locale=en-US", locale_database])
collector_source = re.search(
    r"create function private\.confirmed_test_purge_schema_hash\(\)[\s\S]*?\$\$;",
    (ROOT / "supabase/migrations/20261001130000_confirmed_test_identity_cleanup.sql").read_text(),
).group()
sql(locale_database, """
create schema private;create schema storage;create schema extensions;create schema auth;
create extension pgcrypto with schema extensions;
create table auth.users(id uuid primary key);
create table private.confirmed_test_identity_purges(id uuid primary key);
create table private.confirmed_test_purge_schema(singleton boolean primary key default true,schema_hash text);
create table private.subscription_register(id uuid primary key,version bigint);
create function private.sr_register_gate() returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' and (new.source_request_id is not null) then return new; end if;
  return new;
end;$$;
""" + collector_source + """
insert into private.confirmed_test_purge_schema(schema_hash) select private.confirmed_test_purge_schema_hash();
""")
sql(locale_database, helper["PREDECESSOR"].read_text())
try:
    sql(locale_database, source.replace(' collate "C"', ""))
    raise AssertionError("Locale regression fixture did not distinguish inherited catalog ordering")
except RuntimeError as failure:
    assert "55000" in str(failure), str(failure)
sql(locale_database, source)
assert sql(locale_database, "select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;") == "t"
print("PASS: non-C database locale reproduces the ordering regression and reconciles with explicit catalog ordering", flush=True)
baseline = clone("base")
sql(baseline, "update private.subscription_request_config set enabled=true where singleton;")
original_hash = sql(baseline, "select schema_hash from private.confirmed_test_purge_schema where singleton;")
assert original_hash != sql(baseline, "select private.confirmed_test_purge_schema_hash();")
matched = clone("matched", baseline)
sql(matched, "update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();")
sql(matched, source)
assert sql(matched, "select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;") == "t"
print("PASS: matching catalog supports the membership migration without reconciliation", flush=True)

for index, (label, fault) in enumerate([
    ("unrelated catalog", "create table public.unreviewed_subscription_catalog(id integer);"),
    ("import grant", "grant select on private.existing_subscription_imports to authenticated;"),
    ("import function", "create or replace function private.consume_existing_subscription_import(p_record jsonb,p_operation text) returns boolean language sql as $$select true$$;"),
    ("unknown retained hash", "update private.confirmed_test_purge_schema set schema_hash=repeat('0',64);"),
]):
    database = clone("fault" + str(index), baseline)
    sql(database, fault)
    before = sql(database, "select schema_hash||':'||private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;")
    try:
        sql(database, source)
        raise AssertionError("Unreviewed predecessor accepted: " + label)
    except RuntimeError as failure:
        assert "55000" in str(failure), str(failure)
    assert sql(database, "select schema_hash||':'||private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;") == before
    assert sql(database, "select to_regprocedure('public.update_subscription_members_v1(uuid,bigint,uuid[])') is null;") == "t"
    print("PASS: migration rejects " + label + " and rolls back", flush=True)

late = clone("late", baseline)
injected = source.replace(
    "\nset constraints all immediate;",
    "\ncreate function public.updateXsubscription_members_v1() returns boolean language sql as $$ select true $$;\nset constraints all immediate;",
)
try:
    sql(late, injected)
    raise AssertionError("Late unrelated function accepted")
except RuntimeError as failure:
    assert "55000" in str(failure), str(failure)
assert sql(late, "select schema_hash from private.confirmed_test_purge_schema;") == original_hash
print("PASS: late catalog changes roll back reconciliation and membership migration together", flush=True)

sql(baseline, "create schema if not exists supabase_migrations;create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);")
ledger = []
for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
    version, name = migration.stem.split("_", 1)
    if version <= helper["PREDECESSOR_VERSION"]:
        ledger.append("insert into supabase_migrations.schema_migrations values(" + literal(version) + "," + literal(name) + ",ARRAY[" + literal(migration.read_text()) + "]) on conflict(version) do nothing;")
sql(baseline, "\n".join(ledger))
collector = sql(baseline, "select prosrc from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;")
collector = "\n" + collector + "\n"
expression = helper["state_expression"](source, helper["PREDECESSOR"].read_text(), collector)


def state(database):
    return json.loads(sql(database, "begin read only;set local search_path='';select " + expression + ";rollback;"))


before = state(baseline)
helper["validate_before"](before)
release = helper["transaction"](source, expression, before)
boundary = "\nset constraints all immediate;\ndo $release_final$"
assert release.count(boundary) == 1
for index, (label, fault) in enumerate([
    ("late register configuration", "update private.subscription_request_config set enabled=false;"),
    ("late ledger change", "update supabase_migrations.schema_migrations set name='unreviewed' where version='20261026233543';"),
    ("late unrelated grant", "grant select on private.existing_subscription_imports to authenticated;"),
]):
    database = clone("envelope" + str(index), baseline)
    original = state(database)
    try:
        sql(database, release.replace(boundary, "\n" + fault + boundary))
        raise AssertionError("Late release drift committed: " + label)
    except RuntimeError as failure:
        assert "55000" in str(failure), str(failure)
    assert state(database) == original
    print("PASS: atomic release rejects " + label + " without changing data or history", flush=True)

with tempfile.TemporaryDirectory(prefix="subscription-helper-", dir=socket) as copy:
    copy_root = Path(copy)
    paths = [str(helper[key].relative_to(ROOT)) for key in ("HELPER", "TRANSPORT", "MIGRATION", "PREDECESSOR")]
    for name in paths:
        target = copy_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    command(["git", "-C", copy, "init", "--quiet"])
    command(["git", "-C", copy, "config", "user.name", "mobilityaccessmodifications"])
    command(["git", "-C", copy, "config", "user.email", "310802599+mobilityaccessmodifications@users.noreply.github.com"])
    command(["git", "-C", copy, "remote", "add", "origin", "https://github.com/mobilityaccessmodifications/mam-team-management-system.git"])
    command(["git", "-C", copy, "add", "--", *paths])
    command(["git", "-C", copy, "commit", "--quiet", "-m", "Synthetic subscription release fixture"])
    head = command(["git", "-C", copy, "rev-parse", "HEAD"])
    pins = [head, *[hashlib.sha256((copy_root / name).read_bytes()).hexdigest() for name in paths]]
    candidate = runpy.run_path(str(copy_root / paths[0]))
    submitted = []

    def remote(request, **kwargs):
        if request.full_url == "https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm":
            value = {"id": "xtwlrjqbusadghavchqm", "organization_id": "fwlmbmospuwoaosffvmw"}
        else:
            assert request.full_url == "https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm/database/query"
            query = json.loads(request.data)["query"]
            submitted.append(query)
            result = sql(baseline, query)
            if "select prosrc as source" in query:
                value = [{"source": "\n" + result + "\n"}]
            elif query.startswith("begin read only;"):
                value = [{"state": json.loads(result)}]
            else:
                value = [{"resultingCatalogSha256": result.splitlines()[-1]}]
        return io.BytesIO(json.dumps(value).encode())

    previous = Path.cwd()
    try:
        os.chdir(copy)
        with patch.object(urllib.request, "urlopen", side_effect=remote), patch.dict(os.environ, {"SUPABASE_ACCESS_TOKEN": "synthetic"}):
            for mode in ("inspect", "apply", "apply"):
                with patch.object(sys, "argv", [str(copy_root / paths[0]), mode, *pins]):
                    candidate["main"]()
        assert [value for value in submitted if not value.startswith("begin read only;")] == [release]
        after = state(baseline)
        helper["validate_target"](after)
        assert after["existingCatalogHash"] == before["catalogHash"] and after["dataHash"] == before["dataHash"]
        assert after["ledger"][:-1] == before["ledger"]
        print("PASS: actual pinned helper reconciles only the known import, preserves existing data/ACLs, records exact source atomically and repeats read-only", flush=True)
    finally:
        os.chdir(previous)
