import { test, expect } from "@playwright/test";

test("required manager uses a selected identity, supports search and controlled record changes", async ({ page }) => {
  await page.goto("/?fixture=employee-picker");
  const input = page.getByRole("combobox", { name: "Reports to" });
  await input.fill("not a real person");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Saved manager")).toHaveText("");
  expect(await input.evaluate((element) => element.checkValidity())).toBe(false);
  await input.fill("minor");
  await expect(page.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Saved manager")).toHaveText("person-a");
  await input.fill("no match");
  await input.press("Escape");
  await expect(input).toHaveValue("Alex Example");
  await page.getByRole("button", { name: "Load another record" }).click();
  await expect(input).toHaveValue("Blair Example");
});

test("optional manager can be cleared without submitting arbitrary search text", async ({ page }) => {
  await page.goto("/?fixture=employee-picker&optional");
  const input = page.getByRole("combobox", { name: "Reports to" });
  await input.fill("blair");
  await page.getByRole("option").click();
  await input.click();
  await page.getByRole("button", { name: "Clear employee selection" }).click();
  await input.press("Escape");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Saved manager")).toHaveText("none");
});
