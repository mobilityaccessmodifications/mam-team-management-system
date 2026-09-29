import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const browserErrors = new WeakMap();
test.beforeEach(async ({ context, page, baseURL }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

test("resource behaviors: focus, picker, inactive members, dirty review and credential expiry", async ({ page, context }) => {
  // Reuse the same real-component suite used for visible Ego browser checks.
  const fixture = path.join(process.env.MAM_BROWSER_SOURCE_ROOT, "tests/resources-browser.mjs");
  const { installResourcesFixture, runResourcesRegressions } = await import(pathToFileURL(fixture).href);
  const session = await context.newCDPSession(page);
  const adapter = new Proxy(page, { get(target, key) {
    if (key === "cdp") return (method, params) => session.send(method, params);
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await installResourcesFixture(adapter);
  const passed = await runResourcesRegressions(adapter);
  expect(passed).toHaveLength(5);
  console.log(passed.join("\n"));
});

for (const width of [390, 1440]) {
  for (const partial of [false, true]) {
    test(`calendar authorised duration is visible at ${width}px (${partial ? "part day" : "multi day"})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/?mode=calendar${partial ? "&partial=1" : ""}`);
      await expect(page.getByText("Synthetic Employee (archived)")).toBeVisible();
      await expect(page.getByText(partial ? /3\s*(hours|hrs)/i : /22\.8\s*(hours|hrs)/i)).toBeVisible();
    });
  }
}

test("staff Calendar renders approved and pending types, details and working type filters", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?fixture=staff-calendar");
  await expect(page.getByRole("group", { name: "Leave colour key" })).toContainText("Sick leave");
  await expect(page.getByRole("group", { name: "Leave colour key" })).toContainText("Approved – pending leave balance");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByText(/Sample Staff · Sick leave/).first()).toBeVisible();
  await expect(page.getByText(/Other Staff · Annual leave \(Pending\)/).first()).toBeVisible();
  const eventColour = async (label) => page.getByText(label).first().evaluate((node) => getComputedStyle(node.closest(".df-event")).backgroundColor);
  expect(await eventColour(/Sample Staff · Sick leave/)).toBe("rgb(255, 240, 228)");
  expect(await eventColour(/Other Staff · Annual leave \(Pending\)/)).toBe("rgb(229, 239, 255)");
  await page.getByText(/Sample Staff · Sick leave/).first().evaluate((node) => node.click());
  await expect(page.getByText("Type of leave: Sick leave")).toBeVisible();
  await expect(page.getByText(/Documents uploaded:/)).toHaveCount(0);
  await expect(page.getByText("Approved by: Sample Reviewer")).toBeVisible();
  await expect(page.getByRole("link", { name: "sample.pdf" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close event details" }).click();
  await page.getByText("Filters", { exact: true }).click();
  await page.getByRole("group", { name: "Leave by type" }).getByLabel("Sick leave").uncheck();
  await expect(page.getByText(/Sample Staff · Sick leave/)).toHaveCount(0);
  await expect(page.getByText(/Other Staff · Annual leave \(Pending\)/).first()).toBeVisible();
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.getByText(/Sample Staff · Sick leave/).first()).toBeVisible();
  await page.getByText("Filters", { exact: true }).click();
  await page.getByRole("group", { name: "Events" }).getByLabel("Pending leave", { exact: true }).uncheck();
  await expect(page.getByText(/Other Staff · Annual leave \(Pending\)/)).toHaveCount(0);
  await expect(page.getByText(/Sample Staff · Sick leave/).first()).toBeVisible();
});

test("pending leave details remain readable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?fixture=staff-calendar");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByText(/Other Staff · Annual leave \(Pending\)/).first()).toBeVisible();
  await page.getByText(/Other Staff · Annual leave \(Pending\)/).first().click();
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible();
  await expect(page.getByText("Type of leave: Annual leave")).toBeVisible();
  await expect(page.getByText("Status: Pending")).toBeVisible();
  await expect(page.getByText("Requested: 2 Sept 2026")).toBeVisible();
  await expect(page.getByText("Approved by: Awaiting approval")).toBeVisible();
  await expect(page.getByText(/Documents uploaded:/)).toHaveCount(0);
  await page.getByRole("dialog", { name: "Event details" }).getByRole("button", { name: "Close event details" }).click();
  await page.getByText(/Sample Staff · Sick leave/).first().click();
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible();
  await expect(page.getByText(/Documents uploaded:/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "sample.pdf" })).toHaveCount(0);
});

test("staff month view preserves the visible date and other leave types when filtered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?fixture=staff-calendar");
  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByText(/Other Staff · Annual leave \(Pending\)/).first()).toBeVisible();
  await page.getByText("Filters", { exact: true }).click();
  await page.getByRole("group", { name: "Leave by type" }).getByLabel("Sick leave").uncheck();
  await expect(page.getByText(/Sample Staff · Sick leave/)).toHaveCount(0);
  await expect(page.getByText(/Other Staff · Annual leave \(Pending\)/).first()).toBeVisible();
});

test("Filters stays clickable over the calendar more control", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?fixture=staff-calendar&crowded=1");
  await page.getByRole("button", { name: "Today" }).click();
  const more = page.locator(".df-month-day-cell-more-events").first();
  await expect(more).toBeVisible();
  await page.getByText("Filters", { exact: true }).click();
  const panel = page.getByRole("group", { name: "Leave by type" }).locator("..").locator("..");
  const moreBox = await more.boundingBox();
  const panelBox = await panel.boundingBox();
  const x = Math.max(moreBox.x, panelBox.x) + 10;
  const y = moreBox.y + moreBox.height / 2;
  expect(x).toBeLessThan(Math.min(moreBox.x + moreBox.width, panelBox.x + panelBox.width));
  expect(y).toBeGreaterThan(panelBox.y);
  expect(y).toBeLessThan(panelBox.y + panelBox.height);
  expect(await panel.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), { x, y })).toBe(true);
  const sick = page.getByRole("group", { name: "Leave by type" }).getByLabel("Sick leave");
  await sick.scrollIntoViewIfNeeded();
  await sick.uncheck({ timeout: 3000 });
  await expect(sick).not.toBeChecked();
});

for (const width of [390, 760, 768, 900, 1024, 1440]) {
  test(`calendar Filters panel stays above the month grid at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?fixture=staff-calendar");
    await page.getByText("Filters", { exact: true }).click();
    const summary = page.locator("details > summary").filter({ hasText: "Filters" });
    const panel = page.getByRole("group", { name: "Leave by type" }).locator("..", { has: page.getByLabel("Sick leave") }).locator("..");
    const summaryBox = await summary.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(panelBox.y, "Filters panel should open below its trigger").toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height);
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width);
    const sick = page.getByRole("group", { name: "Leave by type" }).getByLabel("Sick leave");
    await expect(sick).toBeVisible();
    await sick.scrollIntoViewIfNeeded();
    const hit = await sick.evaluate((input) => {
      const box = input.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { hit: top === input || input.parentElement?.contains(top), blocker: top?.className || top?.tagName };
    });
    expect(hit.hit, `Filter checkbox covered by ${hit.blocker}`).toBe(true);
    await sick.uncheck();
    await expect(page.getByText(/Sample Staff · Sick leave/)).toHaveCount(0);
  });
}

test("employee calendar keeps generic leave and no staff-only details or legend", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?fixture=employee-calendar");
  await expect(page.getByRole("group", { name: "Leave colour key" })).toHaveCount(0);
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByText(/Other Staff · Approved leave/).first()).toBeVisible();
  await page.getByText(/Other Staff · Approved leave/).first().evaluate((node) => node.click());
  await expect(page.getByText("Documents uploaded: 1")).toHaveCount(0);
  await expect(page.getByText("Approved by: Sample Reviewer")).toHaveCount(0);
  await page.getByText("Filters", { exact: true }).click();
  await expect(page.getByRole("group", { name: "Leave by type" })).toHaveCount(0);
});
