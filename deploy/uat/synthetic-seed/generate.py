import json
from pathlib import Path
import re
import sys
import uuid

KEYS = ('p0','hr','mam_upper_manager','mam_manager','mam_employee','mam_account','mam_other_manager','equipsy_upper_manager','equipsy_manager','equipsy_employee')
ROLES = ('system_admin','admin','manager','manager','employee','account','manager','manager','manager','employee')
PARENTS = (None,None,None,'mam_upper_manager','mam_manager','mam_manager','mam_upper_manager',None,'equipsy_upper_manager','equipsy_manager')
NAMES = ('UAT P0 Observer','UAT HR Admin','UAT MAM Upper Manager','UAT MAM Manager','UAT MAM Employee','UAT MAM Account','UAT MAM Other Manager','UAT Equipsy Upper Manager','UAT Equipsy Manager','UAT Equipsy Employee')
NAMESPACE = uuid.UUID('a1c28db4-2434-4cb4-8d68-a472f1b7c714')


def catalog():
    people = {key: str(uuid.uuid5(NAMESPACE, key)) if key != 'p0' else None for key in KEYS}
    return [{'fixtureKey':key, 'email':'uat.'+key.replace('_','.')+'@mam-uat.invalid',
             'fullName':name, 'appRole':role,
             'companyKey':None if key == 'p0' else 'equipsy' if key.startswith('equipsy_') else 'mam',
             'personId':people[key], 'parentPersonId':people[parent] if parent is not None else None}
            for key, role, parent, name in zip(KEYS, ROLES, PARENTS, NAMES)]


def closed_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError()


def metadata(raw):
    if len(raw) > 16384:
        raise ValueError()
    model = json.loads(raw.decode('utf-8'), object_pairs_hook=closed_object, parse_constant=invalid_constant)
    if type(model) is not dict or set(model) != {'identities'}:
        raise ValueError()
    identities = model['identities']
    if type(identities) is not list or len(identities) != 10:
        raise ValueError()
    expected = {row['fixtureKey']: row for row in catalog()}
    by_key = {}
    ids = set()
    person_ids = {row['personId'] for row in expected.values()}
    for identity in identities:
        if type(identity) is not dict or set(identity) != {'fixtureKey','authUserId','email'}:
            raise ValueError()
        if any(type(identity[field]) is not str for field in identity):
            raise ValueError()
        key = identity['fixtureKey']
        value = identity['authUserId']
        if key not in expected or key in by_key or identity['email'] != expected[key]['email']:
            raise ValueError()
        if re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', value) is None:
            raise ValueError()
        if str(uuid.UUID(value)) != value or value in ids or value in person_ids:
            raise ValueError()
        by_key[key] = value
        ids.add(value)
    if set(by_key) != set(expected):
        raise ValueError()
    return [dict(row, authUserId=by_key[row['fixtureKey']]) for row in expected.values()]


def literal(value, cast='text'):
    return ('NULL' if value is None else "'"+str(value).replace("'","''")+"'")+'::'+cast


def values(rows):
    result = []
    for ordinal, row in enumerate(rows):
        fields = [(ordinal,'integer'),(row['fixtureKey'],'text'),(row['authUserId'],'uuid'),
                  (row['email'],'text'),(row['fullName'],'text'),(row['appRole'],'text'),
                  (row['personId'],'uuid'),(row['companyKey'],'text'),(row['parentPersonId'],'uuid')]
        result.append('  ('+', '.join(literal(value,cast) for value,cast in fields)+')')
    return ',\n'.join(result)


def seed(rows):
    root = Path(__file__).resolve().parent
    controls = (root/'controls.sql').read_text().strip()
    verify = (root/'verify.sql').read_text().strip().replace('__FIXTURE__','pg_temp.uat_seed_fixture')
    output = (root/'seed.sql').read_text()
    replacements = {'__CONTEXT__':(root/'context.sql').read_text().strip(),
                    '__VALUES__':values(rows), '__CONTROLS__':controls,
                    '__CONTROLS_SCALAR__':controls.removeprefix('SELECT ').removesuffix(' AS state'),
                    '__VERIFY__':verify}
    for marker, value in replacements.items():
        output = output.replace(marker, value)
    return output


def after(rows):
    root = Path(__file__).resolve().parent
    fixture = '(VALUES\n'+values(rows)+'\n) AS f(ordinal, fixture_key, auth_user_id, email, full_name, app_role, person_id, company_key, parent_id)'
    verify = (root/'verify.sql').read_text().strip().replace('FROM __FIXTURE__ f', 'FROM '+fixture)
    return ('BEGIN READ ONLY;\nSET LOCAL search_path = \'\';\n'
            +(root/'context.sql').read_text()
            +'WITH verified AS (\n'+verify+'\n)\n'
            +"SELECT jsonb_build_object('classification','TARGET_RECORD_QUALIFICATION_NOT_CURRENT_ACTOR',\n"
            +"  'profiles',(SELECT count(*) FROM public.profiles),\n"
            +"  'people',(SELECT count(*) FROM public.internal_org_people),\n"
            +"  'authUsers',(SELECT count(*) FROM auth.users),\n"
            +"  'authSessions',(SELECT count(*) FROM auth.sessions),\n"
            +"  'reviews',(SELECT count(*) FROM private.performance_reviews),\n"
            +"  'allMatch',count(*)=10 AND bool_and(row_matches)\n"
            +"    AND (SELECT count(*) FROM public.profiles)=10\n"
            +"    AND (SELECT count(*) FROM public.internal_org_people)=9\n"
            +"    AND (SELECT count(*) FROM auth.users)=10\n"
            +"    AND NOT EXISTS(SELECT 1 FROM auth.sessions)\n"
            +"    AND NOT EXISTS(SELECT 1 FROM private.performance_reviews)\n"
            +"    AND NOT EXISTS(SELECT 1 FROM private.performance_review_events)\n"
            +"    AND NOT EXISTS(SELECT 1 FROM private.performance_review_operations),\n"
            +"  'identities',jsonb_agg(to_jsonb(v)-'ordinal' ORDER BY ordinal)) FROM verified v;\nCOMMIT;\n")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('catalog','seed','after'):
        sys.stderr.write('Usage: generate.py catalog|seed|after\n')
        return 2
    command = sys.argv[1]
    if command == 'catalog':
        output = json.dumps({'identities':catalog()},indent=2)+'\n'
    else:
        try:
            rows = metadata(sys.stdin.buffer.read(16385))
        except (ValueError, TypeError, RecursionError):
            sys.stderr.write('Invalid synthetic metadata manifest.\n')
            return 2
        output = seed(rows) if command == 'seed' else after(rows)
    sys.stdout.write(output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
