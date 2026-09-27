import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Analytics API management links to the in-app API guide", () => {
  const source = readFileSync("src/components/analytics-api-management.tsx", "utf8");
  assert.match(source, /href="\/analytics-api-docs"/);
  assert.match(source, /API documentation/);
});

test("the in-app API guide documents auth, datasets, parameters and pagination", () => {
  const source = readFileSync("src/app/analytics-api-docs/page.tsx", "utf8");
  for (const text of ["Authorization: " + "Bearer", "overview", "employees", "leave_requests", "check_ins", "asset_custody", "subscriptions", "from", "to", "limit", "offset"]) {
    assert.ok(source.includes(text), `API guide is missing ${text}`);
  }
});
