import json
import os
import sys
from urllib.parse import urlsplit

DATABASE = 'mam_uat_people_hub'
MESSAGE = 'UAT database target rejected.'


def validate_database_targets(auth_url, rest_url):
    try:
        for value, role in [(auth_url, 'supabase_auth_admin'), (rest_url, 'authenticator')]:
            if not isinstance(value, str) or not value or value != value.strip():
                raise ValueError(MESSAGE)
            if any(ord(char) < 32 or ord(char) == 127 for char in value):
                raise ValueError(MESSAGE)
            url = urlsplit(value)
            if url.scheme not in {'postgres', 'postgresql'} or url.hostname != 'uat-db' or url.port != 5432:
                raise ValueError(MESSAGE)
            if url.username != role or url.path != '/' + DATABASE or url.fragment or url.query != 'sslmode=disable':
                raise ValueError(MESSAGE)
    except Exception:
        raise ValueError(MESSAGE) from None


def main():
    try:
        if sys.argv[1:] == ['--compose-stdin']:
            raw = sys.stdin.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError(MESSAGE)
            config = json.loads(raw)
            auth_url = config['services']['uat-auth']['environment']['GOTRUE_DB_DATABASE_URL']
            rest_url = config['services']['uat-rest']['environment']['PGRST_DB_URI']
        elif not sys.argv[1:]:
            auth_url = os.environ.get('MAM_UAT_AUTH_DATABASE_URL')
            rest_url = os.environ.get('MAM_UAT_REST_DATABASE_URL')
        else:
            raise ValueError(MESSAGE)
        validate_database_targets(auth_url, rest_url)
    except Exception:
        print(MESSAGE, file=sys.stderr)
        return 78
    print('UAT database targets match.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
