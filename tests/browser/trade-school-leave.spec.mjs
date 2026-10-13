import { expect, test } from "@playwright/test";

for (const mode of ["self", "manager"]) {
  test(`trade school: ${mode} can request the eligible employee without a balance or notice gate`, async ({ page }) => {
    await page.goto(`/?fixture=trade-school${mode === "self" ? "&self" : ""}`);
    const type = page.getByRole("combobox", { name: /^Leave type/ });
    await expect(type.locator("option")).toContainText(["trade school"]);
    await expect(type).toHaveValue("trade school");
    await page.getByRole("textbox", { name: /^Note/ }).fill("Synthetic employee note");
    await page.getByRole("button", { name: "Send request" }).click();
    const submission = JSON.parse(await page.getByTestId("trade-school-submission").textContent());
    expect(submission).toEqual({ personId: "97000000-0000-4000-8000-000000000001", leaveType: "trade school", startDate: "2026-10-12", employeeNote: "Synthetic employee note" });
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
  await page.getByRole("textbox", { name: /^Note/ }).fill("Synthetic employee note");
  await page.getByRole("button", { name: "Send request" }).click();
  const submission = JSON.parse(await page.getByTestId("trade-school-submission").textContent());
  expect(submission.personId).toBe("97000000-0000-4000-8000-000000000002");
  expect(submission.leaveType).toBe("Unpaid leave");
});

for (const width of [390, 1280]) {
  test(`leave note: default-open and native required-note focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?fixture=trade-school&self");
    const extras = page.locator("details").filter({ has: page.getByText("Note & files", { exact: true }) });
    const note = page.getByRole("textbox", { name: /^Note/ });
    await expect(extras).toHaveAttribute("open", "");
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("required", "");
    await expect(note).toHaveAttribute("maxlength", "2000");
    await expect(page.locator('input[name="attachments"]')).not.toHaveAttribute("required", "");
    await extras.locator("summary").click();
    await expect(note).toBeHidden();
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(extras).toHaveAttribute("open", "");
    await expect(note).toBeFocused();
    await expect(page.getByTestId("trade-school-submission")).toHaveText("Not submitted");
  });

  test(`leave note: whitespace rejection and multiline submission at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?fixture=trade-school");
    const note = page.getByRole("textbox", { name: /^Note/ });
    await note.fill(" \n\t\u00a0 ");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByRole("alert")).toHaveText("Add a note before submitting your leave request.");
    await expect(note).toBeFocused();
    await expect(page.getByTestId("trade-school-submission")).toHaveText("Not submitted");
    await note.fill("Synthetic first line\nSynthetic second line");
    await page.getByRole("button", { name: "Send request" }).click();
    const submission = JSON.parse(await page.getByTestId("trade-school-submission").textContent());
    expect(submission.employeeNote).toBe("Synthetic first line\nSynthetic second line");
  });
}
