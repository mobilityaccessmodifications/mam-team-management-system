import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'update-management-team.py'

class ManagementTeamTest(unittest.TestCase):
    def test_exact_six_unique_reviewed_identities_only(self):
        self.assertTrue(PATH.exists(), 'Scoped management helper missing')
        spec = importlib.util.spec_from_file_location('management', PATH)
        assert spec is not None and spec.loader is not None
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        rows = [{'id': f'00000000-0000-4000-8000-{i:012d}', 'fingerprint': 'a'*32, 'team_name': 'Major'} for i in range(1, 7)]
        sql = helper.build_sql(rows)
        self.assertIn("set team_name='Management'", sql)
        self.assertIn("array['team_name']", sql)
        self.assertIn('disable trigger employee_directory_details_sync_employee_check_in_manager_email', sql)
        self.assertIn('enable trigger employee_directory_details_sync_employee_check_in_manager_email', sql)
        self.assertIn('Identity or version drift', sql)
        self.assertIn("d.version=b.version+case when b.team_name='Management' then 0 else 1 end", sql)
        self.assertNotIn('set app_role', sql)
        with self.assertRaises(ValueError):
            helper.build_sql(rows[:5])
        with self.assertRaises(ValueError):
            helper.build_sql([rows[0]]*6)
        with self.assertRaises(ValueError):
            helper.build_sql([dict(row, id="';delete") for row in rows])

if __name__ == '__main__':
    unittest.main()
