import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = Path(__file__).resolve()
ADAPTER = ROOT / 'scripts/deploy-offboarding-after-annual.py'
ADAPTER_SHA = 'cb080a3c90387d673d378ed3d6f9fa42ab8f4595296d058a3b6fccedc856ee23'
SUBSCRIPTION_VERSION = '20261013170000'
SUBSCRIPTION_NAME = 'subscription_review_tasks'
SUBSCRIPTION = ROOT / ('supabase/migrations/' + SUBSCRIPTION_VERSION + '_' + SUBSCRIPTION_NAME + '.sql')
SUBSCRIPTION_SHA = '6d342d3068c4d6e2eca7c17d573d7793fc78269db2bf0fa6976041c16c37f24e'
SUBSCRIPTION_ARRAY_SHA = '8bebd98702d502f2f29d71d3c67e6be1b7f3aade4998873ff9d46ff7043d22d7'
SUBSCRIPTION_FIELDS = ('subscriptionExact', 'subscriptionFunctionsExact', 'subscriptionStateHash')
NOTE_VERSION = '20261013180000'
NOTE_NAME = 'leave_required_employee_note'
NOTE = ROOT / ('supabase/migrations/' + NOTE_VERSION + '_' + NOTE_NAME + '.sql')
NOTE_SHA = 'ef93a9df381fca2ce4bfa932ff5b9359fadd85ea2b413f0bc8ee8559b0fd9fc0'
NOTE_ARRAY_SHA = '5136be7f2fe371c2e48653e9973101f4de0b914346d6009eeb4210d782f456b6'
NOTE_SIGNATURE = 'private.enforce_leave_request_employment_policy()'
NOTE_BEFORE_SHA = '6535b99e6244c42999825fd79262d29623e109f7af701810dcf4b6b410ff9819'
NOTE_AFTER_SHA = '129ff4a64cf0d48c021424e2f95562cee499b9c2baad32586885e6c29f03d4dc'
NOTE_FIELDS = ('noteExact', 'noteFunctionsExact', 'noteStateHash')
DAY_ONE_VERSION = '20261013200000'
DAY_ONE_NAME = 'day_one_reporting_splice_claims'
DAY_ONE = ROOT / ('supabase/migrations/' + DAY_ONE_VERSION + '_' + DAY_ONE_NAME + '.sql')
DAY_ONE_SHA = '8e6b41fb3ce7d0889f5475d4f84f5ed66d076cb46b93820e6f1d8300cb4edb6b'
DAY_ONE_ARRAY_SHA = 'fc724a0dda3623aab4759d14cb421e7035519c921959bf398cc27886b55634a5'
DAY_ONE_SIGNATURE = 'private.sync_new_starter_after_person_change()'
DAY_ONE_BEFORE_SHA = '88f9286ad032b1e62bdda9bb822faba73f6489dbea0c63cdaa3d19b7a970e300'
DAY_ONE_AFTER_SHA = 'f3385de926eaf08c78d25759bc948130a3410aeb0a2ee7725f044081e8699f52'
DAY_ONE_FIELDS = ('dayOneExact', 'dayOneFunctionsExact', 'dayOneStateHash')
SUBSCRIPTION_SIGNATURES = {
    'private.record_subscription_review(uuid,bigint)', 'public.mark_subscription_reviewed_v2(uuid,bigint)',
    'public.list_my_subscription_review_tasks()', 'public.list_subscription_review_tasks_for_preview(uuid)',
    'public.complete_my_subscription_review_task(uuid,bigint)',
}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def source_snapshot(path):
    require(path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]), 'Regular non-symlink dependency required')
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        initial = os.fstat(handle.fileno())
        require(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1 and initial.st_uid == os.getuid() and not initial.st_mode & 0o022, 'Owned single-link dependency mode required')
        raw = handle.read()
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        cookie = lambda value: tuple(getattr(value, key) for key in fields)
        require(cookie(initial) == cookie(os.fstat(handle.fileno())) == cookie(path.lstat()) and not any(p.is_symlink() for p in path.parents), 'Dependency snapshot custody changed')
    return raw


annual_raw = source_snapshot(ADAPTER)
require(hashlib.sha256(annual_raw).hexdigest() == ADAPTER_SHA, 'Immutable after-annual adapter differs')
require('after_subscription_annual_dependency' not in sys.modules, 'Stale after-annual dependency prohibited')
spec = importlib.util.spec_from_file_location('after_subscription_annual_dependency', ADAPTER)
require(spec is not None, 'Missing after-annual dependency specification')
annual = importlib.util.module_from_spec(spec)
exec(compile(annual_raw, str(ADAPTER), 'exec'), annual.__dict__)
sha = annual.sha
PHASES, ANNUAL, ANNUAL_VERSION, ANNUAL_NAME, ANNUAL_ARRAY_SHA = annual.PHASES, annual.ANNUAL, annual.ANNUAL_VERSION, annual.ANNUAL_NAME, annual.ANNUAL_ARRAY_SHA
IMMUTABLE = dict(annual.IMMUTABLE, **{str(ADAPTER.relative_to(ROOT)): ADAPTER_SHA, str(SUBSCRIPTION.relative_to(ROOT)): SUBSCRIPTION_SHA, str(NOTE.relative_to(ROOT)): NOTE_SHA, str(DAY_ONE.relative_to(ROOT)): DAY_ONE_SHA})


class AfterSubscriptionReviewAdapter(annual.AfterAnnualAdapter):
    def __init__(self, phase, head, adapter_sha, helper_sha, guarded_sha, transport_sha, source_sha, annual_sha, wrapper_sha, subscription_sha, note_sha, day_one_sha):
        require(adapter_sha == ADAPTER_SHA and subscription_sha == SUBSCRIPTION_SHA and note_sha == NOTE_SHA and day_one_sha == DAY_ONE_SHA and re.fullmatch('[0-9a-f]{64}', wrapper_sha or '') is not None, 'Explicit exact wrapper/subscription/note/core pins required')
        super().__init__(phase, head, adapter_sha, helper_sha, guarded_sha, transport_sha, source_sha, annual_sha)
        for path, pin in ((WRAPPER, wrapper_sha), (SUBSCRIPTION, subscription_sha), (NOTE, note_sha), (DAY_ONE, day_one_sha)):
            raw = annual.source_snapshot(path)
            require(sha(raw) == pin, 'Reviewed wrapper/subscription/note bytes differ')
            self.pins[path], self.raw[path] = pin, raw
        self.load_subscription()
        self.load_note()
        self.load_day_one()
        self.check_custody()

    def load_subscription(self):
        require(sha(self.raw[SUBSCRIPTION]) == SUBSCRIPTION_SHA, 'Exact published subscription source required')
        section = self.raw[SUBSCRIPTION].decode().split('insert into subscription_review_function_spec values\n', 1)[1].split('do $subscription_review_before$', 1)[0]
        rows = re.findall(r"\('([^']+)',(true|false),(null|'[0-9a-f]{64}'),'([0-9a-f]{64})',(null|'[^']*'::jsonb)\)", section)
        require(len(rows) == 5 and {row[0] for row in rows} == SUBSCRIPTION_SIGNATURES, 'Exact five published subscription definitions required')
        self.subscription_functions = {}
        for signature, existing, before, after, metadata in rows:
            if existing == 'true':
                require(signature == 'public.mark_subscription_reviewed_v2(uuid,bigint)' and before != 'null' and metadata == 'null', 'Exact existing subscription routine required')
                portable = {'owner': 'postgres', 'acl': '{postgres=X/postgres,authenticated=X/postgres}', 'security_definer': True, 'config': ['search_path=""']}
            else:
                require(before == 'null' and metadata != 'null', 'Exact new subscription routine metadata required')
                portable = json.loads(metadata[1:-8])
            require(set(portable) == {'owner', 'acl', 'security_definer', 'config'}, 'Complete published subscription portable metadata required')
            self.subscription_functions[signature] = {'after': after, 'portable': portable}

    def load_note(self):
        require(sha(self.raw[NOTE]) == NOTE_SHA, 'Exact published note source required')
        section = self.raw[NOTE].decode().split('insert into required_note_function_spec values\n', 1)[1].split('\ndo $required_note_predecessor$', 1)[0]
        expected = '(' + ','.join(self.helper.literal(value) for value in (NOTE_SIGNATURE, NOTE_BEFORE_SHA, NOTE_AFTER_SHA)) + ');'
        require(section == expected, 'Exact singleton published note definition required')
        self.note_function = {'after': NOTE_AFTER_SHA, 'portable': {'owner': 'postgres', 'acl': '{postgres=X/postgres}', 'security_definer': True, 'config': ['search_path=""']}}

    def load_day_one(self):
        require(sha(self.raw[DAY_ONE]) == DAY_ONE_SHA, 'Exact recorded Day1 source required')
        section = self.raw[DAY_ONE].decode().split('insert into day_one_splice_function_spec values\n', 1)[1].split('\ndo $day_one_splice_predecessor$', 1)[0]
        expected = '(' + ','.join(self.helper.literal(value) for value in (DAY_ONE_SIGNATURE, DAY_ONE_BEFORE_SHA, DAY_ONE_AFTER_SHA)) + ');'
        require(section == expected, 'Exact singleton recorded Day1 definition required')
        self.day_one_function = {'after': DAY_ONE_AFTER_SHA, 'portable': {'owner': 'postgres', 'acl': '{postgres=X/postgres}', 'security_definer': True, 'config': ['search_path=""']}}

    def note_expression(self):
        literal = self.helper.literal
        source = self.raw[NOTE].decode()
        portable = "jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)"
        expected = literal(json.dumps(self.note_function['portable'], separators=(',', ':'), allow_nan=False)) + '::jsonb'
        function = "coalesce((select encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is not distinct from " + literal(self.note_function['after']) + ' and ' + portable + ' is not distinct from ' + expected + ' from pg_proc p where p.oid=to_regprocedure(' + literal(NOTE_SIGNATURE) + ')),false)'
        metadata = "(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))"
        return "jsonb_build_object('noteExact',coalesce((select name=" + literal(NOTE_NAME) + " and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY[" + literal(source) + ']::text[] from supabase_migrations.schema_migrations where version=' + literal(NOTE_VERSION) + "),false),'noteFunctionsExact'," + function + ",'noteStateHash',encode(extensions.digest((select jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata'," + metadata + ') from pg_proc p where p.oid=to_regprocedure(' + literal(NOTE_SIGNATURE) + "))::text,'sha256'),'hex'))"

    def day_one_expression(self):
        literal = self.helper.literal
        source = self.raw[DAY_ONE].decode()
        portable = "jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)"
        expected = literal(json.dumps(self.day_one_function['portable'], separators=(',', ':'), allow_nan=False)) + '::jsonb'
        function = "coalesce((select encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is not distinct from " + literal(self.day_one_function['after']) + ' and ' + portable + ' is not distinct from ' + expected + ' from pg_proc p where p.oid=to_regprocedure(' + literal(DAY_ONE_SIGNATURE) + ')),false)'
        metadata = "(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))"
        return "jsonb_build_object('dayOneExact',coalesce((select name=" + literal(DAY_ONE_NAME) + " and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY[" + literal(source) + ']::text[] from supabase_migrations.schema_migrations where version=' + literal(DAY_ONE_VERSION) + "),false),'dayOneFunctionsExact'," + function + ",'dayOneStateHash',encode(extensions.digest((select jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata'," + metadata + ') from pg_proc p where p.oid=to_regprocedure(' + literal(DAY_ONE_SIGNATURE) + "))::text,'sha256'),'hex'))"

    def supplementary_expression(self):
        literal = self.helper.literal
        source = self.raw[SUBSCRIPTION].decode()
        signatures = ','.join(literal(sig) for sig in sorted(self.subscription_functions))
        clauses = []
        for signature, item in sorted(self.subscription_functions.items()):
            portable = "jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)"
            expected = literal(json.dumps(item['portable'], separators=(',', ':'), allow_nan=False)) + '::jsonb'
            clauses.append("coalesce((select encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is not distinct from " + literal(item['after']) + ' and ' + portable + ' is not distinct from ' + expected + ' from pg_proc p where p.oid=to_regprocedure(' + literal(signature) + ')),false)')
        expression = "jsonb_build_object('subscriptionExact',coalesce((select name=" + literal(SUBSCRIPTION_NAME) + " and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY[" + literal(source) + ']::text[] from supabase_migrations.schema_migrations where version=' + literal(SUBSCRIPTION_VERSION) + "),false),'subscriptionFunctionsExact',(" + ' and '.join(clauses) + "),'subscriptionStateHash',encode(extensions.digest((select jsonb_object_agg(signature,jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))) from unnest(array[" + signatures + "]::text[]) signature join pg_proc p on p.oid=to_regprocedure(signature))::text,'sha256'),'hex'))"
        return '(' + super().supplementary_expression() + ') || (' + expression + ') || (' + self.note_expression() + ') || (' + self.day_one_expression() + ')'

    def subscription_state(self, frame):
        require(isinstance(frame, dict) and all(field in frame for field in SUBSCRIPTION_FIELDS), 'Complete native subscription snapshot required')
        require(frame['subscriptionExact'] is True and frame['subscriptionFunctionsExact'] is True, 'Exact published subscription source/definitions/metadata required')
        require(isinstance(frame['subscriptionStateHash'], str) and re.fullmatch('[0-9a-f]{64}', frame['subscriptionStateHash']) is not None, 'Invalid protected subscription hash')
        rows = [row for row in frame.get('ledger', []) if row.get('version') == SUBSCRIPTION_VERSION]
        require(len(rows) == 1 and type(rows[0].get('cardinality')) is int, 'Exact integer subscription array cardinality required')
        require(rows == [{'version': SUBSCRIPTION_VERSION, 'name': SUBSCRIPTION_NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': SUBSCRIPTION_ARRAY_SHA}], 'Exact full published subscription ledger row required')
        return {field: frame[field] for field in SUBSCRIPTION_FIELDS}

    def note_state(self, frame):
        require(isinstance(frame, dict) and all(field in frame for field in NOTE_FIELDS), 'Complete native note snapshot required')
        require(frame['noteExact'] is True and frame['noteFunctionsExact'] is True, 'Exact published note source/definition/metadata required')
        require(isinstance(frame['noteStateHash'], str) and re.fullmatch('[0-9a-f]{64}', frame['noteStateHash']) is not None, 'Invalid protected note hash')
        rows = [row for row in frame.get('ledger', []) if row.get('version') == NOTE_VERSION]
        require(len(rows) == 1 and type(rows[0].get('cardinality')) is int, 'Exact integer note array cardinality required')
        require(rows == [{'version': NOTE_VERSION, 'name': NOTE_NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': NOTE_ARRAY_SHA}], 'Exact full published note ledger row required')
        return {field: frame[field] for field in NOTE_FIELDS}

    def day_one_state(self, frame):
        require(isinstance(frame, dict) and all(field in frame for field in DAY_ONE_FIELDS), 'Complete native Day1 snapshot required')
        require(frame['dayOneExact'] is True and frame['dayOneFunctionsExact'] is True, 'Exact recorded Day1 source/definition/metadata required')
        require(isinstance(frame['dayOneStateHash'], str) and re.fullmatch('[0-9a-f]{64}', frame['dayOneStateHash']) is not None, 'Invalid protected Day1 hash')
        rows = [row for row in frame.get('ledger', []) if row.get('version') == DAY_ONE_VERSION]
        require(len(rows) == 1 and type(rows[0].get('cardinality')) is int, 'Exact integer Day1 array cardinality required')
        require(rows == [{'version': DAY_ONE_VERSION, 'name': DAY_ONE_NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': DAY_ONE_ARRAY_SHA}], 'Exact full recorded Day1 ledger row required')
        return {field: frame[field] for field in DAY_ONE_FIELDS}

    def annual_state(self, frame):
        return dict(super().annual_state(frame), **self.subscription_state(frame), **self.note_state(frame), **self.day_one_state(frame))

    def validation_projection(self, frame):
        self.subscription_state(frame)
        self.note_state(frame)
        self.day_one_state(frame)
        projection = {key: value for key, value in super().validation_projection(frame).items() if key not in (*SUBSCRIPTION_FIELDS, *NOTE_FIELDS, *DAY_ONE_FIELDS)}
        projection['ledger'] = [row for row in projection['ledger'] if row['version'] not in (SUBSCRIPTION_VERSION, NOTE_VERSION, DAY_ONE_VERSION)]
        return projection

    def validate_before(self, before, source):
        fields = self.guarded.STATE_FIELDS | set(annual.ANNUAL_FIELDS) | set(SUBSCRIPTION_FIELDS) | set(NOTE_FIELDS) | set(DAY_ONE_FIELDS)
        if self.phase != 'reporting-splice':
            fields = fields | {'predecessorFunctionsExact'}
        require(isinstance(before, dict) and set(before) == fields, 'Exact full native subscription/note phase fields required')
        versions = [row['version'] for row in before['ledger']]
        require(0 < len(versions) <= 512 and len(versions) == len(set(versions)) and versions == sorted(versions) and max(versions) == DAY_ONE_VERSION, 'Only the exact Day1-first latest predecessor admitted')
        with self.measured_reads():
            self.helper.validate_before(self.validation_projection(before), source)

    def run(self, args):
        require(args.wrapper_sha == self.pins[WRAPPER] and args.subscription_sha == self.pins[SUBSCRIPTION] and args.note_sha == self.pins[NOTE] and args.day_one_sha == self.pins[DAY_ONE], 'Entrypoint reviewed wrapper/subscription/note differs')
        return super().run(args)


def arguments(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'inspect', 'apply'))
    parser.add_argument('--phase', choices=tuple(PHASES), required=True)
    for name in ('head', 'adapter-sha', 'helper-sha', 'guarded-sha', 'transport-sha', 'source-sha', 'annual-sha', 'wrapper-sha', 'subscription-sha', 'note-sha', 'day-one-sha'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--snapshot-sha')
    parser.add_argument('--dispatch', type=Path)
    parser.add_argument('--attestation', type=Path)
    parser.add_argument('--attestation-sha')
    return parser.parse_args(argv)


def main(argv=None):
    args = arguments(argv)
    adapter = AfterSubscriptionReviewAdapter(args.phase, args.head, args.adapter_sha, args.helper_sha, args.guarded_sha, args.transport_sha, args.source_sha, args.annual_sha, args.wrapper_sha, args.subscription_sha, args.note_sha, args.day_one_sha)
    return adapter.run(args)


if __name__ == '__main__':
    main()
