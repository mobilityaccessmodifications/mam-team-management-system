import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
helper = ROOT / 'scripts/deploy-performance-reviews.py'
spec = importlib.util.spec_from_file_location('performance_native_builder', helper)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = module.MIGRATION.read_text()
predecessor = module.PREDECESSOR.read_text()
assert hashlib.sha256(source.encode()).hexdigest() == 'b7fc890922455b0a4f57ccd917d0cd936556ee246cac1d3647c169de4ade13b4'
if sys.argv[1] == 'expression':
    print("begin read only; set local search_path=''; select " + module.state_expression(source, predecessor) + ' as state; rollback;')
else:
    before = json.loads(Path(sys.argv[2]).read_bytes())
    synthetic = [{key: row[key] for key in ('version','name','dimensions','statementCount','sourceArraySha256')} for row in before['ledger']]
    setattr(module, 'BASE_LEDGER_SHA256', module.sha(module.encoded(synthetic).encode()))
    if sys.argv[1] == 'build':
        print(module.transaction(source, before, predecessor), end='')
    elif sys.argv[1] == 'validate':
        after = json.loads(Path(sys.argv[3]).read_bytes())
        module.validate_preserved(after, before, source)
        print(json.dumps({'classification': 'SQL_ONLY_SYNTHETIC_HISTORY_NOT_HOSTED_LEDGER', 'rawSourceExact': True, 'readbackVerified': True}))
    else:
        raise AssertionError('Unexpected native test command')
