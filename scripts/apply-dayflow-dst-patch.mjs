import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../patches/dayflow-core-3.7.1-dst.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function applyDayflowDstPatch(packageDirectory = path.join(root, "node_modules/@dayflow/core")) {
  const pkg = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  if (pkg.name !== "@dayflow/core" || pkg.version !== "3.7.1" || manifest.package !== pkg.name || manifest.version !== pkg.version || manifest.file !== "dist/index.esm.js") {
    throw new Error("DayFlow DST patch requires the pinned @dayflow/core 3.7.1 package");
  }
  const filename = path.join(packageDirectory, manifest.file);
  const original = readFileSync(filename);
  if (sha256(original) === manifest.afterSHA256) return { changed: false, sha256: manifest.afterSHA256 };
  if (sha256(original) !== manifest.beforeSHA256) throw new Error("DayFlow DST patch rejected unrecognized original bytes");
  let patched = original.toString("utf8");
  for (const edit of manifest.edits) {
    if (!edit.before || patched.split(edit.before).length !== 2) throw new Error("DayFlow DST patch requires one exact original match per edit");
    patched = patched.replace(edit.before, () => edit.after);
  }
  if (sha256(patched) !== manifest.afterSHA256) throw new Error("DayFlow DST patch rejected unexpected resulting bytes");
  writeFileSync(filename, patched);
  if (sha256(readFileSync(filename)) !== manifest.afterSHA256) throw new Error("DayFlow DST patch write verification failed");
  return { changed: true, sha256: manifest.afterSHA256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = applyDayflowDstPatch();
  console.log(`DayFlow DST patch ${result.changed ? "applied" : "verified"}: ${result.sha256}`);
}
