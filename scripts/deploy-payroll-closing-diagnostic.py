import hashlib
import json
from pathlib import Path
import re
import runpy
import sys
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
HELPER_SHA = '1b23644c10d4dddc04e5ca1d0238e01b1e4fcbdd2dfab84834ec7fcf9b541c98'
CORE_SHA = 'c0662cadbc822ef759b9088b1fd39b777cbab09bb27a2bda024b4cd033de6143'
PINS_SHA = '07e59e20dbeb3943e8f3e3942c895ead83e8937166b432f1eb85e3f436913e3d'


def load_original():
    path = ROOT / 'scripts/deploy-payroll-closing-carryforward.py'
    if hashlib.sha256(path.read_bytes()).hexdigest() != HELPER_SHA:
        raise ValueError('Unreviewed original release helper')
    return runpy.run_path(str(path))


def normalization_diagnostic(sql):
    if hashlib.sha256(sql.encode()).hexdigest() != CORE_SHA:
        raise ValueError('Unreviewed diagnostic core source')
    start = 'do $payroll_purge_after$'
    stop = '  if normalized_definitions is distinct from baseline.definitions or normalized_hash is distinct from baseline.schema_hash then\n'
    if sql.count(start) != 1 or sql.count(stop) != 1:
        raise ValueError('Unsupported reviewed normalization shape')
    prefix = sql[sql.index(start):sql.index(stop)]
    prefix = prefix.replace(start, 'do $payroll_normalization_observation$', 1)
    residuals = []
    for name, left, right in (
        ('added', 'normalized_definitions', 'baseline.definitions'),
        ('removed', 'baseline.definitions', 'normalized_definitions'),
    ):
        rows = '(select unnest(' + left + ') as definition except all select unnest(' + right + '))'
        item = "jsonb_build_object('sha256',encode(extensions.digest(definition,'sha256'),'hex'),'object',coalesce(substring(definition from '^CREATE OR REPLACE FUNCTION ([A-Za-z_][A-Za-z_0-9]*[.][A-Za-z_][A-Za-z_0-9]*)[(]'),substring(definition from '^([A-Za-z_][A-Za-z_0-9]*[.][A-Za-z_][A-Za-z_0-9]*)'),'<catalog-entry>'))"
        residuals.append("'" + name + "Count',(select count(*) from " + rows + " r),\n'" + name + "',(select coalesce(jsonb_agg(" + item + " order by definition),'[]') from (select definition from " + rows + " r order by definition limit 64) limited)")
    return prefix + """  if normalized_definitions is distinct from baseline.definitions or normalized_hash is distinct from baseline.schema_hash then
    raise log 'PAYROLL_NORMALIZATION_DIAGNOSTIC %', jsonb_build_object(
      'version','20261001150000',
      'arraysEqual',normalized_definitions is not distinct from baseline.definitions,
      'hashesEqual',normalized_hash is not distinct from baseline.schema_hash,
      'baselineCount',cardinality(baseline.definitions),
      'normalizedCount',cardinality(normalized_definitions),
      'baselineHash',baseline.schema_hash,
      'normalizedHash',normalized_hash,
      """ + ',\n      '.join(residuals) + """
    );
  end if;
end $payroll_normalization_observation$;
"""


def build_diagnostic_transaction(sql, before, after):
    original = load_original()
    original['load_candidate'](CORE_SHA)
    if hashlib.sha256(original['PINS'].read_bytes()).hexdigest() != PINS_SHA:
        raise ValueError('Unreviewed diagnostic release pins')
    body = original['transaction_body'](sql)
    transaction = original['build_transaction'](sql, before, after)
    if transaction.count(body) != 1:
        raise ValueError('Reviewed executed core body is not unique')
    marker = 'do $payroll_purge_after$'
    index = body.index(marker)
    diagnostic = normalization_diagnostic(sql)
    observed_body = body[:index] + diagnostic + body[index:]
    return transaction.replace(body, observed_body, 1)


def main():
    original = load_original()
    if sys.argv[1:] == ['inspect']:
        original['main']()
        return
    if len(sys.argv) != 6 or sys.argv[1] != 'apply':
        raise ValueError('Use inspect or apply <full-head> <core-sha256> <pins-sha256> <diagnostic-query-sha256>')
    if not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise ValueError('Full reviewed diagnostic release HEAD required')
    if sys.argv[3] != CORE_SHA or sys.argv[4] != PINS_SHA:
        raise ValueError('Original core and release pins must remain unchanged')
    raw = original['load_candidate'](CORE_SHA)
    pins = json.loads(original['PINS'].read_bytes())
    transaction = build_diagnostic_transaction(raw, pins['before'], pins['after'])
    reviewed = sys.argv[5]
    if not re.fullmatch('[0-9a-f]{64}', reviewed) or hashlib.sha256(transaction.encode()).hexdigest() != reviewed:
        raise ValueError('Reviewed diagnostic query differs')
    scope = original['main'].__globals__
    builder = scope['build_transaction']
    argv = sys.argv

    def checked_builder(sql, before, after):
        result = build_diagnostic_transaction(sql, before, after)
        if result != transaction:
            raise ValueError('Diagnostic transaction changed after approval')
        return result

    try:
        scope['build_transaction'] = checked_builder
        sys.argv = argv[:5]
        original['main']()
    finally:
        scope['build_transaction'] = builder
        sys.argv = argv


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Management API HTTP ' + str(error.code) + '; operation is not automatically retried')
    except ValueError as error:
        raise SystemExit(str(error))
