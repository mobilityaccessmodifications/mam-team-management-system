import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import selectors
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PG = Path('/opt/homebrew/opt/postgresql@16/bin')
SCRATCH = Path('/Users/nixon/.hermes/profiles/mam/cache/scratch')
ENV = {'PATH':str(PG)+':/usr/bin:/bin','TMPDIR':str(SCRATCH),'LANG':'C','LC_ALL':'C',
       'PGPASSFILE':'/dev/null','PGSERVICEFILE':'/dev/null','PGCONNECT_TIMEOUT':'5'}
OWNER = 'mam-uat-synthetic-seed-sql-only-v1'
DATABASE = 'mam_uat_people_hub'
BASE = 'mam_test_synthetic_seed_base'
KEYS = ('p0','hr','mam_upper_manager','mam_manager','mam_employee','mam_account','mam_other_manager','equipsy_upper_manager','equipsy_manager','equipsy_employee')


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Rehearsal:
    def __init__(self, package, evidence):
        self.package = package.resolve(strict=True)
        self.evidence = evidence
        self.evidence.mkdir(exist_ok=False)
        self.socket = SCRATCH/('ss'+secrets.token_hex(4))
        self.socket.mkdir(mode=0o700)
        self.marker = {'owner':OWNER,'socket':str(self.socket),'port':55439,'database':DATABASE,'sqlOnly':True}
        (self.socket/'mam-seed-cluster.json').write_text(json.dumps(self.marker)+'\n')
        self.records = []
        self.started = False

    def owned(self):
        assert self.socket.parent.resolve() == SCRATCH.resolve()
        assert re.fullmatch('ss[0-9a-f]{8}',self.socket.name)
        assert not self.socket.is_symlink()
        assert json.loads((self.socket/'mam-seed-cluster.json').read_bytes()) == self.marker

    def run(self, label, command, data=None, expected=0):
        self.owned()
        out = self.evidence/(label+'.stdout.log')
        err = self.evidence/(label+'.stderr.log')
        assert not out.exists() and not err.exists(),label
        with out.open('xb') as stdout, err.open('xb') as stderr:
            result = subprocess.run(command,input=data,cwd=ROOT,env=ENV,stdout=stdout,stderr=stderr,timeout=180)
        row = {'label':label,'command':list(map(str,command)),'exit':result.returncode,
               'expectedExit':expected,'stdoutSha256':sha(out.read_bytes()),'stderrSha256':sha(err.read_bytes())}
        if data is not None:
            row['stdinSha256'] = sha(data)
        self.records.append(row)
        (self.evidence/(label+'.receipt.json')).write_text(json.dumps(row,indent=2)+'\n')
        assert result.returncode == expected, (label,result.returncode,expected,str(err))
        return out.read_bytes().strip()

    def target(self, database=DATABASE, user='postgres'):
        self.owned()
        assert database in (BASE,DATABASE,'mam_test_synthetic_seed_wrong')
        assert user in ('postgres','authenticated')
        return [str(PG/'psql'),'-X','-h',str(self.socket),'-p','55439','-U',user,
                '-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-Atq']

    def sql(self, label, sql, database=DATABASE, expected=0, user='postgres'):
        file = self.evidence/(label+'.sql')
        file.write_text(sql)
        return self.run(label,self.target(database,user)+['-f',str(file)],expected=expected)

    def read_package(self, name):
        return (self.package/name).read_text()

    def fingerprint(self, label, database=DATABASE):
        if not hasattr(self,'business_relations'):
            self.business_relations = json.loads(self.sql('business-relation-census',"SELECT jsonb_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private','storage') AND c.relkind IN ('r','p');"))
            assert all(re.fullmatch('[a-z_]+[.][a-z_0-9]+',name) for name in self.business_relations)
        count_sql = ' UNION ALL '.join("SELECT '"+name+"' AS name,count(*) AS total FROM "+name for name in self.business_relations)
        business = self.sql(label+'-business-counts',"SELECT jsonb_object_agg(name,total) FROM ("+count_sql+") c;",database)
        state = json.loads(self.sql(label,"""SELECT jsonb_build_object(
          'profiles',(SELECT count(*) FROM public.profiles),
          'people',(SELECT count(*) FROM public.internal_org_people),
          'authUsers',(SELECT count(*) FROM auth.users),
          'authSessions',(SELECT count(*) FROM auth.sessions),
          'authRoleMetadata',md5((SELECT jsonb_agg(jsonb_build_array(id,raw_app_meta_data) ORDER BY id)::text FROM auth.users)),
          'controls',md5(("""+self.read_controls().removeprefix('SELECT ').removesuffix(' AS state')+""")::text),
          'reviews',(SELECT count(*) FROM private.performance_reviews),
          'events',(SELECT count(*) FROM private.performance_review_events),
          'operations',(SELECT count(*) FROM private.performance_review_operations));""",database))
        state['businessTableCounts'] = json.loads(business)
        return state

    def read_controls(self):
        return (ROOT/'deploy/uat/synthetic-seed/controls.sql').read_text().strip()

    def start(self):
        version = self.run('00-version',[str(PG/'postgres'),'--version']).decode()
        assert re.search(r'PostgreSQL\) 16\.',version)
        self.run('01-initdb',[str(PG/'initdb'),'-D',str(self.socket/'data'),'-U','postgres',
            '--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
        self.run('02-start',[str(PG/'pg_ctl'),'-D',str(self.socket/'data'),'-l',str(self.socket/'postgres.log'),
            '-o',"-k "+str(self.socket)+" -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700 -c autovacuum=off",'-w','start'])
        self.started = True
        self.run('03-createdb',[str(PG/'createdb'),'-h',str(self.socket),'-p','55439','-U','postgres','--template=template0',BASE])
        self.sql('04-socket-owner-proof',"DO $$ BEGIN ASSERT inet_server_addr() IS NULL AND current_setting('listen_addresses')='' AND current_user='postgres' AND session_user='postgres' AND current_setting('server_version_num')::int/10000=16; END $$;",BASE)

    def install(self):
        manifest = json.loads((self.package/'manifest.json').read_bytes())
        assert sha((self.package/'manifest.json').read_bytes()) == '34e5cc38746506f05a5cd39bfc027b3d946d13c46113ccf732aece2167154e8f'
        for name,row in manifest['generated'].items():
            data = (self.package/name).read_bytes()
            assert sha(data) == row['sha256'] and len(data) == row['bytes'],name
        for label,name in [('05-platform-roles','platform-roles-extensions.sql'),('06-storage-prerequisites','empty-storage-prerequisites.sql')]:
            self.run(label,self.target(BASE)+['-f',str(self.package/name)])
        original = (ROOT/'tests/migrations/0001-supabase-platform.sql').read_text()
        fixtures = ['create schema auth;']
        start = original.index('create table auth.users (')
        fixtures.append(original[start:original.index('\n);',start)+3])
        for name in ('uid','jwt','role'):
            start = original.index('create function auth.'+name+'()')
            fixtures.append(original[start:original.index('$$;',start)+3])
        operator = (ROOT/'tests/migrations/operator-session-platform.sql').read_text()
        start = operator.index('create table auth.sessions (')
        fixtures.append(operator[start:operator.index('\n);',start)+3])
        fixtures += ['alter table auth.users add column deleted_at timestamptz;',
                     'alter table auth.users add column last_sign_in_at timestamptz;',
                     'grant usage on schema auth to anon, authenticated, service_role;']
        self.sql('07-SQL-ONLY-platform-fixture-not-native','\n'.join(fixtures),BASE)
        provider = self.sql('08-provider-observer',self.read_package('platform-provider-observer.sql'),BASE)
        provider_sha = sha(provider)
        self.run('09-original-installer',self.target(BASE)+['-v','uat_target='+BASE,'-v','uat_mode=owned-sql-only',
            '-v','provider_sha='+provider_sha,'-f',str(self.package/'install-new-uat.sql')])
        self.run('10-performance-delta',self.target(BASE)+['-f',str(ROOT/'deploy/uat/performance-review-schema.sql')])
        self.run('11-exact-name-clone',[str(PG/'createdb'),'-h',str(self.socket),'-p','55439','-U','postgres','--template='+BASE,DATABASE])
        return manifest

    def deny(self, label, seed, state='55000', database=DATABASE, reached=None):
        before = self.fingerprint(label+'-before',database)
        self.sql(label,seed,database,expected=3)
        error = (self.evidence/(label+'.stderr.log')).read_text()
        assert state in error,(label,state)
        if reached is not None:
            assert reached in error,(label,reached)
        assert self.fingerprint(label+'-after',database) == before,label

    def negatives(self, seed, after, raw):
        denials = []
        self.run('22-wrong-name-clone',[str(PG/'createdb'),'-h',str(self.socket),'-p','55439','-U','postgres','--template='+BASE,'mam_test_synthetic_seed_wrong'])
        self.deny('23-wrong-target',seed,database='mam_test_synthetic_seed_wrong',reached='Unexpected initial UAT seed context')
        denials.append('wrong_database')
        for index,prefix in enumerate(("SET LOCAL ROLE authenticated;", "SET SESSION AUTHORIZATION authenticated;", "SELECT set_config('request.jwt.claims','{}',true);", "SELECT set_config('request.jwt.claim.sub','deny-only-not-a-uuid',true);", "SELECT set_config('request.jwt.claim.role','deny-only-context',true);")):
            self.deny('24-context-'+str(index),seed.replace('BEGIN;\n','BEGIN;\n'+prefix+'\n',1),reached='Unexpected initial UAT seed context')
            denials.append('context_'+str(index))
        first = '10000000-0000-4000-8000-000000000001'
        for name,field,value in (
            ('unconfirmed','email_confirmed_at','NULL'),('anonymous','is_anonymous','true'),
            ('banned','banned_until',"clock_timestamp()+interval '1 hour'"),
            ('deleted','deleted_at','clock_timestamp()'),('empty-hash','encrypted_password',"''"),
            ('signed-before-seed','last_sign_in_at','clock_timestamp()'),
            ('wrong-email','email',"'uat.wrong@mam-uat.invalid'")):
            fault = "UPDATE auth.users SET "+field+'='+value+" WHERE id='"+first+"';\n"
            self.deny('25-auth-'+name,seed.replace('CREATE TEMP TABLE uat_seed_fixture',fault+'CREATE TEMP TABLE uat_seed_fixture',1))
            denials.append(name)
        model = json.loads(raw)
        model['identities'][0]['authUserId'] = '20000000-0000-4000-8000-000000000001'
        missing = self.run('26-missing-generate',[sys.executable,'-B',str(ROOT/'deploy/uat/synthetic-seed/generate.py'),'seed'],json.dumps(model).encode()).decode()+'\n'
        self.deny('26-missing-auth',missing)
        denials.append('missing_auth')
        extra = "INSERT INTO auth.users(id,email) VALUES ('20000000-0000-4000-8000-000000000002','uat.extra@mam-uat.invalid');\n"
        self.deny('27-extra-auth',seed.replace('CREATE TEMP TABLE uat_seed_fixture',extra+'CREATE TEMP TABLE uat_seed_fixture',1))
        denials.append('extra_auth')
        session = "INSERT INTO auth.sessions(id,user_id,created_at) VALUES ('20000000-0000-4000-8000-000000000003','"+first+"',clock_timestamp());\n"
        self.deny('28-existing-session',seed.replace('CREATE TEMP TABLE uat_seed_fixture',session+'CREATE TEMP TABLE uat_seed_fixture',1))
        denials.append('session_before_seed')
        profile = "INSERT INTO public.profiles(id,full_name,app_role,login_name) VALUES ('10000000-0000-4000-8000-000000000005','UAT Existing Employee','employee','uat.mam.employee@mam-uat.invalid');\n"
        self.deny('28-existing-profile',seed.replace('CREATE TEMP TABLE uat_seed_fixture',profile+'CREATE TEMP TABLE uat_seed_fixture',1))
        denials.append('existing_profile')
        person = "INSERT INTO public.internal_org_people(company_key,full_name,position_title) VALUES ('mam','UAT Existing Unlinked Person','Synthetic UAT role');\n"
        self.deny('28-existing-person',seed.replace('CREATE TEMP TABLE uat_seed_fixture',person+'CREATE TEMP TABLE uat_seed_fixture',1))
        denials.append('existing_person')
        induced = seed.replace('  END LOOP;',"  IF fixture.fixture_key = 'mam_employee' THEN\n    RAISE NOTICE 'induced_prefix profiles=% people=%', (SELECT count(*) FROM public.profiles), (SELECT count(*) FROM public.internal_org_people);\n    PERFORM 1/0;\n  END IF;\n  END LOOP;",1)
        self.deny('29-induced-midway-error',induced,state='22012',reached='induced_prefix profiles=10 people=4')
        denials.append('midway_error_rolls_back_profiles_people_and_trigger_effects')
        pre_after = json.loads(self.sql('30-after-before-seed-is-not-success',after))
        assert pre_after['allMatch'] is False and pre_after['profiles'] == pre_after['people'] == 0
        self.advisory_denial(seed)
        denials.append('bounded_initialization_lock')
        return denials

    def advisory_denial(self, seed):
        command = self.target()+['-f','-']
        stdin = b"BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('mam:uat-native-initial-seed',0));\nSELECT 'LOCK_HELD';\n"
        process = subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV,cwd=ROOT,bufsize=0)
        assert process.stdin and process.stdout and process.stderr
        prefix = b''
        try:
            process.stdin.write(stdin)
            process.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout,selectors.EVENT_READ)
                while b'LOCK_HELD\n' not in prefix:
                    assert selector.select(timeout=10),'Owned lock holder did not reach lock'
                    chunk = process.stdout.read(1)
                    assert chunk,'Owned lock holder exited before lock'
                    prefix += chunk
            self.deny('30-initialization-lock-held',seed,reached='Initial UAT seed already in progress')
        finally:
            stdout,stderr = process.communicate(b'ROLLBACK;\n\\q\n',timeout=10)
            stdout = prefix+stdout
            (self.evidence/'30-lock-holder.stdout.log').write_bytes(stdout)
            (self.evidence/'30-lock-holder.stderr.log').write_bytes(stderr)
            row = {'label':'30-lock-holder','command':command,'exit':process.returncode,'expectedExit':0,
                   'stdoutSha256':sha(stdout),'stderrSha256':sha(stderr),'stdinSha256':sha(stdin+b'ROLLBACK;\n\\q\n')}
            self.records.append(row)
            (self.evidence/'30-lock-holder.receipt.json').write_text(json.dumps(row,indent=2)+'\n')
            assert process.returncode == 0

    def exercise(self):
        catalog = json.loads(self.run('12-catalog',[sys.executable,'-B',str(ROOT/'deploy/uat/synthetic-seed/generate.py'),'catalog']))['identities']
        identities = [{'fixtureKey':key,'authUserId':'10000000-0000-4000-8000-'+format(i+1,'012x'),
                       'email':'uat.'+key.replace('_','.')+'@mam-uat.invalid'} for i,key in enumerate(KEYS)]
        raw = json.dumps({'identities':identities}).encode()
        (self.evidence/'SQL-ONLY-manifest.json').write_bytes(raw+b'\n')
        fixtures = []
        for row in identities:
            fixtures.append("('"+row['authUserId']+"','"+row['email']+"',clock_timestamp(),false,'SQL_ONLY_NOT_PROVIDER_HASH','{\"provider\":\"email\",\"providers\":[\"email\"]}')")
        self.sql('13-SQL-ONLY-identity-fixture-not-native',"INSERT INTO auth.users(id,email,email_confirmed_at,is_anonymous,encrypted_password,raw_app_meta_data) VALUES "+','.join(fixtures)+';')
        seed = self.run('14-generate-seed',[sys.executable,'-B',str(ROOT/'deploy/uat/synthetic-seed/generate.py'),'seed'],raw).decode()+'\n'
        after = self.run('15-generate-after',[sys.executable,'-B',str(ROOT/'deploy/uat/synthetic-seed/generate.py'),'after'],raw).decode()+'\n'
        before = self.fingerprint('16-initial-fingerprint')
        assert before['profiles'] == before['people'] == before['authSessions'] == 0 and before['authUsers'] == 10
        metadata_before = self.sql('17-catalog-before',self.read_package('application-observer.sql'))
        denials = self.negatives(seed,after,raw)
        self.sql('18-first-seed',seed)
        readback = json.loads(self.sql('19-independent-after-connection',after))
        assert readback['allMatch'] and (readback['profiles'],readback['people'],readback['authUsers'],readback['authSessions'],readback['reviews']) == (10,9,10,0,0)
        assert len(readback['identities']) == 10
        assert {row['fixture_key'] for row in readback['identities']} == set(KEYS)
        assert all(row['row_matches'] and row['product_synced_org_role'] for row in readback['identities'])
        by_key = {row['fixture_key']:row for row in readback['identities']}
        assert by_key['p0']['person_id'] is None and by_key['p0']['target_policy_role'] == 'system_admin'
        for row in catalog:
            actual = by_key[row['fixtureKey']]
            assert actual['app_role'] == row['appRole'] and actual['person_id'] == row['personId'] and actual['parent_id'] == row['parentPersonId']
            assert actual['company_key'] == row['companyKey']
        final = self.fingerprint('20-final-fingerprint')
        assert before['controls'] == final['controls']
        self.deny('31-duplicate-first-seed',seed)
        denials.append('duplicate_seed')
        self.deny('32-ordinary-promotion-without-p0',"BEGIN; UPDATE public.profiles SET app_role='system_admin' WHERE id='10000000-0000-4000-8000-000000000005'; COMMIT;",state='42501')
        denials.append('ordinary_to_p0_still_denied_42501')
        self.deny('33-existing-p0-noop-update',"BEGIN; UPDATE public.profiles SET full_name=full_name WHERE id='10000000-0000-4000-8000-000000000001'; COMMIT;",state='42501')
        denials.append('existing_p0_update_still_denied_42501')
        actor = self.sql('34-no-current-actor',"SELECT count(*) FROM private.portal_role_policy();")
        assert actor == b'0'
        pid = {row['fixtureKey']:row['personId'] for row in catalog}
        edges = [('mam_manager','mam_upper_manager'),('mam_other_manager','mam_upper_manager'),('mam_employee','mam_manager'),('mam_account','mam_manager'),('equipsy_manager','equipsy_upper_manager'),('equipsy_employee','equipsy_manager')]
        checks = ["private.performance_review_candidate('"+pid[child]+"','"+pid[parent]+"')" for child,parent in edges]
        checks += ["NOT private.performance_review_candidate('"+pid[child]+"','"+pid[parent]+"')" for child,parent in [('mam_employee','mam_other_manager'),('mam_employee','equipsy_manager'),('mam_manager','mam_manager'),('mam_employee','hr')]]
        assert self.sql('35-manager-eligibility-not-native-actor','SELECT '+' AND '.join(checks)+';') == b't'
        context = (ROOT/'deploy/uat/synthetic-seed/context.sql').read_text()
        major = re.search(r"current_setting\('server_version_num'\)::integer / 10000 <> 16",context)
        assert major
        expression = major.group().replace("current_setting('server_version_num')::integer",'version_number')
        assert self.sql('36-major-guard-component-only',"SELECT bool_and(("+expression+") IS NOT DISTINCT FROM must_reject) FROM (VALUES (160000,false),(169999,false),(170000,true),(180000,true),(150000,true)) c(version_number,must_reject);") == b't'
        assert metadata_before == self.sql('21-catalog-after',self.read_package('application-observer.sql'))
        self.sql('37-post-seed-extra-identity-fixture',"INSERT INTO auth.users(id,email) VALUES ('30000000-0000-4000-8000-000000000001','uat.postseed.extra@mam-uat.invalid');")
        extra_before = self.fingerprint('38-post-seed-extra-before-readback')
        extra_after = json.loads(self.sql('39-after-must-reject-extra-identity',after))
        assert extra_after['authUsers'] == 11 and extra_after['allMatch'] is False,'After-query must not certify a non-closed target'
        assert self.fingerprint('40-post-seed-extra-after-readback') == extra_before
        return {'classification':'SQL_ONLY_NOT_NATIVE','sourceMigrations':195,'profiles':10,'people':9,'readbackIdentities':10,
                'allTargetRolesMatch':True,'productOrgRoleSync':True,'catalogUnchanged':True,'controlsUnchanged':True,
                'denialCases':denials,'denialCount':len(denials),'managerEligibilityChecks':len(checks),
                'majorGuardExpressionCases':5,
                'afterRejectsExtraIdentity':True,
                'differentRuntimePgMajor':'NOT_RUN_PG16_ONLY_AUTHORIZATION',
                'nativeAuth':False,'before':before,'after':final}

    def stop(self):
        if self.started:
            self.run('98-stop',[str(PG/'pg_ctl'),'-D',str(self.socket/'data'),'-m','fast','-w','stop'])
            self.run('99-stopped-status',[str(PG/'pg_ctl'),'-D',str(self.socket/'data'),'status'],expected=3)
            assert not (self.socket/'data/postmaster.pid').exists()
            assert not (self.socket/'.s.PGSQL.55439').exists()
            self.started = False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package',type=Path,required=True)
    parser.add_argument('--evidence',type=Path,required=True)
    args = parser.parse_args()
    expected_root = ROOT/'qa-evidence/uat-20261016/synthetic-seed-owner'
    assert args.evidence.parent.resolve() == expected_root.resolve()
    probe = Rehearsal(args.package,args.evidence)
    result: dict = {'classification':'SQL_ONLY_NOT_NATIVE','passed':False,'nativeAuth':False}
    try:
        probe.start()
        probe.install()
        result = dict(probe.exercise(),passed=True)
    finally:
        probe.stop()
        result['ownedCluster'] = probe.marker
        result['stopped'] = not probe.started
        result['commands'] = probe.records
        (probe.evidence/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key not in ('commands','before','after','ownedCluster')}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
