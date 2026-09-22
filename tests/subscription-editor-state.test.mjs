import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(path) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", code)(exports);
  return exports;
}

const { subscriptionReviewWindow } = load("src/lib/subscription-review-date.ts");
const { subscriptionEditorSnapshot, unavailableSubscriptionMemberIds } = load("src/lib/subscription-editor-state.ts");

test("Melbourne due dates and calendar horizons survive DST, year/month ends and device zones", () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Australia/Melbourne"]) {
      process.env.TZ = timezone;
      for (const [instant, today, day30, day31] of [
        ["2026-09-21T23:00:00Z", "2026-09-22", "2026-10-22", "2026-10-23"],
        ["2026-10-03T23:00:00Z", "2026-10-04", "2026-11-03", "2026-11-04"],
        ["2026-04-04T23:00:00Z", "2026-04-05", "2026-05-05", "2026-05-06"],
        ["2026-01-30T13:00:00Z", "2026-01-31", "2026-03-02", "2026-03-03"],
        ["2026-12-30T13:00:00Z", "2026-12-31", "2027-01-30", "2027-01-31"],
      ]) {
        const now = new Date(instant);
        assert.equal(subscriptionReviewWindow(today, now), "due", `${timezone}: ${today}`);
        assert.equal(subscriptionReviewWindow(day30, now), "next30", `${timezone}: ${day30}`);
        assert.equal(subscriptionReviewWindow(day31, now), "later", `${timezone}: ${day31}`);
      }
      assert.equal(subscriptionReviewWindow("2026-09-22", new Date("2026-09-21T13:59:59Z")), "next30");
      assert.equal(subscriptionReviewWindow("2026-09-22", new Date("2026-09-21T14:00:00Z")), "due");
      assert.equal(subscriptionReviewWindow("2026-12-31", new Date("2026-12-30T12:59:59Z")), "next30");
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("retained membership becomes removable after archiving without extending candidate data", () => {
  const people = [{ personId: "active" }, { personId: "later-archived" }];
  const selected = ["active", "later-archived"];
  assert.deepEqual(unavailableSubscriptionMemberIds(people, selected), []);
  const activeOnly = people.filter((person) => person.personId !== "later-archived");
  assert.deepEqual(unavailableSubscriptionMemberIds(activeOnly, selected), ["later-archived"]);
  assert.deepEqual(unavailableSubscriptionMemberIds(activeOnly, ["active"]), []);
  assert.deepEqual(selected, ["active", "later-archived"], "discovery must not silently remove access");
});

test("review dirty snapshots cover form values and members while allowing exact reverts", () => {
  const form = new FormData();
  for (const [name, value] of Object.entries({ serviceName: "Synthetic", amount: "10.00", seatCount: "2", responsiblePersonId: "person-a", company: "mam", status: "active", creditCardUsed: "no" })) form.set(name, value);
  const initial = subscriptionEditorSnapshot(form, ["a", "b"]);
  for (const field of [...form.keys()]) {
    const value = form.get(field);
    form.set(field, "changed");
    assert.notEqual(subscriptionEditorSnapshot(form, ["a", "b"]), initial, field);
    form.set(field, value);
    assert.equal(subscriptionEditorSnapshot(form, ["a", "b"]), initial, `revert ${field}`);
  }
  assert.notEqual(subscriptionEditorSnapshot(form, ["a"]), initial);
  assert.equal(subscriptionEditorSnapshot(form, ["b", "a"]), initial);
});
