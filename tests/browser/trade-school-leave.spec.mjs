import { expect, test } from "@playwright/test";

for (const mode of ["self", "manager"]) {
  test(`trade school: ${mode} can request the eligible employee without a balance or notice gate`, async ({ page }) => {
    await page.goto(`/?fixture=trade-school${mode === "self" ? "&self" : ""}`);
    const type = page.getByRole("combobox", { name: /^Leave type/ });
    await expect(type.locator("option")).toContainText(["trade school"]);
    await expect(type).toHaveValue("trade school");
    await page.getByRole("button", { name: "Send request" }).click();
    const submission = JSON.parse(await page.getByTestId("trade-school-submission").textContent());
    expect(submission).toEqual({ personId: "97000000-0000-4000-8000-000000000001", leaveType: "trade school", startDate: "2026-10-12" });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
}

test("trade school: selecting another employee removes the option and preserves ordinary leave", async ({ page }) => {
  await page.goto("/?fixture=trade-school");
  await page.getByRole("combobox", { name: "Request leave for" }).selectOption("97000000-0000-4000-8000-000000000002");
  const type = page.getByRole("combobox", { name: /^Leave type/ });
  await expect(type.locator('option[value="trade school"]')).toHaveCount(0);
  await expect(type.locator("option")).toHaveText(["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave"]);
  await expect(type).toHaveValue("Unpaid leave");
  await page.getByRole("button", { name: "Send request" }).click();
  const submission = JSON.parse(await page.getByTestId("trade-school-submission").textContent());
  expect(submission.personId).toBe("97000000-0000-4000-8000-000000000002");
  expect(submission.leaveType).toBe("Unpaid leave");
});
