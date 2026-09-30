import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1000 } });
const wrap = (page, id) => page.locator(`[data-node-id="${id}"]`);
const card = (page, id) => wrap(page, id).locator("button").first();
async function arrange(page, outcome = "lock") {
  await page.goto(`/?fixture=organisation&outcome=${outcome}`);
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(wrap(page, "starter")).toHaveAttribute("data-arrange", "true");
}
async function drop(page, sourceId = "starter", targetId = "manager", intent = "below") {
  const source = await card(page, sourceId).boundingBox();
  const target = await card(page, targetId).boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await card(page, sourceId).focus();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, intent === "above" ? target.y - 18 : target.y + target.height + 18, { steps: 8 });
  await page.mouse.up();
}

test("organisation protected drop restores the card and provides a keyboard-accessible explanation without retry", async ({ page }) => {
  await arrange(page);
  const before = await wrap(page, "starter").evaluate(element => element.style.transform);
  await drop(page);
  const dialog = page.getByRole("dialog", { name: "Connection not saved" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("account-credential email is being processed or needs administrator review");
  await expect(dialog).toContainText("The card has returned to its previous position. No reporting relationship was changed.");
  await expect(wrap(page, "starter")).toHaveAttribute("data-manual", "false");
  expect(await wrap(page, "starter").evaluate(element => element.style.transform)).toBe(before);
  await expect(dialog.getByRole("button", { name: "Got it" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Got it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card(page, "starter")).toBeFocused();
  expect(await page.evaluate(() => window.organisationCalls.length)).toBe(1);
  await expect(page.getByRole("button", { name: "Undo last reporting-line change" })).toBeDisabled();
});

test("organisation protected manager assignment restores the dragged card even when the target was being edited", async ({ page }) => {
  await arrange(page);
  await drop(page, "starter", "manager", "above");
  const dialog = page.getByRole("dialog", { name: "Connection not saved" });
  await expect(dialog).toBeVisible();
  await expect(wrap(page, "starter")).toHaveAttribute("data-manual", "false");
  expect(await page.evaluate(() => window.organisationCalls[0].id)).toBe("manager");
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.organisationCalls.length)).toBe(1);
});

test("organisation ordinary errors give their own reason and successful drops keep existing save/undo behavior", async ({ page }) => {
  await arrange(page, "other");
  await drop(page);
  await expect(page.getByText("This org node changed since it was opened. Refresh and try again.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Connection not saved" })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText("protection lock");
  await expect(wrap(page, "starter")).toHaveAttribute("data-manual", "false");
  await arrange(page, "success");
  await drop(page);
  await expect(page.getByRole("button", { name: "Undo last reporting-line change" })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.organisationCalls[0].draft.reportsTo)).toBe("manager");
});
