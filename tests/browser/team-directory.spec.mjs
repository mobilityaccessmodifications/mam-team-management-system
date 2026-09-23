import { test, expect } from "@playwright/test";

test("employee directory displays server-scoped peers across reporting lines and resets preview", async ({ page }) => {
  await page.goto("/?fixture=team-directory");
  await expect(page.getByRole("button", { name: /Blair Peer/ })).toBeVisible();
  await page.getByRole("button", { name: /Blair Peer/ }).click();
  await expect(page.getByText("Jordan Manager", { exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("Blair");
  await expect(page.getByRole("button", { name: /Alex Employee/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Switch employee" }).click();
  await expect(page.getByRole("button", { name: /Other Peer/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Blair Peer/ })).toHaveCount(0);
});

test("directory failure does not expose fallback people and can retry", async ({ page }) => {
  await page.goto("/?fixture=team-directory&fail");
  await expect(page.getByRole("alert")).toContainText("Team employees could not be loaded.");
  await expect(page.getByRole("button", { name: /Blair Peer/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: /Blair Peer/ })).toBeVisible();
});
