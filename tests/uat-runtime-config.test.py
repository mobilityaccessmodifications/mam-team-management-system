import json
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'deploy/uat/runtime'
PINS = RUNTIME / 'images.json'


class RuntimeConfigTests(unittest.TestCase):
    def compose(self):
        path = RUNTIME / 'compose.json'
        self.assertTrue(path.is_file(), 'The actual five-service Compose artifact is absent.')
        return json.loads(path.read_bytes())

    def test_01_pinned_five_service_artifact(self):
        config = self.compose()
        images = json.loads(PINS.read_bytes())
        self.assertEqual(hashlib.sha256(PINS.read_bytes()).hexdigest(), '1df9b6dc383e45f9fbdca50cda9de566f0e183f1df928d023ab5ef4f362d163b')
        self.assertEqual(config['name'], 'mam-people-hub-uat')
        self.assertEqual(set(config['services']), {f'uat-{s}' for s in images})
        self.assertEqual(json.loads((RUNTIME / 'images.json').read_bytes()), images)
        supplemental = json.loads((RUNTIME / 'postgres16.json').read_bytes())
        self.assertEqual(supplemental['requiredDatabaseMajor'], 16)
        self.assertEqual(supplemental['sourceTag'], '16-bookworm')
        pin = {'sourceSha256': '9481c4188a5c67699627ef64f1e8059dc86e9487e14c52c0a855da37ea1a9c7f'}
        self.assertEqual(hashlib.sha256((RUNTIME / 'postgres16.json').read_bytes()).hexdigest(), pin['sourceSha256'])
        images['db'] = supplemental
        for name, pin in images.items():
            service = config['services']['uat-' + name]
            self.assertEqual(service['platform'], 'linux/amd64')
            expected = pin['repository'] + '@' + pin['platformManifestDigest']
            if 'build' in service:
                self.assertEqual(service['build']['args']['UAT_BASE_IMAGE'], expected)
            else:
                self.assertEqual(service['image'], expected)
            self.assertNotEqual(pin['platformManifestDigest'], pin['imageConfigDigest'])

    def test_02_internal_network_and_task_only_storage(self):
        config = self.compose()
        self.assertIn('networks', config, 'Compose has no isolated network contract.')
        self.assertEqual(set(config['networks']), {'backend', 'ingress'})
        backend = config['networks']['backend']
        self.assertIs(backend['internal'], True)
        self.assertEqual(backend['name'], 'mam-people-hub-uat-backend')
        self.assertEqual(backend['labels']['com.mam.uat.instance'], 'mam-people-hub-uat-v1')
        self.assertEqual(config['networks']['ingress'], {'external': True, 'name': 'n8n_default'})
        self.assertEqual(set(config['volumes']), {'db-data'})
        self.assertEqual(config['volumes']['db-data']['name'], 'mam-people-hub-uat-db-data')
        for name, service in config['services'].items():
            expected = {'backend', 'ingress'} if name == 'uat-gateway' else {'backend'}
            self.assertEqual(set(service['networks']), expected)
            self.assertFalse(set(service) & {'ports', 'network_mode', 'env_file', 'privileged', 'depends_on', 'container_name'})
            for mount in service.get('volumes', []):
                self.assertEqual(name, 'uat-db')
                self.assertEqual(mount['type'], 'volume')
                self.assertEqual(mount['source'], 'db-data')
            self.assertEqual(service['labels']['com.mam.uat.instance'], 'mam-people-hub-uat-v1')
        self.assertEqual(config['services']['uat-gateway']['networks']['backend']['aliases'], ['uat-gateway-private'])

    def test_03_resource_nonroot_and_writable_path_fences(self):
        config = self.compose()
        for name, service in config['services'].items():
            self.assertIn('cpus', service, f'{name} has no CPU bound.')
            self.assertGreater(float(service['cpus']), 0)
            self.assertRegex(service['mem_limit'], r'^\d+[mg]$')
            self.assertTrue(1 <= service['pids_limit'] <= 256)
            self.assertEqual(service['cap_drop'], ['ALL'])
            self.assertEqual(service['security_opt'], ['no-new-privileges:true'])
            self.assertIs(service['read_only'], True)
            self.assertEqual(service['restart'], 'unless-stopped')
            self.assertEqual(service['logging'], {'driver': 'none'})
            self.assertIn('/tmp:', ' '.join(service['tmpfs']))
            if name == 'uat-db':
                self.assertEqual(set(service['cap_add']), {'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'})
                self.assertTrue(any(v.startswith('/var/run/postgresql:') for v in service['tmpfs']))
            else:
                self.assertNotIn('cap_add', service)
                self.assertRegex(service['user'], r'^[1-9][0-9]*:[1-9][0-9]*$')
        web = config['services']['uat-web']
        self.assertIn('/app/.next/cache:rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700', web['tmpfs'])
        gateway = config['services']['uat-gateway']
        self.assertEqual(gateway['user'], '101:101')
        self.assertTrue(any(v.startswith('/etc/nginx/conf.d:rw,') and 'uid=101' in v for v in gateway['tmpfs']))
        self.assertEqual(gateway['sysctls'], {'net.ipv4.ip_forward': '0'})

    def test_04_native_password_auth_and_public_only_rest(self):
        services = self.compose()['services']
        self.assertIn('environment', services['uat-auth'], 'Native GoTrue has no explicit no-mail contract.')
        auth = services['uat-auth']['environment']
        required = {
            'GOTRUE_API_HOST': '0.0.0.0', 'GOTRUE_API_PORT': '9999',
            'API_EXTERNAL_URL': 'https://supabase-uat.srv1866578.hstgr.cloud',
            'GOTRUE_SITE_URL': 'https://people-hub-uat.srv1866578.hstgr.cloud',
            'GOTRUE_URI_ALLOW_LIST': 'https://people-hub-uat.srv1866578.hstgr.cloud',
            'GOTRUE_DB_DRIVER': 'postgres', 'GOTRUE_DB_NAMESPACE': 'auth',
            'GOTRUE_DB_DATABASE_URL': '${MAM_UAT_AUTH_DATABASE_URL:?required}',
            'GOTRUE_JWT_SECRET': '${MAM_UAT_JWT_SECRET:?required}',
            'GOTRUE_JWT_ISSUER': 'mam-people-hub-uat-v1',
            'GOTRUE_JWT_AUD': 'authenticated', 'GOTRUE_JWT_DEFAULT_GROUP_NAME': 'authenticated',
            'GOTRUE_JWT_ADMIN_ROLES': 'service_role',
            'GOTRUE_DISABLE_SIGNUP': 'true', 'GOTRUE_EXTERNAL_EMAIL_ENABLED': 'true',
            'GOTRUE_EXTERNAL_EMAIL_MAGIC_LINK_ENABLED': 'false',
            'GOTRUE_MAILER_AUTOCONFIRM': 'false', 'GOTRUE_EXTERNAL_PHONE_ENABLED': 'false',
            'GOTRUE_SMS_PROVIDER': '', 'GOTRUE_SMS_AUTOCONFIRM': 'false',
            'GOTRUE_SMTP_HOST': '127.0.0.1', 'GOTRUE_SMTP_PORT': '1',
            'GOTRUE_SMTP_USER': '', 'GOTRUE_SMTP_PASS': '',
            'GOTRUE_SMTP_LOGGING_ENABLED': 'false',
            'GOTRUE_SAML_ENABLED': 'false', 'GOTRUE_CUSTOM_OAUTH_ENABLED': 'false',
            'GOTRUE_OAUTH_SERVER_ENABLED': 'false',
        }
        for key, value in required.items():
            self.assertEqual(auth.get(key), value, key)
        for key, value in auth.items():
            if key.startswith('GOTRUE_EXTERNAL_') and key.endswith('_ENABLED') and key != 'GOTRUE_EXTERNAL_EMAIL_ENABLED':
                self.assertEqual(value, 'false', key)
            self.assertNotIn('WEBHOOK', key)
        self.assertNotIn('GOTRUE_SMS_ENABLED', auth)
        rest = services['uat-rest']['environment']
        self.assertEqual(rest['PGRST_DB_URI'], '${MAM_UAT_REST_DATABASE_URL:?required}')
        self.assertEqual(rest['PGRST_DB_SCHEMAS'], 'public')
        self.assertEqual(rest['PGRST_DB_EXTRA_SEARCH_PATH'], 'public')
        self.assertEqual(rest['PGRST_DB_ANON_ROLE'], 'anon')
        self.assertEqual(rest['PGRST_JWT_AUD'], 'authenticated')
        self.assertEqual(rest['PGRST_JWT_SECRET'], '${MAM_UAT_JWT_SECRET:?required}')
        db = services['uat-db']['environment']
        self.assertEqual(db['POSTGRES_DB'], 'mam_uat_people_hub')
        self.assertEqual(db['POSTGRES_PASSWORD'], '${MAM_UAT_POSTGRES_PASSWORD:?required}')
        self.assertEqual(db['POSTGRES_USER'], 'postgres')
        self.assertIn('--auth-host=scram-sha-256', db['POSTGRES_INITDB_ARGS'])
        self.assertNotIn('trust', json.dumps(db))

    def test_05_standalone_build_and_runtime_never_inherit_secrets(self):
        web = self.compose()['services']['uat-web']
        self.assertIn('environment', web, 'Standalone runtime has no explicit UAT environment.')
        environment = web['environment']
        expected = {
            'NODE_ENV': 'production', 'HOSTNAME': '0.0.0.0', 'PORT': '3000',
            'NEXT_TELEMETRY_DISABLED': '1', 'MAM_UAT_ENABLED': 'true',
            'NEXT_PUBLIC_MAM_UAT_ENABLED': 'true', 'MAM_APP_ENV': 'preview',
            'MAM_UAT_TARGET': 'mam-people-hub-uat-v1', 'MAM_UAT_BUILD_ONLY': 'false',
            'MAM_UAT_INTERNAL_SUPABASE_URL': 'http://uat-gateway:8080',
            'NEXT_PUBLIC_SUPABASE_URL': 'https://supabase-uat.srv1866578.hstgr.cloud',
            'NEXT_PUBLIC_APP_URL': 'https://people-hub-uat.srv1866578.hstgr.cloud',
            'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': '${MAM_UAT_ANON_KEY:?required}',
            'SUPABASE_SECRET_KEY': '${MAM_UAT_SERVICE_ROLE_KEY:?required}',
            'MAM_PERFORMANCE_REVIEW_ENABLED': 'true',
        }
        self.assertEqual(environment, expected)
        build = web['build']['args']
        self.assertFalse(set(build) & {'SUPABASE_SECRET_KEY', 'MAM_UAT_SERVICE_ROLE_KEY', 'MAM_UAT_JWT_SECRET'})
        self.assertEqual(build['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'], '${MAM_UAT_ANON_KEY:?required}')
        path = RUNTIME / 'web/Dockerfile'
        self.assertTrue(path.is_file(), 'The real multi-stage Dockerfile is absent.')
        text = path.read_text()
        self.assertIn('AS deps', text)
        self.assertIn('AS builder', text)
        self.assertIn('AS runner', text)
        self.assertIn('npm ci --ignore-scripts --no-audit --no-fund --include=dev', text)
        self.assertIn('npm run build', text)
        self.assertIn('MAM_UAT_BUILD_ONLY=true', text)
        self.assertNotIn('SUPABASE_SECRET_KEY', text)
        self.assertNotIn('COPY . .', text)
        self.assertIn('COPY patches/dayflow-core-3.7.1-dst.json ./patches/', text)
        self.assertIn('/app/.next/standalone ./', text)
        self.assertIn('/app/.next/static ./.next/static', text)
        self.assertIn('/app/public ./public', text)
        runner = text.split('AS runner', 1)[1]
        self.assertNotIn('MAM_UAT_BUILD_ONLY=true', runner)
        self.assertIn('USER 1000:1000', runner)
        self.assertIn('CMD ["node", "server.js"]', runner)
        ignore = (RUNTIME / 'web/Dockerfile.dockerignore').read_text().splitlines()
        self.assertEqual(ignore[0], '**')
        self.assertIn('!patches/dayflow-core-3.7.1-dst.json', ignore)
        self.assertIn('**/.env*', ignore)
        self.assertNotIn('!qa-evidence/**', ignore)
        self.assertNotIn('!deploy/uat/**', ignore)

    def test_06_ingress_comes_from_verified_metadata(self):
        gateway = self.compose()['services']['uat-gateway']
        labels = gateway['labels']
        self.assertIn('traefik.enable', labels, 'The verified HTTPS ingress is not wired.')
        source = json.loads((ROOT / 'qa-evidence/uat-20261016/discovery/mam-ingress-readback.json').read_bytes())
        target = json.loads((ROOT / 'qa-evidence/uat-20261016/discovery/mam-runtime-target-readback.json').read_bytes())
        existing = source['n8n-n8n-1']
        self.assertEqual(labels['traefik.docker.network'], target['ingressNetworks'][0])
        for router, host in [('app', 'people-hub-uat'), ('api', 'supabase-uat')]:
            prefix = 'traefik.http.routers.mam-people-hub-uat-' + router
            self.assertEqual(labels[prefix + '.rule'], 'Host(`' + host + '.srv1866578.hstgr.cloud`)')
            self.assertEqual(labels[prefix + '.entrypoints'], 'websecure')
            self.assertIn(labels[prefix + '.entrypoints'], existing['traefik.http.routers.n8n.entrypoints'].split(','))
            self.assertEqual(labels[prefix + '.tls'], 'true')
            self.assertEqual(labels[prefix + '.tls.certresolver'], existing['traefik.http.routers.n8n.tls.certresolver'])
            self.assertEqual(labels[prefix + '.service'], 'mam-people-hub-uat')
        self.assertEqual(labels['traefik.http.services.mam-people-hub-uat.loadbalancer.server.port'], '8081')
        self.assertEqual(labels['traefik.http.services.mam-people-hub-uat.loadbalancer.server.scheme'], 'http')
        env = gateway['environment']
        self.assertEqual(env['MAM_UAT_ANON_KEY'], '${MAM_UAT_ANON_KEY:?required}')
        self.assertEqual(env['MAM_UAT_SERVICE_ROLE_KEY'], '${MAM_UAT_SERVICE_ROLE_KEY:?required}')
        self.assertEqual(env['NGINX_ENVSUBST_FILTER'], '^(MAM_UAT_ANON_KEY|MAM_UAT_SERVICE_ROLE_KEY)$$')
        self.assertEqual(len([k for k in labels if k.endswith('.rule')]), 2)

    def test_07_health_commands_are_bounded_and_do_not_log_queries_or_keys(self):
        services = self.compose()['services']
        for name in ['uat-db', 'uat-auth', 'uat-web', 'uat-gateway']:
            service = services[name]
            self.assertIn('healthcheck', service, name + ' has no bounded native readiness command.')
            health = service['healthcheck']
            self.assertEqual(health['interval'], '15s')
            self.assertEqual(health['timeout'], '5s')
            self.assertEqual(health['retries'], 10)
            self.assertEqual(health['start_period'], '30s')
            self.assertNotRegex(json.dumps(health), r'(?:PASSWORD|JWT|SERVICE_ROLE|SECRET_KEY|apikey)')
        self.assertEqual(services['uat-db']['healthcheck']['test'], ['CMD', 'pg_isready', '-U', 'postgres', '-d', 'mam_uat_people_hub', '-h', '127.0.0.1'])
        self.assertIn('127.0.0.1:9999/health', json.dumps(services['uat-auth']['healthcheck']))
        self.assertEqual(services['uat-gateway']['healthcheck']['test'], ['CMD', 'nginx', '-t', '-q'])
        self.assertIn('redirect: "error"', services['uat-web']['healthcheck']['test'][-1])
        self.assertEqual(services['uat-rest']['environment']['PGRST_SERVER_ADMIN_PORT'], '3001')
        self.assertIn('log_min_error_statement=panic', services['uat-db']['command'])
        self.assertIn('log_statement=none', services['uat-db']['command'])
        self.assertIn('log_parameter_max_length_on_error=0', services['uat-db']['command'])

    def test_08_standard_test_entrypoint_and_generated_bytes_are_current(self):
        path = ROOT / 'tests/uat-runtime-config.test.mjs'
        self.assertTrue(path.is_file(), 'The normal Node test glob cannot reach the Python contracts.')
        entrypoint = path.read_text()
        self.assertIn('uat-runtime-config.test.py', entrypoint)
        self.assertIn('uat-runtime-config-policy.test.py', entrypoint)
        self.assertNotIn('process.env', entrypoint)
        result = subprocess.run([sys.executable, '-B', str(RUNTIME / 'generate.py'), '--check'], capture_output=True, env={})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'Runtime configuration matches.\n')

    def test_09_standalone_image_itself_cannot_default_out_of_uat_mode(self):
        text = (RUNTIME / 'web/Dockerfile').read_text().split('AS runner', 1)[1]
        self.assertIn('MAM_UAT_ENABLED=true', text, 'Direct image startup could omit the runtime UAT/service-key guard.')
        self.assertIn('MAM_UAT_BUILD_ONLY=false', text)
        self.assertIn('MAM_APP_ENV=preview', text)
        self.assertIn('MAM_UAT_TARGET=mam-people-hub-uat-v1', text)
        self.assertIn('MAM_UAT_INTERNAL_SUPABASE_URL=http://uat-gateway:8080', text)
        self.assertNotIn('SUPABASE_SECRET_KEY=', text)

    def test_10_database_target_guard_rejects_wrong_database_or_roles_without_secrets(self):
        path = RUNTIME / 'check-database-targets.py'
        self.assertTrue(path.is_file(), 'GoTrue/PostgREST URL targets have no focused native-bootstrap guard.')
        spec = importlib.util.spec_from_file_location('uat_database_target_check', path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        auth = 'postgresql://supabase_auth_admin@uat-db:5432/mam_uat_people_hub?sslmode=disable'
        rest = 'postgresql://authenticator@uat-db:5432/mam_uat_people_hub?sslmode=disable'
        self.assertIsNone(module.validate_database_targets(auth, rest))
        for old, new in [
            ('mam_uat_people_hub', 'postgres'), ('mam_uat_people_hub', 'mam_uat_other'),
            ('uat-db:', '127.0.0.1:'), ('uat-db:', 'production.invalid:'),
            (':5432/', ':5433/'), ('supabase_auth_admin@', 'postgres@'),
            ('sslmode=disable', 'sslmode=require'), ('sslmode=disable', 'sslmode=disable&target_session_attrs=any'),
        ]:
            with self.subTest(target_shape='rejected'):
                with self.assertRaisesRegex(ValueError, '^UAT database target rejected[.]$'):
                    module.validate_database_targets(auth.replace(old, new), rest)
        with self.assertRaisesRegex(ValueError, '^UAT database target rejected[.]$'):
            module.validate_database_targets(auth, rest.replace('authenticator@', 'postgres@'))
        with self.assertRaisesRegex(ValueError, '^UAT database target rejected[.]$'):
            module.validate_database_targets(auth + '#not-allowed', rest)
        result = subprocess.run([sys.executable, '-B', str(path)], capture_output=True, env={})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (78, b'', b'UAT database target rejected.\n'))
        result = subprocess.run([sys.executable, '-B', str(path)], capture_output=True, env={
            'MAM_UAT_AUTH_DATABASE_URL': auth, 'MAM_UAT_REST_DATABASE_URL': rest,
        })
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'UAT database targets match.\n', b''))
        doc = {'services': {
            'uat-auth': {'environment': {'GOTRUE_DB_DATABASE_URL': auth}},
            'uat-rest': {'environment': {'PGRST_DB_URI': rest}},
        }}
        result = subprocess.run([sys.executable, '-B', str(path), '--compose-stdin'], input=json.dumps(doc).encode(), capture_output=True, env={})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'UAT database targets match.\n', b''))
        result = subprocess.run([sys.executable, '-B', str(path), '--compose-stdin'], input=b'{not-json}', capture_output=True, env={})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (78, b'', b'UAT database target rejected.\n'))

    def test_11_non_gateway_services_are_never_auto_published_by_traefik(self):
        for name, service in self.compose()['services'].items():
            expected = 'true' if name == 'uat-gateway' else 'false'
            self.assertEqual(service['labels'].get('traefik.enable'), expected, name + ' must explicitly opt out of shared ingress auto-discovery.')


if __name__ == '__main__':
    unittest.main(verbosity=2)
