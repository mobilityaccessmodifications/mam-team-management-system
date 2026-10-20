import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types

LOADED_CODE = sys._getframe().f_code
HELPER = Path(__file__).resolve()
ROOT = HELPER.parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORGANIZATION = 'fwlmbmospuwoaosffvmw'
VERSION = '20261020212355'
NAME = 'performance_review_meeting_invitation'
PREDECESSOR_VERSION = '20261020003343'
PREDECESSOR_NAME = 'performance_review_careers_cc'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PREDECESSOR = MIGRATION.parent / (PREDECESSOR_VERSION + '_' + PREDECESSOR_NAME + '.sql')
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
CATALOG_FIXTURE = ROOT / 'scripts/performance-review-meeting-catalog-20261020212355.pg17.json'
CATALOG_SHA256 = 'bbfa3ba93fdd96ba9c64626a0ef54e70415844d67a76aa15fbb3f903b50bc083'
SIGNATURES = (
    'public.mutate_performance_review(uuid,uuid,text,text,jsonb)',
    'public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)',
    'public.claim_performance_review_notifications(uuid,integer)',
    'public.reserve_performance_review_notification_mail(text,text,text,uuid,text)',
    'private.notification_event_key_valid(text)',
    'private.performance_review_meeting_addresses(private.performance_reviews)',
    'private.queue_performance_review_meeting_request()',
    'private.performance_review_notification_payload(private.performance_reviews,text)',
    'public.list_performance_review_meeting_imports(integer)',
    'public.import_performance_review_meeting(uuid,text,jsonb)',
)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def load_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate receipt key')
            result[key] = value
        return result
    def invalid(value):
        raise SystemExit('Non-finite receipt value')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def transaction_body(source):
    require(source.startswith('begin;\n') and source.endswith('\ncommit;\n') and '\r' not in source and source.count('\ncommit;') == 1, 'Unsupported meeting migration boundaries')
    return source[len('begin;\n'):-len('commit;\n')]


def expected_bodies(source):
    definitions = re.findall(r'^create (?:or replace )?function ((?:public|private)\.[a-z_]+)\(.*?\n.*?as \$\$(.*?)\$\$;', source, re.M | re.S)
    require(len(definitions) == len(SIGNATURES) and len({name for name, _ in definitions}) == len(SIGNATURES), 'Unexpected meeting function source set')
    by_name = {name: sha(body.encode()) for name, body in definitions}
    require(set(by_name) == {signature.split('(')[0] for signature in SIGNATURES}, 'Meeting source functions differ')
    return {signature: by_name[signature.split('(')[0]] for signature in SIGNATURES}


def predecessor_bodies(source):
    section = source.split('insert into meeting_function_spec values\n', 1)[1].split('do $predecessor$', 1)[0]
    bodies = dict(re.findall(r"\('([^']+)','([0-9a-f]{64})'\)", section))
    require(len(bodies) == 6 and set(bodies).issubset(SIGNATURES), 'Unexpected predecessor function pins')
    return {signature: bodies.get(signature) for signature in SIGNATURES}


def local_migrations():
    result = []
    for path in sorted(MIGRATION.parent.glob('*.sql')):
        match = re.fullmatch(r'([0-9]{14})_([a-z][a-z0-9_]*)\.sql', path.name)
        require(match is not None and path.is_file() and not path.is_symlink(), 'Malformed local migration')
        result.append({'version': match[1], 'name': match[2], 'sha256': sha(path.read_bytes())})
    require(1 <= len(result) <= 512 and len({row['version'] for row in result}) == len(result), 'Invalid bounded migration set')
    require(result[-1]['version'] == VERSION and result[-1]['name'] == NAME and any(row['version'] == PREDECESSOR_VERSION and row['name'] == PREDECESSOR_NAME for row in result), 'Latest local migration differs')
    return result


def feature_catalog_expression():
    return """jsonb_build_object(
 'table',(select jsonb_build_object('name',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'persistence',c.relpersistence,'options',c.reloptions,'replicaIdentity',c.relreplident,'partition',c.relispartition,
   'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type),'[]') from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=to_regclass('private.performance_review_meeting_requests')),
 'columns',(select coalesce(jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',case when a.attcollation=0 then null else a.attcollation::regcollation::text end,'storage',a.attstorage,'compression',a.attcompression,
   'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) order by x.grantee=0,pg_get_userbyid(x.grantee),x.privilege_type),'[]') from aclexplode(a.attacl) x)) order by a.attnum),'[]') from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=to_regclass('private.performance_review_meeting_requests') and a.attnum>0 and not a.attisdropped),
 'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(select jsonb_agg(case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end order by r=0,pg_get_userbyid(r)) from unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname),'[]') from pg_policy p where p.polrelid=to_regclass('private.performance_review_meeting_requests')),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('relation',k.conrelid::regclass::text,'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,'noInherit',k.connoinherit) order by k.conrelid::regclass::text,k.conname),'[]') from pg_constraint k where k.conrelid=to_regclass('private.performance_review_meeting_requests') or(k.conrelid='private.performance_review_notifications'::regclass and k.conname in('performance_review_notifications_event_check','performance_review_notifications_cc_check'))),
 'indexes',(select coalesce(jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,'immediate',i.indimmediate,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'replicaIdentity',i.indisreplident) order by i.indexrelid::regclass::text),'[]') from pg_index i where i.indrelid=to_regclass('private.performance_review_meeting_requests')),
 'triggers',(select coalesce(jsonb_agg(item order by item::text),'[]') from(select jsonb_build_object('name',case when t.tgisinternal then null else t.tgname end,'relation',t.tgrelid::regclass::text,'constraint',k.conname,'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')','enabled',t.tgenabled,'internal',t.tgisinternal,'type',t.tgtype,'columns',t.tgattr::text,'args',encode(t.tgargs,'hex'),'hasWhen',t.tgqual is not null,'oldTable',t.tgoldtable,'newTable',t.tgnewtable,'definition',case when t.tgisinternal then null else pg_get_triggerdef(t.oid) end) item from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace left join pg_constraint k on k.oid=t.tgconstraint where t.tgrelid=to_regclass('private.performance_review_meeting_requests') or k.conrelid=to_regclass('private.performance_review_meeting_requests') or(t.tgrelid='private.performance_review_events'::regclass and t.tgname='performance_review_meeting_requested')) triggers),
 'functions',(select coalesce(jsonb_object_agg(s.signature,jsonb_build_object('arguments',pg_get_function_arguments(p.oid),'returns',pg_get_function_result(p.oid),'language',l.lanname,'owner',pg_get_userbyid(p.proowner),'kind',p.prokind,'securityDefiner',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regproc::text,'config',p.proconfig,
   'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) order by x.grantee=0,pg_get_userbyid(x.grantee),x.privilege_type),'[]') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x))),'{}') from unnest(array['private.performance_review_meeting_addresses(private.performance_reviews)','private.queue_performance_review_meeting_request()','public.list_performance_review_meeting_imports(integer)','public.import_performance_review_meeting(uuid,text,jsonb)']) s(signature) join pg_proc p on p.oid=to_regprocedure(s.signature) join pg_language l on l.oid=p.prolang))"""


def expected_catalog(source):
    raw = CATALOG_FIXTURE.read_bytes()
    require(sha(raw) == CATALOG_SHA256, 'Reviewed meeting catalog fixture differs')
    fixture = load_json(raw)
    require(isinstance(fixture,dict) and set(fixture) == {'version','postgresMajor','migrationSha256','catalog'} and fixture['version'] == VERSION and fixture['postgresMajor'] == 17 and fixture['migrationSha256'] == sha(source.encode()) and isinstance(fixture['catalog'],dict), 'Meeting catalog fixture source binding differs')
    return fixture['catalog']


def state_expression(source, predecessor):
    signatures = ','.join(literal(value) for value in SIGNATURES)
    preserved = source.split('$catalog$',2)[1].strip()
    pins = ','.join(literal(value) for value,body in predecessor_bodies(source).items() if body is not None)
    preserved = preserved.replace('pg_temp.meeting_function_spec', '(select unnest(array[' + pins + ']) signature)')
    return f"""jsonb_build_object(
'major',current_setting('server_version_num')::integer/10000,'actor',current_user,'session',session_user,'readOnly',current_setting('transaction_read_only'),
'catalogHash',private.confirmed_test_purge_schema_hash(),
'preservedHash',(select encode(extensions.digest(coalesce(string_agg(definition,E'\\n' order by definition),''),'sha256'),'hex') from ({preserved}) catalog(definition)),
'oldMetadata',(select jsonb_object_agg(s.signature,jsonb_build_object('metadata',to_jsonb(p)-'prosrc'-'proargdefaults','arguments',pg_get_function_arguments(p.oid))) from unnest(array[{pins}]) s(signature) join pg_proc p on p.oid=to_regprocedure(s.signature)),
'storedHash',(select schema_hash from private.confirmed_test_purge_schema where singleton),
'purgeRows',(select count(*) from private.confirmed_test_purge_schema),
'dataHash',(select encode(extensions.digest(coalesce(string_agg(document,E'\\n' order by document),''),'sha256'),'hex') from(
 select 'review:'||to_jsonb(r)::text document from private.performance_reviews r union all select 'event:'||to_jsonb(r)::text from private.performance_review_events r union all select 'notification:'||to_jsonb(r)::text from private.performance_review_notifications r) items),
'predecessorExact',coalesce((select name={literal(PREDECESSOR_NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(predecessor)}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
'targetPresent',exists(select 1 from supabase_migrations.schema_migrations where version={literal(VERSION)}),
'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'rowSha256',encode(extensions.digest(to_jsonb(m)::text,'sha256'),'hex'),'sourceArraySha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex')) order by m.version),'[]') from supabase_migrations.schema_migrations m),
'featureCatalog',({feature_catalog_expression()}),
'requestTable',to_regclass('private.performance_review_meeting_requests') is not null,\n'bodies',(select jsonb_object_agg(s.signature,encode(extensions.digest(p.prosrc,'sha256'),'hex')) from unnest(array[{signatures}]) s(signature) left join pg_proc p on p.oid=to_regprocedure(s.signature)),
'ready',coalesce((select relrowsecurity and relforcerowsecurity and pg_get_userbyid(relowner)='postgres' and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) from pg_class c where c.oid=to_regclass('private.performance_review_meeting_requests')),false)
 and not exists(select 1 from unnest(array['anon','authenticated']) r cross join unnest(array['public.list_performance_review_meeting_imports(integer)','public.import_performance_review_meeting(uuid,text,jsonb)']) s where coalesce(has_function_privilege(r,to_regprocedure(s),'EXECUTE'),true))
 and coalesce(has_function_privilege('service_role',to_regprocedure('public.list_performance_review_meeting_imports(integer)'),'EXECUTE'),false)
 and coalesce(has_function_privilege('service_role',to_regprocedure('public.import_performance_review_meeting(uuid,text,jsonb)'),'EXECUTE'),false)
 and not exists(select 1 from unnest(array['private.performance_review_meeting_addresses(private.performance_reviews)','private.queue_performance_review_meeting_request()','public.list_performance_review_meeting_imports(integer)','public.import_performance_review_meeting(uuid,text,jsonb)']) s left join pg_proc p on p.oid=to_regprocedure(s) where p.oid is null or not p.prosecdef or p.proconfig is distinct from array['search_path=\"\"'] or pg_get_userbyid(p.proowner)<>'postgres')
 and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['private.performance_review_meeting_addresses(private.performance_reviews)','private.queue_performance_review_meeting_request()']) s where coalesce(has_function_privilege(r,to_regprocedure(s),'EXECUTE'),true))
 and exists(select 1 from pg_trigger t where t.tgrelid='private.performance_review_events'::regclass and t.tgname='performance_review_meeting_requested' and t.tgenabled='O' and t.tgfoid=to_regprocedure('private.queue_performance_review_meeting_request()')))"""


def read_state(source, predecessor, query):
    result = query("begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='45s';\nselect " + state_expression(source, predecessor) + ' as state; rollback;')
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and set(result[0]) == {'state'} and isinstance(result[0]['state'], dict), 'Invalid metadata response')
    return result[0]['state']


def validate_common(state):
    require(type(state.get('major')) is int and state['major'] == 17 and state.get('actor') == state.get('session') == 'postgres' and state.get('readOnly') == 'on', 'Exact PostgreSQL 17 read-only management actor required')
    require(state.get('purgeRows') == 1 and state.get('predecessorExact') is True, 'Missing purge control or exact Careers CC predecessor')
    for name in ('catalogHash', 'storedHash', 'dataHash', 'preservedHash'):
        require(isinstance(state.get(name), str) and re.fullmatch('[0-9a-f]{64}', state[name]) is not None, 'Invalid state hash')
    ledger = state.get('ledger')
    require(isinstance(ledger, list) and 1 <= len(ledger) <= 512, 'Invalid bounded native ledger')
    versions = []
    for row in ledger:
        require(isinstance(row, dict) and set(row) == {'version','name','rowSha256','sourceArraySha256'} and isinstance(row['version'], str) and re.fullmatch('[0-9]{14}', row['version']) is not None and isinstance(row['name'], str) and re.fullmatch('[a-zA-Z0-9_]+', row['name']) is not None, 'Invalid native ledger row')
        require(all(isinstance(row[field], str) and re.fullmatch('[0-9a-f]{64}', row[field]) is not None for field in ('rowSha256','sourceArraySha256')), 'Invalid native ledger digest')
        versions.append(row['version'])
    require(versions == sorted(set(versions)), 'Duplicate or unordered native ledger')
    require(type(state.get('targetPresent')) is bool and type(state.get('targetExact')) is bool, 'Missing exact target predicate')
    return ledger


def validate_before(state, source):
    ledger = validate_common(state)
    require(ledger[-1]['version'] == PREDECESSOR_VERSION and ledger[-1]['name'] == PREDECESSOR_NAME and state['targetPresent'] is False and state['targetExact'] is False, 'Latest unrecorded predecessor differs')
    require(state.get('requestTable') is False and state.get('bodies') == predecessor_bodies(source), 'Exact meeting predecessor functions or request table differ')
    expected_bodies(source)


def validate_target(state, source):
    ledger = validate_common(state)
    require(state['targetPresent'] is True and state['targetExact'] is True and ledger[-1]['version'] == VERSION and ledger[-1]['name'] == NAME, 'Recorded target source differs; HOLD')
    require(state.get('featureCatalog') == expected_catalog(source), 'Exact meeting catalog definitions differ; HOLD')
    require(state.get('requestTable') is True and state.get('bodies') == expected_bodies(source) and state.get('ready') is True, 'Meeting bodies or service access differs; HOLD')


def validate_preserved(after, before, source, catalog=None):
    validate_target(after, source)
    for name in ('major','actor','session','readOnly','predecessorExact','purgeRows','dataHash','preservedHash','oldMetadata'):
        require(after[name] == before[name], 'Preservation differs: ' + name + '; HOLD')
    require(after['ledger'][:-1] == before['ledger'] and len(after['ledger']) == len(before['ledger']) + 1, 'Native historical ledger changed; HOLD')
    if catalog is not None:
        require(after['catalogHash'] == catalog, 'Commit catalog attestation differs; HOLD')
    require(after['storedHash'] == (after['catalogHash'] if before['storedHash'] == before['catalogHash'] else before['storedHash']), 'Existing purge HOLD changed; HOLD')


def transaction(source, before, predecessor):
    validate_before(before, source)
    expected = literal(encoded(before)) + '::jsonb'
    expression = state_expression(source, predecessor)
    return "begin;\nset local search_path=''; set local lock_timeout='3s'; set local statement_timeout='90s';\n" + \
        "do $meeting_release_lock$ begin if not pg_try_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)) then raise exception 'Meeting role control busy' using errcode='55P03'; end if; end $meeting_release_lock$;\nlock table private.confirmed_test_purge_schema,private.performance_reviews,private.performance_review_events,private.performance_review_notifications in share row exclusive mode nowait;\n" + \
        'lock table supabase_migrations.schema_migrations in access exclusive mode nowait;\n' + \
        'do $meeting_release_before$ declare actual jsonb:=' + expression + '; begin if (actual||jsonb_build_object(\'readOnly\',\'on\')) is distinct from ' + expected + " or actual->>'readOnly' is distinct from 'off' then raise exception 'Meeting locked predecessor changed' using errcode='55000'; end if; end $meeting_release_before$;\n" + \
        transaction_body(source) + '\n' + \
        'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + literal(VERSION) + ',' + literal(NAME) + ',ARRAY[' + literal(source) + ']::text[]);\nset constraints all immediate;\n' + \
        'create temporary table meeting_release_attested on commit drop as select ' + expression + ' state;\n' + \
        'do $meeting_release_after$ declare actual jsonb:=(select state from pg_temp.meeting_release_attested); expected jsonb:=' + expected + '; begin\n' + \
        "if (actual-array['readOnly','catalogHash','storedHash','featureCatalog','requestTable','bodies','ready','targetPresent','targetExact','ledger']) is distinct from (expected-array['readOnly','catalogHash','storedHash','featureCatalog','requestTable','bodies','ready','targetPresent','targetExact','ledger'])\n" + \
        "or actual->>'readOnly' is distinct from 'off' or actual->'ready' is distinct from 'true'::jsonb or actual->'targetExact' is distinct from 'true'::jsonb or actual->'bodies' is distinct from " + literal(encoded(expected_bodies(source))) + '::jsonb\n' + \
        "or actual->'featureCatalog' is distinct from " + literal(encoded(expected_catalog(source))) + '::jsonb\n' + \
        "or jsonb_array_length(actual->'ledger')<>jsonb_array_length(expected->'ledger')+1 or ((actual->'ledger')-jsonb_array_length(expected->'ledger')) is distinct from expected->'ledger'\n" + \
        "or actual->>'storedHash' is distinct from (case when expected->>'storedHash'=expected->>'catalogHash' then actual->>'catalogHash' else expected->>'storedHash' end)\n" + \
        "then raise exception 'Meeting release preservation differs' using errcode='55000'; end if; end $meeting_release_after$;\nnotify pgrst,'reload schema';\nselect state->>'catalogHash' as \"resultingCatalogSha256\" from pg_temp.meeting_release_attested;\ncommit;"


def clean_source(reviewed_head, held):
    require(LOADED_CODE == compile(held[HELPER], str(HELPER), 'exec', dont_inherit=True), 'Loaded meeting helper differs')
    require(Path.cwd().resolve() == ROOT, 'Run from exact MAM source root')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')
    def git(*args):
        return subprocess.check_output(['git','-c','core.fsmonitor=false',*args], cwd=ROOT, env=environment, stderr=subprocess.PIPE)
    require(Path(git('rev-parse','--show-toplevel').decode().strip()).resolve() == ROOT and git('rev-parse','HEAD').decode().strip() == reviewed_head and not git('status','--porcelain').strip(), 'Exact clean reviewed Git source required')
    require(git('remote','get-url','origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM origin')
    require(git('show','-s','--format=%an <%ae>','HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path, raw in held.items():
        require(path.read_bytes() == raw == git('show','HEAD:' + str(path.relative_to(ROOT))), 'Reviewed release bytes changed')


def private_path(value):
    path = Path(value)
    require(path.is_absolute() and path.parent.resolve() == path.parent and not path.is_symlink() and ROOT not in path.parents, 'Private absolute operator path outside source required')
    metadata = path.parent.stat()
    require(metadata.st_uid == os.getuid() and metadata.st_mode & 0o777 == 0o700, 'Owner-only operator directory required')
    return path


def retain(value, data):
    path = private_path(value)
    raw = (encoded(data) + '\n').encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return sha(raw)


def read_private(value, pin=None):
    path = private_path(value)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        require(metadata.st_uid == os.getuid() and metadata.st_mode & 0o177777 == 0o100600 and metadata.st_nlink == 1 and 0 < metadata.st_size <= 8388608, 'Bounded regular private receipt required')
        raw = stream.read(8388609)
    require(len(raw) == metadata.st_size and (pin is None or sha(raw) == pin), 'Private receipt bytes differ')
    return raw


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    require(args and ((args[0] == 'inspect' and len(args) == 6) or (args[0] == 'snapshot' and len(args) == 7) or (args[0] in ('apply','readback') and len(args) == 8)), 'Usage: inspect|snapshot|apply|readback <reviewed-head> <helper-sha256> <transport-sha256> <migration-sha256> <predecessor-sha256> [private-snapshot-path [snapshot-sha256]]')
    require(re.fullmatch('[0-9a-f]{40}', args[1]) is not None and all(re.fullmatch('[0-9a-f]{64}', value) is not None for value in args[2:6]), 'Explicit full reviewed source pins required')
    held = {}
    for path, pin in zip((HELPER,TRANSPORT,MIGRATION,PREDECESSOR),args[2:6]):
        require(path.is_file() and not path.is_symlink(), 'Regular reviewed release source required')
        raw = path.read_bytes()
        require(sha(raw) == pin, 'Reviewed release hash differs: ' + str(path.relative_to(ROOT)))
        held[path] = raw
    require(CATALOG_FIXTURE.is_file() and not CATALOG_FIXTURE.is_symlink(), 'Regular reviewed catalog fixture required')
    held[CATALOG_FIXTURE] = CATALOG_FIXTURE.read_bytes()
    require(sha(held[CATALOG_FIXTURE]) == CATALOG_SHA256, 'Reviewed catalog fixture hash differs')
    clean_source(args[1], held)
    local = local_migrations()
    source, predecessor = held[MIGRATION].decode(), held[PREDECESSOR].decode()
    transaction_body(source)
    expected_bodies(source)
    expected_catalog(source)
    require(os.environ.get('CODEX_COMPANY_PROFILE') == 'mam' and bool(os.environ.get('SUPABASE_ACCESS_TOKEN')), 'Use the MAM credential helper exec supabase route')
    transport = types.ModuleType('meeting_release_transport')
    transport.__file__ = str(TRANSPORT)
    exec(compile(held[TRANSPORT], str(TRANSPORT), 'exec', dont_inherit=True), transport.__dict__)
    bindings = dict(transport.__dict__)
    functions = [(value,value.__code__,value.__defaults__) for value in bindings.values() if isinstance(value,types.FunctionType)]
    frame = snapshot_raw = None
    if args[0] in ('apply','readback'):
        require(re.fullmatch('[0-9a-f]{64}',args[7]) is not None, 'Explicit private snapshot hash required')
        snapshot_raw = read_private(args[6],args[7])
        frame = load_json(snapshot_raw)
        require(isinstance(frame,dict) and set(frame) == {'version','project','organization','reviewedHead','sourceHashes','localMigrations','before'} and frame['version'] == VERSION and frame['project'] == PROJECT and frame['organization'] == ORGANIZATION and frame['reviewedHead'] == args[1] and frame['sourceHashes'] == args[2:6] and frame['localMigrations'] == local, 'Private snapshot source binding differs')
        validate_before(frame['before'],source)
    def check():
        clean_source(args[1],held)
        require(local_migrations() == local, 'Local migration set changed')
        require(set(transport.__dict__) == set(bindings) and all(transport.__dict__[key] is value for key,value in bindings.items()) and all(function.__code__ == code and function.__defaults__ == defaults for function,code,defaults in functions), 'Loaded transport changed')
        if snapshot_raw is not None:
            require(read_private(args[6],args[7]) == snapshot_raw, 'Private snapshot changed')
    entered, phase = False, 'preflight'
    try:
        check()
        target = transport.api('')
        check()
        require(isinstance(target,dict) and target.get('id') == PROJECT and target.get('organization_id') == ORGANIZATION, 'Wrong MAM organization/project')
        state = read_state(source,predecessor,transport.query)
        check()
        catalog = None
        if frame is not None:
            release = transaction(source,frame['before'],predecessor)
            binding = {'version':VERSION,'snapshotSha256':args[7],'querySha256':sha(release.encode())}
            directory = private_path(args[6]).parent
            journal = directory / (VERSION + '.entered.json')
            attestation = directory / (VERSION + '.attested.json')
            verified = directory / (VERSION + '.verified.json')
            if attestation.exists():
                receipt = load_json(read_private(str(attestation)))
                require(isinstance(receipt,dict) and set(receipt) == set(binding)|{'resultingCatalogSha256'} and all(receipt.get(key) == value for key,value in binding.items()) and isinstance(receipt['resultingCatalogSha256'],str) and re.fullmatch('[0-9a-f]{64}',receipt['resultingCatalogSha256']) is not None, 'Commit attestation binding differs; HOLD')
                catalog = receipt['resultingCatalogSha256']
            if args[0] == 'apply' and (journal.exists() or journal.is_symlink()):
                require(load_json(read_private(str(journal))) == dict(binding,enteredMutation=True) and verified.exists(), 'Entered release journal is spent; HOLD; readback only, never retry')
                require(load_json(read_private(str(verified))) == dict(binding,readbackVerified=True,resultingCatalogSha256=catalog), 'Verified release journal differs; HOLD')
            if state.get('targetPresent'):
                require(journal.exists() and load_json(read_private(str(journal))) == dict(binding,enteredMutation=True), 'Exact entered release binding required; HOLD')
                validate_preserved(state,frame['before'],source,catalog)
                if catalog is None:
                    require(args[0] == 'readback', 'Unknown response requires readback; no mutation retry')
                    catalog = state['catalogHash']
                    retain(str(attestation),dict(binding,resultingCatalogSha256=catalog))
                if not verified.exists():
                    retain(str(verified),dict(binding,readbackVerified=True,resultingCatalogSha256=catalog))
                receipt = {'readOnly':True,'recorded':True,'readbackVerified':True,'version':VERSION}
            else:
                validate_before(state,source)
                require(args[0] == 'apply' and state == frame['before'] and not attestation.exists() and not verified.exists(), 'Unrecorded or changed release; HOLD; inspect only')
                check()
                retain(str(journal),dict(binding,enteredMutation=True))
                entered, phase = True, 'dispatch'
                check()
                result = transport.query(release)
                check()
                require(isinstance(result,list) and len(result) == 1 and isinstance(result[0],dict) and set(result[0]) == {'resultingCatalogSha256'} and isinstance(result[0]['resultingCatalogSha256'],str) and re.fullmatch('[0-9a-f]{64}',result[0]['resultingCatalogSha256']) is not None, 'Missing commit attestation; HOLD')
                catalog = result[0]['resultingCatalogSha256']
                retain(str(attestation),dict(binding,resultingCatalogSha256=catalog))
                phase = 'readback'
                state = read_state(source,predecessor,transport.query)
                check()
                validate_preserved(state,frame['before'],source,catalog)
                retain(str(verified),dict(binding,readbackVerified=True,resultingCatalogSha256=catalog))
                receipt = {'committed':True,'readbackVerified':True,'writeCount':1,'version':VERSION}
        elif state.get('targetPresent'):
            validate_target(state,source)
            receipt = {'readOnly':True,'recorded':True,'preservationVerified':False,'version':VERSION}
        else:
            validate_before(state,source)
            receipt = {'readOnly':True,'targetAbsent':True,'predecessorVerified':True,'existingPurgeHold':state['storedHash'] != state['catalogHash'],'historyRepair':False,'version':VERSION}
        if args[0] == 'snapshot':
            require(not state['targetPresent'], 'Cannot replace before snapshot with recorded target')
            frame = {'version':VERSION,'project':PROJECT,'organization':ORGANIZATION,'reviewedHead':args[1],'sourceHashes':args[2:6],'localMigrations':local,'before':state}
            receipt['snapshotSha256'] = retain(args[6],frame)
        check()
        print(json.dumps(receipt))
    except BaseException:
        if entered:
            raise SystemExit('Meeting release ' + phase + ' unverified; HOLD; preserve entered journal; inspect/readback only, never retry or reset') from None
        raise


if __name__ == '__main__':
    main()
