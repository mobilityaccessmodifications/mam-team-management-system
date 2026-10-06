import { test, expect } from "@playwright/test";

test.use({ timezoneId: "Australia/Melbourne", viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
test.beforeEach(async ({ context, baseURL }) => {
  await context.route("**/*", (route) => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  await context.routeWebSocket(/.*/, (socket) => socket.close());
});

const cases = [["spring DST", "2026-10-06T01:00:00Z"], ["autumn DST", "2026-04-07T01:00:00Z"], ["ordinary dates", "2026-09-08T01:00:00Z"]];
for (const [label, instant] of cases) {
test(`mobile week keeps the ${label} event in its civil date column`, async ({ page }) => {
  await page.clock.setFixedTime(new Date(instant));
  await page.goto("/?fixture=staff-calendar");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Today" }).click();
  const event = page.getByText(/Sample Staff · Sick leave/).first();
  await expect(event).toBeVisible();
  await event.click();
  await expect(page.getByText("Type of leave: Sick leave")).toBeVisible();
  await expect(page.getByText("Approved by: Sample Reviewer")).toBeVisible();
});

test(`mobile week gives both all-day rows full non-overlapping touch targets over ${label}`, async ({ page }) => {
  await page.clock.setFixedTime(new Date(instant));
  await page.goto("/?fixture=staff-calendar");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Today" }).click();
  const first = page.getByText(/Sample Staff · Sick leave/).first().locator("xpath=ancestor::*[@role='button'][1]");
  const second = page.getByText(/Other Staff · Annual leave/).first().locator("xpath=ancestor::*[@role='button'][1]");
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const boxes = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(boxes[0].height).toBeGreaterThanOrEqual(44);
  expect(boxes[1].height).toBeGreaterThanOrEqual(44);
  const ordered = [...boxes].sort((a, b) => a.y - b.y);
  expect(ordered[1].y).toBeGreaterThanOrEqual(ordered[0].y + ordered[0].height);
  for (const target of [first, second]) {
    await expect(target).toBeInViewport({ ratio: 1 });
    const fullTarget = await target.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return [rect.top + 1, rect.bottom - 1].every((y) => node.contains(document.elementFromPoint(rect.x + rect.width / 2, y)));
    });
    expect(fullTarget).toBe(true);
  }
  await first.click();
  await expect(page.getByText("Type of leave: Sick leave")).toBeVisible();
  await page.getByRole("button", { name: "Close event details" }).click();
  await expect(page.locator(".df-event-detail-panel")).toHaveCount(0);
  await second.click();
  await expect(page.getByText("Type of leave: Annual leave")).toBeVisible();
});

test(`mobile week natively opens the cross-day event over ${label}`, async ({ page }) => {
  await page.clock.setFixedTime(new Date(instant));
  await page.goto("/?fixture=staff-calendar&calendar-span");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Today" }).click();
  const event = page.getByText(/Sample Staff · Sick leave/).first();
  await expect(event).toBeVisible();
  await event.click();
  await expect(page.getByText("Type of leave: Sick leave")).toBeVisible();
  await expect(page.getByText("Approved by: Sample Reviewer")).toBeVisible();
});
}
