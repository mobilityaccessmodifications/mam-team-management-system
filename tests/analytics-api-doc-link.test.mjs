import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Analytics API management links to the in-app API guide", () => {
  const source = readFileSync("src/components/analytics-api-management.tsx", "utf8");
  assert.match(source, /href="\/analytics-api-docs"/);
  assert.match(source, /API documentation/);
});

test("both API guides document the full analytics response contract", () => {
  const page = readFileSync("src/app/analytics-api-docs/page.tsx", "utf8");
  const markdown = readFileSync("docs/analytics-api.md", "utf8");
  const fields = [
    "api_version", "generated_at", "pagination", "analytics_unavailable",
    "invalid_dataset", "invalid_date_range", "invalid_pagination",
    "headcount.active", "headcount.archived", "headcount.mam_active", "headcount.equipsy_active",
    "leave.requests", "leave.submitted", "leave.approved", "leave.declined", "leave.cancelled", "leave.business_days", "leave.hours",
    "check_ins.total", "check_ins.scheduled", "check_ins.needs_review", "check_ins.completed", "check_ins.delivered",
    "assets.total", "assets.assigned", "assets.available", "assets.repair", "assets.retired",
    "subscriptions.total", "subscriptions.active", "subscriptions.paused", "subscriptions.cancelled", "subscriptions.monthly_cost_aud",
    "employee_id", "first_name", "last_name", "company", "position_title", "employment_status", "started_on", "record_created_at", "record_updated_at",
    "scheduled_employment_end_date", "team", "employment_type", "contract_type", "working_weekdays", "working_day_times",
    "request_id", "start_date", "end_date", "business_days", "hours", "status", "submitted_at", "decided_at", "updated_at",
    "event_id", "event_type", "occurred_at", "reminder_id", "milestone", "sequence", "due_date", "notify_date", "needs_review_reason", "attempt_count", "delivered_at", "completed_at",
    "error_code", "custody_id", "asset_id", "asset_code", "asset_type", "asset_status", "assigned_on", "returned_on", "recorded_at",
    "subscription_id", "subscription_code", "service_name", "plan_name", "pricing_model", "billing_cycle", "amount_cents", "currency", "renewal_date", "next_review_on", "responsible_employee_id", "member_count", "changed_fields",
  ];
  for (const source of [page, markdown]) {
    for (const field of fields) {
      assert.ok(source.includes(field), `API guide is missing ${field}`);
    }
  }
});

test("the in-app API guide documents auth, datasets, parameters and pagination", () => {
  const source = readFileSync("src/app/analytics-api-docs/page.tsx", "utf8");
  for (const text of ["Authorization: " + "Bearer", "overview", "employees", "leave_requests", "check_ins", "asset_custody", "subscriptions", "from", "to", "limit", "offset"]) {
    assert.ok(source.includes(text), `API guide is missing ${text}`);
  }
});
