import { test, expect } from '@playwright/test';
const ownerId='11000000-0000-4000-8000-000000000005';
const subscriptionId='33000000-0000-4000-8000-000000000010';
const tasks=page=>page.getByRole('region',{name:'Tasks',exact:true});
const tabs=page=>page.getByRole('tablist',{name:'People sections'});
async function openTasks(page){
  await page.getByRole('complementary',{name:'People Hub navigation'}).getByRole('button',{name:'People',exact:true}).click();
  await tabs(page).getByRole('tab',{name:'Tasks',exact:true}).click();
  await expect(tasks(page)).toBeVisible();
  await expect(tasks(page)).toContainText('Synthetic due review');
}
test.beforeEach(async({page,context,baseURL})=>{
  page.reviewErrors=[];page.on('pageerror',error=>page.reviewErrors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===baseURL?route.continue():route.abort());
  await page.setViewportSize({width:1440,height:1000});
});
test.afterEach(async({page})=>{
  expect(page.reviewErrors).toEqual([]);
  expect(await page.evaluate(()=>window.unifiedRoleFixture.unexpected)).toEqual([]);
});
for(const width of [1440,390])test(`global register manager has Tasks and versioned Done at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  await page.goto('/?fixture=unified-roles&subscription-reviews=register-manager');
  await openTasks(page);
  await expect(tabs(page).getByRole('tab')).toHaveText(['Directory','Tasks','Subscriptions']);
  await tasks(page).getByRole('button',{name:"Open Synthetic due review's Quarterly subscription review",exact:true}).click();
  const details=page.getByRole(width <= 900 ? 'dialog' : 'region',{name:'Task details',exact:true});
  const done=details.getByRole('button',{name:"Mark Synthetic due review's subscription review done",exact:true});
  await expect(done).toBeEnabled();
  await expect(tasks(page)).toContainText('1 Jan 2500');
  await page.evaluate(id=>window.unifiedRoleFixture.holdNext('completeMySubscriptionReviewTask',id),subscriptionId);
  await done.click();
  await expect(done).toBeDisabled();
  await done.dispatchEvent('click');
  await expect.poll(()=>page.evaluate(()=>window.unifiedRoleFixture.calls.filter(c=>c.name==='completeMySubscriptionReviewTask').length)).toBe(1);
  await page.evaluate(id=>window.unifiedRoleFixture.finish('completeMySubscriptionReviewTask',id),subscriptionId);
  await expect(tasks(page).getByRole('status').filter({hasText:'review is complete'})).toHaveCount(1);
  await expect(details).toHaveCount(0);
  await tasks(page).getByRole('button',{name:"Open Synthetic due review's Quarterly subscription review",exact:true}).click();
  await expect(done).toBeDisabled();
  if(width <= 900) await page.keyboard.press('Escape');
  await tasks(page).getByRole('button',{name:"Open Synthetic future review's Quarterly subscription review",exact:true}).click();
  await expect(details.getByRole('button',{name:"Mark Synthetic future review's subscription review done",exact:true})).toBeDisabled();
  const mutations=await page.evaluate(()=>window.unifiedRoleFixture.calls.filter(c=>c.name==='completeMySubscriptionReviewTask'));
  expect(mutations[0].args).toEqual([{subscriptionId,version:4}]);
});
test('Change Profile shows only the register manager reviews without Done or completion dispatch',async({page})=>{
  await page.goto('/?fixture=unified-roles&subscription-reviews=preview-register-manager');
  await page.getByRole('region',{name:'Employee access preview'}).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog',{name:'Change profile',exact:true}).getByRole('button',{name:/Synthetic Employee/}).click();
  await openTasks(page);
  await expect(tasks(page).getByRole('button',{name:/subscription review done/})).toHaveCount(0);
  const calls=await page.evaluate(()=>window.unifiedRoleFixture.calls);
  expect(calls.filter(c=>c.name==='list_subscription_review_tasks_for_preview').map(c=>c.args)).toEqual([[{p_person_id:ownerId}]]);
  expect(calls.filter(c=>c.name==='completeMySubscriptionReviewTask')).toEqual([]);
});
