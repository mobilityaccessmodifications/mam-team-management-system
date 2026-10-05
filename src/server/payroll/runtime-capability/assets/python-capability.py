import ast
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import sysconfig
from typing import Any
from types import SimpleNamespace

required = ['ast', 'decimal', 'hashlib', 'json', 'pathlib', 're', 'sys', 'typing', 'types']
module = ast.parse('def fixed(value: Any):\n return json.dumps({"result": str(Decimal(value))})\n')
namespace = {'Any': Any, 'json': json, 'Decimal': Decimal}
exec(compile(module, '<fixed-stdlib-operation>', 'exec'), namespace)
operations = json.loads(namespace['fixed']('1.25')) == {'result': '1.25'}
operations = operations and re.fullmatch('[0-9]+', '123') is not None
operations = operations and SimpleNamespace(value=1).value == 1
operations = operations and hashlib.sha256(b'fixed-public-capability').hexdigest() == '68ac9421d2a13b689d725ff0bc1c24fbf347fb8aded9b04ba66dd59eae4cee6b'
rows = []
foreign = 0
prefix = Path(sys.base_prefix).resolve()
for name, loaded in sorted(sys.modules.copy().items()):
    filename = getattr(loaded, '__file__', None)
    if not filename or name == '__main__':
        continue
    location = Path(filename).resolve()
    if prefix not in location.parents and location != prefix:
        foreign += 1
        continue
    if location.is_file():
        raw = location.read_bytes()
        rows.append({'module': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
executable = Path(sys.executable).resolve()
assert executable.is_file()
report = {'version': list(sys.version_info[:3]), 'implementation': platform.python_implementation(), 'machine': platform.machine(), 'libc': list(platform.libc_ver()), 'requiredImports': required, 'requiredImportsPassed': all(name in sys.modules for name in required), 'selectedStdlibOperationsPassed': operations, 'isolated': bool(sys.flags.isolated), 'siteDisabled': bool(sys.flags.no_site), 'bytecodeDisabled': bool(sys.dont_write_bytecode), 'foreignFileModules': foreign, 'moduleCount': len(rows), 'moduleDigestSHA256': hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest(), 'executableSHA256Observed': hashlib.sha256(executable.read_bytes()).hexdigest(), 'completeSharedLibraryClosureProven': False, 'stdlibImportClosureIsOnlyThisProbe': True}
print(json.dumps(report, separators=(',', ':')))
