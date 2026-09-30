import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/deploy-people-lifecycle.py"
spec = importlib.util.spec_from_file_location("people_lifecycle", SCRIPT)
assert spec is not None and spec.loader is not None
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class LifecycleDeployTest(unittest.TestCase):
    def setUp(self):
        self.rows = {}
        self.writes = []
        self.schema = [
            {"functions": {sig: (True if i == 0 or sig == "private.notification_event_key_valid(text)" else None)
                           for sig, _ in group},
             "tables": {table: None for table in helper.TABLES[i]}}
            for i, group in enumerate(helper.FUNCTIONS)
        ]
        self.project = {"id": helper.PROJECT, "organization_id": helper.ORGANISATION}
        self.rows[helper.PREDECESSOR[0]] = [{"version": helper.PREDECESSOR[0], "name": helper.PREDECESSOR[1]}]
        self.boundary = False
        self.api_patch = patch.object(helper, "api", side_effect=lambda path: self.project)
        self.query_patch = patch.object(helper, "query", side_effect=self.query)
        self.schema_patch = patch.object(helper, "schema_state", side_effect=lambda i: self.schema[i])
        self.boundary_patch = patch.object(helper, "calendar_boundary", side_effect=self.check_boundary)
        for item in (self.api_patch, self.query_patch, self.schema_patch, self.boundary_patch):
            item.start()
            self.addCleanup(item.stop)

    def check_boundary(self, applied):
        if applied != self.boundary:
            raise SystemExit("Calendar scope differs")

    def query(self, sql):
        if sql.startswith("select version,name,statements from supabase_migrations.schema_migrations where version="):
            return self.rows.get(sql.split("'")[1], [])
        if sql.startswith("begin;"):
            self.writes.append(sql)
            entry = helper.MIGRATIONS[len(self.writes) - 1]
            source = helper.source(entry)
            self.assertIn("ARRAY[" + helper.literal(source) + "]", sql)
            self.assertIn("set local lock_timeout='5s'", sql)
            self.assertIn("set local statement_timeout='75s'", sql)
            self.assertTrue(sql.endswith("notify pgrst,'reload schema';\ncommit;\n"))
            self.rows[entry[0]] = [{"version": entry[0], "name": entry[1], "statements": [source]}]
            self.schema[len(self.writes) - 1] = {
                "functions": {sig: True for sig, _ in helper.FUNCTIONS[len(self.writes) - 1]},
                "tables": {table: True for table in helper.TABLES[len(self.writes) - 1]},
            }
            if len(self.writes) == 1:
                self.boundary = True
            return []
        raise AssertionError("Unexpected query")

    def test_inspect_never_writes(self):
        helper.main(["inspect"])
        self.assertEqual(self.writes, [])

    def test_ordered_hash_pinned_apply_and_replay(self):
        for entry in helper.MIGRATIONS:
            helper.main(["apply", entry[0], entry[2]])
        self.assertEqual(len(self.writes), 4)
        helper.main(["inspect"])
        helper.main(["apply", helper.MIGRATIONS[-1][0], helper.MIGRATIONS[-1][2]])
        self.assertEqual(len(self.writes), 4)

    def test_reject_wrong_hash_before_network(self):
        with patch.object(helper, "api", side_effect=AssertionError("network used")):
            with self.assertRaises(SystemExit):
                helper.main(["apply", helper.MIGRATIONS[0][0], "0" * 64])
        self.assertEqual(self.writes, [])

    def test_reject_wrong_target_and_out_of_order(self):
        self.project["organization_id"] = "synthetic-other-org"
        with self.assertRaises(SystemExit):
            helper.main(["apply", helper.MIGRATIONS[0][0], helper.MIGRATIONS[0][2]])
        self.project["organization_id"] = helper.ORGANISATION
        with self.assertRaises(SystemExit):
            helper.main(["apply", helper.MIGRATIONS[1][0], helper.MIGRATIONS[1][2]])
        self.assertEqual(self.writes, [])

    def test_reject_ledger_drift_and_unsafe_acl(self):
        first = helper.MIGRATIONS[0]
        self.rows[first[0]] = [{"name": first[1], "statements": ["different source"]}]
        with self.assertRaises(SystemExit):
            helper.main(["inspect"])
        del self.rows[first[0]]
        self.schema[0]["functions"]["public.list_leave_calendar_entries()"] = False
        with self.assertRaises(SystemExit):
            helper.main(["apply", first[0], first[2]])
        self.assertEqual(self.writes, [])


if __name__ == "__main__":
    unittest.main()
