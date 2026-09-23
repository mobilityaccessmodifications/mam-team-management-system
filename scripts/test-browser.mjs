import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// This harness does not start Next or read a .env. Production components are
// compiled unchanged; only server-action boundaries receive synthetic data.
const sourceRoot = realpathSync(process.argv[2] ?? process.cwd());
const scratch = mkdtempSync(path.join(tmpdir(), "mam-browser-test-"));
const server = createServer((request, response) => {
  const name = request.url === "/fixture.js" ? "fixture.js" : request.url === "/fixture.css" ? "fixture.css" : null;
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  response.setHeader("Content-Type", name?.endsWith(".js") ? "text/javascript" : name ? "text/css" : "text/html");
  response.end(name ? readFileSync(path.join(scratch, name)) : '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic component tests</title><link rel="stylesheet" href="/fixture.css"><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
try {
  await build({
    entryPoints: ["tests/browser/fixture.jsx"], bundle: true, outdir: scratch,
    platform: "browser", jsx: "automatic", sourcemap: false, minify: false,
    alias: { "@/app/people/team-directory-actions": path.join(sourceRoot, "tests/browser/team-directory-actions.jsx"), "@": path.join(sourceRoot, "src"), react: path.resolve("node_modules/react"), "react-dom": path.resolve("node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "test-presentation-exports", setup(builder) {
      // Test-only exports of existing local presentation functions; no copied UI.
      builder.onLoad({ filter: /[/\\]team-calendar\.tsx$/ }, ({ path: filename }) => ({
        contents: readFileSync(filename, "utf8") + "\nexport { buildEvents as fixtureBuildEvents, EventDetail as FixtureEventDetail };",
        loader: "tsx", resolveDir: path.dirname(filename),
      }));
    } }],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=tests/browser/playwright.config.mjs", ...process.argv.slice(3)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CI: process.env.CI ?? "", PLAYWRIGHT_BROWSERS_PATH: path.resolve("node_modules/.cache/ms-playwright"),
      MAM_BROWSER_SOURCE_ROOT: sourceRoot,
      MAM_BROWSER_ORIGIN: `http://127.0.0.1:${address.port}`, MAM_BROWSER_RESULTS: path.join(scratch, "results") },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  process.exitCode = code ?? 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
