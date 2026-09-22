import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export function measureHomeBundle(buildDirectory, budget) {
  // Read the actual production bundler's emitted manifests; never substitute
  // a webpack build or sum every async chunk in .next/static.
  const root = path.resolve(buildDirectory);
  readFileSync(path.join(root, "BUILD_ID"), "utf8"); // Reject an absent/dev build.
  const build = JSON.parse(readFileSync(path.join(root, "build-manifest.json"), "utf8"));
  const context = { __RSC_MANIFEST: {} };
  vm.runInNewContext(readFileSync(path.join(root, "server/app/page_client-reference-manifest.js"), "utf8"), context, { timeout: 1000 });
  const manifest = context.__RSC_MANIFEST["/page"];
  assert.ok(manifest?.clientModules, "Missing /page client manifest; update the budget reader for this Next version");
  const entry = Object.entries(manifest.clientModules).find(([name]) => name.replaceAll("\\", "/").endsWith(budget.moduleSuffix));
  assert.ok(entry, `Missing home client boundary ${budget.moduleSuffix}`);
  const files = new Set();
  const add = (candidate) => {
    if (typeof candidate !== "string" || !/\.js(?:\?|$)/.test(candidate)) return;
    const file = decodeURIComponent(candidate.split("?")[0]).replace(/^\/_next\//, "");
    assert.ok(file.startsWith("static/") && !file.split("/").includes(".."), `Unexpected chunk path ${file}`);
    files.add(file);
  };
  entry[1].chunks.forEach(add); // Webpack has alternating IDs/paths; Turbopack paths.
  assert.ok(files.size, "Home entry has no synchronous JS chunks");
  assert.ok(Array.isArray(build.rootMainFiles) && build.rootMainFiles.length, "Missing root runtime files");
  build.rootMainFiles.forEach(add);
  (build.polyfillFiles ?? []).forEach(add);
  const chunks = [...files].sort().map((file) => {
    const bytes = readFileSync(path.join(root, file));
    return { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
  });
  const rawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0);
  const gzipBytes = chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
  return { scope: "Home client boundary + root runtime + polyfills (JS only)", rawBytes, gzipBytes, chunks,
    passed: rawBytes <= budget.maxRawBytes && gzipBytes <= budget.maxGzipBytes };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budget = JSON.parse(readFileSync(new URL("../tests/bundle-budget.json", import.meta.url), "utf8"));
  const result = measureHomeBundle(process.argv[2] ?? ".next", budget);
  console.log(JSON.stringify({ ...result, limits: budget }, null, 2));
  if (!result.passed) throw new Error("Home synchronous JS budget exceeded; inspect actual production chunks before changing limits");
}
