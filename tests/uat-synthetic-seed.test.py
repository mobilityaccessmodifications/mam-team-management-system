import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT/'deploy/uat/synthetic-seed/generate.py'
KEYS = ('p0','hr','mam_upper_manager','mam_manager','mam_employee','mam_account','mam_other_manager','equipsy_upper_manager','equipsy_manager','equipsy_employee')


class SyntheticSeedCliTests(unittest.TestCase):
    def invoke(self, command, data=b''):
        return subprocess.run([sys.executable, '-B', str(CLI), command], input=data, capture_output=True, timeout=10)

    def manifest(self) -> dict:
        return {'identities':[{'fixtureKey':key, 'authUserId':'10000000-0000-4000-8000-'+format(index+1,'012x'), 'email':'uat.'+key.replace('_','.')+'@mam-uat.invalid'} for index,key in enumerate(KEYS)]}

    def test_seed_uses_actual_stdin_and_emits_one_guarded_transaction(self):
        data = json.dumps(self.manifest()).encode()
        result = self.invoke('seed', data)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b'')
        sql = result.stdout.decode()
        self.assertTrue(sql.startswith('BEGIN;\n'))
        self.assertTrue(sql.endswith('COMMIT;\n'))
        self.assertEqual(sql.count('BEGIN;'), 1)
        self.assertEqual(sql.count('COMMIT;'), 1)
        self.assertIn('INSERT INTO public.profiles',sql)
        self.assertIn('INSERT INTO public.internal_org_people',sql)
        self.assertIn('SET CONSTRAINTS ALL IMMEDIATE;',sql)
        self.assertIn("current_database() <> 'mam_uat_people_hub'",sql)
        self.assertNotIn('ON CONFLICT',sql)
        self.assertNotIn('INSERT INTO auth.',sql)
        self.assertNotIn('UPDATE public.',sql)
        self.assertNotIn('DELETE ',sql)
        reversed_manifest = self.manifest()
        reversed_manifest['identities'].reverse()
        self.assertEqual(self.invoke('seed',json.dumps(reversed_manifest).encode()).stdout,result.stdout)

    def test_invalid_closed_metadata_has_no_partial_stdout_or_input_echo(self):
        mutations = [None, [], {}, {'identities':None}, {'identities':[]}, {'identities':self.manifest()['identities'][:9]}]
        for field,value in [('fixtureKey','not_a_role'),('fixtureKey',"p0';drop table profiles;--"),('authUserId','{10000000-0000-4000-8000-000000000001}'),('authUserId','10000000000040008000000000000001'),('authUserId','10000000-0000-4000-8000-00000000000A'),('authUserId','10000000-0000-4000-7000-000000000001'),('authUserId','00000000-0000-0000-0000-000000000000'),('authUserId',None),('authUserId',42),('email','UAT.p0@mam-uat.invalid'),('email','uat.p0@mam-uat.invalid '),('email',"x'@mam-uat.invalid"),('email','uat.p0@example.org')]:
            model = self.manifest()
            model['identities'][0][field] = value
            mutations.append(model)
        for extra in ('role','appRole','company','sql','owner','url','password','jwt'):
            model = self.manifest()
            model['identities'][0][extra] = 'synthetic-denied-marker'
            mutations.append(model)
        model = self.manifest()
        model['unexpected'] = True
        mutations.append(model)
        model = self.manifest()
        model['identities'][1]['authUserId'] = model['identities'][0]['authUserId']
        mutations.append(model)
        model = self.manifest()
        model['identities'][1] = model['identities'][0].copy()
        mutations.append(model)
        model = self.manifest()
        del model['identities'][0]['email']
        mutations.append(model)
        model = self.manifest()
        model['identities'].append(model['identities'][0].copy())
        mutations.append(model)
        raw_cases = [json.dumps(model).encode() for model in mutations]
        raw_cases += [b'{bad',b'{"identities":[],"identities":[]}',b'\xff',b' '*16385,b'{"identities":NaN}']
        for data in raw_cases:
            with self.subTest(case=raw_cases.index(data)):
                result = self.invoke('seed',data)
                self.assertEqual(result.returncode,2)
                self.assertEqual(result.stdout,b'')
                self.assertEqual(result.stderr,b'Invalid synthetic metadata manifest.\n')

    def test_after_is_separate_read_only_and_uses_the_same_closed_input(self):
        result = self.invoke('after',json.dumps(self.manifest()).encode())
        self.assertEqual(result.returncode,0,result.stderr.decode())
        sql = result.stdout.decode()
        self.assertTrue(sql.startswith('BEGIN READ ONLY;\n'))
        self.assertTrue(sql.endswith('COMMIT;\n'))
        self.assertIn('target_policy_role',sql)
        self.assertIn('row_matches',sql)
        self.assertNotIn('__',sql)
        for token in ('INSERT ','UPDATE ','DELETE ','CREATE ','ALTER ','set_config','performance_review_actor() policy'):
            self.assertNotIn(token,sql)
        invalid = self.manifest()
        invalid['identities'][0]['password'] = 'synthetic-denied-marker'
        rejected = self.invoke('after',json.dumps(invalid).encode())
        self.assertEqual((rejected.returncode,rejected.stdout,rejected.stderr),(2,b'',b'Invalid synthetic metadata manifest.\n'))

    def test_catalog_is_the_closed_ten_identity_contract(self):
        result = self.invoke('catalog')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        rows = json.loads(result.stdout)['identities']
        self.assertEqual(tuple(row['fixtureKey'] for row in rows), KEYS)
        self.assertTrue(all(row['email'] == 'uat.'+row['fixtureKey'].replace('_','.')+'@mam-uat.invalid' for row in rows))
        self.assertEqual(rows[0]['appRole'], 'system_admin')
        self.assertIsNone(rows[0]['personId'])
        self.assertEqual(rows[1]['appRole'], 'admin')
        self.assertTrue(all(row['companyKey'] in ('mam','equipsy') for row in rows[1:]))
        self.assertEqual(len({row['personId'] for row in rows[1:]}), 9)

    def test_cli_never_reads_runtime_environment_or_opens_network(self):
        program = """import argparse, builtins, hashlib, io, json, os, pathlib, re, runpy, socket, sys, uuid
class DeniedEnvironment:
    def __getattribute__(self, key):
        raise AssertionError('Runtime environment access denied')
def deny_network(*args, **kwargs):
    raise AssertionError('Network access denied')
root = pathlib.Path(sys.argv[1]).resolve().parent
allowed = {root/name for name in ('generate.py','context.sql','seed.sql','controls.sql','verify.sql')}
original_open = io.open
def closed_open(file, *args, **kwargs):
    if pathlib.Path(file).resolve() not in allowed:
        raise AssertionError('Non-source file access denied')
    return original_open(file, *args, **kwargs)
os.environ = DeniedEnvironment()
socket.socket = deny_network
io.open = closed_open
builtins.open = closed_open
sys.argv = [sys.argv[1], 'seed']
runpy.run_path(sys.argv[0], run_name='__main__')
"""
        data = json.dumps(self.manifest()).encode()
        result = subprocess.run([sys.executable,'-I','-B','-c',program,str(CLI)],input=data,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr.decode())
        self.assertEqual(result.stdout,self.invoke('seed',data).stdout)
        self.assertEqual(result.stderr,b'')
        for arguments in ([],['unknown'],['seed','extra']):
            invalid = subprocess.run([sys.executable,'-B',str(CLI),*arguments],input=data,capture_output=True,timeout=10)
            self.assertEqual((invalid.returncode,invalid.stdout,invalid.stderr),(2,b'',b'Usage: generate.py catalog|seed|after\n'))


if __name__ == '__main__':
    unittest.main()
