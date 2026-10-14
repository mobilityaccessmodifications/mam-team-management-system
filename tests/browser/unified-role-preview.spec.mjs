import { test, expect } from '@playwright/test';

const names = { admin: 'Synthetic Admin', account: 'Synthetic Account', manager: 'Synthetic Manager', employee: 'Synthetic Employee' };
const ids = {
  admin: '11000000-0000-4000-8000-000000000002', account: '11000000-0000-4000-8000-000000000003',
  manager: '11000000-0000-4000-8000-000000000004', employee: '11000000-0000-4000-8000-000000000005',
};
const sections = {
  system_admin: ['Directory', 'Organisation', 'Check-ins', 'Tasks', 'Accounts', 'Assets', 'Subscriptions', 'Analytics API'],
  admin: ['Directory', 'Organisation', 'Check-ins', 'Tasks', 'Accounts', 'Assets', 'Subscriptions'],
  account: ['Directory', 'Tasks'], manager: ['Directory', 'Organisation', 'Check-ins', 'Tasks', 'Subscriptions'],
  employee: ['Directory', 'Tasks'],
};
const navigation = page => page.getByRole('complementary', { name: 'People Hub navigation' });
const peopleTabs = page => page.getByRole('tablist', { name: 'People sections' });
const preview = page => page.getByRole('region', { name: 'Employee access preview' });
async function selectProfile(page, role) {
  await preview(page).locator('button[aria-haspopup="dialog"]').click();
  const dialog = page.getByRole('dialog', { name: 'Change profile', exact: true });
  await dialog.getByRole('button', { name: new RegExp(names[role]) }).click();
  await expect(dialog).toHaveCount(0);
}
async function openPeople(page, role) {
  await navigation(page).getByRole('button', { name: 'People', exact: true }).click();
  await expect(peopleTabs(page).getByRole('tab')).toHaveText(sections[role]);
}

for (const identical of [false, true]) for (const returnToA of [false, true]) for (const newSave of [false, true]) test(`selected contact late save preserves draft feedback busy identical=${identical} returnToA=${returnToA} newSave=${newSave}`, async ({ page }) => {
  if (identical) await page.evaluate(({ a, b }) => window.unifiedRoleFixture.setContact(b, a), { a: ids.admin, b: ids.employee });
  await selectProfile(page, 'admin');
  const trigger = name => page.getByRole('button', { name: `Open ${name}'s profile`, exact: true });
  await trigger(names.admin).click();
  let dialog = page.getByRole('dialog', { name: names.admin, exact: true });
  await dialog.getByLabel('Phone', { exact: true }).fill('A pending');
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('updateSelectedEmployeeProfile', id), ids.admin);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`updateSelectedEmployeeProfile:${ids.admin}`);
  await page.keyboard.press('Escape');
  await selectProfile(page, 'employee');
  if (returnToA) { await expect(trigger(identical ? names.admin : names.employee)).toBeEnabled(); await selectProfile(page, 'admin'); }
  const name = returnToA || identical ? names.admin : names.employee;
  await expect(trigger(name)).toBeEnabled(); await trigger(name).click();
  dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.getByLabel('Phone', { exact: true }).fill('new draft');
  if (newSave) await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await expect(dialog.locator('[data-tone]')).toHaveCount(0);
  const reads = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getLeaveWorkspaceData').length);
  const nextId = returnToA ? ids.admin : ids.employee;
  if (newSave) {
    await page.evaluate(id => window.unifiedRoleFixture.holdNext('updateSelectedEmployeeProfile', id), nextId);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(id => window.unifiedRoleFixture.calls.filter(call => call.name === 'updateSelectedEmployeeProfile' && call.args[0].personId === id).length, nextId)).toBe(returnToA ? 2 : 1);
  }
  await page.evaluate(id => window.unifiedRoleFixture.finish('updateSelectedEmployeeProfile', id), ids.admin);
  await expect.poll(() => page.evaluate(id => window.unifiedRoleFixture.responses.filter(response => response.key === `updateSelectedEmployeeProfile:${id}`).length, ids.admin)).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('new draft');
  await expect(dialog.locator('[data-tone]')).toHaveCount(0);
  if (newSave) await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  else await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getLeaveWorkspaceData').length)).toBe(reads);
  if (newSave) {
    await page.evaluate(id => window.unifiedRoleFixture.finish('updateSelectedEmployeeProfile', id), nextId);
    await expect(dialog.locator('[data-tone="success"]')).toContainText('contact details are saved');
    await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('new draft');
    await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  }
});

test('selected profile preserves native focus containment close and successful save', async ({ page }) => {
  const pickerTrigger = preview(page).locator('button[aria-haspopup="dialog"]');
  await pickerTrigger.click(); const picker = page.getByRole('dialog', { name: 'Change profile', exact: true });
  await expect(picker.locator('input')).toBeFocused();
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); expect(await picker.evaluate(node => node.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(pickerTrigger).toBeFocused();
  await selectProfile(page, 'admin'); const trigger = page.getByRole('button', { name: `Open ${names.admin}'s profile`, exact: true });
  await trigger.click();let dialog = page.getByRole('dialog', { name: names.admin, exact: true });
  await expect(dialog.getByLabel('Personal email')).toBeFocused();
  await page.keyboard.press('Shift+Tab');expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
  await trigger.click();dialog=page.getByRole('dialog', { name: names.admin, exact: true });
  await dialog.getByLabel('Phone', { exact: true }).fill('saved phone');await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.locator('[data-tone="success"]')).toContainText('contact details are saved');
  await dialog.getByRole('button', { name: 'Close profile', exact: true }).click();await expect(trigger).toBeFocused();
  await trigger.click();await expect(page.getByRole('dialog', { name: names.admin, exact: true }).getByLabel('Phone', { exact: true })).toHaveValue('saved phone');
});

test.beforeEach(async ({ context, page, baseURL }) => {
  const errors = [], external = [];
  page.__unifiedRoleErrors = errors;
  page.__unifiedRoleExternal = external;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === baseURL) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?fixture=unified-roles');
});
test.afterEach(async ({ page }) => {
  expect(page.__unifiedRoleErrors).toEqual([]);
  expect(page.__unifiedRoleExternal).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
});

test('actual LeaveDemo switches P0 through Admin, Account, Manager and Employee without inheriting P0 controls', async ({ page }) => {
  await openPeople(page, 'system_admin');
  for (const role of ['admin', 'account', 'manager', 'employee']) {
    await selectProfile(page, role);
    await expect(preview(page)).toContainText(`Viewing ${names[role]}`);
    await openPeople(page, role);
    await expect(page.getByRole('button', { name: 'Role', exact: true })).toHaveCount(0);
    await expect(peopleTabs(page).getByRole('tab', { name: 'Analytics API', exact: true })).toHaveCount(0);
    await expect(preview(page)).toContainText('signed in as System administrator');
  }
  await preview(page).getByRole('button', { name: 'Return to Super Admin', exact: true }).click();
  await expect(preview(page).getByRole('status')).toHaveText('Super Admin');
  await openPeople(page, 'system_admin');
  const calls = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getPortalRoleCapabilities').map(call => call.args[0] ?? null));
  expect(calls).toEqual([ids.admin, ids.account, ids.manager, ids.employee, null]);
});

test('Admin preview mounts the real HR Directory, Accounts, Assets and credential-enabled Subscriptions but no role or delegate settings', async ({ page }) => {
  await selectProfile(page, 'admin');
  await openPeople(page, 'admin');
  await page.getByRole('complementary', { name: 'Employee records' }).getByRole('button', { name: new RegExp(names.admin) }).click();
  await expect(page.getByLabel('Personal email', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Date of birth', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Role', exact: true })).toHaveCount(0);
  await peopleTabs(page).getByRole('tab', { name: 'Accounts', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Login accounts' })).toBeVisible();
  await peopleTabs(page).getByRole('tab', { name: 'Assets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add device', exact: true }).and(page.locator('.people_toolbar_primary'))).toBeVisible();
  await peopleTabs(page).getByRole('tab', { name: 'Subscriptions', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Subscriptions', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Credentials', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage subscription delegation', exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => window.unifiedRoleFixture.calls.map(call => call.name));
  expect(calls).toEqual(expect.arrayContaining(['listEmployeeDirectoryRecords', 'listPortalAccounts', 'listItAssets', 'listItAssetAssignees', 'listSubscriptions', 'listSubscriptionPeople', 'listSubscriptionCredentialCatalogue']));
  expect(calls.filter(name => name === 'listEmployeeDirectoryRoles')).toHaveLength(1);
});

test('Admin permissions and operational tabs load independently of selected-contact failure and contact retry', async ({ page }) => {
  await page.evaluate(id => window.unifiedRoleFixture.failNext('getSelectedEmployeeProfile', id, 'contact'), ids.admin);
  await selectProfile(page, 'admin');
  await expect(page.getByRole('alert')).toContainText('Employee profile could not be loaded.');
  await expect(page.locator('body')).not.toContainText(/private synthetic|permission detail|contact detail/);
  await expect(page.getByRole('button', { name: `Open ${names.admin}'s profile`, exact: true })).toBeDisabled();
  await openPeople(page, 'admin');
  const before = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getPortalRoleCapabilities').length);
  await page.getByRole('button', { name: 'Retry profile', exact: true }).click();
  await expect(page.getByRole('button', { name: `Open ${names.admin}'s profile`, exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(peopleTabs(page).getByRole('tab')).toHaveText(sections.admin);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getPortalRoleCapabilities').length)).toBe(before);
});

for (const failure of ['denied', 'malformed', 'transport']) test(`canonical ${failure} capability failure clears prior privileges, never falls back to Employee, and retries the same target`, async ({ page }) => {
  await selectProfile(page, 'admin');
  await openPeople(page, 'admin');
  await page.evaluate(({ id, failure }) => window.unifiedRoleFixture.failNext('getPortalRoleCapabilities', id, failure), { id: ids.account, failure });
  await selectProfile(page, 'account');
  await expect(page.getByRole('alert')).toHaveText('Role permissions could not be loaded. Retry before using this profile.Retry permissions');
  await expect(page.getByRole('region', { name: 'People operations workspace', includeHidden: true })).toHaveCount(0);
  await expect(navigation(page).getByRole('button', { name: 'Calendar', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/private synthetic|Team member|No leave requests/);
  const targetReads = await page.evaluate(id => window.unifiedRoleFixture.calls.filter(call => ['getLeaveWorkspaceData', 'loadEmployeeWorkScheduleWorkspace', 'listEmployeeTeamDirectory'].includes(call.name) && call.args[0] === id), ids.account);
  expect(targetReads).toEqual([]);
  await page.getByRole('button', { name: 'Retry permissions', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await openPeople(page, 'account');
  await navigation(page).getByRole('button', { name: /^Leave/ }).click();
  await expect(page.getByRole('button', { name: 'Balance', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Approvals/ })).toHaveCount(0);
  expect(await page.evaluate(id => window.unifiedRoleFixture.calls.filter(call => call.name === 'getPortalRoleCapabilities' && call.args[0] === id).length, ids.account)).toBe(2);
});

for (const management of [false, true]) for (const vault of [false, true]) test(`Manager preview keeps actual subscription management=${management} and vault=${vault} independent`, async ({ page }) => {
  await page.evaluate(({ id, management, vault }) => window.unifiedRoleFixture.setSubscriptionGrants(id, management, vault), { id: ids.manager, management, vault });
  await selectProfile(page, 'manager');
  await openPeople(page, 'manager');
  await peopleTabs(page).getByRole('tab', { name: 'Subscriptions', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Subscriptions', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(management ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Credentials', exact: true })).toHaveCount(vault ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(management ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Manage subscription delegation', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'listSubscriptionCredentialCatalogue').length)).toBe(vault ? 1 : 0);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'listSubscriptionPeople').length)).toBe(management ? 1 : 0);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => /Credential.*(?:Grants|Candidates)|ManagementDelegates/.test(call.name)))).toEqual([]);
});

test('Account preview reads retained staff leave notes and evidence without other-owner controls, then uploads an immutable payroll comparison', async ({ page }) => {
  await selectProfile(page, 'account');
  await navigation(page).getByRole('button', { name: /^Leave/ }).click();
  await expect(page.getByRole('button', { name: /^Approvals/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^All\s*\d/ }).click();
  const records = page.getByRole('list', { name: 'Leave requests', exact: true });
  await expect(records.getByRole('button')).toHaveCount(7);
  await records.getByRole('button', { name: /Synthetic Employee: Annual leave.*Pending/ }).click();
  const detail = page.getByRole('complementary', { name: 'Annual leave leave details' });
  await expect(detail).toContainText('Synthetic retained employee note');
  await expect(detail.getByRole('link', { name: /synthetic-evidence.pdf/ })).toHaveAttribute('href', '/leave/attachments/44000000-0000-4000-8000-000000000001');
  await expect(detail.getByRole('button', { name: /Cancel leave|Delete|Approve|Decline/ })).toHaveCount(0);
  await expect(detail.locator('input[type="file"]')).toHaveCount(0);
  for (const status of ['Approved', 'Declined', 'Cancelled']) await expect(records.getByRole('button', { name: new RegExp(`Synthetic Employee: Annual leave.*${status}`) })).toBeVisible();
  await page.getByRole('button', { name: 'Balance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload CSV or Excel', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Manage access', exact: true })).toHaveCount(0);
  const payrollFile = { name: 'synthetic-payroll.csv', mimeType: 'text/csv', buffer: Buffer.from('employee,annual\nSynthetic Employee,16\n') };
  await page.getByLabel('Choose payroll leave balance CSV or Excel files').setInputFiles(payrollFile);
  const dialog = page.getByRole('dialog', { name: 'Payroll balance preview', exact: true });
  await expect(dialog.getByRole('table', { name: 'Payroll comparison' })).toBeVisible();
  await expect(dialog).toContainText('Balances unchanged.');
  await expect(dialog.getByRole('button', { name: 'Apply matched balances', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const calls = await page.evaluate(() => window.unifiedRoleFixture.calls);
  const stage = calls.find(call => call.name === 'stagePayrollBalanceFiles');
  expect(stage.args).toEqual([{ files: [{ name: payrollFile.name, type: payrollFile.mimeType, size: payrollFile.buffer.length }] }, ids.account]);
  expect(calls.filter(call => /commitPayroll|saveAnnualLeaveBalance|saveSickLeaveBalance|decideLeave|submitLeaveRequestForSelectedEmployee|deleteLeave/.test(call.name))).toEqual([]);
});

test('same-target reselect refreshes promotion and demotion while pending transitions unmount privileged panels', async ({ page }) => {
  await selectProfile(page, 'employee');
  await openPeople(page, 'employee');
  for (const role of ['admin', 'employee']) {
    await page.evaluate(({ id, role }) => {
      window.unifiedRoleFixture.setRole(id, role);
      window.unifiedRoleFixture.holdNext('getPortalRoleCapabilities', id);
    }, { id: ids.employee, role });
    await selectProfile(page, 'employee');
    await expect(page.getByRole('status').filter({ hasText: 'Loading role permissions…' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'People operations workspace', includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Credentials', exact: true, includeHidden: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(id => window.unifiedRoleFixture.pendingKeys().includes(`getPortalRoleCapabilities:${id}`), ids.employee)).toBe(true);
    await page.evaluate(id => window.unifiedRoleFixture.finish('getPortalRoleCapabilities', id), ids.employee);
    await openPeople(page, role);
    await expect(page.getByRole('button', { name: 'Role', exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(id => window.unifiedRoleFixture.calls.filter(call => call.name === 'getPortalRoleCapabilities' && call.args[0] === id).length, ids.employee)).toBe(3);
});

for (const name of ['getPortalRoleCapabilities', 'getSelectedEmployeeProfile', 'getLeaveWorkspaceData']) test(`late Admin ${name} response cannot replace the Employee selected while A was pending`, async ({ page }) => {
  await page.evaluate(({ name, id }) => window.unifiedRoleFixture.holdNext(name, id), { name, id: ids.admin });
  await selectProfile(page, 'admin');
  await expect.poll(() => page.evaluate(({ name, id }) => window.unifiedRoleFixture.pendingKeys().includes(`${name}:${id}`), { name, id: ids.admin })).toBe(true);
  await selectProfile(page, 'employee');
  await expect(preview(page)).toContainText(`Viewing ${names.employee}`);
  await openPeople(page, 'employee');
  const reads = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getLeaveWorkspaceData').length);
  await page.evaluate(({ name, id }) => window.unifiedRoleFixture.finish(name, id), { name, id: ids.admin });
  await expect.poll(() => page.evaluate(({ name, id }) => window.unifiedRoleFixture.responses.some(response => response.key === `${name}:${id}`), { name, id: ids.admin })).toBe(true);
  await expect(peopleTabs(page).getByRole('tab')).toHaveText(sections.employee);
  await expect(page.getByRole('button', { name: `Open ${names.employee}'s profile`, exact: true })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText(names.admin);
  await navigation(page).getByRole('button', { name: /^Leave/ }).click();
  await expect(page.getByRole('list', { name: 'Leave requests', exact: true }).getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Leave requests', exact: true }).getByRole('button')).toHaveAccessibleName(/for you:/);
  await expect(page.getByRole('button', { name: /^Approvals|^Balance$/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getLeaveWorkspaceData').length)).toBe(reads);
});

test('new paid register entry navigates to the request form while free remains direct entry',async({page})=>{
  await openPeople(page,'system_admin');
  await peopleTabs(page).getByRole('tab',{name:'Subscriptions',exact:true}).click();
  await page.getByRole('button',{name:'Add subscription',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Add subscription',exact:true});
  await expect(dialog.getByLabel('Free',{exact:true})).toBeChecked();
  await expect(dialog.getByRole('button',{name:'Add subscription',exact:true})).toBeEnabled();
  await dialog.getByLabel('Paid',{exact:true}).check();
  await expect.poll(()=>page.evaluate(()=>window.fixtureNavigation)).toBe('/subscription-requests?new=1');
  await expect(dialog.getByRole('button',{name:'Add subscription',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.unifiedRoleFixture.calls.filter(c=>c.name==='createSubscription'))).toEqual([]);
});
