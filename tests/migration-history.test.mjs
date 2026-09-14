import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const migrationsDirectory = path.resolve("supabase/migrations");
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

test("versioned migrations use unique versions", () => {
  const byVersion = new Map();

  for (const fileName of migrationFiles) {
    const match = /^(\d{14})_/.exec(fileName);
    assert.ok(match, `${fileName} must start with a 14-digit migration version`);

    const version = match[1];
    const duplicate = byVersion.get(version);

    assert.equal(
      duplicate,
      undefined,
      `${fileName} reuses version ${version} from ${duplicate}; Supabase records one migration per version`,
    );
    byVersion.set(version, fileName);
  }
});

test("versioned migrations do not contain duplicate SQL bodies", () => {
  const byDigest = new Map();

  for (const fileName of migrationFiles) {
    const body = readFileSync(path.join(migrationsDirectory, fileName), "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    const duplicate = byDigest.get(digest);

    assert.equal(
      duplicate,
      undefined,
      `${fileName} duplicates ${duplicate}; a clean database would apply both versions`,
    );
    byDigest.set(digest, fileName);
  }
});
