import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { workspace, review, ids, failure } from '../performance-review-fixtures.mjs';
import { QUESTIONS } from '../../src/lib/performance-review-questions.mjs';
import './performance-review-conflict-cases.mjs';

const ORIGIN = process.env.MAM_PERFORMANCE_ORIGIN;
test.skip(!ORIGIN, 'Dedicated synthetic performance-component bundle required; not real Auth.');
if (ORIGIN && (!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname) || new URL(ORIGIN).protocol !== 'http:')) throw new Error('Performance fixture must be loopback HTTP.');
const observations = new WeakMap();
const field = (page, name) => page.locator(`[name="${name}"]`);
const calls = (page, name) => page.evaluate(name => window.performanceReviewFixture.calls.filter(call => call.name === name), name);
const submit = (page, name) => page.locator(`form[aria-label="${name}"]`).evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
async function open(page, audience = 'employee', company = 'MAM') {
  await page.goto(`${ORIGIN}/?audience=${audience}&company=${company}`);
  await expect(field(page, 'self-0')).toBeVisible();
}
async function hold(page, name) { await page.evaluate(name => window.performanceReviewFixture.holdNext(name), name); }
async function release(page, name, result) { await page.evaluate(({ name, result }) => window.performanceReviewFixture.release(name, result), { name, result }); }
async function waitPending(page, name) { await page.waitForFunction(name => window.performanceReviewFixture.pending().some(item => item.name === name), name); }

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  observations.set(page, { errors: [], external: [] });
  page.on('pageerror', error => observations.get(page).errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === ORIGIN) return route.continue();
    observations.get(page).external.push(route.request().url()); return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(observations.get(page)).toEqual({ errors: [], external: [] });
  expect(await page.evaluate(() => window.performanceReviewFixture?.unexpected ?? [])).toEqual([]);
});

for (const company of ['MAM', 'Equipsy']) for (const audience of ['employee', 'manager', 'admin']) test(`actual React ${company} ${audience} prompts and native Word download`, async ({ page }) => {
  await open(page, audience, company);
  for (let i = 0; i < 12; i++) await expect(field(page, 'self-'+i)).toHaveValue(`Synthetic answer ${i + 1}`);
  const prompt = field(page, 'self-6').locator('..'); await expect(prompt).toBeVisible(); expect(await prompt.evaluate(label => Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''))).toBe(QUESTIONS[company][6]);
  if (audience === 'employee') await expect(field(page, 'managerNote')).toHaveCount(0);
  else {
    await expect(page.getByRole('form', { name: 'Self assessment', exact: true })).toHaveCount(0);
    for (let i = 0; i < 12; i++) {
      const pair = field(page, 'manager-'+i).locator('../..');
      await expect(pair.locator(`[name="self-${i}"]`)).toBeDisabled();
      expect(await pair.locator('textarea').evaluateAll(fields => fields.map(field => field.name))).toEqual(['self-'+i, 'manager-'+i]);
      const selfBox = await field(page, 'self-'+i).boundingBox(), managerBox = await field(page, 'manager-'+i).boundingBox();
      expect(managerBox.y).toBeGreaterThanOrEqual(selfBox.y + selfBox.height);
      expect(managerBox.y - selfBox.y - selfBox.height).toBeLessThan(50);
    }
  }
  if (audience === 'admin') {
    await expect(field(page, 'managerNote')).toBeDisabled();
    await expect(page.getByRole('form', { name: 'Self assessment', exact: true })).toHaveCount(0);
    await submit(page, 'Manager assessment'); await submit(page, 'Review meeting');
    expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(0);
    await expect(page.getByRole('button', { name: /Save|Complete|Finalise|Create|Start review/ })).toHaveCount(0);
  }
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Word', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`PR-2026-0001-${audience === 'employee' ? 'employee' : 'manager'}.docx`);
  const xml = strFromU8(unzipSync(new Uint8Array(await readFile(await download.path())))['word/document.xml']);
  expect(xml).not.toContain('PRIVATE-SYNTHETIC-MANAGER-NOTE');
  expect(xml).toContain(company === 'MAM' ? 'Your Safety First' : 'Purpose Built');
  if (audience === 'employee') expect(xml).not.toContain('Synthetic feedback');
});

test('native manager yearly review defaults cross daylight saving by calendar days and keep the selected cycle in its payload', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-03T14:30:00Z'));
  await open(page, 'manager');
  await page.evaluate(id => { const person = window.performanceReviewFixture.workspace.startablePeople[0]; window.performanceReviewFixture.workspace.startablePeople.push({ ...person, id, name: 'Synthetic Second' }); }, ids.other);
  await page.evaluate(actor => window.performanceReviewFixture.emitAuth('TOKEN_REFRESHED', actor), ids.actor);
  await page.getByRole('navigation', { name: 'Review employees' }).getByRole('button', { name: 'Synthetic Second — MAM', exact: true }).click();
  const form = page.getByRole('form', { name: 'New yearly review', exact: true });
  await expect(page.getByRole('combobox', { name: 'Cycle', exact: true })).toHaveValue('2026');
  await expect(field(page, 'start-dueDate')).toHaveValue('2026-10-11');
  const employees = page.getByRole('navigation', { name: 'Review employees' });
  await expect(employees.getByRole('button')).toHaveCount(2);
  await expect(employees.getByRole('button').last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Review list' })).toHaveCount(0);
  const listBox = await employees.boundingBox(), formBox = await form.boundingBox();
  expect(formBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  const startButton = form.getByRole('button', { name: 'Start review', exact: true }), startBox = await startButton.boundingBox();
  expect(Math.abs(startBox.x + startBox.width - formBox.x - formBox.width)).toBeLessThan(2);
  expect(Math.abs(startBox.y + startBox.height - formBox.y - formBox.height)).toBeLessThan(2);
  await expect(startButton).toHaveCSS('background-color', 'rgb(195, 77, 20)');
  await employees.getByRole('button', { name: 'Synthetic Second — MAM', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(employees.getByRole('button').last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Synthetic Second — MAM', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Cycle', exact: true }).selectOption('2027');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileList = await employees.boundingBox(), mobileForm = await form.boundingBox();
  expect(mobileForm.y).toBeGreaterThanOrEqual(mobileList.y + mobileList.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Cycle', exact: true })).toHaveValue('2027');
  await expect(field(page, 'start-dueDate')).toHaveValue('2026-10-11');
  await hold(page, 'startPerformanceReview');
  await form.getByRole('button', { name: 'Start review', exact: true }).click();
  await waitPending(page, 'startPerformanceReview');
  const writes = await calls(page, 'startPerformanceReview');
  expect(writes).toHaveLength(1);
  expect(writes[0].args[0]).toMatchObject({ employeePersonId: ids.other, cycle: '2027', dueDate: '2026-10-11' });
  await expect(page.getByRole('button', { name: 'New yearly review', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toHaveCount(0);
  await expect(employees.getByRole('button').first()).toBeDisabled();
});

test('employee search filters the scoped roster without losing a manager draft and clears on auth changes', async ({ page }) => {
  await open(page, 'manager');
  await page.evaluate(({ other, actor }) => {
    const person = window.performanceReviewFixture.workspace.startablePeople[0];
    window.performanceReviewFixture.workspace.startablePeople.push({ ...person, id: other, name: 'Synthetic Second', team: 'Warehouse', jobTitle: 'Team leader', company: 'Equipsy' });
    window.performanceReviewFixture.emitAuth('TOKEN_REFRESHED', actor);
  }, { other: ids.other, actor: ids.actor });
  const employees = page.getByRole('navigation', { name: 'Review employees' });
  await expect(employees.getByRole('button')).toHaveCount(2);
  await field(page, 'manager-0').fill('Keep this manager draft');
  const search = page.getByRole('searchbox', { name: 'Search employees' });
  await search.fill(' WAREHOUSE ');
  await expect(employees.getByRole('button')).toHaveCount(1);
  await expect(employees.getByRole('button')).toHaveAccessibleName('Synthetic Second — Equipsy');
  await expect(field(page, 'manager-0')).toHaveValue('Keep this manager draft');
  await search.fill('no such employee');
  await expect(employees.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('No employees match that search.');
  await search.fill('equipsy');
  await expect(employees.getByRole('button')).toHaveCount(1);
  await search.fill('');
  await expect(employees.getByRole('button')).toHaveCount(2);
  await expect(field(page, 'manager-0')).toHaveValue('Keep this manager draft');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await search.fill('Synthetic Second');
  await employees.getByRole('button').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Synthetic Second — Equipsy', exact: true })).toBeVisible();
  await expect(field(page, 'start-dueDate')).toBeVisible();
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(0);
  expect(await calls(page, 'startPerformanceReview')).toHaveLength(0);
  await page.evaluate(actor => { window.performanceReviewFixture.emitAuth('SIGNED_OUT'); window.performanceReviewFixture.emitAuth('SIGNED_IN', actor); }, ids.actor);
  await expect(search).toHaveValue('');
});

test('self immediate duplicate guard, committed submit lock and exact payload', async ({ page }) => {
  await open(page); await field(page, 'self-0').fill('Browser synthetic draft'); await hold(page, 'mutatePerformanceReview');
  const save = page.getByRole('button', { name: 'Save self draft', exact: true }); await save.click();
  await waitPending(page, 'mutatePerformanceReview'); await expect(save).toBeDisabled();
  await submit(page, 'Self assessment'); const writes = await calls(page, 'mutatePerformanceReview'); expect(writes).toHaveLength(1);
  const input = writes[0].args[0]; expect(input.expectedRevision).toBe('self:0'); expect(input.command).toBe('save_self'); expect(Object.keys(input.input)).toEqual(['answers']);
  await release(page, 'mutatePerformanceReview', { ok: true, committed: true, operationId: input.operationId, review: review('employee', 'MAM', { selfRevision: 'self:1', selfAnswers: input.input.answers }) });
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await hold(page, 'mutatePerformanceReview'); await submit(page, 'Self assessment'); await waitPending(page, 'mutatePerformanceReview');
  const second = (await calls(page, 'mutatePerformanceReview'))[1].args[0];
  expect(second.command).toBe('submit_self'); expect(second.expectedRevision).toBe('self:1');
  await release(page, 'mutatePerformanceReview', { ok: true, committed: true, operationId: second.operationId, review: review('employee', 'MAM', { selfRevision: 'self:2', selfSubmittedAt: '2026-10-01T01:00:00Z', selfStatus: 'manager_review', selfAnswers: second.input.answers, capabilities: { saveSelf: false, submitSelf: false, downloadDocument: true } }) });
  await expect(field(page, 'self-0')).toBeDisabled(); await submit(page, 'Self assessment'); expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(2);
});

test('unknown write and not_found never unlock replay; explicit receipt confirms', async ({ page }) => {
  await open(page); await field(page, 'self-0').fill('Uncertain browser draft');
  await page.evaluate(result => window.performanceReviewFixture.enqueue('mutatePerformanceReview', result), failure('uncertain', true));
  await page.getByRole('button', { name: 'Save self draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reconcile update', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(field(page, 'self-0')).toHaveValue('Uncertain browser draft');
  await page.evaluate(() => window.performanceReviewFixture.enqueue('reconcilePerformanceReviewOperation', { ok: true, data: { status: 'not_found', review: null } }));
  await page.getByRole('button', { name: 'Reconcile update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save self draft', exact: true })).toBeDisabled();
  await submit(page, 'Self assessment'); expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(1);
  await page.evaluate(row => window.performanceReviewFixture.enqueue('reconcilePerformanceReviewOperation', { ok: true, data: { status: 'committed', review: row } }), review('employee', 'MAM', { selfRevision: 'self:1' }));
  await page.getByRole('button', { name: 'Reconcile update', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('Update confirmed.');
});

test('manager meeting is not held by registration and final needs explicit held plus completed assessment', async ({ page }) => {
  await open(page, 'manager'); await field(page, 'meeting-date').fill('2026-10-01'); await field(page, 'meeting-time').fill('10:30');
  await hold(page, 'mutatePerformanceReview'); await page.getByRole('button', { name: 'Save meeting', exact: true }).click(); await waitPending(page, 'mutatePerformanceReview');
  const input = (await calls(page, 'mutatePerformanceReview'))[0].args[0]; expect(input.command).toBe('save_meeting'); expect(input.input).not.toHaveProperty('held');
  const row = review('manager', 'MAM', { managerRevision: 'manager:0:1', meeting: input.input, managerCompletedAt: '2026-10-01T02:00:00Z' });
  await release(page, 'mutatePerformanceReview', { ok: true, committed: true, operationId: input.operationId, review: row });
  await expect(field(page, 'held')).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Finalise review', exact: true })).toBeDisabled();
  await field(page, 'held').check(); await hold(page, 'mutatePerformanceReview'); await submit(page, 'Review meeting'); await waitPending(page, 'mutatePerformanceReview');
  const final = (await calls(page, 'mutatePerformanceReview'))[1].args[0]; expect(final.command).toBe('submit_review'); expect(final.input.held).toBe(true);
  await release(page, 'mutatePerformanceReview', { ok: true, committed: true, operationId: final.operationId, review: { ...row, managerRevision: 'manager:0:2', finalisedAt: '2026-10-01T03:00:00Z' } });
  await expect(field(page, 'meeting-date')).toBeDisabled();
});

test('native auth event clears manager DOM and ignores late manager load after same-user sign-in', async ({ page }) => {
  await open(page, 'manager'); await field(page, 'managerNote').fill('PRIVATE-BROWSER-DRAFT');
  await hold(page, 'loadPerformanceReviews'); await page.evaluate(actor => window.performanceReviewFixture.emitAuth('TOKEN_REFRESHED', actor), ids.actor); await waitPending(page, 'loadPerformanceReviews');
  await page.evaluate(data => { window.performanceReviewFixture.emitAuth('SIGNED_OUT'); window.performanceReviewFixture.workspace = data; }, workspace());
  await expect(field(page, 'managerNote')).toHaveCount(0); await expect(page.getByText('Synthetic Colleague — MAM', { exact: true })).toHaveCount(0);
  await page.evaluate(actor => window.performanceReviewFixture.emitAuth('SIGNED_IN', actor), ids.actor);
  await expect(field(page, 'self-0')).toBeVisible(); await release(page, 'loadPerformanceReviews', { ok: true, data: workspace('manager') });
  await expect(field(page, 'managerNote')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Manager assessment', exact: true })).toHaveCount(0);
});

test('native Admin Performance starts a manager review and saves with its admin revision', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T00:00:00Z'));
  await open(page, 'admin');
  const manager = { ...review().employee, id: ids.other, name: 'Synthetic Manager', jobTitle: 'Manager' };
  await page.evaluate(({ manager, actor }) => {
    window.performanceReviewFixture.workspace.startablePeople = [manager];
    window.performanceReviewFixture.emitAuth('TOKEN_REFRESHED', actor);
  }, { manager, actor: ids.actor });
  await page.getByRole('navigation', { name: 'Review employees' }).getByRole('button', { name: 'Synthetic Manager — MAM', exact: true }).click();
  await expect(field(page, 'start-cycle')).toHaveValue('2026');
  await expect(field(page, 'start-dueDate')).toHaveValue('2026-10-27');
  await hold(page, 'startPerformanceReview');
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await waitPending(page, 'startPerformanceReview');
  const start = (await calls(page, 'startPerformanceReview'))[0].args[0];
  expect(start).toMatchObject({ employeePersonId: manager.id, cycle: '2026', dueDate: '2026-10-27' });
  const row = review('admin', 'MAM', { employee: manager, readRevision: 'read:0:0', capabilities: { ...review('manager').capabilities } });
  await release(page, 'startPerformanceReview', { ok: true, committed: true, operationId: start.operationId, review: row, existing: false });
  await expect(field(page, 'self-0')).toBeDisabled();
  await expect(field(page, 'managerNote')).toBeEnabled();
  await field(page, 'managerNote').fill('Synthetic Admin reviewer note');
  await hold(page, 'mutatePerformanceReview');
  await page.getByRole('button', { name: 'Save manager draft', exact: true }).click();
  await waitPending(page, 'mutatePerformanceReview');
  const write = (await calls(page, 'mutatePerformanceReview'))[0].args[0];
  expect(write.command).toBe('save_manager'); expect(write.expectedRevision).toBe('read:0:0');
  await release(page, 'mutatePerformanceReview', { ok: true, committed: true, operationId: write.operationId, review: { ...row, readRevision: 'read:0:1', managerNote: write.input.managerNote } });
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(field(page, 'managerNote')).toHaveValue('Synthetic Admin reviewer note');
});
