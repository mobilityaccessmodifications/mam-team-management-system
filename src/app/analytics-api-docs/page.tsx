import Link from "next/link";

import styles from "./page.module.css";

const datasets = [
  {
    name: "overview",
    shape: "Object",
    description: "One nested current-state summary. Date filters affect leave and check-in totals only; headcount, assets and subscriptions are not date-filtered.",
    dateRange: "Leave requests overlapping the range; check-ins by due_date.",
    fields: [
      ["headcount.active", "integer", "Active employee records."],
      ["headcount.archived", "integer", "Archived employee records."],
      ["headcount.mam_active", "integer", "Active MAM employee records."],
      ["headcount.equipsy_active", "integer", "Active Equipsy employee records."],
      ["leave.requests", "integer", "Overlapping requests."],
      ["leave.submitted", "integer", "Overlapping requests with submitted status."],
      ["leave.approved", "integer", "Overlapping approved requests."],
      ["leave.declined", "integer", "Overlapping rejected or declined requests."],
      ["leave.cancelled", "integer", "Overlapping cancelled requests."],
      ["leave.business_days", "number", "Sum of business days for overlapping requests."],
      ["leave.hours", "number", "Sum of hours for overlapping requests."],
      ["check_ins.total", "integer", "Check-ins due in the range."],
      ["check_ins.scheduled", "integer", "Due check-ins with scheduled status."],
      ["check_ins.needs_review", "integer", "Due check-ins held for review."],
      ["check_ins.completed", "integer", "Due check-ins completed."],
      ["check_ins.delivered", "integer", "Due check-ins delivered."],
      ["assets.total", "integer", "Current asset count."],
      ["assets.assigned", "integer", "Current assigned assets."],
      ["assets.available", "integer", "Current available assets."],
      ["assets.repair", "integer", "Current assets marked for repair."],
      ["assets.retired", "integer", "Current retired assets."],
      ["subscriptions.total", "integer", "Current subscription count."],
      ["subscriptions.active", "integer", "Current active subscriptions."],
      ["subscriptions.paused", "integer", "Current paused subscriptions."],
      ["subscriptions.cancelled", "integer", "Current cancelled subscriptions."],
      ["subscriptions.monthly_cost_aud", "number", "Monthly-equivalent AUD cost for paid active and paused subscriptions."],
    ],
  },
  {
    name: "employees",
    shape: "Array<Object>",
    description: "Directory facts for current and archived employees. Name, team, employment and schedule fields use private HR projections; nullable source fields stay null and unrecorded daily times are an empty array. No contact fields are returned.",
    dateRange: "record_created_at calendar date, not started_on.",
    fields: [
      ["employee_id", "UUID", "Stable directory person identifier."],
      ["first_name", "string | null", "First name, null when not stored."],
      ["last_name", "string | null", "Last name, null when not stored."],
      ["team", "string | null", "HR team label, null when not stored."],
      ["scheduled_employment_end_date", "date | null", "Scheduled employment end date, null when not recorded."],
      ["employment_type", "string | null", "Employment arrangement: abn, casual, full_time or part_time, when recorded."],
      ["contract_type", "string | null", "HR check-in classification: permanent or fixed_term; null when unset."],
      ["working_weekdays", "integer[] | null", "ISO weekdays 1=Monday through 7=Sunday; null when not recorded."],
      ["working_day_times", "object[]", "Optional weekday/start_time/end_time intervals; [] when exact hours are not recorded."],
      ["company", "string", "Company key, such as mam or equipsy."],
      ["position_title", "string | null", "Directory position title."],
      ["employment_status", "string", "active or archived."],
      ["started_on", "date | null", "Recorded start date."],
      ["record_created_at", "timestamp", "Directory record creation time."],
      ["record_updated_at", "timestamp", "Directory record last-update time."],
    ],
  },
  {
    name: "leave_requests",
    shape: "Array<Object>",
    description: "Durable leave request facts. Category, reason, notes, evidence and email addresses are excluded. Unmatched employee_id is null and company is unknown.",
    dateRange: "Request start_date/end_date interval overlaps the range.",
    fields: [
      ["request_id", "UUID", "Request identifier."],
      ["employee_id", "UUID | null", "Matched directory person identifier."],
      ["company", "string", "Company key, or unknown when no person is matched."],
      ["start_date", "date", "First requested date."],
      ["end_date", "date", "Last requested date."],
      ["business_days", "number", "Recorded business-day duration."],
      ["hours", "number", "Recorded duration in hours."],
      ["status", "string", "Current request status."],
      ["submitted_at", "timestamp", "Submission time."],
      ["decided_at", "timestamp | null", "Decision time, if decided."],
      ["created_at", "timestamp", "Record creation time."],
      ["updated_at", "timestamp", "Record last-update time."],
    ],
  },
  {
    name: "leave_events",
    shape: "Array<Object>",
    description: "Leave workflow event history without leave reasons or notes.",
    dateRange: "occurred_at calendar date.",
    fields: [
      ["event_id", "UUID", "Event identifier."],
      ["request_id", "UUID", "Related request identifier."],
      ["event_type", "string", "Recorded event type."],
      ["occurred_at", "timestamp", "Event creation time."],
    ],
  },
  {
    name: "check_ins",
    shape: "Array<Object>",
    description: "Check-in schedule and delivery state, including an operational review-hold reason; no employee names or contact details.",
    dateRange: "due_date, not notify_date.",
    fields: [
      ["reminder_id", "UUID", "Reminder identifier."],
      ["employee_id", "UUID", "Related directory person identifier."],
      ["milestone", "string", "Check-in milestone."],
      ["sequence", "integer", "Reminder sequence number."],
      ["due_date", "date", "Check-in due date."],
      ["notify_date", "date", "Scheduled notification date."],
      ["status", "string", "Delivery status."],
      ["needs_review_reason", "string | null", "Operational hold reason, if present."],
      ["attempt_count", "integer", "Recorded delivery attempts."],
      ["delivered_at", "timestamp | null", "Delivery time, if delivered."],
      ["completed_at", "timestamp | null", "Completion time, if completed."],
      ["created_at", "timestamp", "Record creation time."],
      ["updated_at", "timestamp", "Record last-update time."],
    ],
  },
  {
    name: "check_in_events",
    shape: "Array<Object>",
    description: "Check-in delivery and completion events.",
    dateRange: "occurred_at calendar date.",
    fields: [
      ["event_id", "UUID", "Event identifier."],
      ["reminder_id", "UUID", "Related reminder identifier."],
      ["event_type", "string", "Recorded event type."],
      ["error_code", "string | null", "Sanitised delivery error code, if recorded."],
      ["occurred_at", "timestamp", "Event creation time."],
    ],
  },
  {
    name: "asset_custody",
    shape: "Array<Object>",
    description: "Durable asset assignment/return periods. Includes asset and employee IDs, not employee names or contact details.",
    dateRange: "Assignment interval assigned_on/returned_on overlaps the range; null returned_on is still open.",
    fields: [
      ["custody_id", "UUID", "Custody-history identifier."],
      ["asset_id", "UUID", "Asset identifier."],
      ["asset_code", "string", "Asset code."],
      ["asset_type", "string", "Asset type."],
      ["asset_status", "string", "Asset status."],
      ["employee_id", "UUID", "Related directory person identifier."],
      ["assigned_on", "date", "Assignment date."],
      ["returned_on", "date | null", "Return date; null means the assignment is open."],
      ["recorded_at", "timestamp", "Custody-record creation time."],
      ["updated_at", "timestamp", "Custody-record last-update time."],
    ],
  },
  {
    name: "subscriptions",
    shape: "Array<Object>",
    description: "Subscription register facts and aggregate member counts. Member identities and credential values are excluded.",
    dateRange: "created_at calendar date.",
    fields: [
      ["subscription_id", "UUID", "Subscription identifier."],
      ["subscription_code", "string", "Internal subscription code."],
      ["service_name", "string", "Service name."],
      ["plan_name", "string | null", "Plan name, if recorded."],
      ["status", "string", "Subscription status."],
      ["pricing_model", "string", "Pricing model."],
      ["billing_cycle", "string", "Billing cycle."],
      ["amount_cents", "integer | null", "Amount in the smallest currency unit."],
      ["currency", "string", "Currency code."],
      ["renewal_date", "date | null", "Renewal date, if recorded."],
      ["next_review_on", "date | null", "Next review date, if recorded."],
      ["responsible_employee_id", "UUID | null", "Responsible person identifier."],
      ["member_count", "integer", "Number of linked members; no member identities."],
      ["created_at", "timestamp", "Register-record creation time."],
      ["updated_at", "timestamp", "Register-record last-update time."],
    ],
  },
  {
    name: "subscription_events",
    shape: "Array<Object>",
    description: "Subscription review/change history without actor names or credential values.",
    dateRange: "occurred_at calendar date.",
    fields: [
      ["event_id", "UUID", "Event identifier."],
      ["subscription_id", "UUID", "Related subscription identifier."],
      ["event_type", "string", "Recorded event type."],
      ["changed_fields", "string[]", "Field names changed by the event, not field values."],
      ["occurred_at", "timestamp", "Event creation time."],
    ],
  },
] as const;

export default function AnalyticsApiDocsPage() {
  return <main className={styles.page}>
    <Link className={styles.back} href="/?view=people">← People Hub</Link>
    <header className={styles.header}>
      <span>System Admin · API reference</span>
      <h1>Analytics API</h1>
      <p>Read-only server-to-server reporting for approved dashboard connectors and analytics backends. Do not call this API from browser code.</p>
    </header>

    <section className={styles.card}>
      <h2>Authentication</h2>
      <p>Send the dedicated Analytics API key as a bearer token. System Admin generates it from People → Analytics API. The full key is shown once; only its hash is retained. Keep it in the connector’s encrypted secret store. Rotation invalidates the previous key immediately, so update the connector secret before rotating.</p>
      <pre><code>Authorization: Bearer example-placeholder</code></pre>
      <p>Never use or share Supabase publishable, secret or service-role keys, a Supabase Management API token, a portal login, or a subscription credential. This API does not enable browser CORS and responses use <code>Cache-Control: no-store</code>. Do not place the bearer key in browser code, a spreadsheet, source control, chat or email.</p>
    </section>

    <section className={styles.card}>
      <h2>Endpoint</h2>
      <p>Production base URL: <code>https://mam-team-management-system-ten.vercel.app</code></p>
      <pre><code>GET /api/analytics/v1</code></pre>
      <h3>Query parameters</h3>
      <div className={styles.tableWrap}><table><thead><tr><th>Parameter</th><th>Default</th><th>Rules</th></tr></thead><tbody>
        <tr><td><code>dataset</code></td><td><code>overview</code></td><td>Exact lower-case dataset name from the reference below.</td></tr>
        <tr><td><code>from</code></td><td>No lower bound</td><td>Inclusive valid calendar date in <code>YYYY-MM-DD</code> format.</td></tr>
        <tr><td><code>to</code></td><td>No upper bound</td><td>Inclusive valid calendar date; must be on or after <code>from</code>.</td></tr>
        <tr><td><code>limit</code></td><td><code>500</code></td><td>Record datasets: integer from 1–1000.</td></tr>
        <tr><td><code>offset</code></td><td><code>0</code></td><td>Integer rows to skip, from 0–1,000,000.</td></tr>
      </tbody></table></div>
      <p>Date bounds are inclusive and use the dataset-specific basis. They do not change the dates returned in each record.</p>
      <div className={styles.tableWrap}><table><thead><tr><th>Dataset</th><th>Date filter basis</th></tr></thead><tbody>
        <tr><td><code>overview</code></td><td>Leave requests that overlap the range and check-ins by <code>due_date</code>. Headcount, asset and subscription totals remain current-state totals.</td></tr>
        <tr><td><code>employees</code></td><td><code>record_created_at</code> calendar date, not <code>started_on</code>.</td></tr>
        <tr><td><code>leave_requests</code></td><td>Request <code>start_date</code>/<code>end_date</code> interval overlaps the range.</td></tr>
        <tr><td><code>leave_events</code>, <code>check_in_events</code>, <code>subscription_events</code></td><td><code>occurred_at</code> calendar date.</td></tr>
        <tr><td><code>check_ins</code></td><td><code>due_date</code>, not <code>notify_date</code>.</td></tr>
        <tr><td><code>asset_custody</code></td><td>Assignment interval <code>assigned_on</code>/<code>returned_on</code> overlaps; null <code>returned_on</code> remains open.</td></tr>
        <tr><td><code>subscriptions</code></td><td><code>created_at</code> calendar date.</td></tr>
      </tbody></table></div>
    </section>

    <section className={styles.card}>
      <h2>Dataset reference</h2>
      <p>UUIDs are JSON strings; dates use YYYY-MM-DD; timestamps are ISO-8601 strings; numeric values are JSON numbers. Nullable source values are returned as <code>null</code>, not omitted.</p>
      {datasets.map((dataset) => <section key={dataset.name}>
        <h3><code>{dataset.name}</code> · {dataset.shape}</h3>
        <p>{dataset.description}</p>
        <p><strong>Date filter:</strong> {dataset.dateRange}</p>
        <div className={styles.tableWrap}><table><thead><tr><th>Field</th><th>JSON type</th><th>Meaning</th></tr></thead><tbody>
          {dataset.fields.map(([field, type, meaning]) => <tr key={field}><td><code>{field}</code></td><td>{type}</td><td>{meaning}</td></tr>)}
        </tbody></table></div>
      </section>)}
      <p>For <code>employees</code>, <code>from</code>/<code>to</code> continue to filter by <code>record_created_at</code>, not start or scheduled end date. <code>working_weekdays</code> uses ISO numbering. Each <code>working_day_times</code> item is <code>{'{ "weekday": 1, "start_time": "09:00", "end_time": "17:00" }'}</code>.</p>
      <p>The API returns only eligible records present in durable system projections. It does not reconstruct history for fields that pre-date their durable register.</p>
    </section>

    <section className={styles.card}>
      <h2>Response envelope and pagination</h2>
      <pre><code>{`{
  "ok": true,
  "api_version": "v1",
  "generated_at": "2026-09-28T01:23:45.000Z",
  "dataset": "employees",
  "from": null,
  "to": null,
  "data": [],
  "pagination": { "total": 0, "limit": 500, "offset": 0 }
}`}</code></pre>
      <p><code>generated_at</code> is response time, not a source-data watermark. <code>overview.data</code> is an object; record datasets return arrays. <code>pagination.total</code> counts matching rows before pagination. Empty results are <code>[]</code>. <code>overview</code> always reports total 1, limit 1, offset 0.</p>
    </section>

    <section className={styles.card}>
      <h2>Errors</h2>
      <div className={styles.tableWrap}><table><thead><tr><th>HTTP</th><th>Code</th><th>Meaning</th></tr></thead><tbody>
        <tr><td>401</td><td><code>unauthorized</code></td><td>Missing, invalid or revoked bearer key.</td></tr>
        <tr><td>400</td><td><code>invalid_dataset</code></td><td>Unsupported dataset; response includes the supported dataset list.</td></tr>
        <tr><td>400</td><td><code>invalid_date_range</code></td><td>Malformed/impossible date or <code>to</code> precedes <code>from</code>.</td></tr>
        <tr><td>400</td><td><code>invalid_pagination</code></td><td><code>limit</code> or <code>offset</code> is outside the accepted integer range.</td></tr>
        <tr><td>503</td><td><code>analytics_unavailable</code></td><td>Approved reporting projection could not be read; retry later. Do not use direct database access as a fallback.</td></tr>
      </tbody></table></div>
      <p>Errors use <code>{'{ "ok": false, "code": "..." }'}</code>; raw database errors are not returned.</p>
    </section>

    <section className={styles.card}>
      <h2>Example</h2>
      <pre><code>{`curl --fail --silent \\
  -H "Authorization: Bearer $MAM_ANALYTICS_API_KEY" \\
  "https://mam-team-management-system-ten.vercel.app/api/analytics/v1?dataset=employees&limit=500"`}</code></pre>
      <p>Store the bearer value in the connector’s encrypted secret settings; never place it in browser JavaScript, a spreadsheet, chat, email, or source code.</p>
      <h3>Synthetic employees response</h3>
      <pre><code>{`{
  "ok": true,
  "api_version": "v1",
  "generated_at": "2026-09-28T01:23:45.000Z",
  "dataset": "employees",
  "from": null,
  "to": null,
  "data": [{
    "employee_id": "00000000-0000-4000-8000-000000000001",
    "first_name": "Alex",
    "last_name": "Example",
    "team": "Major",
    "scheduled_employment_end_date": "2027-12-31",
    "employment_type": "casual",
    "contract_type": "fixed_term",
    "working_weekdays": [1, 3, 5],
    "working_day_times": [
      { "weekday": 1, "start_time": "09:00", "end_time": "17:00" }
    ],
    "company": "mam",
    "position_title": "Coordinator",
    "employment_status": "active",
    "started_on": "2026-01-15",
    "record_created_at": "2026-01-15T00:00:00.000Z",
    "record_updated_at": "2026-01-15T00:00:00.000Z"
  }],
  "pagination": { "total": 1, "limit": 500, "offset": 0 }
}`}</code></pre>
    </section>

    <section className={styles.card}>
      <h2>Data boundaries</h2>
      <p>The <code>employees</code> dataset exposes employee names, team, scheduled employment end date, employment type, contract type and work-schedule fields for the approved reporting use; other datasets carry employee IDs, not names. The API excludes work/personal email, phone, date of birth, street address, leave type/category, leave reason, employee/manager notes, leave evidence, authentication data, passwords, recovery codes, asset passcodes, subscription credentials and member names. Check-in <code>needs_review_reason</code> is an operational review reason, not a leave reason or contact field.</p>
      <p>Employee and object UUIDs are stable operational identifiers for joins between approved datasets. They are not database credentials and cannot be used to query Supabase directly.</p>
    </section>
  </main>;
}
