import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
helper = ROOT / 'scripts/deploy-performance-review-completion.py'
spec = importlib.util.spec_from_file_location('completion_native_builder', helper)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = module.MIGRATION.read_text()
predecessor = module.PREDECESSOR.read_text()
if sys.argv[1] == 'expression':
    print("begin read only; set local search_path=''; select " + module.state_expression(source, predecessor) + ' as state; rollback;')
else:
    before = module.load_json(Path(sys.argv[2]).read_bytes())
    synthetic = [{key: row[key] for key in ('version', 'name', 'dimensions', 'statementCount', 'sourceArraySha256')} for row in before['ledger']]
    setattr(module, 'BASE_LEDGER_SHA256', module.sha(module.encoded(synthetic).encode()))
    if sys.argv[1] == 'build':
        print(module.transaction(source, before, predecessor), end='')
    elif sys.argv[1] == 'validate':
        after = module.load_json(Path(sys.argv[3]).read_bytes())
        module.validate_preserved(after, before, source, sys.argv[4])
        print(json.dumps({'classification': 'SQL_ONLY_SYNTHETIC_HISTORY_NOT_HOSTED_LEDGER', 'rawSourceExact': True, 'readbackVerified': True}))
    else:
        raise AssertionError('Unexpected native test command')
