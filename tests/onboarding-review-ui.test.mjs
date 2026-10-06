import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { loadModule, hooksHarness, nodes, text, flush } from './helpers/contact-lifetime-harness.mjs';
const require = createRequire(import.meta.url);
const React = require('react');
const file = 'src/app/onboarding-review/review-list.tsx';
const review = { deliveryId: '71000000-0000-4000-8000-000000000006', employeeName: 'Synthetic Starter', company: 'mam', status: 'needs_review', reviewCode: 'delivery_uncertain', hasClaimedLogin: true, dueDate: '2026-10-01', createdAt: '2026-10-01T05:00:00.123456+00:00', updatedAt: '2026-10-01T05:00:00.123456+00:00' };
function fixture(result) {
  assert.ok(existsSync(file), 'Credential review confirmation UI is missing');
  const hooks = hooksHarness(React), calls = [];
  const actions = { cancelOnboardingCredentialReview: async input => { calls.push(input); return result; }, listOnboardingCredentialReviews: async () => ({ ok: true, reviews: [review] }) };
  const { OnboardingCredentialReviews } = loadModule(file, { react: hooks.react, './actions': actions,
    '@/components/ui/modal-backdrop': { ModalBackdrop() {} }, '@/components/ui/use-dialog-focus': { useDialogFocus() {} } });
  let tree;
  const render = () => { hooks.begin(); tree = OnboardingCredentialReviews({ initialReviews: [review] }); hooks.effects(); return tree; };
  const button = label => nodes(tree).find(n => n.type === 'button' && text(n) === label);
  render();
  return { calls, render, button, tree: () => tree, form: () => nodes(tree).find(n => n.type === 'form') };
}
test('Directory entry uses the existing P0-only canManageRoles prop without widening ordinary Admin access', () => {
  for (const permitted of [true, false, undefined]) {
    const hooks = hooksHarness(React);
    const { EmployeeDirectory } = loadModule('src/components/employee-directory.tsx', {
      react: hooks.react,
      '@/app/people/actions': { listEmployeeDirectoryRoles: async () => ({}) },
      '@/components/ui/modal-backdrop': { ModalBackdrop() {} },
      '@/components/employee-device-assignments': { EmployeeDeviceAssignments() {} },
      '@/components/ui/motion-loader': { MotionLoader() {} },
      '@/components/ui/use-dialog-focus': { useDialogFocus() {} },
      '@/components/ui/use-media-query': { useMediaQuery: () => false },
    });
    hooks.begin();
    const tree = EmployeeDirectory({ initialRecords: [], canManageRoles: permitted });
    const links = nodes(tree).filter(n => n.type === 'a' && n.props.href === '/onboarding-review');
    assert.equal(links.length, permitted === true ? 1 : 0);
  }
});
const event = () => ({ preventDefault() {} });
test('cancellation requires explicit confirmation and preserves the original timestamp payload', async () => {
  const ui = fixture({ ok: true, committed: true, message: 'Cancelled.' });
  ui.button('Cancel delivery').props.onClick(); ui.render();
  assert.equal(ui.calls.length, 0);
  assert.match(text(ui.tree()), /Cancel onboarding delivery/);
  ui.button('Keep review').props.onClick(); ui.render();
  assert.equal(ui.calls.length, 0);
  ui.button('Cancel delivery').props.onClick(); ui.render();
  const submit = ui.form().props.onSubmit;
  submit(event()); submit(event()); await flush(); ui.render();
  assert.deepEqual(ui.calls, [{ deliveryId: review.deliveryId, updatedAt: review.updatedAt }]);
  assert.match(text(ui.tree()), /Cancelled/);
  assert.equal(ui.button('Cancel delivery'), undefined);
});
test('stale and ambiguous failures do not retry before an explicit authoritative refresh', async () => {
  for (const message of ['The review changed. Refresh the list.', 'Cancellation could not be confirmed. Refresh the list.']) {
    const ui = fixture({ ok: false, message });
    ui.button('Cancel delivery').props.onClick(); ui.render();
    const oldSubmit = ui.form().props.onSubmit;
    oldSubmit(event()); await flush(); ui.render();
    assert.equal(ui.button('Cancel delivery').props.disabled, true);
    assert.match(text(ui.tree()), /Refresh/);
    oldSubmit(event()); await flush(); ui.render();
    assert.equal(ui.calls.length, 1);
    ui.button('Refresh list').props.onClick(); await flush(); ui.render();
    assert.equal(ui.button('Cancel delivery').props.disabled, false);
    assert.equal(ui.calls.length, 1);
  }
});
test('known committed cancellation cannot be resubmitted when revalidation fails', async () => {
  const ui = fixture({ ok: true, committed: true, message: 'Cancelled. Refresh to load the latest records.' });
  ui.button('Cancel delivery').props.onClick(); ui.render();
  const submit = ui.form().props.onSubmit;
  submit(event()); await flush(); ui.render(); submit(event()); await flush(); ui.render();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.button('Cancel delivery'), undefined);
  assert.match(text(ui.tree()), /Cancelled. Refresh/);
});
test('independent page never renders private records on a failed list authorization', async () => {
  const page = 'src/app/onboarding-review/page.tsx';
  assert.ok(existsSync(page), 'Independent onboarding review route is missing');
  const { default: Page } = loadModule(page, { './actions': { listOnboardingCredentialReviews: async () => ({ ok: false, message: 'Only System Admin may review onboarding credentials.' }) }, './review-list': { OnboardingCredentialReviews() {} } });
  const tree = await Page();
  assert.match(text(tree), /Only System Admin/);
  assert.equal(nodes(tree).some(n => n.props?.initialReviews), false);
});
