import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/analytics-api-management.tsx", "utf8");

test("Analytics API rotation reports rotation while saving", () => {
  assert.match(
    source,
    /saving \? rotating \? "Rotating…" : "Generating…" : rotating \? "Rotate key" : "Generate key"/,
  );
});
