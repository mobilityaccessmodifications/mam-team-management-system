import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
BASE = 'ff9da87f8d4c5b9b98e7d499e2b21cc91fc09541'
CONTRACT = '637cae723762c6c889285d765db4d9fbb47bc55c18199272b81c2fd1fdee82af'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def source_inventory():
    if git('rev-parse', 'HEAD').decode().strip() != BASE:
        raise ValueError('Source base differs from the frozen UAT contract')
    common = json.loads((ROOT/'qa-evidence/uat-20261016/common-source-pins.json').read_text())
    if common['base'] != BASE or common['files']['docs/uat-performance-contract-v1.md'] != CONTRACT:
        raise ValueError('Unrecognized common source contract')
    for name, expected in common['files'].items():
        if sha((ROOT/name).read_bytes()) != expected:
            raise ValueError('Common source changed: '+name)
    names = git('ls-tree', '-r', '--name-only', BASE, '--', 'scripts', 'tests', 'supabase/migrations', 'package.json', 'package-lock.json').decode().splitlines()
    tracked = git('ls-tree', '-r', '--name-only', BASE, '--', 'supabase/migrations').decode().splitlines()
    current = sorted(str(p.relative_to(ROOT)) for p in (ROOT/'supabase/migrations').glob('*.sql'))
    if len(current) != 195 or current != tracked:
        raise ValueError('Expected exactly the 195 unchanged original migrations')
    inputs = {}
    migrations = []
    for name in names:
        raw = (ROOT/name).read_bytes()
        expected = git('show', BASE+':'+name)
        if raw != expected:
            raise ValueError('Original source changed: '+name)
        entry = {'sha256':sha(raw), 'bytes':len(raw)}
        inputs[name] = entry
        if name in tracked:
            migrations.append({'path':name, **entry})
    return {'format':'mam-uat-source-schema-v1', 'base':BASE, 'common':common['files'],
            'commonPinsSha256':sha((ROOT/'qa-evidence/uat-20261016/common-source-pins.json').read_bytes()),
            'migrations':migrations, 'inputs':inputs}


def owned_target(socket, database, owned):
    scratch = Path(os.environ.get('TMPDIR', '')).resolve()
    candidate = Path(socket)
    if not candidate.is_absolute() or str(candidate.resolve()) != socket or candidate.parent != scratch or not re.fullmatch(r'mam-openclaw-pg\.[A-Za-z0-9]+', candidate.name):
        raise ValueError('A task-owned local PostgreSQL socket is required')
    if not re.fullmatch('mam_test_[a-z0-9_]+', database) or len(database) > 63:
        raise ValueError('A synthetic owned database is required')
    expected = {'owner':'mam-local-tests-v1', 'socket':socket, 'port':55439}
    marker = json.loads((candidate/'mam-test-cluster.json').read_text())
    if marker != expected or not any(row.get('socket') == socket and row.get('database') == database and row.get('marker') == expected for row in owned):
        raise ValueError('Missing explicit task ownership of the target')
    return ['-X', '-h', socket, '-p', '55439', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']


def sql_statements(text):
    statements, raw, skeleton = [], [], []
    index = 0
    while index < len(text):
        if text.startswith('--', index):
            end = text.find('\n', index)
            end = len(text) if end < 0 else end + 1
            raw.append(text[index:end])
            skeleton.append(' ')
            index = end
        elif text.startswith('/*', index):
            end, depth = index + 2, 1
            while depth and end < len(text):
                if text.startswith('/*', end):
                    depth, end = depth + 1, end + 2
                elif text.startswith('*/', end):
                    depth, end = depth - 1, end + 2
                else:
                    end += 1
            if depth:
                raise ValueError('Unterminated schema-only SQL comment')
            raw.append(text[index:end])
            skeleton.append(' ')
            index = end
        elif text[index] in "'\"":
            quote, end = text[index], index + 1
            escaped = quote == "'" and index > 0 and text[index - 1] in 'eE' and (index == 1 or not text[index - 2].isalnum())
            while end < len(text):
                if escaped and text[end] == '\\':
                    end += 2
                elif text[end] == quote:
                    if end + 1 < len(text) and text[end + 1] == quote:
                        end += 2
                    else:
                        end += 1
                        break
                else:
                    end += 1
            else:
                raise ValueError('Unterminated schema-only SQL quote')
            value = text[index:end]
            raw.append(value)
            skeleton.append("'VALUE'" if quote == "'" else value[1:-1].replace('""', '"'))
            index = end
        elif text[index] == '$' and re.match(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$', text[index:]):
            tag = re.match(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$', text[index:]).group()
            end = text.find(tag, index + len(tag))
            if end < 0:
                raise ValueError('Unterminated schema-only SQL body')
            end += len(tag)
            raw.append(text[index:end])
            skeleton.append('DOLLAR_BODY')
            index = end
        elif text[index] == ';':
            raw.append(';')
            statements.append((''.join(raw), ''.join(skeleton).strip()))
            raw, skeleton = [], []
            index += 1
        else:
            raw.append(text[index])
            skeleton.append(text[index])
            index += 1
    if ''.join(skeleton).strip():
        raise ValueError('Incomplete schema-only SQL statement')
    return statements


def validate_schema_sql(text):
    lines = []
    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith('\\'):
            if re.fullmatch(r'\\(?:un)?restrict [A-Za-z0-9]+\s*', line):
                continue
            raise ValueError('Unexpected psql command in schema-only artifact')
        lines.append(line)
    count = 0
    for raw, skeleton in sql_statements(''.join(lines)):
        command = re.sub(r'\s+', ' ', skeleton).lower()
        if not command:
            continue
        if command.startswith(('set ', 'select pg_catalog.set_config(')):
            if command.startswith('set role') or command.startswith('set session authorization'):
                raise ValueError('Role change outside schema-only scope')
            count += 1
            continue
        allowed = any(re.match(pattern, command) for pattern in [
            r'create schema (?:public|private)(?:\s|$)',
            r'create (?:type|domain|function|table|sequence|view|materialized view) (?:public|private)\.',
            r'create (?:unique )?index .+? on (?:only )?(?:public|private)\.',
            r'create (?:constraint )?trigger .+? on (?:public|private)\.',
            r'create policy .+? on (?:public|private)\.',
            r'alter (?:type|domain|function|table|sequence|view|materialized view) (?:only )?(?:public|private)\.',
            r'alter schema (?:public|private) ',
            r'alter default privileges for role [a-z0-9_]+ in schema (?:public|private) ',
            r'(?:grant|revoke) .+? on (?:schema (?:public|private)(?:\s|,|$)|(?:table |sequence |function |type )?(?:public|private)\.)',
            r'comment on (?:schema (?:public|private)(?:\s|$)|(?:type|domain|function|table|column|view|sequence|constraint|policy|trigger) .*(?:public|private)\.)',
        ])
        if not allowed:
            raise ValueError('Statement outside application schema-only scope: '+command[:100])
        count += 1
    if not count:
        raise ValueError('Empty schema-only artifact')
    return count


def read_bound_file(binding):
    raw = Path(binding['path']).read_bytes()
    if len(raw) != binding['bytes'] or sha(raw) != binding['sha256']:
        raise ValueError('Source/replay artifact binding differs')
    return raw


def admit_replay(receipt, capture, sources, socket, database):
    if receipt.get('actualExitCode') != 0 or capture.get('actualExitCode') != 0:
        raise ValueError('A real successful full replay is required')
    if receipt.get('command') != ['node', 'scripts/test-migration-replay.mjs', socket, database] or receipt.get('cwd') != str(ROOT):
        raise ValueError('Unexpected replay command or source root')
    text = read_bound_file(receipt['stdout']).decode()
    read_bound_file(receipt['stderr'])
    expected = [Path(entry['path']).name for entry in sources['migrations']]
    if len(expected) != 195 or re.findall(r'^Replay (.+)$', text, re.MULTILINE) != expected:
        raise ValueError('Replay did not execute the complete unchanged migration order')
    for marker in ('PASS: executed all 195 ordered migrations without changing their bytes', 'PASS: effective schema, RLS, role/function ACLs and denied operations'):
        if text.splitlines().count(marker) != 1:
            raise ValueError('Full replay/effective-contract completion missing')
    for name, pin in {**{name:entry['sha256'] for name, entry in sources['inputs'].items()}, **sources['common']}.items():
        if capture.get('sourceHashesBefore', {}).get(name) != pin or capture.get('sourceHashesAfter', {}).get(name) != pin:
            raise ValueError('Original replay source custody missing: '+name)
    return {'class':'OWNED_SYNTHETIC_SQL_REPLAY', 'nativeAuth':False, 'command':receipt['command'],
            'actualExitCode':receipt['actualExitCode'], 'stdout':receipt['stdout'], 'stderr':receipt['stderr'],
            'migrationCount':195, 'effectiveContractExecuted':True}


def application_dump(text):
    cleaned = ''.join(line for line in text.splitlines(keepends=True) if not re.fullmatch(r'\\(?:un)?restrict [A-Za-z0-9]+\s*',line))
    found, offset = [], 0
    for raw,skeleton in sql_statements(cleaned):
        if re.sub(r'\s+',' ',skeleton).lower() == 'create schema public':
            literal = 'CREATE SCHEMA public;'
            position = raw.rfind(literal)
            if position < 0:
                raise ValueError('Unreviewed public-schema dump spelling')
            start = offset + position
            end = start + len(literal)
            if cleaned[end:end+1] == '\n':
                end += 1
            found.append((start,end))
        offset += len(raw)
    if len(found) != 1:
        raise ValueError('Expected one source CREATE SCHEMA public for initdb normalization')
    start,end = found[0]
    return cleaned[:start]+cleaned[end:]


def restore_source_spellings(text, catalog):
    specifications = [
        ('private.employee_check_in_review_notifications','employee_check_in_review_notificatio_provider_delivery_id_check','char_length(provider_delivery_id)',200,'20260924200000_five_month_no_surprises_review.sql'),
        ('private.leave_accrual_policies','leave_accrual_policies_weekdays_check','cardinality(weekdays)',7,'20260910023719_automatic_leave_accrual.sql'),
        ('private.leave_attachment_upload_intents','leave_attachment_upload_intents_file_name_check','char_length(file_name)',255,'20260907051607_priority_leave_workflows.sql'),
        ('private.payroll_balance_source_archives','payroll_balance_source_archives_original_file_name_check','char_length(original_file_name)',180,'20260918100000_payroll_balance_source_file_retention.sql'),
        ('public.leave_request_attachments','leave_request_attachments_file_name_check','char_length(file_name)',255,'20260819130000_leave_request_attachments.sql'),
    ]
    replacements, evidence = {}, []
    for table,name,expression,upper,migration in specifications:
        entries = [row for row in catalog['constraints'] if row['relation']==table and row['name']==name]
        if not entries:
            continue
        file = 'supabase/migrations/'+migration
        raw = (ROOT/file).read_bytes()
        if raw != git('show',BASE+':'+file) or not re.search(re.escape(expression)+r'\s+between\s+1\s+and\s+'+str(upper)+r'\b',raw.decode(),re.IGNORECASE):
            raise ValueError('Original BETWEEN source constraint differs')
        original = entries[0]['definition']
        pair = '(('+expression+' >= 1) AND ('+expression+' <= '+str(upper)+'))'
        if original.count(pair)!=1:
            raise ValueError('Source constraint expression differs: '+table+':'+name)
        replacement = original.replace(pair,'('+expression+' BETWEEN 1 AND '+str(upper)+')')
        replacements.setdefault(table,[]).append((original,replacement))
        evidence.append({'kind':'constraint-original-BETWEEN','identity':table+':'+name,'source':file,'sourceSha256':sha(raw),'before':original,'generatedSpelling':replacement})
    parts, consumed = [], 0
    for raw,skeleton in sql_statements(text):
        command = re.sub(r'\s+',' ',skeleton).lower()
        for table,items in replacements.items():
            if command.startswith('create table '+table+' '):
                for original,replacement in items:
                    if raw.count(original)!=1:
                        raise ValueError('Source constraint not found exactly once in dump: '+table)
                    raw=raw.replace(original,replacement,1)
        parts.append(raw)
    consumed=sum(len(raw) for raw,skeleton in sql_statements(text))
    result=''.join(parts)+text[consumed:]
    for entry in catalog['triggers']:
        if entry['relation']=='public.profiles' and entry['name']=='profiles_zz_reroute_manager_leave':
            file='supabase/migrations/20260910041150_manager_leave_reviewers.sql'
            raw=(ROOT/file).read_bytes()
            if raw != git('show',BASE+':'+file):
                raise ValueError('Original row-DISTINCT trigger source differs')
            originals=[body for body,skeleton in sql_statements(raw.decode()) if re.sub(r'\s+',' ',skeleton).lower().startswith('create trigger profiles_zz_reroute_manager_leave ')]
            original=entry['definition']+';'
            if len(originals)!=1 or result.count(original)!=1:
                raise ValueError('Source trigger not found exactly once in dump')
            result=result.replace(original,originals[0].strip(),1)
            evidence.append({'kind':'trigger-original-row-DISTINCT','identity':entry['relation']+':'+entry['name'],'source':file,'sourceSha256':sha(raw),'generatedSpelling':originals[0].strip(),'expectedDefinition':entry['definition']})
    for entry in catalog['relations']:
        owner=entry['owner']
        bits='rwU' if entry['kind']=='S' else 'arwdDxt'
        if entry['kind'] in ('S','r','p') and entry['acl']==[owner+'='+bits+'/'+owner]:
            sql='GRANT ALL PRIVILEGES ON '+('SEQUENCE ' if entry['kind']=='S' else 'TABLE ')+entry['identity']+' TO '+identifier(owner)+';\n'
            result+='\n'+sql
            evidence.append({'kind':'materialize-source-explicit-owner-ACL','identity':entry['identity'],'sourceAcl':entry['acl'],'generatedSql':sql})
    return result,evidence


def binding(file):
    raw = Path(file).read_bytes()
    return {'path':str(file), 'bytes':len(raw), 'sha256':sha(raw)}


def save_json(file, value):
    with Path(file).open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def execution_env():
    return {'PATH':os.environ['PATH'], 'TMPDIR':os.environ['TMPDIR'], 'LC_ALL':'C', 'LANG':'C',
            'PGPASSFILE':'/dev/null', 'PGSERVICEFILE':'/dev/null', 'PGCONNECT_TIMEOUT':'5',
            'PYTHONDONTWRITEBYTECODE':'1'}


class Recorder:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir()
        self.records = []

    def run(self, label, command, input_file=None, expected_exit=0):
        stdout = self.directory/(label+'.stdout.log')
        stderr = self.directory/(label+'.stderr.log')
        start = datetime.now(timezone.utc).isoformat()
        with stdout.open('xb') as out, stderr.open('xb') as err:
            result = subprocess.run(command, cwd=ROOT, env=execution_env(), stdout=out, stderr=err, stdin=subprocess.DEVNULL)
        record = {'label':label, 'command':command, 'actualExitCode':result.returncode, 'startedAt':start,
                  'expectedExitCode':expected_exit, 'endedAt':datetime.now(timezone.utc).isoformat(), 'stdout':binding(stdout), 'stderr':binding(stderr)}
        if input_file is not None:
            record['input'] = binding(input_file)
        self.records.append(record)
        save_json(self.directory/(label+'.receipt.json'), record)
        if result.returncode != expected_exit:
            raise ValueError(label+' failed; exact exit='+str(result.returncode)+'; see '+str(stderr))
        return stdout.read_bytes()

    def sql(self, label, target, text):
        file = self.directory/(label+'.sql')
        file.write_text(text)
        return self.run(label, ['psql', *target, '-Atq', '-f', str(file)], file).decode().strip()


def query_source(name):
    return Path(__file__).with_name(name).read_text()


def select_query(name):
    text = query_source(name)
    prefix = "set search_path = '';\n"
    if not text.startswith(prefix) or not text.endswith(';\n'):
        raise ValueError('Unexpected catalog query source')
    return text[len(prefix):-2]


def canonical(value):
    if isinstance(value, dict):
        return {key: sorted(item) if key == 'acl' and isinstance(item,list) else canonical(item) for key,item in value.items()}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def app_catalog(recorder, label, target):
    return canonical(json.loads(recorder.sql(label, target, query_source('catalog.sql'))))


def row_counts(recorder, label, target, catalog):
    tables = [entry['identity'] for entry in catalog['relations'] if entry['kind'] in ('r','p')]
    query = 'select jsonb_object_agg(k,n) from ('+' union all '.join('select '+quote(name)+'::text as k, count(*) as n from only '+name for name in tables)+') counts;'
    return json.loads(recorder.sql(label, target, query))


def build(socket, database, owned, receipt, capture, output):
    target = owned_target(socket, database, owned)
    sources = source_inventory()
    provenance = admit_replay(receipt, capture, sources, socket, database)
    output = Path(output).absolute()
    if output.exists() or output.parent.resolve() != (ROOT/'qa-evidence/uat-20261016/bootstrap-owner').resolve():
        raise ValueError('A new task-owned schema artifact directory is required')
    output.mkdir()
    recorder = Recorder(output/'commands')
    versions = {name:recorder.run('version-'+name,command).decode().strip() for name,command in [('node',['node','--version']),('pg-dump',['pg_dump','--version']),('psql',['psql','--version']),('python',[sys.executable,'--version'])]}
    if versions['node']!='v24.21.0':
        raise ValueError('Frozen Node 24.21.0 is required')
    server = json.loads(recorder.sql('source-server', target, "select jsonb_build_object('database',current_database(),'version',current_setting('server_version'),'major',current_setting('server_version_num')::int/10000,'address',inet_server_addr(),'listen',current_setting('listen_addresses'),'dataDirectory',current_setting('data_directory'));") )
    if server['database'] != database or server['address'] is not None or server['listen'] != '' or Path(server['dataDirectory']) != Path(socket)/'data':
        raise ValueError('Live source is not the admitted owned socket-only database')
    before = app_catalog(recorder, 'source-app-before', target)
    counts = row_counts(recorder, 'source-counts-only', target, before)
    adjunct = json.loads(recorder.sql('source-platform-app-objects', target, query_source('adjunct.sql')))
    raw_dump = recorder.run('dump-app-schema', ['pg_dump','--host='+socket,'--port=55439','--username=postgres','--dbname='+database,'--schema-only','--strict-names','--schema=public','--schema=private'])
    app_sql, restorations = restore_source_spellings(application_dump(raw_dump.decode()),before)
    statements = validate_schema_sql(app_sql)
    (output/'application-schema.sql').write_text(app_sql)
    raw_storage = recorder.run('dump-storage-structure', ['pg_dump','--host='+socket,'--port=55439','--username=postgres','--dbname='+database,'--schema-only','--strict-names','--schema=storage'])
    cleaned_storage = ''.join(line for line in raw_storage.decode().splitlines(keepends=True) if not line.startswith(('\\restrict ', '\\unrestrict ')))
    storage_parts = []
    for raw, skeleton in sql_statements(cleaned_storage):
        command = re.sub(r'\s+',' ',skeleton).lower()
        if re.match(r'create (?:constraint )?trigger |create policy ',command):
            continue
        if command.startswith(('insert ', 'update ', 'delete ', 'copy ', 'create schema auth', 'create function auth', 'create table auth')):
            raise ValueError('Non-structural Storage prerequisite rejected')
        storage_parts.append(raw)
    (output/'empty-storage-prerequisites.sql').write_text(''.join(storage_parts)+'\n')
    adjunct_parts = []
    for kind in ('triggers','policies'):
        for entry in adjunct[kind]:
            if entry['relation'].split('.')[0] not in ('auth','storage') or not re.fullmatch('[a-z_][a-z0-9_]*',entry['name']):
                raise ValueError('Unknown platform application adjunct')
            matches = []
            for migration in sources['migrations']:
                text = (ROOT/migration['path']).read_text()
                if entry['name'] in text or kind == 'triggers' and entry['function'].split('.')[1] in text:
                    matches.append(migration['path'])
            if not matches:
                raise ValueError('Application adjunct lacks migration source provenance')
            entry['sourceMigrations'] = matches
            adjunct_parts.append(entry['definition']+';\n')
            if kind == 'triggers' and entry['enabled'] != 'O':
                action = {'D':'DISABLE','A':'ENABLE ALWAYS','R':'ENABLE REPLICA'}[entry['enabled']]
                adjunct_parts.append('ALTER TABLE '+entry['relation']+' '+action+' TRIGGER '+identifier(entry['name'])+';\n')
    (output/'auth-storage-application.sql').write_text('set search_path = \'\';\n'+''.join(adjunct_parts))
    auth = json.loads(recorder.sql('source-auth-dependencies', target, "set search_path=''; select jsonb_build_object('tables',(select jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod)) order by c.relname,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname in ('users','sessions') and a.attnum>0 and not a.attisdropped),'functions',jsonb_build_array('auth.uid() -> uuid','auth.jwt() -> jsonb','auth.role() -> text'));"))
    after = app_catalog(recorder, 'source-app-after', target)
    if before != after or sources != source_inventory():
        raise ValueError('Source changed during schema export')
    save_json(output/'application-inventory.json', before)
    save_json(output/'platform-application-inventory.json', adjunct)
    (output/'platform-provider-observer.sql').write_text(query_source('provider.sql'))
    (output/'application-observer.sql').write_text(query_source('catalog.sql'))
    (output/'platform-application-observer.sql').write_text(query_source('adjunct.sql'))
    write_installer(output, before, adjunct, auth, server['major'])
    code = {str(p.relative_to(ROOT)):binding(p) for p in Path(__file__).parent.iterdir() if p.is_file()}
    files = {p.name:binding(p) for p in output.iterdir() if p.is_file()}
    tests = {str(p.relative_to(ROOT)):binding(p) for p in sorted((ROOT/'tests').glob('uat-source-bootstrap*')) if p.is_file()}
    replay_evidence = {}
    for name,expected in [('source-replay.receipt.json',receipt),('unchanged-195-source-replay.receipt.json',capture)]:
        file = ROOT/'qa-evidence/uat-20261016/bootstrap-owner'/name
        if json.loads(file.read_text())!=expected:
            raise ValueError('Replay receipt file changed or is not the admitted execution')
        replay_evidence[name]=binding(file)
    manifest = {**sources, 'sourceReplay':provenance, 'replayEvidence':replay_evidence, 'bootstrapTests':tests, 'toolVersions':versions,
                'sourceServer':server, 'exportedAt':datetime.now(timezone.utc).isoformat(),
                'bootstrapSource':code, 'generated':files, 'generatedSqlSha256':sha(app_sql.encode()), 'rawPgDumpSha256':sha(raw_dump),
                'dumpTransformations':['remove only top-level CREATE SCHEMA public; plus its line terminator; validated empty initdb public is retained','remove pg_dump restrict/unrestrict transport directives; all application object definitions retained'], 'schemaOnlyStatements':statements,
                'sourceSpellingAndExplicitAclRestorations':restorations,
                'objectCounts':{key:len(value) for key,value in before.items()}, 'sourceRowCountsNotExported':counts,
                'authPrerequisites':auth, 'platformApplicationObjects':adjunct, 'controls':CONTROL_TABLES,
                'prerequisites':{'postgresMajor':server['major'],'extension':'pgcrypto in extensions','roles':['postgres','anon','authenticated','service_role','supabase_storage_admin'],'authOwner':'Real GoTrue/provider; never installed or replaced by this package','storageMode':'SQL structure only; install empty-storage-prerequisites.sql ONLY when storage schema is absent; never overwrite provider tables'},
                'classification':{'sourceReplay':'SYNTHETIC_SQL_ONLY','targetInstall':'NOT_RUN','nativeAuth':'NOT_RUN','http':'NOT_RUN','physicalStorage':'NOT_RUN','realtime':'NOT_RUN','independentReview':'REQUIRED_NOT_PERFORMED','productionAuthorization':False},
                'migrationHistoryExported':False,'businessRowsExported':False,'sourceBeforeAfterIdentical':True,'commands':recorder.records}
    save_json(output/'manifest.json', manifest)
    return {'manifest':binding(output/'manifest.json'), 'schema':files['application-schema.sql'], 'objectCounts':manifest['objectCounts']}


CONTROL_TABLES = ['private.openclaw_leave_release_gate','private.notification_delivery_control','private.subscription_request_config','private.confirmed_test_purge_schema']


def write_installer(output, catalog, adjunct, auth, major):
    policy_keys = [entry['relation']+':'+entry['name'] for entry in adjunct['policies']]
    expected_adjunct = {kind:[{k:v for k,v in entry.items() if k != 'sourceMigrations'} for entry in adjunct[kind]] for kind in ('triggers','policies')}
    roles = """do $uat_roles$
declare name text; begin
 if current_database() !~ '^(mam_uat_|mam_test_)[a-z0-9_]+$' or current_user <> 'postgres' then raise exception 'New UAT database required' using errcode='55000'; end if;
 foreach name in array array['anon','authenticated','service_role','supabase_storage_admin'] loop
  if not exists(select 1 from pg_roles where rolname=name) then
   execute format('create role %I nologin nosuperuser nocreatedb nocreaterole noreplication %s',name,case when name='service_role' then 'bypassrls' else 'nobypassrls' end);
  elsif exists(select 1 from pg_roles where rolname=name and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls is distinct from (name='service_role'))) then
   raise exception 'Unknown existing UAT role attributes' using errcode='55000';
  end if;
 end loop;
end $uat_roles$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $uat_extension$ begin
 if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto' and n.nspname='extensions') then raise exception 'pgcrypto must be owned in extensions' using errcode='55000'; end if;
end $uat_extension$;
"""
    (output/'platform-roles-extensions.sql').write_text(roles)
    checks = []
    for entry in auth['tables']:
        allowed_type = "format_type(a.atttypid,a.atttypmod)="+quote(entry['type'])
        if entry['type'] == 'text':
            allowed_type = "a.atttypid in ('text'::regtype,'varchar'::regtype)"
        checks.append("if not exists(select 1 from pg_attribute a where a.attrelid=to_regclass("+quote(entry['relation'])+") and a.attname="+quote(entry['column'])+" and a.attnum>0 and not a.attisdropped and "+allowed_type+") then raise exception "+quote('Missing provider dependency: '+entry['relation']+'.'+entry['column'])+" using errcode='55000'; end if;")
    for signature, result in [('auth.uid()','uuid'),('auth.jwt()','jsonb'),('auth.role()','text')]:
        checks.append("if not exists(select 1 from pg_proc p where p.oid=to_regprocedure("+quote(signature)+") and p.prorettype="+quote(result)+"::regtype) then raise exception 'Native Auth helpers must already exist' using errcode='55000'; end if;")
    preflight = """do $uat_preflight$ declare checked_relation record; occupied boolean; begin
 if current_database() <> current_setting('mam.uat.bootstrap_target') or current_user <> 'postgres' or session_user <> 'postgres' or pg_is_in_recovery() then raise exception 'Wrong UAT bootstrap target/owner' using errcode='55000'; end if;
 if current_setting('mam.uat.bootstrap_mode')='native-reviewed' then
  if current_database() !~ '^mam_uat_[a-z0-9_]+$' then raise exception 'Native installer requires a new named UAT database' using errcode='55000'; end if;
 elsif current_setting('mam.uat.bootstrap_mode')='owned-sql-only' then
  if current_database() !~ '^mam_test_[a-z0-9_]+$' or inet_server_addr() is not null or current_setting('listen_addresses')<>'' then raise exception 'Owned synthetic socket-only target required' using errcode='55000'; end if;
 else raise exception 'Explicit reviewed-native or owned-sql-only bootstrap mode required' using errcode='55000'; end if;
 if current_setting('server_version_num')::int/10000 <> MAJOR then raise exception 'Unreviewed PostgreSQL major' using errcode='55000'; end if;
 if exists(select 1 from pg_namespace where nspname not in ('pg_catalog','information_schema','pg_toast','public','private','auth','storage','extensions') and nspname !~ '^pg_temp_[0-9]+$' and nspname !~ '^pg_toast_temp_[0-9]+$') then raise exception 'Unreviewed schema in new UAT target' using errcode='55000'; end if;
 for checked_relation in select n.nspname as schema_name,c.relname as relation_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage') and c.relkind in ('r','p') and (n.nspname::text,c.relname::text) not in (('auth','schema_migrations'),('storage','migrations')) order by n.nspname,c.relname loop
  execute format('select exists(select 1 from only %I.%I)',checked_relation.schema_name,checked_relation.relation_name) into occupied;
  if occupied then raise exception 'Existing provider business rows: %.%',checked_relation.schema_name,checked_relation.relation_name using errcode='55000'; end if;
 end loop;
 if to_regnamespace('public') is null then raise exception 'Empty initdb public namespace must already exist' using errcode='55000'; end if;
 if to_regnamespace('private') is not null or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') or exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public') then raise exception 'Only a new empty application target may be initialized; never refresh an existing database' using errcode='55000'; end if;
 if to_regclass('supabase_migrations.schema_migrations') is not null then raise exception 'Application migration history is not a schema-only bootstrap target' using errcode='55000'; end if;
 if exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and (rolsuper or rolcreatedb or rolcreaterole or rolreplication)) or (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','supabase_storage_admin'))<>4 then raise exception 'Unsafe or missing UAT application roles' using errcode='55000'; end if;
 if pg_has_role('anon','service_role','MEMBER') or pg_has_role('authenticated','service_role','MEMBER') or pg_has_role('anon','postgres','MEMBER') or pg_has_role('authenticated','postgres','MEMBER') then raise exception 'Unsafe UAT role membership' using errcode='55000'; end if;
CHECKS
 if exists(select 1 from auth.users) or exists(select 1 from auth.sessions) or exists(select 1 from storage.buckets) or exists(select 1 from storage.objects) then raise exception 'Initial UAT target must not contain Auth or Storage business rows' using errcode='55000'; end if;
end $uat_preflight$;
""".replace('MAJOR',str(major)).replace('CHECKS','\n'.join(checks))
    (output/'preflight.sql').write_text(preflight)
    canonical_sql = """create function pg_temp.uat_canonical(j jsonb) returns jsonb language plpgsql immutable set search_path='' as $uat_canonical$
declare kind text:=jsonb_typeof(j); result jsonb; k text; v jsonb; begin
 if kind='object' then
  result:='{}';
  for k,v in select key,value from jsonb_each(j) loop
   if k='acl' and jsonb_typeof(v)='array' then select coalesce(jsonb_agg(value order by value::text collate "C"),'[]') into v from jsonb_array_elements(v); else v:=pg_temp.uat_canonical(v); end if;
   result:=result||jsonb_build_object(k,v);
  end loop;
  return result;
 elsif kind='array' then select coalesce(jsonb_agg(pg_temp.uat_canonical(value) order by ordinal),'[]') into result from jsonb_array_elements(j) with ordinality as t(value,ordinal); return result;
 else return j; end if;
end $uat_canonical$;
"""
    app_validate = "create temporary table uat_app_actual on commit drop as select metadata from ("+select_query('catalog.sql')+") as t(metadata);\n"
    app_validate += "do $uat_app_inventory$ begin if (select pg_temp.uat_canonical(metadata) from uat_app_actual) is distinct from "+quote(json.dumps(catalog))+"::jsonb then raise exception 'Complete application schema inventory differs' using errcode='55000'; end if; end $uat_app_inventory$;\n"
    adjunct_validate = "create temporary table uat_adjunct_actual on commit drop as select metadata from ("+select_query('adjunct.sql')+") as t(metadata);\n"
    adjunct_validate += "do $uat_adjunct_inventory$ begin if (select metadata from uat_adjunct_actual) is distinct from "+quote(json.dumps(expected_adjunct))+"::jsonb then raise exception 'Auth/Storage application trigger or policy differs' using errcode='55000'; end if; end $uat_adjunct_inventory$;\n"
    controls = """insert into private.openclaw_leave_release_gate(singleton,enabled) values(true,false);
insert into private.notification_delivery_control(singleton,ready,legacy_import_sha256,legacy_import_count,legacy_imported_at) values(true,false,null,null,null);
insert into private.subscription_request_config(singleton,enabled,approver_user_id,approver_person_id) values(true,false,null,null);
insert into private.confirmed_test_purge_schema(singleton,schema_hash) select true,private.confirmed_test_purge_schema_hash();
"""
    (output/'fresh-controls.sql').write_text(controls)
    empty_checks = []
    for entry in catalog['relations']:
        if entry['kind'] in ('r','p'):
            count = 1 if entry['identity'] in CONTROL_TABLES else 0
            empty_checks.append("if (select count(*) from only "+entry['identity']+")<>"+str(count)+" then raise exception "+quote('Unexpected initial rows: '+entry['identity'])+" using errcode='55000'; end if;")
    empty_validate = "do $uat_empty$ begin\n"+'\n'.join(empty_checks)+"\nif (select enabled from private.openclaw_leave_release_gate where singleton) or (select ready from private.notification_delivery_control where singleton) or (select enabled or approver_user_id is not null or approver_person_id is not null from private.subscription_request_config where singleton) then raise exception 'UAT outbound control unexpectedly enabled' using errcode='55000'; end if;\nif (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from private.confirmed_test_purge_schema_hash() then raise exception 'New-target initial guard row does not match its final catalog' using errcode='55000'; end if;\nend $uat_empty$;\n"
    (output/'validate-empty.sql').write_text(empty_validate)
    (output/'validate-application.sql').write_text(canonical_sql+app_validate+adjunct_validate)
    (output/'validate-final-application.sql').write_text(app_validate.replace('uat_app_actual','uat_app_final')+adjunct_validate.replace('uat_adjunct_actual','uat_adjunct_final'))
    native = r"""\set ON_ERROR_STOP on
begin;
select pg_advisory_xact_lock(hashtextextended('mam-uat-source-bootstrap:'||current_database(),0));
select set_config('mam.uat.bootstrap_target', :'uat_target', true);
select set_config('mam.uat.bootstrap_mode', :'uat_mode', true);
select set_config('mam.uat.bootstrap_provider_sha', :'provider_sha', true);
select set_config('mam.uat.bootstrap_policy_keys', POLICY_KEYS, true);
set local search_path='';
\ir preflight.sql
create temporary table uat_provider_before on commit drop as select metadata from (PROVIDER_QUERY) as t(metadata);
do $uat_provider_pin$ begin if (select encode(extensions.digest(metadata::text,'sha256'),'hex') from uat_provider_before) is distinct from current_setting('mam.uat.bootstrap_provider_sha') then raise exception 'Provider baseline is not the independently reviewed initial target' using errcode='55000'; end if; end $uat_provider_pin$;
\ir application-schema.sql
\ir auth-storage-application.sql
set local search_path='';
\ir validate-application.sql
\ir fresh-controls.sql
set constraints all immediate;
\ir validate-final-application.sql
\ir validate-empty.sql
create temporary table uat_provider_after on commit drop as select metadata from (PROVIDER_QUERY) as t(metadata);
do $uat_provider_unchanged$ begin if (select metadata from uat_provider_before) is distinct from (select metadata from uat_provider_after) then raise exception 'Provider-owned schema/roles changed during application install' using errcode='55000'; end if; end $uat_provider_unchanged$;
commit;
""".replace('POLICY_KEYS',quote(json.dumps(policy_keys))).replace('PROVIDER_QUERY',select_query('provider.sql'))
    (output/'install-new-uat.sql').write_text(native)


def validate_package(package, expected_manifest_sha):
    package = Path(package).resolve()
    raw = (package/'manifest.json').read_bytes()
    if not re.fullmatch('[0-9a-f]{64}', expected_manifest_sha) or sha(raw) != expected_manifest_sha:
        raise ValueError('Reviewed schema manifest SHA differs')
    manifest = json.loads(raw)
    current = source_inventory()
    for key in ('format','base','common','commonPinsSha256','migrations','inputs'):
        if manifest.get(key) != current[key]:
            raise ValueError('Source-bound package differs: '+key)
    current_code = {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in Path(__file__).parent.iterdir() if p.is_file()}
    if current_code != {name:pin['sha256'] for name,pin in manifest['bootstrapSource'].items()}:
        raise ValueError('Bootstrap executable source changed since generation')
    for name,pin in manifest.get('bootstrapTests',{}).items():
        if (ROOT/name).is_symlink() or sha((ROOT/name).read_bytes()) != pin['sha256']:
            raise ValueError('Bootstrap regression source changed since generation')
    for pin in manifest.get('replayEvidence',{}).values():
        read_bound_file(pin)
    for name, pin in manifest['generated'].items():
        if not re.fullmatch(r'[a-z0-9-]+\.(?:sql|json)', name):
            raise ValueError('Unsafe schema artifact path')
        file = package/name
        if file.is_symlink() or file.resolve().parent != package:
            raise ValueError('Schema artifact path left its bound package')
        actual = file.read_bytes()
        if len(actual) != pin['bytes'] or sha(actual) != pin['sha256']:
            raise ValueError('Schema artifact changed: '+name)
    if manifest['migrationHistoryExported'] or manifest['businessRowsExported'] or manifest['sourceReplay']['migrationCount'] != 195 or manifest['sourceReplay']['actualExitCode'] != 0:
        raise ValueError('Not a source-only successful full-replay package')
    validate_schema_sql((package/'application-schema.sql').read_text())
    return manifest


def policy_setup(manifest):
    keys = [entry['relation']+':'+entry['name'] for entry in manifest['platformApplicationObjects']['policies']]
    return 'select set_config(\'mam.uat.bootstrap_policy_keys\','+quote(json.dumps(keys))+',false);\n'


def provider_observation(recorder, label, target, manifest):
    output = recorder.sql(label, target, policy_setup(manifest)+query_source('provider.sql'))
    rows = output.splitlines()
    if len(rows) != 2:
        raise ValueError('Incomplete provider metadata observation')
    return rows[-1]


def validate_installed(recorder, target, package, manifest, before_provider=None):
    catalog = app_catalog(recorder, 'postcommit-application', target)
    expected = json.loads((package/'application-inventory.json').read_text())
    if catalog != expected:
        raise ValueError('Independent postcommit complete application schema readback differs')
    adjunct = json.loads(recorder.sql('postcommit-platform-app-objects', target, query_source('adjunct.sql')))
    expected_adjunct = {kind:[{key:value for key,value in entry.items() if key != 'sourceMigrations'} for entry in manifest['platformApplicationObjects'][kind]] for kind in ('triggers','policies')}
    if adjunct != expected_adjunct:
        raise ValueError('Independent postcommit Auth/Storage application adjunct differs')
    counts = row_counts(recorder, 'postcommit-counts-only', target, catalog)
    if any(count != (1 if table in CONTROL_TABLES else 0) for table,count in counts.items()):
        raise ValueError('Unexpected business rows after schema-only install')
    state = json.loads(recorder.sql('postcommit-guard-auth-history', target, "select jsonb_build_object('authUsers',(select count(*) from auth.users),'authSessions',(select count(*) from auth.sessions),'historyAbsent',to_regclass('supabase_migrations.schema_migrations') is null,'guardInitialMatches',(select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema where singleton),'openclawDisabled',(select not enabled from private.openclaw_leave_release_gate where singleton),'notificationDisabled',(select not ready from private.notification_delivery_control where singleton),'subscriptionDisabled',(select not enabled and approver_user_id is null and approver_person_id is null from private.subscription_request_config where singleton));"))
    if state['authUsers'] or state['authSessions'] or not all(state[key] for key in ('historyAbsent','guardInitialMatches','openclawDisabled','notificationDisabled','subscriptionDisabled')):
        raise ValueError('Native guard, empty Auth/history or disabled-control readback differs')
    after_provider = provider_observation(recorder, 'postcommit-provider', target, manifest)
    if before_provider is not None and before_provider != after_provider:
        raise ValueError('Independent postcommit provider metadata changed')
    recorder.run('unchanged-effective-contract', ['psql',*target,'-Atq','-f',str(ROOT/'tests/migrations/effective-contract.sql')], ROOT/'tests/migrations/effective-contract.sql')
    return {'applicationInventoryExact':True,'applicationObjectCounts':{key:len(value) for key,value in catalog.items()},
            'platformApplicationInventoryExact':True,'providerBeforeAfterExact':before_provider is not None,
            'providerMetadataSha256':sha(after_provider.encode()),'rowCounts':counts, 'state':state,
            'classification':'OWNED_SYNTHETIC_SQL_ONLY','nativeAuth':False,'http':False,'physicalStorage':False,'realtime':False}


def install(socket, database, owned, package, manifest_sha, provider_sha, log_directory):
    target = owned_target(socket, database, owned)
    manifest = validate_package(package, manifest_sha)
    if not re.fullmatch('[0-9a-f]{64}',provider_sha):
        raise ValueError('Explicit reviewed initial provider SHA required')
    package = Path(package).resolve()
    recorder = Recorder(log_directory)
    before_provider = provider_observation(recorder, 'preinstall-provider', target, manifest)
    if sha(before_provider.encode()) != provider_sha:
        raise ValueError('Initial provider metadata differs from supplied reviewed pin')
    recorder.run('install-new-owned-target', ['psql',*target,'-v','uat_target='+database,'-v','uat_mode=owned-sql-only','-v','provider_sha='+provider_sha,'-f',str(package/'install-new-uat.sql')], package/'install-new-uat.sql')
    verified = validate_installed(recorder, target, package, manifest, before_provider)
    validate_package(package, manifest_sha)
    verified['manifestSha256'] = manifest_sha
    verified['commands'] = recorder.records
    save_json(Path(log_directory)/'verification.json', verified)
    return verified


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['sources','build','install','verify-package'])
    parser.add_argument('--socket')
    parser.add_argument('--database')
    parser.add_argument('--ownership',type=Path)
    parser.add_argument('--replay-receipt',type=Path)
    parser.add_argument('--source-capture',type=Path)
    parser.add_argument('--out',type=Path)
    parser.add_argument('--package',type=Path)
    parser.add_argument('--manifest-sha')
    parser.add_argument('--provider-sha')
    args = parser.parse_args()
    if args.action == 'sources':
        result = source_inventory()
    elif args.action == 'verify-package':
        manifest = validate_package(args.package,args.manifest_sha)
        result = {'verifiedPackage':True, 'objectCounts':manifest['objectCounts']}
    elif args.action == 'build':
        if not all([args.socket,args.database,args.ownership,args.replay_receipt,args.source_capture,args.out]):
            parser.error('build requires an owned target, real replay receipts and a new artifact path')
        result = build(args.socket,args.database,json.loads(args.ownership.read_text()),json.loads(args.replay_receipt.read_text()),json.loads(args.source_capture.read_text()),args.out)
    else:
        if not all([args.socket,args.database,args.ownership,args.package,args.manifest_sha,args.provider_sha,args.out]):
            parser.error('install requires owned socket-only target, bound package and reviewed initial provider SHA')
        result = install(args.socket,args.database,json.loads(args.ownership.read_text()),args.package,args.manifest_sha,args.provider_sha,args.out)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
