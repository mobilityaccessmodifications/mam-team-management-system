import argparse
import json
from pathlib import Path
import re
from typing import Any

HERE = Path(__file__).resolve().parent
PROJECT = 'mam-people-hub-uat'
INSTANCE = 'mam-people-hub-uat-v1'
DATABASE = 'mam_uat_people_hub'
APP_HOST = 'people-hub-uat.srv1866578.hstgr.cloud'
API_HOST = 'supabase-uat.srv1866578.hstgr.cloud'


def image_references():
    pins = json.loads((HERE / 'images.json').read_bytes())
    if set(pins) != {'db', 'auth', 'rest', 'web', 'gateway'}:
        raise ValueError('The five official image pins are required.')
    postgres16 = json.loads((HERE / 'postgres16.json').read_bytes())
    if postgres16['requiredDatabaseMajor'] != 16 or postgres16['sourceTag'] != '16-bookworm' or postgres16['repository'] != 'library/postgres':
        raise ValueError('The generated-v5 bootstrap requires its verified PostgreSQL 16 pin.')
    pins['db'] = postgres16
    result = {}
    for name, pin in pins.items():
        digest = pin['platformManifestDigest']
        if pin['platform'] != 'linux/amd64' or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise ValueError('Invalid platform manifest pin.')
        ref = pin['repository'] + '@' + digest
        if ref != pin['reference'] or digest == pin['imageConfigDigest']:
            raise ValueError('A manifest pin, not an image-config digest, is required.')
        result[name] = ref
    return result


def native_environments():
    auth = {
        'GOTRUE_API_HOST': '0.0.0.0', 'GOTRUE_API_PORT': '9999',
        'API_EXTERNAL_URL': 'https://' + API_HOST,
        'GOTRUE_SITE_URL': 'https://' + APP_HOST,
        'GOTRUE_URI_ALLOW_LIST': 'https://' + APP_HOST,
        'GOTRUE_DB_DRIVER': 'postgres', 'GOTRUE_DB_NAMESPACE': 'auth',
        'GOTRUE_DB_DATABASE_URL': '${MAM_UAT_AUTH_DATABASE_URL:?required}',
        'GOTRUE_JWT_SECRET': '${MAM_UAT_JWT_SECRET:?required}',
        'GOTRUE_JWT_ISSUER': INSTANCE, 'GOTRUE_JWT_AUD': 'authenticated',
        'GOTRUE_JWT_DEFAULT_GROUP_NAME': 'authenticated',
        'GOTRUE_JWT_ADMIN_ROLES': 'service_role', 'GOTRUE_JWT_ADMIN_GROUP_NAME': 'service_role',
        'GOTRUE_JWT_EXP': '3600', 'GOTRUE_DISABLE_SIGNUP': 'true',
        'GOTRUE_EXTERNAL_EMAIL_ENABLED': 'true',
        'GOTRUE_EXTERNAL_EMAIL_MAGIC_LINK_ENABLED': 'false',
        'GOTRUE_MAILER_AUTOCONFIRM': 'false',
        'GOTRUE_MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS': 'false',
        'GOTRUE_EXTERNAL_PHONE_ENABLED': 'false',
        'GOTRUE_SMS_PROVIDER': '', 'GOTRUE_SMS_AUTOCONFIRM': 'false',
        'GOTRUE_SMTP_HOST': '127.0.0.1', 'GOTRUE_SMTP_PORT': '1',
        'GOTRUE_SMTP_USER': '', 'GOTRUE_SMTP_PASS': '', 'GOTRUE_SMTP_ADMIN_EMAIL': '',
        'GOTRUE_SMTP_SENDER_NAME': '', 'GOTRUE_SMTP_LOGGING_ENABLED': 'false',
        'GOTRUE_SAML_ENABLED': 'false', 'GOTRUE_CUSTOM_OAUTH_ENABLED': 'false',
        'GOTRUE_OAUTH_SERVER_ENABLED': 'false', 'GOTRUE_PASSKEY_ENABLED': 'false',
        'GOTRUE_PASSWORD_MIN_LENGTH': '8',
        'GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED': 'false',
        'GOTRUE_MAILER_EMAIL_BACKGROUND_SENDING': 'false',
        'GOTRUE_MAILER_EMAIL_VALIDATION_SERVICE_URL': '',
        'GOTRUE_LOG_LEVEL': 'error',
    }
    providers = [
        'ANONYMOUS_USERS', 'APPLE', 'AZURE', 'BITBUCKET', 'DISCORD', 'FACEBOOK',
        'SNAPCHAT', 'FIGMA', 'FLY', 'GITHUB', 'GITLAB', 'GOOGLE', 'KAKAO',
        'NOTION', 'KEYCLOAK', 'LINKEDIN', 'LINKEDIN_OIDC', 'SPOTIFY', 'SLACK',
        'SLACK_OIDC', 'TWITTER', 'TWITCH', 'VERCEL_MARKETPLACE', 'WORKOS', 'X',
        'ZOOM', 'WEB3_SOLANA', 'WEB3_ETHEREUM',
    ]
    auth.update({'GOTRUE_EXTERNAL_' + p + '_ENABLED': 'false' for p in providers})
    for notification in [
        'PASSWORD_CHANGED', 'EMAIL_CHANGED', 'PHONE_CHANGED', 'IDENTITY_LINKED',
        'IDENTITY_UNLINKED', 'MFA_FACTOR_ENROLLED', 'MFA_FACTOR_UNENROLLED',
    ]:
        auth['GOTRUE_MAILER_NOTIFICATIONS_' + notification + '_ENABLED'] = 'false'
    return {
        'auth': auth,
        'rest': {
            'PGRST_DB_URI': '${MAM_UAT_REST_DATABASE_URL:?required}',
            'PGRST_DB_SCHEMAS': 'public', 'PGRST_DB_EXTRA_SEARCH_PATH': 'public',
            'PGRST_DB_ANON_ROLE': 'anon',
            'PGRST_JWT_SECRET': '${MAM_UAT_JWT_SECRET:?required}',
            'PGRST_JWT_AUD': 'authenticated',
            'PGRST_SERVER_HOST': '0.0.0.0', 'PGRST_SERVER_PORT': '3000',
            'PGRST_SERVER_ADMIN_PORT': '3001',
            'PGRST_DB_POOL': '5', 'PGRST_MAX_ROWS': '1000',
            'PGRST_OPENAPI_MODE': 'disabled', 'PGRST_LOG_LEVEL': 'crit',
        },
        'db': {
            'POSTGRES_DB': DATABASE, 'POSTGRES_USER': 'postgres',
            'POSTGRES_PASSWORD': '${MAM_UAT_POSTGRES_PASSWORD:?required}',
            'PGDATA': '/var/lib/postgresql/data/pgdata',
            'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256 --auth-local=scram-sha-256',
        },
    }


def compose():
    ingress = json.loads((HERE / 'ingress.json').read_bytes())
    if ingress['network'] != 'n8n_default' or not all(re.fullmatch('[a-zA-Z0-9_-]+', ingress[k]) for k in ['entrypoint', 'certresolver']):
        raise ValueError('Invalid verified ingress metadata.')
    services = {}
    for name, ref in image_references().items():
        service: dict[str, Any] = {'platform': 'linux/amd64'}
        if name in {'web', 'gateway'}:
            service['image'] = PROJECT + '-' + name + ':' + INSTANCE
            service['build'] = {
                'context': '../../..' if name == 'web' else './gateway',
                'dockerfile': 'deploy/uat/runtime/web/Dockerfile' if name == 'web' else 'Dockerfile',
                'args': {'UAT_BASE_IMAGE': ref},
            }
        else:
            service['image'] = ref
        service['labels'] = {'com.mam.uat.owner': PROJECT, 'com.mam.uat.instance': INSTANCE, 'traefik.enable': 'false'}
        service['networks'] = {'backend': {}}
        cpu, memory, pids, uid = {
            'db': ('1.00', '1024m', 128, None),
            'auth': ('0.50', '384m', 128, '1000:1000'),
            'rest': ('0.50', '256m', 128, '1000:1000'),
            'web': ('1.00', '1024m', 192, '1000:1000'),
            'gateway': ('0.50', '128m', 64, '101:101'),
        }[name]
        service.update({
            'cpus': cpu, 'mem_limit': memory, 'pids_limit': pids,
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'read_only': True, 'restart': 'unless-stopped',
            'logging': {'driver': 'none'},
            'tmpfs': ['/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'],
        })
        if uid:
            service['user'] = uid
        health_commands = {
            'db': ['CMD', 'pg_isready', '-U', 'postgres', '-d', DATABASE, '-h', '127.0.0.1'],
            'auth': ['CMD', 'wget', '-q', '--spider', 'http://127.0.0.1:9999/health'],
            'gateway': ['CMD', 'nginx', '-t', '-q'],
            'web': ['CMD', 'node', '-e', 'fetch("http://127.0.0.1:3000/login", { redirect: "error", signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'],
        }
        if name in health_commands:
            service['healthcheck'] = {
                'test': health_commands[name], 'interval': '15s', 'timeout': '5s',
                'retries': 10, 'start_period': '30s',
            }
        if name == 'gateway':
            service['networks']['backend'] = {'aliases': ['uat-gateway-private']}
            service['networks']['ingress'] = {}
            service['tmpfs'].append('/etc/nginx/conf.d:rw,nosuid,nodev,noexec,size=1m,uid=101,gid=101,mode=0700')
            service['sysctls'] = {'net.ipv4.ip_forward': '0'}
            service['environment'] = {
                'MAM_UAT_ANON_KEY': '${MAM_UAT_ANON_KEY:?required}',
                'MAM_UAT_SERVICE_ROLE_KEY': '${MAM_UAT_SERVICE_ROLE_KEY:?required}',
                'NGINX_ENVSUBST_FILTER': '^(MAM_UAT_ANON_KEY|MAM_UAT_SERVICE_ROLE_KEY)$$',
                'NGINX_ENTRYPOINT_QUIET_LOGS': '1',
            }
            service['labels'].update({
                'traefik.enable': 'true', 'traefik.docker.network': ingress['network'],
                'traefik.http.services.' + PROJECT + '.loadbalancer.server.port': '8081',
                'traefik.http.services.' + PROJECT + '.loadbalancer.server.scheme': 'http',
            })
            for router, host in [('app', APP_HOST), ('api', API_HOST)]:
                prefix = 'traefik.http.routers.' + PROJECT + '-' + router
                service['labels'].update({
                    prefix + '.rule': 'Host(`' + host + '`)',
                    prefix + '.entrypoints': ingress['entrypoint'],
                    prefix + '.tls': 'true', prefix + '.tls.certresolver': ingress['certresolver'],
                    prefix + '.service': PROJECT,
                })
        if name == 'web':
            service['tmpfs'].append('/app/.next/cache:rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700')
        if name == 'db':
            service['cap_add'] = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']
            service['tmpfs'].append('/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m,uid=999,gid=999,mode=3775')
            service['volumes'] = [{'type': 'volume', 'source': 'db-data', 'target': '/var/lib/postgresql/data'}]
            service['command'] = [
                'postgres', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic',
                '-c', 'log_parameter_max_length_on_error=0', '-c', 'log_connections=off',
                '-c', 'log_disconnections=off', '-c', 'log_duration=off',
            ]
        if name in native_environments():
            service['environment'] = native_environments()[name]
        if name == 'web':
            public = {
                'NEXT_PUBLIC_MAM_UAT_ENABLED': 'true',
                'NEXT_PUBLIC_APP_URL': 'https://' + APP_HOST,
                'NEXT_PUBLIC_SUPABASE_URL': 'https://' + API_HOST,
                'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': '${MAM_UAT_ANON_KEY:?required}',
            }
            service['build']['args'].update(public)
            service['environment'] = {
                **public, 'NODE_ENV': 'production', 'HOSTNAME': '0.0.0.0', 'PORT': '3000',
                'NEXT_TELEMETRY_DISABLED': '1', 'MAM_UAT_ENABLED': 'true',
                'MAM_APP_ENV': 'preview', 'MAM_UAT_TARGET': INSTANCE,
                'MAM_UAT_BUILD_ONLY': 'false',
                'MAM_UAT_INTERNAL_SUPABASE_URL': 'http://uat-gateway:8080',
                'SUPABASE_SECRET_KEY': '${MAM_UAT_SERVICE_ROLE_KEY:?required}',
                'MAM_PERFORMANCE_REVIEW_ENABLED': 'true',
            }
        services['uat-' + name] = service
    labels = {'com.mam.uat.owner': PROJECT, 'com.mam.uat.instance': INSTANCE}
    return {
        'name': PROJECT, 'services': services,
        'networks': {
            'backend': {'name': PROJECT + '-backend', 'internal': True, 'labels': labels},
            'ingress': {'external': True, 'name': ingress['network']},
        },
        'volumes': {'db-data': {'name': PROJECT + '-db-data', 'labels': labels}},
    }


def nginx_map(source, variable, rows):
    body = '\n'.join('    ' + json.dumps(key) + ' ' + json.dumps(value) + ';' for key, value in rows)
    return 'map ' + json.dumps(source) + ' $' + variable + ' {\n' + body + '\n}\n'


def gateway_template():
    anon = '${MAM_UAT_ANON_KEY}'
    service = '${MAM_UAT_SERVICE_ROLE_KEY}'
    chunks = [
        'upstream uat_auth { server uat-auth:9999; }\n',
        'upstream uat_rest { server uat-rest:3000; }\n',
        'upstream uat_web { server uat-web:3000; }\n',
        nginx_map('$http_origin', 'uat_origin_ok', [('default', '0'), ('', '1'), ('~^https://' + re.escape(APP_HOST) + '$', '1')]),
        nginx_map('$http_origin', 'uat_cors_origin', [('default', ''), ('~^https://' + re.escape(APP_HOST) + '$', '$http_origin')]),
        nginx_map('$request_method:$http_origin', 'uat_preflight_origin_ok', [('default', '1'), ('OPTIONS:', '0')]),
        nginx_map('$request_method', 'uat_policy_method', [('default', '$request_method'), ('OPTIONS', '$http_access_control_request_method')]),
        nginx_map('$http_host', 'uat_app_host_ok', [('default', '0'), ('~^' + re.escape(APP_HOST) + '(?::443)?$', '1')]),
        nginx_map('$http_host', 'uat_api_host_ok', [('default', '0'), ('~^' + re.escape(API_HOST) + '(?::443)?$', '1')]),
        nginx_map('$http_host', 'uat_private_host_ok', [('default', '0'), ('uat-gateway:8080', '1')]),
        nginx_map('$request_method', 'uat_app_method_ok', [('default', '0'), ('GET', '1'), ('HEAD', '1'), ('POST', '1')]),
        nginx_map('$http_apikey', 'uat_api_key', [
            ('default', 'invalid'), (r'~^\Q' + anon + r'\E$', 'anon'), (r'~^\Q' + service + r'\E$', 'service'),
        ]),
        nginx_map('$http_authorization', 'uat_bearer', [('default', 'user'), ('', 'absent'), (r'~\Q' + service + r'\E', 'service')]),
        nginx_map('$uat_api_key:$uat_bearer', 'uat_public_credential_ok', [('default', '0'), ('anon:absent', '1'), ('anon:user', '1')]),
        nginx_map('$request_method:$request_uri', 'uat_login_rpc', [
            ('default', '0'),
            (r'~^POST:/rest/v1/rpc/(?:claim_portal_login_attempt|resolve_portal_login_auth_email|clear_portal_login_rate_limit)$', '1'),
        ]),
        nginx_map('$uat_api_key:$uat_bearer:$uat_login_rpc', 'uat_private_credential_ok', [
            ('default', '0'), ('anon:absent:0', '1'), ('anon:absent:1', '1'),
            ('anon:user:0', '1'), ('anon:user:1', '1'), ('service:service:1', '1'),
        ]),
        nginx_map('$uat_policy_method:$request_uri', 'uat_auth_route', [
            ('default', '0'),
            (r'~^POST:/auth/v1/token[?]grant_type=(?:password|refresh_token)$', '1'),
            (r'~^POST:/auth/v1/logout(?:[?]scope=(?:local|global|others))?$', '1'),
            (r'~^GET:/auth/v1/(?:user|settings|[.]well-known/jwks[.]json)$', '1'),
        ]),
        nginx_map('$uat_policy_method:$request_uri', 'uat_rest_route', [
            ('default', '0'),
            (r'~^(?:GET|HEAD|POST):/rest/v1/(?:rpc/)?[a-z][a-z0-9_]*(?:[?].*)?$', '1'),
        ]),
        'server { listen 8081 default_server; server_name _; return 444; }\n',
        'server { listen uat-gateway-private:8080 default_server; server_name _; return 444; }\n',
        'server {\n    listen 8081;\n    server_name ' + APP_HOST + ';\n'
        '    if ($uat_app_host_ok = 0) { return 444; }\n'
        '    if ($uat_origin_ok = 0) { return 403; }\n'
        '    location / {\n'
        '        if ($uat_app_method_ok = 0) { return 405; }\n'
        '        proxy_http_version 1.1;\n'
        '        proxy_set_header Host $http_host;\n'
        '        proxy_set_header X-Forwarded-Host $http_host;\n'
        '        proxy_set_header X-Forwarded-Proto https;\n'
        '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        '        proxy_set_header Connection "";\n'
        '        proxy_ignore_headers X-Accel-Redirect;\n'
        '        proxy_buffering off;\n'
        '        proxy_redirect off;\n'
        '        proxy_pass http://uat_web;\n'
        '    }\n}\n',
    ]
    for private in [False, True]:
        chunks.append(api_server(private))
    return '\n'.join(chunks)


def api_server(private):
    listener, hostname, scope = ('uat-gateway-private:8080', 'uat-gateway', 'private') if private else ('8081', API_HOST, 'api')
    credential = '$uat_private_credential_ok' if private else '$uat_public_credential_ok'
    text = 'server {\n    listen ' + listener + ';\n    server_name ' + hostname + ';\n'
    text += '    if ($uat_' + scope + '_host_ok = 0) { return 444; }\n'
    text += '    if ($uat_origin_ok = 0) { return 403; }\n'
    text += '    if ($uat_preflight_origin_ok = 0) { return 403; }\n'
    text += '    proxy_intercept_errors on;\n'
    text += '    proxy_ignore_headers X-Accel-Redirect;\n'
    text += '    error_page ' + ' '.join(str(code) for code in range(300, 400)) + ' =502 @uat_redirect_denied;\n'
    for header in [
        'Location', 'Refresh', 'X-Accel-Redirect', 'Access-Control-Allow-Origin',
        'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers',
        'Access-Control-Allow-Methods', 'Access-Control-Expose-Headers',
    ]:
        text += '    proxy_hide_header ' + header + ';\n'
    text += '    location @uat_redirect_denied { return 502; }\n'
    text += '''    add_header Access-Control-Allow-Origin $uat_cors_origin always;
    add_header Vary Origin always;
    add_header Access-Control-Allow-Methods "GET, HEAD, POST, OPTIONS" always;
    add_header Access-Control-Allow-Headers "apikey, authorization, content-type, x-client-info, accept, accept-profile, content-profile, prefer, range, range-unit, x-supabase-api-version" always;
    add_header Access-Control-Expose-Headers "content-range, range-unit" always;
'''
    for path in ['token', 'logout', 'user', 'settings', '.well-known/jwks.json']:
        text += '    location = /auth/v1/' + path + ' {\n'
        text += native_proxy('auth', credential, 'http://uat_auth/' + path)
        text += '    }\n'
    text += '    location ~ ^/rest/v1/(?:rpc/)?[a-z][a-z0-9_]*$ {\n'
    text += native_proxy('rest', credential, 'http://uat_rest')
    text += '    }\n    location / { return 404; }\n}\n'
    return text


def native_proxy(kind, credential, upstream):
    text = '        if ($uat_' + kind + '_route = 0) { return 404; }\n'
    text += '        if ($request_method = OPTIONS) { return 204; }\n'
    text += '        if (' + credential + ' = 0) { return 401; }\n'
    text += '''        proxy_http_version 1.1;
        proxy_pass_request_headers off;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Content-Type $http_content_type;
        proxy_set_header Accept $http_accept;
        proxy_set_header Accept-Profile $http_accept_profile;
        proxy_set_header Content-Profile $http_content_profile;
        proxy_set_header Prefer $http_prefer;
        proxy_set_header Range $http_range;
        proxy_set_header Range-Unit $http_range_unit;
        proxy_set_header X-Client-Info $http_x_client_info;
        proxy_set_header X-Supabase-Api-Version $http_x_supabase_api_version;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_redirect off;
'''
    text += '        proxy_set_header Host ' + API_HOST + ';\n'
    if kind == 'rest':
        text += '        rewrite ^/rest/v1/(.*)$ /$1 break;\n'
    text += '        proxy_pass ' + upstream + ';\n'
    return text


def artifacts():
    return {
        'compose.json': json.dumps(compose(), indent=2) + '\n',
        'gateway/uat.conf.template': gateway_template(),
    }



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for name, value in artifacts().items():
        target = HERE / name
        if args.check:
            if not target.is_file() or target.read_text() != value:
                raise SystemExit('Generated runtime artifact differs: ' + name)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value)
    print('Runtime configuration matches.' if args.check else 'Runtime configuration generated.')


if __name__ == '__main__':
    main()
