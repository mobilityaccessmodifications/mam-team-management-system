import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import postcssConfig from "../postcss.config.mjs";
import { draft, personId, loadActions } from "../tests/helpers/directory-action-harness.mjs";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildUnifiedRoleFixture } from "../tests/browser/unified-role-build.mjs";
import { applyDayflowDstPatch } from "./apply-dayflow-dst-patch.mjs";
import { reviewActionHarness, deliveryId, updatedAt, rowFixture } from "../tests/helpers/onboarding-review-action-harness.mjs";

// This harness does not start Next or read a .env. Production components are
// compiled unchanged; only server-action boundaries receive synthetic data.
const sourceRoot = realpathSync(process.argv[2] ?? process.cwd());
applyDayflowDstPatch(path.join(sourceRoot, "node_modules/@dayflow/core"));
const onboardingReviewResults = {};
for (const [name, options] of Object.entries({
  success: {}, committed: { revalidateError: true }, stale: { dbError: { code: "55000", message: "synthetic private detail" } },
  unknown: { transportError: new Error("synthetic private provider") },
})) onboardingReviewResults[name] = await reviewActionHarness({ ...options, sourceRoot }).actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt });
for (const [name, rows] of Object.entries({ list: [rowFixture], empty: [], refreshed: [{ ...rowFixture, updated_at: "2026-10-01T05:00:00.987654+00:00" }] })) {
  onboardingReviewResults[name] = await reviewActionHarness({ rows, sourceRoot }).actions.listOnboardingCredentialReviews();
  if (!onboardingReviewResults[name].ok) throw new Error("Canonical onboarding review fixture rejected");
}
const directoryInput = { ...draft, personId, personVersion: 1, detailVersion: 1 };
const directoryResults = {};
for (const [name, dbError] of Object.entries({
  lock: { code: "55000", message: "Onboarding credential delivery in progress" },
  stale: { code: "40001", message: "synthetic private detail" },
  unknown: { code: "XX000", message: "synthetic private provider detail" },
})) directoryResults[name] = await loadActions({ dbError, sourceRoot }).actions.updateEmployeeDirectoryRecord(directoryInput);
directoryResults.role = await loadActions({ dbError: { code: "40001" }, sourceRoot }).actions.updateEmployeeDirectoryRole({ personId, role: "manager", expectedRole: "employee" });
directoryResults.auth = await loadActions({ authError: new Error("Your session has expired. Sign in again."), sourceRoot }).actions.updateEmployeeDirectoryRecord(directoryInput);
directoryResults.validation = await loadActions({ sourceRoot }).actions.updateEmployeeDirectoryRecord({ ...directoryInput, workEmail: "invalid" });
directoryResults.create = await loadActions({ dbError: { code: "55000", message: "Onboarding credential delivery in progress" }, sourceRoot }).actions.createEmployeeDirectoryRecord(draft);

directoryResults.partialRole = await loadActions({ revalidateError: new Error("private fixture revalidation failure"), sourceRoot }).actions.updateEmployeeDirectoryRole({ personId, role: "manager", expectedRole: "employee" });
directoryResults.partialCreate = await loadActions({ readErrorAt: 1, sourceRoot }).actions.createEmployeeDirectoryRecord(draft);
directoryResults.partialUpdate = await loadActions({ readErrorAt: 2, sourceRoot }).actions.updateEmployeeDirectoryRecord(directoryInput);
directoryResults.roleSuccess = {};
for (const role of ["employee", "manager", "account", "admin"]) {
  directoryResults.roleSuccess[role] = await loadActions({ sourceRoot }).actions.updateEmployeeDirectoryRole({
    personId, role, expectedRole: role === "employee" ? "manager" : "employee",
  });
}

const scratch = mkdtempSync(path.join(tmpdir(), "mam-browser-test-"));
const server = createServer((request, response) => {
  const name = /^\/(?:fixture|unified-role-fixture)\.(?:js|css)$/.test(request.url ?? "") ? request.url.slice(1) : null;
  const fixture = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("fixture") === "unified-roles" ? "unified-role-fixture" : "fixture";
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  response.setHeader("Content-Type", name?.endsWith(".js") ? "text/javascript" : name ? "text/css" : "text/html");
  response.end(name ? readFileSync(path.join(scratch, name)) : `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic component tests</title><link rel="stylesheet" href="/${fixture}.css"><body><div id="root"></div><script src="/${fixture}.js"></script></body></html>`);
});
try {
  await build({
    entryPoints: ["tests/browser/fixture.jsx"], bundle: true, outdir: scratch,
    platform: "browser", jsx: "automatic", sourcemap: false, minify: false,
    alias: { "@/app/leave/actions": path.join(sourceRoot, "tests/browser/payroll-display-actions.jsx"), "@/app/people/actions": path.join(sourceRoot, "tests/browser/directory-actions.jsx"), "@/components/employee-device-assignments": path.join(sourceRoot, "tests/browser/directory-fixture.jsx"), "@/app/people/team-directory-actions": path.join(sourceRoot, "tests/browser/team-directory-actions.jsx"), "@": path.join(sourceRoot, "src"), react: path.resolve("node_modules/react"), "react-dom": path.resolve("node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', DIRECTORY_FIXTURE_RESULTS: JSON.stringify(directoryResults), ONBOARDING_REVIEW_RESULTS: JSON.stringify(onboardingReviewResults) },
    plugins: [{ name: "onboarding-review-action-boundary", setup(builder) {
      builder.onResolve({ filter: /^\.\/actions$/ }, ({ importer }) => {
        if (/[/\\]src[/\\]app[/\\]onboarding-review[/\\]review-list\.tsx$/.test(importer)) return { path: path.join(sourceRoot, "tests/browser/onboarding-review-actions.mjs") };
      });
    } }, { name: "production-global-styles", setup(builder) {
      // Use the real global source and existing PostCSS configuration, not a
      // copied portal rule or a stale Next build artifact.
      builder.onLoad({ filter: /[/\\]src[/\\]app[/\\]globals\.css$/ }, async ({ path: filename }) => {
        const result = await postcss([tailwindcss({ ...postcssConfig.plugins["@tailwindcss/postcss"], base: sourceRoot })])
          .process(readFileSync(filename, "utf8"), { from: filename, map: false });
        return { contents: result.css, loader: "css", resolveDir: path.dirname(filename) };
      });
    } }, { name: "test-presentation-exports", setup(builder) {
      // Test-only exports of existing local presentation functions; no copied UI.
      builder.onLoad({ filter: /[/\\]team-calendar\.tsx$/ }, ({ path: filename }) => ({
        contents: readFileSync(filename, "utf8") + "\nexport { buildEvents as fixtureBuildEvents, EventDetail as FixtureEventDetail };",
        loader: "tsx", resolveDir: path.dirname(filename),
      }));
    } }],
  });
  await buildUnifiedRoleFixture(sourceRoot, scratch);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=tests/browser/playwright.config.mjs", ...process.argv.slice(3)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CI: process.env.CI ?? "", PLAYWRIGHT_BROWSERS_PATH: path.resolve("node_modules/.cache/ms-playwright"),
      MAM_BROWSER_SOURCE_ROOT: sourceRoot,
      MAM_BROWSER_ORIGIN: `http://127.0.0.1:${address.port}`, MAM_BROWSER_RESULTS: path.join(scratch, "results") },
    stdio: "inherit", timeout: 180_000, killSignal: "SIGTERM",
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  process.exitCode = code ?? 1;
  if (process.exitCode === 0) {
    const contact = spawn(process.execPath, ["tests/browser/contact-lifetime-runner.mjs", ...process.argv.slice(3)], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, MAM_BROWSER_SOURCE_ROOT: sourceRoot },
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve, reject) => { contact.on("error", reject); contact.on("exit", resolve); }) ?? 1;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
