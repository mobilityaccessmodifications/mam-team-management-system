import { test, expect } from '@playwright/test';
import {readFileSync} from 'node:fs';
async function completeRequest(page) {
  await page.getByRole('button',{name:'New request',exact:true}).click();
  for(const [label,value] of [['Service','Synthetic evidence request'],['Purpose','Project work'],['Payer','MAM'],['Usage duration','12 months'],['Tax basis','Inclusive'],['Original quote (cents)','12000'],['AUD estimate (cents)','18000'],['Intended users','Synthetic project team']]) await page.getByLabel(label,{exact:true}).fill(value);
}
test('Requests form submit and returned resubmit use the real component',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New request',exact:true}).click();
  await page.getByLabel('Service', {exact:true}).fill('Synthetic Service');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByText('Saved.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('required');
  for(const [label,value] of [['Purpose','Project work'],['Payer','MAM'],['Usage duration','12 months'],['Tax basis','Inclusive'],['Original quote (cents)','12000'],['AUD estimate (cents)','18000'],['Intended users','Synthetic project team']]) await page.getByLabel(label,{exact:true}).fill(value);
  await page.getByLabel('Payment method',{exact:true}).selectOption('non_card');
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await expect(page.getByText('submitted',{exact:true}).first()).toBeVisible();
  await page.getByLabel('Decision reason').fill('Please revise');
  await page.getByRole('button',{name:'Return',exact:true}).click();
  await expect(page.getByRole('button',{name:'Resubmit',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Resubmit',exact:true}).click();
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByText('Approved — pending procurement',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Activate',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Withdraw',exact:true}).click();
  await expect(page.getByText('withdrawn',{exact:true}).first()).toBeVisible();
});
test('pending mutation disables controls and rejects direct duplicate submit',async({page})=>{
  await page.goto('/'); await page.getByRole('button',{name:'New request',exact:true}).click();
  await page.evaluate(()=>window.srHold=true);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
  await page.locator('form').evaluate(el=>el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(await page.evaluate(()=>window.srCalls.length)).toBe(1);
  await page.evaluate(()=>window.srRelease());
  await expect(page.getByText('Saved.',{exact:true})).toBeVisible();
});
test('uncertain action requires reload and preserves draft',async({page})=>{
  await page.goto('/'); await page.getByRole('button',{name:'New request',exact:true}).click();
  await page.getByLabel('Service',{exact:true}).fill('Retained draft'); await page.evaluate(()=>window.srUncertain=true);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Reload');
  await expect(page.getByLabel('Service',{exact:true})).toHaveValue('Retained draft');
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.srCalls.length)).toBe(1);
});
test('private evidence survives real upload and authenticated download unchanged',async({page})=>{
  await page.goto('/');await completeRequest(page);
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=','base64');
  await page.locator('input[type=file]').setInputFiles({name:'synthetic-quote.png',mimeType:'image/png',buffer:bytes});
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await page.getByText('Version 1 — submit',{exact:true}).click();
  const ready=page.waitForEvent('download');await page.getByRole('button',{name:'Download synthetic-quote.png',exact:true}).click();
  const file=await ready;expect(file.suggestedFilename()).toBe('synthetic-quote.png');expect(readFileSync(await file.path())).toEqual(bytes);
});
test('rejection needs a reason and keeps an immutable terminal record',async({page})=>{
  await page.goto('/');await completeRequest(page);await page.getByRole('button',{name:'Submit',exact:true}).click();
  await page.getByRole('button',{name:'Reject',exact:true}).click();await expect(page.getByRole('alert')).toContainText('reason');
  await page.getByLabel('Decision reason').fill('Not required');await page.getByRole('button',{name:'Reject',exact:true}).click();
  await expect(page.getByText('rejected',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('button',{name:'Resubmit',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
  await page.getByText('Version 2 — reject',{exact:true}).click();await expect(page.getByText(/Not required/)).toBeVisible();
});
test('authoritative reload removes a selected request after access is revoked',async({page})=>{
  const seed=await page.request.post('/fixture/revocation-seed');expect(seed.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button',{name:'Synthetic revoked request — submitted',exact:true}).click();
  await expect(page.getByLabel('Service',{exact:true})).toHaveValue('Synthetic revoked request');
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
  try {
    expect((await page.request.post('/fixture/revoke')).ok()).toBe(true);
    const read=await page.request.post('/action',{data:{name:'loadSubscriptionRequests',args:[]}});
    const result=await read.json();expect(result.ok).toBe(true);expect(result.data.canApply).toBe(false);
    expect(result.data.requests.some(r=>r.id==='b1000000-0000-4000-8000-000000000090')).toBe(false);
    await page.getByRole('button',{name:'Reload',exact:true}).click();
    await expect(page.getByText('Reloaded.',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Service',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
    await expect(page.getByRole('region',{name:'Request history',exact:true})).toHaveCount(0);
    expect(await page.evaluate(()=>window.srCalls.length)).toBe(0);
  } finally {expect((await page.request.post('/fixture/restore')).ok()).toBe(true);}
});
test('reload preserves a genuinely unsaved new draft',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'New request',exact:true}).click();
  await page.getByLabel('Service',{exact:true}).fill('Synthetic unsaved draft');
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await expect(page.getByText('Reloaded.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Service',{exact:true})).toHaveValue('Synthetic unsaved draft');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByText('Saved.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.srCalls.length)).toBe(1);
});
