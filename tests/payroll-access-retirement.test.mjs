import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import * as React from 'react';
import test from 'node:test';
import { actionFixture, actorId, capabilities, flush, hooksHarness, loadModule, nodes, targetId, text } from './helpers/unified-role-harness.mjs';

const batchId = '12000000-0000-4000-8000-000000000004';
const retiredMessage = 'Payroll import access is controlled by portal roles.';
const reminder = { dueOn: '2026-10-01', mamAsOf: null, equipsyAsOf: null, mamComplete: false, equipsyComplete: false, complete: false };
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const upload = () => new File(['Company,Employee,As of,Annual Leave,Sick Leave\nMAM,Synthetic Target,2026-10-01,80,40'], 'synthetic-payroll.csv', { type: 'text/csv' });

function payrollFixture({ role = 'system_admin', session = true, capabilityError = null } = {}) {
  const actor = capabilities(role, role === 'system_admin' ? null : targetId);
  const f = actionFixture({ actor, session, error: capabilityError });
  const events = [];
  const legacy = { grants: [targetId], events: [{ eventId: 'synthetic-historical-grant', personId: targetId }] };
  const state = { batch: null };
  const originalRpc = f.client.rpc;
  f.client.rpc = async (name, args) => {
    if (name === 'get_portal_role_capabilities') return originalRpc(name, args);
    f.calls.push({ name, args });
    if (name === 'get_payroll_balance_import_workspace') return { data: {
      canImport: actor.can_import_payroll_balances, canManageAccess: true,
      comparisonOnly: actor.payroll_comparison_only, canManageBalances: actor.can_manage_leave_balances,
      reminder, recentBatches: state.batch ? [{ ...state.batch, rowCount: state.batch.rows.length }] : [],
    }, error: null };
    if (name === 'can_manage_payroll_balance_import_grants') return { data: true, error: null };
    if (name === 'replace_payroll_balance_import_grants') {
      legacy.grants = [...args.p_person_ids];
      legacy.events.push({ eventId: 'synthetic-new-grant', personIds: args.p_person_ids });
      return { data: null, error: null };
    }
    if (name === 'get_payroll_balance_import_batch') return { data: state.batch, error: null };
    if (name === 'commit_payroll_balance_import') {
      state.batch = { ...state.batch, status: 'committed', version: state.batch.version + 1, committedAt: '2026-10-01T00:01:00Z' };
      return { data: state.batch, error: null };
    }
    assert.fail('Unexpected synthetic payroll RPC ' + name);
  };
  const actions = loadModule('src/app/payroll-balances/actions.ts', {
    ...f.overrides,
    'next/cache': { revalidatePath: path => events.push(['revalidate', path]) },
    '@/lib/payroll-balance-source-archive': {
      archivePayrollBalanceFiles: async (actor, files) => { events.push(['archive', actor, files]); return ['synthetic-source-archive']; },
      linkPayrollBalanceSourceArchives: async (...args) => { events.push(['link', ...args]); },
      markPayrollBalanceSourceArchivesFailed: async (...args) => { events.push(['archive-failed', ...args]); },
    },
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name, args) => {
      f.calls.push({ name, args });
      assert.equal(name, 'stage_payroll_balance_import');
      assert.equal(args.p_actor_user_id, actorId);
      const comparisonOnly = actor.payroll_comparison_only;
      state.batch = {
        batchId, status: 'staged', version: 1, comparisonOnly, createdAt: '2026-10-01T00:00:00Z', committedAt: null,
        files: args.p_files,
        rows: args.p_rows.map((row, index) => ({
          rowId: index + 1, employeeName: row.employeeName, company: row.companyKey, asOf: row.asOf,
          annualHours: row.annualHours, sickHours: row.sickHours, status: 'linked', linkedName: row.employeeName,
          willApplyAnnual: !comparisonOnly && row.annualHours !== null, willApplySick: !comparisonOnly && row.sickHours !== null,
        })),
        differenceCount: comparisonOnly ? 1 : 0,
        comparisonRows: comparisonOnly ? [{ rowId: 1, employeeName: 'Synthetic Target', company: 'mam', kind: 'annual', uploadedHours: 80, systemHours: 70, fileAsOf: '2026-10-01', systemAsOf: '2026-09-01', different: true }] : [],
      };
      return { data: state.batch, error: null };
    } }) },
  });
  return { ...f, actions, events, legacy, state };
}

function importer(actions, props = {}) {
  const hooks = hooksHarness(React);
  let focus = [];
  let saved = 0;
  const mod = loadModule('src/components/payroll-balance-importer.tsx', {
    react: { ...hooks.react, startTransition: callback => callback() },
    '@/app/payroll-balances/actions': actions,
    '@/components/ui/modal-backdrop': { ModalBackdrop: 'backdrop' },
    '@/components/ui/use-dialog-focus': { useDialogFocus: (...args) => focus.push(args) },
  });
  const ui = {
    render() {
      hooks.begin(); focus = [];
      const tree = mod.PayrollBalanceImporter({ onSaved: async () => { saved += 1; }, ...props });
      hooks.effects();
      assert.equal(focus.filter(([open]) => open).length, nodes(tree).filter(node => node.props?.role === 'dialog').length);
      return tree;
    },
    async mount() { ui.render(); await flush(); return ui.render(); },
    async stage(tree) {
      nodes(tree).find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ currentTarget: { files: [upload()] } });
      await flush(); return ui.render();
    },
    focus: () => focus,
    saved: () => saved,
  };
  return ui;
}

test('normal P0 importer has no effective-access editor even when the canonical workspace retains its legacy flag', async () => {
  const f = payrollFixture();
  const ready = await f.actions.getPayrollBalanceImportWorkspace();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.workspace.canImport, true);
  assert.equal(ready.workspace.canManageAccess, true);
  const before = structuredClone(f.legacy);
  const ui = importer(f.actions);
  const tree = await ui.mount();
  assert.equal(button(tree, 'Upload CSV or Excel').props.disabled, false);
  assert.doesNotMatch(text(tree), /Manage access|Payroll import access|Save access/);
  assert.equal(nodes(tree).some(node => node.props?.['aria-labelledby'] === 'payroll-access-title'), false);
  assert.deepEqual(f.legacy, before);
  assert.ok(!f.calls.some(call => /grant/.test(call.name)));
});

test('direct legacy grant action denies an effective-access save without changing retained grants or events', async () => {
  const f = payrollFixture();
  const before = structuredClone(f.legacy);
  const result = await f.actions.replacePayrollBalanceImportGrants([]);
  assert.deepEqual({
    result,
    legacy: f.legacy,
    mutations: f.calls.filter(call => call.name === 'replace_payroll_balance_import_grants'),
    revalidations: f.events.filter(([name]) => name === 'revalidate'),
  }, {
    result: { ok: false, message: retiredMessage },
    legacy: before,
    mutations: [],
    revalidations: [],
  });
  assert.deepEqual(f.calls, [{ name: 'get_portal_role_capabilities', args: { p_person_id: null } }]);
});

test('retired editable payroll-grant workspace is not exported by the real action module', () => {
  assert.equal(Object.hasOwn(payrollFixture().actions, 'getPayrollBalanceImportAccessWorkspace'), false);
});

test('retired grant action keeps known validation failures serializable without touching historical rows', async () => {
  const f = payrollFixture();
  const before = structuredClone(f.legacy);
  const invalid = [undefined, null, targetId, [targetId, targetId], ['not-a-uuid'], [null], [{}],
    Array.from({ length: 26 }, (_, index) => `13000000-0000-4000-8000-${String(index).padStart(12, '0')}`)];
  for (const ids of invalid) assert.deepEqual(await f.actions.replacePayrollBalanceImportGrants(ids), {
    ok: false, message: 'Choose a valid unique payroll importer list.',
  });
  assert.deepEqual(await f.actions.replacePayrollBalanceImportGrants([targetId]), { ok: false, message: retiredMessage });
  assert.deepEqual(f.legacy, before);
  assert.ok(f.calls.every(call => call.name === 'get_portal_role_capabilities' && call.args.p_person_id === null));
  assert.deepEqual(f.events, []);
});

test('ordinary roles cannot recover the retired editor through a retained legacy management flag', async () => {
  for (const role of ['employee', 'manager', 'account', 'admin']) {
    const f = payrollFixture({ role });
    const before = structuredClone(f.legacy);
    assert.deepEqual(await f.actions.replacePayrollBalanceImportGrants([targetId]), {
      ok: false, message: 'Only a Super Admin can manage payroll import access.',
    });
    assert.deepEqual(f.legacy, before);
    assert.deepEqual(f.calls, [{ name: 'get_portal_role_capabilities', args: { p_person_id: null } }]);
    assert.deepEqual(f.events, []);
  }
});

test('retired grant action sanitizes session, canonical-role and thrown provider failures', async () => {
  const fixtures = [payrollFixture({ session: false }), payrollFixture({ capabilityError: { message: 'Synthetic private provider detail' } }), payrollFixture()];
  fixtures[2].client.auth.getUser = async () => { throw new Error('Synthetic private provider detail'); };
  for (const f of fixtures) {
    const before = structuredClone(f.legacy);
    const result = await f.actions.replacePayrollBalanceImportGrants([targetId]);
    assert.deepEqual(result, { ok: false, message: 'Payroll import access could not be confirmed. Refresh and try again.' });
    assert.doesNotMatch(JSON.stringify(result), /provider|digest|stack/);
    assert.deepEqual(f.legacy, before);
    assert.ok(!f.calls.some(call => /grant/.test(call.name)));
    assert.deepEqual(f.events, []);
  }
});

for (const role of ['system_admin', 'admin']) test(`${role} retains normal upload, apply, history and preview focus bindings after grant retirement`, async () => {
  const f = payrollFixture({ role });
  const before = structuredClone(f.legacy);
  const ui = importer(f.actions);
  let tree = await ui.mount();
  const input = nodes(tree).find(node => node.type === 'input' && node.props.type === 'file');
  input.props.ref.current = { value: 'synthetic-file-input' };
  tree = await ui.stage(tree);
  assert.equal(input.props.ref.current.value, '');
  assert.deepEqual(f.state.batch.rows.map(row => [row.employeeName, row.annualHours, row.sickHours]), [['Synthetic Target', 80, 40]]);
  assert.deepEqual(f.events.map(([name]) => name), ['archive', 'link']);
  assert.equal(f.events[0][1], actorId);
  assert.equal(f.events[0][2][0].buffer.toString(), await upload().text());
  assert.deepEqual(f.events[1], ['link', actorId, ['synthetic-source-archive'], batchId]);
  assert.equal(ui.saved(), 0);
  assert.equal(button(tree, 'Apply matched balances').props.disabled, false);
  const dialog = nodes(tree).find(node => node.props?.role === 'dialog');
  const close = nodes(tree).find(node => node.props?.['aria-label'] === 'Close payroll balance preview');
  const [open, dialogRef, initialFocusRef, onClose, returnFocusRef] = ui.focus()[0];
  assert.equal(open, true);
  assert.equal(dialogRef, dialog.props.ref);
  assert.equal(initialFocusRef, close.props.ref);
  assert.equal(onClose, close.props.onClick);
  assert.equal(returnFocusRef, input.props.ref);
  button(tree, 'Apply matched balances').props.onClick();
  tree = ui.render();
  assert.equal(button(tree, 'Applying…').props.disabled, true);
  assert.equal(nodes(tree).find(node => node.props?.['aria-label'] === 'Close payroll balance preview').props.disabled, true);
  await flush(); tree = ui.render();
  assert.equal(ui.saved(), 1);
  assert.match(text(tree), /Payroll balances applied/);
  assert.equal(button(tree, 'Apply matched balances'), undefined);
  assert.deepEqual(f.calls.filter(call => call.name === 'commit_payroll_balance_import'), [{
    name: 'commit_payroll_balance_import', args: { p_batch_id: batchId, p_expected_version: 1 },
  }]);
  button(tree, 'Done').props.onClick(); tree = ui.render();
  assert.equal(ui.focus()[0][0], false);
  assert.match(text(tree), /Recent imports · 1/);
  assert.match(text(tree), /Appliedsynthetic-payroll.csv/);
  button(tree, 'View').props.onClick(); await flush(); tree = ui.render();
  assert.match(text(tree), /Import completePayroll balance preview/);
  assert.equal(button(tree, 'Apply matched balances'), undefined);
  assert.ok(f.calls.some(call => call.name === 'get_payroll_balance_import_batch' && call.args.p_batch_id === batchId));
  assert.deepEqual(f.legacy, before);
  assert.ok(!f.calls.some(call => /grant/.test(call.name)));
});

test('normal Account retains real comparison upload and readable history but cannot apply balances', async () => {
  const f = payrollFixture({ role: 'account' });
  const before = structuredClone(f.legacy);
  const ui = importer(f.actions, { comparisonOnly: true });
  let tree = await ui.mount();
  tree = await ui.stage(tree);
  assert.match(text(tree), /Comparison savedPayroll balance preview/);
  assert.match(text(tree), /Balances unchanged/);
  assert.ok(nodes(tree).some(node => node.props?.role === 'table' && node.props['aria-label'] === 'Payroll comparison'));
  assert.equal(button(tree, 'Apply matched balances'), undefined);
  assert.doesNotMatch(text(tree), /Manage access|Save access/);
  assert.equal(f.state.batch.comparisonOnly, true);
  assert.deepEqual(f.events.map(([name]) => name), ['archive', 'link']);
  assert.equal((await f.actions.getPayrollBalanceImportBatch(batchId)).comparisonOnly, true);
  assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId, 1), {
    ok: false, message: 'Comparison-only access cannot apply payroll balances.',
  });
  assert.equal(ui.saved(), 0);
  assert.ok(!f.calls.some(call => call.name === 'commit_payroll_balance_import'));
  button(tree, 'Cancel').props.onClick(); tree = ui.render();
  assert.match(text(tree), /Recent imports · 1/);
  button(tree, 'View').props.onClick(); await flush(); tree = ui.render();
  assert.match(text(tree), /Payroll comparison|Comparison saved/);
  assert.equal(button(tree, 'Apply matched balances'), undefined);
  assert.deepEqual(f.legacy, before);
  assert.ok(!f.calls.some(call => /grant/.test(call.name)));
});

test('Employee and Manager have neither importer UI nor direct upload/apply despite retained grants', async () => {
  for (const role of ['employee', 'manager']) {
    const f = payrollFixture({ role });
    const before = structuredClone(f.legacy);
    const ui = importer(f.actions);
    const tree = await ui.mount();
    assert.match(text(tree), /You do not have permission to import payroll balances/);
    assert.doesNotMatch(text(tree), /Manage access|Upload CSV or Excel|Apply matched balances/);
    const form = new FormData(); form.append('files', upload());
    for (const result of [await f.actions.stagePayrollBalanceFiles(form), await f.actions.commitPayrollBalanceImport(batchId, 1)]) {
      assert.deepEqual(result, { ok: false, message: 'You do not have permission to import payroll balances.' });
    }
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.legacy, before);
    assert.ok(!f.calls.some(call => /grant|stage_payroll|commit_payroll/.test(call.name)));
  }
});

test('direct retired grant denial survives real production Flight without an error row or success result', async () => {
  const encoded = spawnSync(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { actionFixture, loadModule, targetId } from './tests/helpers/unified-role-harness.mjs';
    const f = actionFixture();
    const actions = loadModule('src/app/payroll-balances/actions.ts', {
      ...f.overrides, '@/lib/payroll-balance-import': {}, '@/lib/payroll-balance-source-archive': {}, '@/lib/supabase/admin': {},
    });
    createRequire(import.meta.url)('next/dist/compiled/react-server-dom-webpack/server.node')
      .renderToPipeableStream({ result: actions.replacePayrollBalanceImportGrants([targetId]) }, {}, { onError: () => 'synthetic-digest' })
      .pipe(process.stdout);
  `], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(encoded.status, 0, encoded.stderr);
  const { createFromNodeStream } = createRequire(import.meta.url)('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
  const decoded = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
  assert.deepEqual(await decoded.result, { ok: false, message: retiredMessage });
  assert.doesNotMatch(encoded.stdout, /synthetic-digest|:E\{|ok[^\n]*true/);
});
