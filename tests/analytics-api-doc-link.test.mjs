import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Analytics API management links to the in-app API guide", () => {
  const source = readFileSync("src/components/analytics-api-management.tsx", "utf8");
  assert.match(source, /href="\/analytics-api-docs"/);
  assert.match(source, /API documentation/);
});

test("both API guides document the employee name fields", () => {
  const page = readFileSync("src/app/analytics-api-docs/page.tsx", "utf8");
  const markdown = readFileSync("docs/analytics-api.md", "utf8");
  for (const source of [page, markdown]) {
    assert.ok(source.includes("first_name"));
    assert.ok(source.includes("last_name"));
  }
});

test("the in-app API guide documents auth, datasets, parameters and pagination", () => {
  const source = readFileSync("src/app/analytics-api-docs/page.tsx", "utf8");
  for (const text of ["Authorization: " + "Bearer", "overview", "employees", "leave_requests", "check_ins", "asset_custody", "subscriptions", "from", "to", "limit", "offset"]) {
    assert.ok(source.includes(text), `API guide is missing ${text}`);
  }
});
