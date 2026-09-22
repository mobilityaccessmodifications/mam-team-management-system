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
