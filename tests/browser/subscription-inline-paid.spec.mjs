import { test, expect } from '@playwright/test';

const navigation = page => page.getByRole('complementary', { name: 'People Hub navigation' });
const dialogFor = page => page.getByRole('dialog', { name: 'Add subscription', exact: true });
const field = (dialog, name) => ['Free', 'Paid'].includes(name) ? dialog.getByRole('radio', { name, exact: true }) : dialog.getByLabel(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
const submitFor = dialog => dialog.getByRole('button', { name: 'Submit request', exact: true });
const writes = page => page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => ['createSubscription', 'mutateSubscriptionRequest'].includes(call.name)));

async function openModal(page, mode = 'enabled') {
  await page.goto(`/?fixture=unified-roles&subscription-inline=${mode}`);
  await navigation(page).getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('tablist', { name: 'People sections' }).getByRole('tab', { name: 'Subscriptions', exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  return dialogFor(page);
}
async function commonFields(dialog) {
  await dialog.getByLabel(/^Service name/).fill('Synthetic inline subscription');
  await dialog.getByLabel(/^Plan/).fill('Synthetic annual team plan');
  await dialog.getByLabel(/^Company/).selectOption('mam');
}
async function paidFields(dialog, payment = 'card') {
  await commonFields(dialog);
  await field(dialog, 'Paid').click();
  await expect(field(dialog, 'Requested by')).toHaveValue('Synthetic Applicant');
  await field(dialog, 'Purpose').fill('Synthetic project collaboration');
  await field(dialog, 'Website link').fill('https://example.test/product');
  await field(dialog, 'Category').selectOption('subscription');
  await field(dialog, 'Intended users').fill('Synthetic delivery team');
  await field(dialog, 'Expected usage').selectOption('12_months');
  await field(dialog, 'Usage frequency').fill('Daily');
  await dialog.getByLabel(/^Start date/).fill('2026-11-01');
  await field(dialog, 'Monthly cost (AUD)').fill('25.50');
  await field(dialog, 'Annual cost (AUD)').fill('255.00');
  await field(dialog, 'Preferred billing').selectOption('annual');
  await field(dialog, 'Payment method').selectOption(payment);
  if (payment === 'card') {
    await field(dialog, 'Card label').fill('Synthetic corporate card');
    await field(dialog, 'Card holder').fill('Synthetic Cardholder');
  } else if (payment === 'invoice') {
    await field(dialog, 'Invoice email').fill('synthetic-accounts@example.test');
    await field(dialog, 'Invoice contact').fill('Synthetic Accounts');
  }
}
async function expectLocked(dialog) {
  expect(await dialog.locator('input, textarea, select').evaluateAll(nodes => nodes.every(node => node.disabled || node.matches(':disabled')))).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close subscription form', exact: true })).toBeDisabled();
}
async function holdSubmit(page, dialog) {
  await page.evaluate(() => window.unifiedRoleFixture.holdNext('mutateSubscriptionRequest'));
  await submitFor(dialog).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain('mutateSubscriptionRequest:');
  await expect(dialog.getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled();
  expect((await writes(page)).map(call => call.name)).toEqual(['mutateSubscriptionRequest']);
}

test.beforeEach(async ({ page, context, baseURL }) => {
  page.__inlineErrors = [];
  page.__inlineExternal = [];
  page.on('pageerror', error => page.__inlineErrors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    page.__inlineExternal.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
});
test.afterEach(async ({ page }) => {
  expect(page.__inlineErrors).toEqual([]);
  expect(page.__inlineExternal).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture?.unexpected ?? [])).toEqual([]);
});

test('inline paid preserves common and paid drafts when switching Free and Paid', async ({ page }) => {
  const dialog = await openModal(page);
  await expect(dialog.getByLabel(/^Service name/)).toBeFocused();
  await paidFields(dialog);
  expect(await field(dialog, 'Requested by').evaluate(node => node.readOnly || node.disabled || node.matches(':disabled'))).toBe(true);
  await expect(dialog.locator('form')).toHaveCount(1);
  await expect(dialog.locator('form form')).toHaveCount(0);
  await expect(dialog.getByLabel(/^Responsible person/)).toBeHidden();
  await expect(dialog.getByRole('combobox', { name: 'Search employees', exact: true, includeHidden: true })).toBeDisabled();
  await expect(field(dialog, 'Alternative quote unavailable reason')).toBeVisible();
  await expect(dialog.getByLabel(/^Evidence/)).toBeVisible();
  await field(dialog, 'Free').click();
  await expect(dialog.getByRole('button', { name: 'Add subscription', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel(/^Service name/)).toHaveValue('Synthetic inline subscription');
  await expect(dialog.getByLabel(/^Plan/)).toHaveValue('Synthetic annual team plan');
  await expect(dialog.getByLabel(/^Company/)).toHaveValue('mam');
  await field(dialog, 'Paid').click();
  await expect(field(dialog, 'Purpose')).toHaveValue('Synthetic project collaboration');
  await expect(field(dialog, 'Monthly cost (AUD)')).toHaveValue('25.50');
  await expect(field(dialog, 'Annual cost (AUD)')).toHaveValue('255.00');
  await expect(dialog.getByLabel(/^Start date/)).toHaveValue('2026-11-01');
  await expect(field(dialog, 'Card label')).toHaveValue('Synthetic corporate card');
  expect(await writes(page)).toEqual([]);
  expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
});

test('inline paid card request submits the template fields and evidence once without creating a register row', async ({ page }) => {
  const dialog = await openModal(page);
  const originalUrl = page.url();
  await paidFields(dialog);
  await dialog.getByLabel(/^Evidence/).setInputFiles({ name: 'synthetic-quote.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic quote') });
  await submitFor(dialog).click();
  await expect(dialog).toHaveCount(0);
  const calls = await writes(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe('mutateSubscriptionRequest');
  const input = calls[0].args[0];
  expect(input).toMatchObject({ version: 0, operation: 'submit', payload: {
    formVersion: 3, kind: 'new_purchase', service: 'Synthetic inline subscription', plan: 'Synthetic annual team plan',
    company: 'mam', purpose: 'Synthetic project collaboration', websiteUrl: 'https://example.test/product',
    category: 'subscription', intendedUsers: 'Synthetic delivery team', duration: '12_months', usageFrequency: 'Daily',
    startDate: '2026-11-01', billing: 'annual', currency: 'AUD', monthlyCostCents: 2550, annualCostCents: 25500,
    quoteCents: 25500, audEstimateCents: 25500, payment: 'card', cardLabel: 'Synthetic corporate card', cardHolder: 'Synthetic Cardholder',
  } });
  expect(input.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(input.evidence).toHaveLength(1);
  expect(input.evidence[0]).toMatchObject({ name: 'synthetic-quote.pdf', mime: 'application/pdf' });
  expect(Buffer.from(input.evidence[0].base64, 'base64').toString()).toBe('%PDF-1.4 synthetic quote');
  expect(page.url()).toBe(originalUrl);
  expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
});

test('inline paid one-off invoice strips recurring prices and unused card details from submission', async ({ page }) => {
  const dialog = await openModal(page);
  await paidFields(dialog);
  await field(dialog, 'Payment method').selectOption('invoice');
  await field(dialog, 'Invoice email').fill('synthetic-accounts@example.test');
  await field(dialog, 'Invoice contact').fill('Synthetic Accounts');
  await field(dialog, 'Category').selectOption('one_off_service');
  await expect(field(dialog, 'Preferred billing')).toHaveValue('one_off');
  await field(dialog, 'One-off cost (AUD)').fill('420.25');
  await submitFor(dialog).click();
  await expect(dialog).toHaveCount(0);
  const calls = await writes(page);
  expect(calls.map(call => call.name)).toEqual(['mutateSubscriptionRequest']);
  const payload = calls[0].args[0].payload;
  expect(payload).toMatchObject({ category: 'one_off_service', billing: 'one_off', payment: 'invoice', oneOffCostCents: 42025,
    quoteCents: 42025, audEstimateCents: 42025, invoiceEmail: 'synthetic-accounts@example.test', invoiceContact: 'Synthetic Accounts' });
  expect(payload.monthlyCostCents ?? null).toBeNull();
  expect(payload.annualCostCents ?? null).toBeNull();
  expect(payload.cardLabel ?? '').toBe('');
  expect(payload.cardHolder ?? '').toBe('');
});

test('inline paid recurring direct debit accepts an unavailable alternative quote with its reason', async ({ page }) => {
  const dialog = await openModal(page);
  await paidFields(dialog, 'direct_debit');
  await field(dialog, 'Preferred billing').selectOption('monthly');
  await field(dialog, 'Annual cost (AUD)').fill('');
  await field(dialog, 'Alternative quote unavailable reason').fill('Synthetic vendor offers monthly billing only');
  await submitFor(dialog).click();
  await expect(dialog).toHaveCount(0);
  const calls = await writes(page);
  expect(calls.map(call => call.name)).toEqual(['mutateSubscriptionRequest']);
  expect(calls[0].args[0].payload).toMatchObject({ billing: 'monthly', payment: 'direct_debit', quoteCents: 2550,
    comparisonUnavailableReason: 'Synthetic vendor offers monthly billing only' });
});

test('inline paid switching back to Free adds directly and does not send a request', async ({ page }) => {
  const dialog = await openModal(page);
  await paidFields(dialog);
  await field(dialog, 'Free').click();
  await dialog.getByRole('combobox', { name: 'Search employees', exact: true }).fill('Synthetic Manager');
  await dialog.getByRole('option', { name: /Synthetic Manager/ }).click();
  await dialog.getByRole('button', { name: 'Add subscription', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = await writes(page);
  expect(calls.map(call => call.name)).toEqual(['createSubscription']);
  expect(calls[0].args[0]).toMatchObject({ serviceName: 'Synthetic inline subscription', planName: 'Synthetic annual team plan',
    company: 'mam', pricingModel: 'free', amountCents: null, responsiblePersonId: '11000000-0000-4000-8000-000000000004' });
});

test('inline paid double click submits once and locks every close and edit path until completion', async ({ page }) => {
  const dialog = await openModal(page);
  await paidFields(dialog);
  await holdSubmit(page, dialog);
  await expectLocked(dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.unifiedRoleFixture.finish('mutateSubscriptionRequest'));
  await expect(dialog).toHaveCount(0);
  expect((await writes(page)).map(call => call.name)).toEqual(['mutateSubscriptionRequest']);
});

test('inline paid uncertain commit requires reload and never resubmits or loses its committed request', async ({ page }) => {
  const dialog = await openModal(page);
  await paidFields(dialog);
  await holdSubmit(page, dialog);
  await page.evaluate(() => window.unifiedRoleFixture.rejectPending('mutateSubscriptionRequest'));
  const reload = dialog.getByRole('button', { name: 'Reload requests', exact: true });
  await expect(reload).toBeEnabled();
  await expectLocked(dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('synthetic uncertain save outcome');
  await reload.click();
  await expect(dialog).toHaveCount(0);
  expect((await writes(page)).map(call => call.name)).toEqual(['mutateSubscriptionRequest']);
  const loads = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'loadSubscriptionRequests').length);
  expect(loads).toBeGreaterThanOrEqual(2);
});

test('inline paid denial scrubs applicant common and paid values and permits closing', async ({ page }) => {
  const dialog = await openModal(page);
  await paidFields(dialog);
  await page.evaluate(() => window.unifiedRoleFixture.failNext('mutateSubscriptionRequest', undefined, 'denied'));
  await submitFor(dialog).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel(/^Service name/)).toHaveValue('');
  await expect(dialog.getByLabel(/^Plan/)).toHaveValue('');
  await expect(dialog.getByLabel(/^Company/)).toHaveValue('');
  expect(await dialog.locator('input, textarea, select').evaluateAll(nodes => nodes.filter(node => !['radio', 'hidden'].includes(node.type)).map(node => node.value).join(' '))).not.toMatch(/Synthetic|255|25.50|2026-11-01/);
  expect(await dialog.locator('input, textarea, select').evaluateAll(nodes => nodes.every(node => node.disabled || node.matches(':disabled')))).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeFocused();
  expect((await writes(page)).map(call => call.name)).toEqual(['mutateSubscriptionRequest']);
});

test('inline paid failed initial load can retry without navigating or mutating', async ({ page }) => {
  const dialog = await openModal(page);
  await commonFields(dialog);
  await page.evaluate(() => window.unifiedRoleFixture.failNext('loadSubscriptionRequests', undefined, 'transport'));
  await field(dialog, 'Paid').click();
  await dialog.getByRole('button', { name: 'Reload requests', exact: true }).click();
  await expect(field(dialog, 'Requested by')).toHaveValue('Synthetic Applicant');
  await expect(dialog.getByLabel(/^Service name/)).toHaveValue('Synthetic inline subscription');
  await expect(submitFor(dialog)).toBeEnabled();
  expect(await writes(page)).toEqual([]);
  expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
});

for (const mode of ['unavailable', 'no-apply', 'legacy', 'denied']) test(`inline paid ${mode} workspace cannot submit a new request`, async ({ page }) => {
  const dialog = await openModal(page, mode);
  await commonFields(dialog);
  await field(dialog, 'Paid').click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(submitFor(dialog)).toBeDisabled();
  expect(await writes(page)).toEqual([]);
  expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) test(`inline paid layout focus and return work at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const dialog = await openModal(page);
  await paidFields(dialog);
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await submitFor(dialog).focus();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeFocused();
  expect(await writes(page)).toEqual([]);
});
