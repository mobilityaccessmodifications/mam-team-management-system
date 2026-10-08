import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`subscription delegation long synthetic list scrolls and saves independent Employee grants at ${viewport.width}px`, async ({ context, page, baseURL }) => {
    await page.setViewportSize(viewport);
    await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/?fixture=unified-roles&delegation');
    const dialog = page.getByRole('dialog', { name: 'Subscription delegation', exact: true });
    await expect(dialog).toContainText('Active Managers and Employees');
    await expect(dialog).toContainText('only Super Admin controls delegation');
    await expect(dialog.getByRole('switch')).toHaveCount(160);
    const register = dialog.getByRole('switch', { name: 'Register management for Synthetic Employee 02', exact: true });
    const vault = dialog.getByRole('switch', { name: 'Credential vault for Synthetic Employee 80', exact: true });
    await register.check();
    await expect(dialog.getByRole('switch', { name: 'Credential vault for Synthetic Employee 02', exact: true })).not.toBeChecked();
    await vault.scrollIntoViewIfNeeded();
    await expect(vault).toBeInViewport();
    expect(await vault.evaluate(node => {
      let parent = node.parentElement;
      while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
      return Boolean(parent && parent.scrollTop > 0);
    })).toBe(true);
    await vault.check();
    await expect(dialog.getByRole('switch', { name: 'Register management for Synthetic Employee 80', exact: true })).not.toBeChecked();
    const save = dialog.getByRole('button', { name: 'Save delegation', exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.delegationSaved)).toBe(1);
    expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name.startsWith('replaceSubscription')))).toEqual([
      { module: '@/app/subscriptions/delegation-actions', name: 'replaceSubscriptionManagementDelegates', args: [['77000000-0000-4000-8000-000000000002']] },
      { module: '@/app/subscription-credentials/actions', name: 'replaceSubscriptionCredentialAccessGrants', args: [['77000000-0000-4000-8000-000000000080']] },
    ]);
    await page.getByRole('button', { name: 'Reopen delegation', exact: true }).click();
    await expect(register).toBeChecked();
    await expect(vault).toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Credential vault for Synthetic Employee 02', exact: true })).not.toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Register management for Synthetic Employee 80', exact: true })).not.toBeChecked();
    expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
