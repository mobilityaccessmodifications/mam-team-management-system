import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { workspace, review, ids, failure } from '../performance-review-fixtures.mjs';
import { QUESTIONS } from '../../src/lib/performance-review-questions.mjs';

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
  if (audience === 'admin') {
    await expect(field(page, 'managerNote')).toBeDisabled();
    await submit(page, 'Self assessment'); await submit(page, 'Manager assessment'); await submit(page, 'Review meeting');
    expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(0);
    await expect(page.getByRole('button', { name: /Save|Complete|Finalise|Create/ })).toHaveCount(0);
  }
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Word', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`PR-2026-0001-${audience === 'employee' ? 'employee' : 'manager'}.docx`);
  const xml = strFromU8(unzipSync(new Uint8Array(await readFile(await download.path())))['word/document.xml']);
  expect(xml).not.toContain('PRIVATE-SYNTHETIC-MANAGER-NOTE');
  expect(xml).toContain(company === 'MAM' ? 'Your Safety First' : 'Purpose Built');
  if (audience === 'employee') expect(xml).not.toContain('Synthetic feedback');
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
  await hold(page, 'loadPerformanceReviews'); await page.getByRole('button', { name: 'Reload', exact: true }).click(); await waitPending(page, 'loadPerformanceReviews');
  await page.evaluate(data => { window.performanceReviewFixture.emitAuth('SIGNED_OUT'); window.performanceReviewFixture.workspace = data; }, workspace());
  await expect(field(page, 'managerNote')).toHaveCount(0); await expect(page.getByText('Synthetic Colleague — MAM', { exact: true })).toHaveCount(0);
  await page.evaluate(actor => window.performanceReviewFixture.emitAuth('SIGNED_IN', actor), ids.actor);
  await expect(field(page, 'self-0')).toBeVisible(); await release(page, 'loadPerformanceReviews', { ok: true, data: workspace('manager') });
  await expect(field(page, 'managerNote')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Manager assessment', exact: true })).toHaveCount(0);
});
