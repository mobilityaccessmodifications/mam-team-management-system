import json
from pathlib import Path
import re
import subprocess
import unittest
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'deploy/uat/runtime'


ANON = '${MAM_UAT_ANON_KEY}'
SERVICE = '${MAM_UAT_SERVICE_ROLE_KEY}'
APP = 'people-hub-uat.srv1866578.hstgr.cloud'
API = 'supabase-uat.srv1866578.hstgr.cloud'


def nginx_tokens(text):
    result, current = [], ''
    started = False
    i = 0
    while i < len(text):
        char = text[i]
        if char == '$' and text[i:i + 2] == '${':
            started = True
            end = text.index('}', i + 2)
            current += text[i:end + 1]
            i = end + 1
            continue
        if char in '\"\'':
            started = True
            quote = char
            i += 1
            while i < len(text) and text[i] != quote:
                if text[i] == '\\' and i + 1 < len(text) and text[i + 1] in ['\\', quote]:
                    i += 1
                current += text[i]
                i += 1
            if i == len(text):
                raise AssertionError('Unclosed Nginx string.')
        elif char.isspace() or char in ';{}':
            if started:
                result.append(current)
                current = ''
                started = False
            if char in ';{}':
                result.append(char)
        elif char == '#':
            raise AssertionError('The test parser accepts only comment-free generated config.')
        else:
            started = True
            current += char
        i += 1
    if started:
        result.append(current)
    return result


def nginx_tree(text):
    tokens = nginx_tokens(text)
    cursor = 0

    def block(nested=False):
        nonlocal cursor
        nodes, words = [], []
        while cursor < len(tokens):
            token = tokens[cursor]
            cursor += 1
            if token == '}':
                if words or not nested:
                    raise AssertionError('Unexpected Nginx block end.')
                return nodes
            if token == '{':
                if not words:
                    raise AssertionError('Unnamed Nginx block.')
                nodes.append((words[0], words[1:], block(True)))
                words = []
            elif token == ';':
                if not words:
                    raise AssertionError('Empty Nginx directive.')
                nodes.append((words[0], words[1:], []))
                words = []
            else:
                words.append(token)
        if words or nested:
            raise AssertionError('Incomplete Nginx directive.')
        return nodes

    return block()


def entries(nodes, name):
    return [args for directive, args, children in nodes if directive == name]


def pcre(pattern):
    pattern = re.sub(r'\\Q(.*?)\\E', lambda m: re.escape(m.group(1)), pattern)
    return re.compile(pattern)


class ParsedGateway:
    def __init__(self, text):
        self.nodes = nginx_tree(text)
        self.maps = {args[1]: (args[0], children) for name, args, children in self.nodes if name == 'map'}
        self.servers = [children for name, args, children in self.nodes if name == 'server']

    def dispatch(self, method, uri, *, private=False, host=None, origin='', apikey=ANON, authorization='', preflight='') -> dict[str, Any]:
        host = host or ('uat-gateway:8080' if private else API)
        values = {
            '$request_method': method, '$request_uri': uri, '$uri': uri.split('?', 1)[0],
            '$args': uri.partition('?')[2], '$http_host': host,
            '$host': host.split(':')[0], '$http_origin': origin, '$http_apikey': apikey,
            '$http_authorization': authorization, '$http_access_control_request_method': preflight,
            '$remote_addr': '<native-peer>', '$proxy_add_x_forwarded_for': '<native-chain>',
        }

        def expand(value):
            return re.sub(r'\$[a-zA-Z_][a-zA-Z0-9_]*', lambda m: lookup(m.group()), value)

        def lookup(variable):
            if variable in values:
                return values[variable]
            if variable not in self.maps:
                return ''
            source, rows = self.maps[variable]
            value, fallback = expand(source), ''
            for key, result, unused in rows:
                if key == 'default':
                    fallback = result[0]
                elif not key.startswith('~') and key.lower() == value.lower():
                    values[variable] = expand(result[0])
                    return values[variable]
            for key, result, unused in rows:
                if key.startswith('~') and pcre(key[1:]).search(value):
                    values[variable] = expand(result[0])
                    return values[variable]
            values[variable] = expand(fallback)
            return values[variable]

        listener = 'uat-gateway-private:8080' if private else '8081'
        servers = [s for s in self.servers if any(a[0] == listener for a in entries(s, 'listen'))]
        defaults = [s for s in servers if any('default_server' in a for a in entries(s, 'listen'))]
        server = next((s for s in servers if any(host.split(':')[0] in a for a in entries(s, 'server_name'))), defaults[0])

        def run(nodes, headers) -> Any:
            for name, args, children in nodes:
                if name == 'if':
                    expression = ' '.join(args)
                    match = re.fullmatch(r'\((\$[a-zA-Z_]+) = ([^ ]+)\)', expression)
                    if not match:
                        raise AssertionError('Unsupported conditional: ' + expression)
                    if lookup(match.group(1)) == match.group(2):
                        response = run(children, headers)
                        if response is not None:
                            return response
                elif name == 'return':
                    return {'status': int(args[0])}
                elif name == 'rewrite':
                    replacement = re.sub(r'\$(\d)', r'\\g<\1>', args[1])
                    values['$uri'] = re.sub(args[0], replacement, values['$uri'])
                elif name == 'proxy_set_header':
                    headers[args[0].lower()] = expand(args[1])
                elif name == 'proxy_pass':
                    target = args[0].removeprefix('http://')
                    upstream, slash, path = target.partition('/')
                    final_path = '/' + path if slash else values['$uri']
                    if values['$args']:
                        final_path += '?' + values['$args']
                    return {'upstream': upstream, 'path': final_path, 'headers': headers}
            return None

        response = run(server, {})
        if response is not None:
            return response
        path = values['$uri']
        locations = [(a, c) for n, a, c in server if n == 'location']
        selected = next((c for a, c in locations if a[0] == '=' and a[1] == path), None)
        if selected is None:
            selected = next((c for a, c in locations if a[0] == '~' and pcre(a[1]).search(path)), None)
        if selected is None:
            selected = next((c for a, c in locations if a == ['/']), [])
        return run(selected, {}) or {'status': 599}


class GatewayPolicyTests(unittest.TestCase):
    def required(self, name):
        path = RUNTIME / 'gateway' / name
        self.assertTrue(path.is_file(), 'The executable gateway artifact is absent: ' + name)
        return path.read_text()

    def test_01_gateway_image_has_no_root_or_secret_render_bypass(self):
        text = self.required('Dockerfile')
        self.assertIn('ARG UAT_BASE_IMAGE', text)
        self.assertIn('FROM ${UAT_BASE_IMAGE}', text)
        self.assertIn('USER 101:101', text)
        self.assertNotRegex(text, r'(?m)^(?:ARG|ENV).*MAM_UAT_(?:ANON|SERVICE_ROLE)_KEY=')
        self.assertIn('COPY nginx.conf /etc/nginx/nginx.conf', text)
        self.assertIn('COPY uat.conf.template /etc/nginx/templates/uat.conf.template', text)
        script = self.required('entrypoint.sh')
        self.assertIn("NGINX_ENVSUBST_FILTER='^(MAM_UAT_ANON_KEY|MAM_UAT_SERVICE_ROLE_KEY)$'", script)
        self.assertIn('/docker-entrypoint.d/20-envsubst-on-templates.sh', script)
        self.assertNotIn('set -x', script)
        self.assertNotIn('envsubst <', script)
        result = subprocess.run(['/bin/sh', '-n', str(RUNTIME / 'gateway/entrypoint.sh')], capture_output=True, env={})
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(['/bin/sh', str(RUNTIME / 'gateway/entrypoint.sh')], capture_output=True, env={})
        self.assertEqual(result.returncode, 78)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'UAT gateway configuration rejected.\n')
        main = self.required('nginx.conf')
        self.assertIn('pid /tmp/nginx.pid;', main)
        self.assertIn('access_log off;', main)
        self.assertIn('error_log /dev/null emerg;', main)
        self.assertIn('client_body_temp_path /tmp/client_body;', main)
        self.assertIn('proxy_temp_path /tmp/proxy;', main)
        self.assertIn('client_max_body_size 2m;', main)
        self.assertGreater(2 * 1024 * 1024, 12 * 8000 * 6 + 4 * 8000 * 6)
        self.assertNotRegex(main, r'(?m)^user\s')

    def test_02_actual_template_routes_only_closed_native_api(self):
        self.assertEqual(nginx_tree('map $input $result { default 0; exact 1; }')[0][0], 'map')
        self.assertIsNotNone(pcre(r'^\Q${MAM_UAT_ANON_KEY}\E$').fullmatch(ANON))
        gateway = ParsedGateway(self.required('uat.conf.template'))
        self.assertEqual(len(gateway.servers), 5)
        upstreams = {a[0]: entries(c, 'server')[0][0] for n, a, c in gateway.nodes if n == 'upstream'}
        self.assertEqual(upstreams, {'uat_auth': 'uat-auth:9999', 'uat_rest': 'uat-rest:3000', 'uat_web': 'uat-web:3000'})
        for private in [False, True]:
            for method, path, native in [
                ('POST', '/auth/v1/token?grant_type=password', '/token?grant_type=password'),
                ('POST', '/auth/v1/token?grant_type=refresh_token', '/token?grant_type=refresh_token'),
                ('POST', '/auth/v1/logout', '/logout'),
                ('POST', '/auth/v1/logout?scope=local', '/logout?scope=local'),
                ('POST', '/auth/v1/logout?scope=global', '/logout?scope=global'),
                ('POST', '/auth/v1/logout?scope=others', '/logout?scope=others'),
                ('GET', '/auth/v1/user', '/user'),
                ('GET', '/auth/v1/settings', '/settings'),
                ('GET', '/auth/v1/.well-known/jwks.json', '/.well-known/jwks.json'),
            ]:
                with self.subTest(private=private, method=method, path=path):
                    result = gateway.dispatch(method, path, private=private, authorization='Bearer <native-user>')
                    self.assertEqual(result.get('upstream'), 'uat_auth')
                    self.assertEqual(result['path'], native)
                    self.assertEqual(result['headers']['authorization'], 'Bearer <native-user>')
            for method in ['GET', 'HEAD', 'POST']:
                for path in ['/rest/v1/public_relation?select=id&limit=10', '/rest/v1/rpc/performance_review_workspace']:
                    result = gateway.dispatch(method, path, private=private, authorization='Bearer <native-user>')
                    self.assertEqual(result.get('upstream'), 'uat_rest')
                    self.assertEqual(result['path'], path.removeprefix('/rest/v1'))
                    self.assertEqual(result['headers']['authorization'], 'Bearer <native-user>')
            for method, path in [
                ('GET', '/auth/v1/token?grant_type=password'),
                ('POST', '/auth/v1/token?grant_type=pkce'),
                ('POST', '/auth/v1/token?grant_type=password&grant_type=password'),
                ('POST', '/auth/v1/token?grant_type=password&redirect_to=https://invalid.example'),
                ('POST', '/auth/v1/logout?scope=all'), ('POST', '/auth/v1/logout?scope=local&scope=global'),
                ('GET', '/auth/v1/user?select=*'), ('PUT', '/auth/v1/user'),
                ('POST', '/auth/v1/signup'), ('POST', '/auth/v1/recover'),
                ('POST', '/auth/v1/verify'), ('POST', '/auth/v1/otp'),
                ('POST', '/auth/v1/invite'), ('GET', '/auth/v1/admin/users'),
                ('POST', '/auth/v1/sso'), ('GET', '/storage/v1/object'), ('GET', '/realtime/v1/websocket'),
                ('PUT', '/rest/v1/public_relation'), ('PATCH', '/rest/v1/public_relation'),
                ('DELETE', '/rest/v1/public_relation'), ('POST', '/rest/v1/rpc/a/b'),
                ('POST', '/rest/v1/rpc/%61'), ('POST', '/rest/v1/rpc/Fn'),
                ('GET', '/rest/v1/rpc/a/'), ('GET', '//rest/v1/rpc/a'),
            ]:
                with self.subTest(private=private, method=method, path=path):
                    self.assertEqual(gateway.dispatch(method, path, private=private), {'status': 404})
        for apikey, authorization in [('', ''), ('<not-an-apikey>', ''), (SERVICE, 'Bearer ' + SERVICE), (ANON, 'Bearer ' + SERVICE), (ANON, 'bEaReR ' + SERVICE), (ANON.lower(), '')]:
            with self.subTest(credential_class='rejected'):
                self.assertEqual(gateway.dispatch('GET', '/auth/v1/settings', apikey=apikey, authorization=authorization), {'status': 401})
        for origin in ['https://' + APP, '']:
            self.assertEqual(gateway.dispatch('GET', '/auth/v1/settings', origin=origin)['upstream'], 'uat_auth')
        for origin in ['null', 'https://invalid.example', 'https://' + APP + '.invalid', 'https://' + APP + '/']:
            self.assertEqual(gateway.dispatch('GET', '/auth/v1/settings', origin=origin), {'status': 403})
        self.assertEqual(gateway.dispatch('OPTIONS', '/auth/v1/token?grant_type=password', origin='https://' + APP, apikey='', preflight='POST'), {'status': 204})
        self.assertEqual(gateway.dispatch('OPTIONS', '/auth/v1/token?grant_type=password', origin='https://' + APP, apikey='', preflight='GET'), {'status': 404})
        self.assertEqual(gateway.dispatch('OPTIONS', '/auth/v1/token?grant_type=password', apikey='', preflight='POST'), {'status': 403})
        self.assertEqual(gateway.dispatch('GET', '/auth/v1/settings', host='invalid.example'), {'status': 444})
        self.assertEqual(gateway.dispatch('GET', '/auth/v1/settings', host=API + ':8080'), {'status': 444})
        self.assertEqual(gateway.dispatch('GET', '/auth/v1/settings', private=True, host=API), {'status': 444})
        app = gateway.dispatch('GET', '/login', host=APP)
        self.assertEqual(app['upstream'], 'uat_web')
        self.assertEqual(app['headers']['host'], APP)
        self.assertEqual(app['headers']['x-forwarded-proto'], 'https')

    def test_03_private_service_token_is_confined_to_actual_login_rpcs(self):
        source = (ROOT / 'src/app/login/actions.ts').read_text()
        login_rpcs = re.findall(r'\badmin(?:\?)?\.rpc\(\s*"([a-z_]+)"', source)
        self.assertEqual(set(login_rpcs), {'claim_portal_login_attempt', 'resolve_portal_login_auth_email', 'clear_portal_login_rate_limit'})
        gateway = ParsedGateway(self.required('uat.conf.template'))
        for function in login_rpcs:
            path = '/rest/v1/rpc/' + function
            result = gateway.dispatch('POST', path, private=True, apikey=SERVICE, authorization='Bearer ' + SERVICE)
            self.assertEqual(result.get('upstream'), 'uat_rest', 'Required native login RPC was blocked: ' + function)
            self.assertEqual(result['path'], '/rpc/' + function)
            self.assertEqual(result['headers']['authorization'], 'Bearer ' + SERVICE)
            self.assertEqual(gateway.dispatch('POST', path, apikey=SERVICE, authorization='Bearer ' + SERVICE), {'status': 401})
            for method, suffix in [('GET', ''), ('HEAD', ''), ('POST', '?arg=1')]:
                self.assertEqual(gateway.dispatch(method, path + suffix, private=True, apikey=SERVICE, authorization='Bearer ' + SERVICE), {'status': 401})
        for path in ['/rest/v1/rpc/claim_other_background_worker', '/rest/v1/rpc/mutate_performance_review', '/rest/v1/private_relation', '/auth/v1/user', '/auth/v1/settings']:
            self.assertEqual(gateway.dispatch('GET' if path.startswith('/auth/') else 'POST', path, private=True, apikey=SERVICE, authorization='Bearer ' + SERVICE), {'status': 401})
        for header in ['Bearer ' + SERVICE, 'bEaReR    ' + SERVICE + '  ', 'Bearer\t' + SERVICE]:
            self.assertEqual(gateway.dispatch('POST', '/rest/v1/rpc/claim_other_background_worker', private=True, apikey=ANON, authorization=header), {'status': 401})
            self.assertEqual(gateway.dispatch('POST', '/rest/v1/rpc/claim_portal_login_attempt', apikey=ANON, authorization=header), {'status': 401})
        private = [s for s in gateway.servers if entries(s, 'server_name') == [['uat-gateway']]][0]
        self.assertEqual(entries(private, 'listen'), [['uat-gateway-private:8080']])
        self.assertNotIn(['8080'], [v for s in gateway.servers for v in entries(s, 'listen')])

    def test_04_native_redirects_and_untrusted_response_headers_are_not_forwarded(self):
        gateway = ParsedGateway(self.required('uat.conf.template'))
        native_servers = [s for s in gateway.servers if entries(s, 'server_name') in [[[API]], [['uat-gateway']]]]
        self.assertEqual(len(native_servers), 2)
        for server in native_servers:
            self.assertEqual(entries(server, 'proxy_intercept_errors'), [['on']], 'Native API redirects could reach the browser.')
            pages = entries(server, 'error_page')
            self.assertEqual(len(pages), 1)
            self.assertEqual({int(v) for v in pages[0][:-2]}, set(range(300, 400)))
            self.assertEqual(pages[0][-2:], ['=502', '@uat_redirect_denied'])
            denial = [c for n, a, c in server if n == 'location' and a == ['@uat_redirect_denied']]
            self.assertEqual(entries(denial[0], 'return'), [['502']])
            hidden = {v[0] for v in entries(server, 'proxy_hide_header')}
            self.assertTrue({'Location', 'Refresh', 'X-Accel-Redirect', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Credentials'} <= hidden)
            self.assertEqual(entries(server, 'proxy_ignore_headers'), [['X-Accel-Redirect']])
            cors = {v[0]: v[1:] for v in entries(server, 'add_header')}
            self.assertEqual(cors['Access-Control-Allow-Origin'], ['$uat_cors_origin', 'always'])
            self.assertNotIn('*', json.dumps(cors))
            for name, args, location in server:
                if name == 'location' and entries(location, 'proxy_pass'):
                    self.assertEqual(entries(location, 'proxy_pass_request_headers'), [['off']])
                    header = {a[0].lower(): a[1] for a in entries(location, 'proxy_set_header')}
                    self.assertEqual(header['authorization'], '$http_authorization')
                    self.assertNotIn('apikey', header)
                    self.assertEqual(header['accept-profile'], '$http_accept_profile')
                    self.assertEqual(header['content-profile'], '$http_content_profile')
                    self.assertNotIn('$', entries(location, 'proxy_pass')[0][0])
        app = [s for s in gateway.servers if entries(s, 'server_name') == [[APP]]][0]
        self.assertFalse(entries(app, 'proxy_intercept_errors'), 'Native API redirect policy must not break Next login redirects.')
        self.assertNotIn('resolver', {n for n, a, c in gateway.nodes})
        self.assertNotIn('lua', self.required('uat.conf.template').lower())


if __name__ == '__main__':
    unittest.main(verbosity=2)
