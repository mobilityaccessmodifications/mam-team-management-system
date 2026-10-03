import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ context, baseURL }) => {
  await context.route("**/*", (route) => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  await context.routeWebSocket(/.*/, (socket) => socket.close());
});

for (const opening of ["programmatic", "pointer"]) {
  test(`desktop calendar fully closes Saturday details after ${opening} opening`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-10-03T03:01:41Z"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=staff-calendar");
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await page.getByRole("button", { name: "Today" }).click();
    const event = page.getByText(/Sample Staff · Sick leave/).first();
    await expect(event).toBeVisible();
    if (opening === "programmatic") await event.evaluate((node) => node.click());
    else await event.click();
    await expect(page.getByText("Type of leave: Sick leave")).toBeVisible();
    await expect(page.getByText("Approved by: Sample Reviewer")).toBeVisible();
    const close = page.getByRole("button", { name: "Close event details" });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(page.locator(".df-event-detail-panel")).toHaveCount(0);
    await expect(close).toHaveCount(0);
    await expect(event).toBeVisible();
    expect(errors).toEqual([]);
  });
}
