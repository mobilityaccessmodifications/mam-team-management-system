import json
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parents[1]
args = sys.argv[1:]
helper = ROOT / 'scripts/deploy-performance-review-completion-with-master.py'
sys.argv = [str(helper), 'master']
scope = runpy.run_path(str(helper), run_name='master_release_fixture_snapshot')
m = scope['BASE']
assert m.VERSION == '20261019000000', 'The continuation must have a Master-only phase'
assert m.PREDECESSOR_VERSION == '20261017103000'
source = m.MIGRATION.read_text()
predecessor = m.PREDECESSOR.read_text()
if args[0] == 'contract':
    assert m.local_migrations()[-1]['version'] == m.VERSION
    print(json.dumps({'masterPhase': True, 'exactPredecessor': True}))
elif args[0] == 'expression':
    print("begin read only; set local search_path=''; select " + m.state_expression(source, predecessor) + ' as state; rollback;')
else:
    before = m.load_json(Path(args[1]).read_bytes())
    synthetic = [{key: row[key] for key in ('version', 'name', 'dimensions', 'statementCount', 'sourceArraySha256')} for row in before['ledger'] if row['version'] != '20261017103000']
    m.BASE_LEDGER_SHA256 = m.sha(m.encoded(synthetic).encode())
    if args[0] == 'build':
        print(m.transaction(source, before, predecessor), end='')
    elif args[0] == 'validate':
        after = m.load_json(Path(args[2]).read_bytes())
        m.validate_preserved(after, before, source, args[3])
        print(json.dumps({'classification': 'SQL_ONLY_SYNTHETIC_HISTORY_NOT_HOSTED_LEDGER', 'readbackVerified': True}))
    else:
        raise AssertionError('Unsupported fixture operation')
