import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { measureHomeBundle } from "../scripts/check-bundle-budget.mjs";

test("bundle gate follows emitted entry/runtime chunks, deduplicates and excludes unopened panels", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mam-bundle-contract-"));
  try {
    mkdirSync(path.join(root, "server/app"), { recursive: true });
    mkdirSync(path.join(root, "static/chunks"), { recursive: true });
    writeFileSync(path.join(root, "BUILD_ID"), "synthetic");
    writeFileSync(path.join(root, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/runtime.js", "static/chunks/shared.js"], polyfillFiles: [] }));
    writeFileSync(path.join(root, "server/app/page_client-reference-manifest.js"), 'globalThis.__RSC_MANIFEST["/page"] = ' + JSON.stringify({ clientModules: {
      "[project]/src/components/leave-demo.tsx": { chunks: ["123", "/_next/static/chunks/home.js", "4", "static/chunks/shared.js?dpl=synthetic"] },
      "[project]/src/components/team-calendar.tsx": { chunks: ["static/chunks/calendar.js"] },
    } }));
    for (const [file, content] of [["home.js", "home"], ["shared.js", "shared"], ["runtime.js", "runtime"], ["calendar.js", "large".repeat(1000)]]) {
      writeFileSync(path.join(root, "static/chunks", file), content);
    }
    const budget = { moduleSuffix: "/src/components/leave-demo.tsx", maxRawBytes: 100, maxGzipBytes: 1000 };
    const result = measureHomeBundle(root, budget);
    assert.equal(result.rawBytes, 17);
    assert.equal(result.chunks.length, 3);
    assert.equal(result.passed, true);
    assert.equal(measureHomeBundle(root, { ...budget, maxRawBytes: 16 }).passed, false);
    assert.throws(() => measureHomeBundle(root, { ...budget, moduleSuffix: "/missing.tsx" }), /Missing home/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
