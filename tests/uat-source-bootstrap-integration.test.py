import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT/'qa-evidence/uat-20261016/bootstrap-owner'
CLI = ROOT/'deploy/uat/bootstrap-source/bootstrap.py'
spec = importlib.util.spec_from_file_location('uat_bootstrap_integration', CLI)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def persist(owned):
    (EVIDENCE/'ownTargets.json').write_text(json.dumps(owned,indent=2)+'\n')


def stopped(recorder, label, socket):
    recorder.run(label+'-stop',['node','scripts/local-test-postgres.mjs','stop',socket])
    recorder.run(label+'-status',['pg_ctl','-D',str(Path(socket)/'data'),'status'],expected_exit=3)
    if (Path(socket)/'.s.PGSQL.55439').exists() or (Path(socket)/'data/postmaster.pid').exists():
        raise ValueError('Owned socket or PID file survived stop')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--label',required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-z0-9-]+',args.label):
        parser.error('safe unique label required')
    owned = json.loads((EVIDENCE/'ownTargets.json').read_text())
    source = owned[0]
    module.owned_target(source['socket'],source['database'],owned)
    if not source['stopped'] or (Path(source['socket'])/'data/postmaster.pid').exists() or (Path(source['socket'])/'.s.PGSQL.55439').exists():
        raise ValueError('Source must be verified stopped before controlled export restart')
    package = EVIDENCE/('generated-'+args.label)
    logs = EVIDENCE/('integration-'+args.label)
    recorder = module.Recorder(logs)
    socket = source['socket']
    start = ['pg_ctl','-D',str(Path(socket)/'data'),'-l',str(Path(socket)/'snapshot-restart.log'),'-o',f"-k {socket} -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700 -c autovacuum=off",'-w','start']
    recorder.run('source-restart',start)
    source['stopped'] = False
    persist(owned)
    result = {}
    try:
        result = module.build(socket,source['database'],owned,
                              json.loads((EVIDENCE/'source-replay.receipt.json').read_text()),
                              json.loads((EVIDENCE/'unchanged-195-source-replay.receipt.json').read_text()),package)
    finally:
        stopped(recorder,'source-export',socket)
        source['stopped'] = True
        persist(owned)
    manifest_sha = result['manifest']['sha256']
    manifest = module.validate_package(package,manifest_sha)
    socket = recorder.run('second-cluster-start',['node','scripts/local-test-postgres.mjs','start']).decode().strip()
    marker = json.loads((Path(socket)/'mam-test-cluster.json').read_text())
    row = {'socket':socket,'database':'mam_test_uat_install','marker':marker,'purpose':'second independent empty SQL-only schema install '+args.label,'started':True,'stopped':False}
    owned.append(row)
    persist(owned)
    installed = None
    try:
        recorder.run('second-create-empty-db',['node','scripts/local-test-postgres.mjs','createdb',socket,row['database']])
        target = module.owned_target(socket,row['database'],owned)
        recorder.run('second-role-extension-prerequisites',['psql',*target,'-Atq','-f',str(package/'platform-roles-extensions.sql')],package/'platform-roles-extensions.sql')
        recorder.run('second-absent-storage-prerequisites',['psql',*target,'-Atq','-f',str(package/'empty-storage-prerequisites.sql')],package/'empty-storage-prerequisites.sql')
        fixture = []
        original = (ROOT/'tests/migrations/0001-supabase-platform.sql').read_text()
        for raw,skeleton in module.sql_statements(original):
            command = re.sub(r'\s+',' ',skeleton).lower()
            if command.startswith(('create schema auth','create table auth.','create function auth.','grant usage on schema auth')):
                fixture.append(raw)
        operator = (ROOT/'tests/migrations/operator-session-platform.sql').read_text()
        for raw,skeleton in module.sql_statements(operator):
            command = re.sub(r'\s+',' ',skeleton).lower()
            if command.startswith(('create table auth.sessions','alter table auth.users add column deleted_at')):
                fixture.append(raw)
        recorder.sql('sql-only-auth-fixture-never-shipped',target,'\n'.join(fixture))
        initial = json.loads(recorder.sql('second-empty-app-proof',target,"select jsonb_build_object('appRelations',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private')),'appRoutines',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),'authUsers',(select count(*) from auth.users),'historyAbsent',to_regclass('supabase_migrations.schema_migrations') is null);"))
        assert initial == {'appRelations':0,'appRoutines':0,'authUsers':0,'historyAbsent':True},initial
        negative_count = 0
        for label,fault,reason in [('unknown-namespace','create schema bootstrap_unknown;','Unreviewed schema in new UAT target'),('provider-business-rows','create table auth.bootstrap_audit_probe(id integer); insert into auth.bootstrap_audit_probe values(1);','Existing provider business rows: auth.bootstrap_audit_probe')]:
            file=logs/('fresh-target-denial-'+label+'.sql')
            file.write_text('begin;\nselect set_config(\'mam.uat.bootstrap_target\','+module.quote(row['database'])+',true);\nselect set_config(\'mam.uat.bootstrap_mode\',\'owned-sql-only\',true);\n'+fault+'\n\\ir '+str(package/'preflight.sql')+'\ncommit;\n')
            recorder.run('fresh-target-denial-'+label,['psql',*target,'-Atq','-f',str(file)],file,expected_exit=3)
            error=(logs/('fresh-target-denial-'+label+'.stderr.log')).read_text()
            assert '55000' in error and reason in error,error
            negative_count += 1
        clean=recorder.sql('fresh-target-denial-rollback',target,"select to_regnamespace('bootstrap_unknown') is null and to_regclass('auth.bootstrap_audit_probe') is null and to_regnamespace('private') is null;")
        assert clean=='t',clean
        provider = module.provider_observation(recorder,'second-initial-provider',target,manifest)
        provider_sha = module.sha(provider.encode())
        installed = module.install(socket,row['database'],owned,package,manifest_sha,provider_sha,logs/'installed')
        for label,override in [('wrong-target',['-v','uat_target=mam_test_other','-v','uat_mode=owned-sql-only']),('wrong-native-mode',['-v','uat_target='+row['database'],'-v','uat_mode=native-reviewed']),('existing-target',['-v','uat_target='+row['database'],'-v','uat_mode=owned-sql-only'])]:
            recorder.run('denial-'+label,['psql',*target,*override,'-v','provider_sha='+provider_sha,'-f',str(package/'install-new-uat.sql')],package/'install-new-uat.sql',expected_exit=3)
            error = (logs/('denial-'+label+'.stderr.log')).read_text()
            assert '55000' in error,error
            negative_count += 1
        expected_app = json.loads((package/'application-inventory.json').read_text())
        for label,fault in [('disabled-rls','alter table public.profiles disable row level security;'),('unexpected-rpc-acl','grant execute on function public.resolve_portal_login_auth_email(text) to authenticated;')]:
            file = logs/('fault-'+label+'.sql')
            file.write_text('begin;\n'+fault+'\n\\ir '+str(package/'validate-application.sql')+'\ncommit;\n')
            recorder.run('denial-'+label,['psql',*target,'-Atq','-f',str(file)],file,expected_exit=3)
            assert '55000' in (logs/('denial-'+label+'.stderr.log')).read_text()
            assert module.app_catalog(recorder,'rollback-'+label,target) == expected_app
            negative_count += 1
        for name in ('unified-role-capabilities.sql','unified-role-policy.sql'):
            file = ROOT/'tests'/name
            recorder.run('unchanged-'+file.stem,['psql',*target,'-Atq','-f',str(file)],file)
        final = module.validate_installed(recorder,target,package,manifest,provider)
        assert final['state']['authUsers']==0 and final['state']['authSessions']==0
        assert all(count==0 for table,count in final['rowCounts'].items() if table not in module.CONTROL_TABLES)
        module.validate_package(package,manifest_sha)
        module.save_json(logs/'result.json',{'package':result,'initialEmptyTarget':initial,'installedVerification':installed,'finalVerification':final,'negativeCases':negative_count,'originalRoleSuites':2,'classification':'OWNED_SYNTHETIC_SQL_ONLY','nativeAuth':False,'commands':recorder.records})
        print(json.dumps({'artifact':str(package),'manifestSha256':manifest_sha,'schemaSha256':result['schema']['sha256'],'sourceMigrationCount':195,'allAppObjectsReadBack':True,'negativeCases':negative_count,'originalRoleSuites':2,'nativeAuth':False}))
    finally:
        stopped(recorder,'second-install',socket)
        row['stopped'] = True
        persist(owned)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
