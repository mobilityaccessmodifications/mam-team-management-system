import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDayflowDstPatch } from "../scripts/apply-dayflow-dst-patch.mjs";

const manifest = JSON.parse(readFileSync(new URL("../patches/dayflow-core-3.7.1-dst.json", import.meta.url), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
let original = readFileSync(new URL("../node_modules/@dayflow/core/dist/index.esm.js", import.meta.url), "utf8");
if (digest(original) === manifest.afterSHA256) {
  for (const edit of [...manifest.edits].reverse()) original = original.replace(edit.after, () => edit.before);
}
assert.equal(digest(original), manifest.beforeSHA256);

function fixture(callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "mam-dayflow-patch-"));
  try {
    mkdirSync(path.join(directory, "dist"));
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "@dayflow/core", version: "3.7.1" }));
    writeFileSync(path.join(directory, manifest.file), original);
    callback(directory, path.join(directory, manifest.file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("managed DayFlow patch produces only the exact reviewed bytes", () => fixture((directory, file) => {
  assert.equal(applyDayflowDstPatch(directory).changed, true);
  assert.equal(digest(readFileSync(file)), manifest.afterSHA256);
}));

test("managed DayFlow patch is idempotent without a second write", () => fixture((directory, file) => {
  applyDayflowDstPatch(directory);
  const before = readFileSync(file);
  assert.deepEqual(applyDayflowDstPatch(directory), { changed: false, sha256: manifest.afterSHA256 });
  assert.deepEqual(readFileSync(file), before);
}));

test("managed DayFlow patch rejects original byte drift without writing", () => fixture((directory, file) => {
  const drift = `${original}\n`;
  writeFileSync(file, drift);
  assert.throws(() => applyDayflowDstPatch(directory), /unrecognized original bytes/);
  assert.equal(readFileSync(file, "utf8"), drift);
}));

test("managed DayFlow patch rejects patched byte drift without writing", () => fixture((directory, file) => {
  applyDayflowDstPatch(directory);
  const drift = `${readFileSync(file, "utf8")}\n`;
  writeFileSync(file, drift);
  assert.throws(() => applyDayflowDstPatch(directory), /unrecognized original bytes/);
  assert.equal(readFileSync(file, "utf8"), drift);
}));

test("managed DayFlow patch rejects any different dependency version", () => fixture((directory, file) => {
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "@dayflow/core", version: "3.7.2" }));
  assert.throws(() => applyDayflowDstPatch(directory), /pinned @dayflow\/core 3.7.1/);
  assert.equal(readFileSync(file, "utf8"), original);
}));
