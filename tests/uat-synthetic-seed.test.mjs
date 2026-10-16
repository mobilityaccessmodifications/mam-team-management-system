import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const suite = fileURLToPath(new URL("./uat-synthetic-seed.test.py", import.meta.url));

test("synthetic seed portable closed-metadata CLI contract", () => {
  const result = spawnSync("python3", ["-B", suite], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summaries = [...result.stderr.matchAll(/^Ran (\d+) tests? in .+$/gm)];
  assert.equal(summaries.length, 1);
  assert.equal(Number(summaries[0][1]), 5);
  assert.match(result.stderr, /^OK$/m);
});
