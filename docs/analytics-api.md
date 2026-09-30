# Analytics API

`GET /api/analytics/v1` is the MAM read-only server-to-server reporting API.
Use it from an approved BI connector or backend, not from browser code.

Production base URL: `https://mam-team-management-system-ten.vercel.app`

## Endpoint

```http
GET /api/analytics/v1
```

The same request path is used for every dataset. Choose a dataset with the
`dataset` query parameter; `overview` is the default.

## Authentication

Send the dedicated Analytics API key in the HTTP `Authorization` header:

```http
Authorization: Bearer <ANALYTICS_API_KEY>
```

System Admin manages the key from **People → Analytics API**. The full key is
shown once when generated; only its hash is retained by the system. Store it in
the connector's encrypted secret store. Rotation invalidates the previous key
immediately, and revocation stops access immediately. Update the connector's
secret before rotating so scheduled refreshes are not interrupted.

Do not use or share a Supabase publishable, secret or service-role key, a
Supabase Management API token, an HR portal account, or a subscription
credential. The endpoint does not enable browser CORS, and responses are not
cacheable (`Cache-Control: no-store`). Keep the bearer key server-side; never
put it in a spreadsheet, browser bundle, source control, chat or email.

## Query parameters

| Parameter | Default | Accepted values and behavior |
| --- | --- | --- |
| `dataset` | `overview` | One exact lower-case name in the dataset reference below. |
| `from` | No lower bound | Inclusive, valid calendar date in `YYYY-MM-DD` format. |
| `to` | No upper bound | Inclusive, valid calendar date in `YYYY-MM-DD` format. Must be on or after `from`. |
| `limit` | `500` | Integer from `1` to `1000`; maximum rows per page for record datasets. |
| `offset` | `0` | Integer from `0` to `1000000`; number of matching rows to skip. |

`from`/`to` are applied using the dataset-specific dates below. They do not
change the meaning of dates returned in a record.

| Dataset | Date-range rule |
| --- | --- |
| `overview` | Leave totals include requests overlapping the range; check-in totals use `due_date`. Headcount, asset and subscription totals are current totals and are not date-filtered. |
| `employees` | Filters by the directory record's `record_created_at` calendar date, not `started_on`. |
| `leave_requests` | Includes requests whose `start_date`/`end_date` interval overlaps the range. |
| `leave_events` | Filters by `occurred_at`. |
| `check_ins` | Filters by `due_date`, not `notify_date`. |
| `check_in_events` | Filters by `occurred_at`. |
| `asset_custody` | Includes assignments whose `assigned_on`/`returned_on` interval overlaps the range; a null `returned_on` is still open. |
| `subscriptions` | Filters by `created_at`. |
| `subscription_events` | Filters by `occurred_at`. |

## Success response

Every successful response has this envelope:

```json
{
  "ok": true,
  "api_version": "v1",
  "generated_at": "2026-09-28T01:23:45.000Z",
  "dataset": "employees",
  "from": null,
  "to": null,
  "data": [],
  "pagination": {
    "total": 0,
    "limit": 500,
    "offset": 0
  }
}
```

`generated_at` is the response-generation timestamp, not a source-data
watermark. `overview.data` is an object. Each record dataset returns `data` as
an array; an empty result is `[]`. `pagination.total` is the count of all
matching records before pagination. `limit` and `offset` report the applied
page. `overview` always reports `total: 1`, `limit: 1`, and `offset: 0`.

## Dataset reference

UUIDs are JSON strings. Dates use `YYYY-MM-DD`; timestamps are ISO-8601 strings;
numeric values are JSON numbers. Nullable source values are returned as JSON
`null`, not omitted. The keys shown below are the fields in each dataset.

### `overview`

`data` is one nested summary object, not a row array.

| Field path | Type | Meaning |
| --- | --- | --- |
| `headcount.active` | integer | Active employee records. |
| `headcount.archived` | integer | Archived employee records. |
| `headcount.mam_active` | integer | Active MAM employee records. |
| `headcount.equipsy_active` | integer | Active Equipsy employee records. |
| `leave.requests` | integer | Requests overlapping the selected date range. |
| `leave.submitted` | integer | Overlapping requests with submitted status. |
| `leave.approved` | integer | Overlapping approved requests. |
| `leave.declined` | integer | Overlapping rejected/declined requests. |
| `leave.cancelled` | integer | Overlapping cancelled requests. |
| `leave.business_days` | number | Sum of business days for overlapping requests. |
| `leave.hours` | number | Sum of hours for overlapping requests. |
| `check_ins.total` | integer | Check-ins due in the selected date range. |
| `check_ins.scheduled` | integer | Due check-ins with scheduled status. |
| `check_ins.needs_review` | integer | Due check-ins held for review. |
| `check_ins.completed` | integer | Due check-ins completed. |
| `check_ins.delivered` | integer | Due check-ins delivered. |
| `assets.total` | integer | Current asset count. |
| `assets.assigned` | integer | Current assigned assets. |
| `assets.available` | integer | Current available assets. |
| `assets.repair` | integer | Current assets marked for repair. |
| `assets.retired` | integer | Current retired assets. |
| `subscriptions.total` | integer | Current subscription count. |
| `subscriptions.active` | integer | Current active subscriptions. |
| `subscriptions.paused` | integer | Current paused subscriptions. |
| `subscriptions.cancelled` | integer | Current cancelled subscriptions. |
| `subscriptions.monthly_cost_aud` | number | Monthly-equivalent AUD cost for paid active and paused subscriptions. |

### `employees`

Directory facts for employees and archived employee records. Name, team,
employment and work-schedule fields are read from their existing private HR
projections. Nullable source fields remain `null`; an unrecorded daily-time
schedule is an empty array. No contact details are returned.

| Field | Type | Meaning |
| --- | --- | --- |
| `employee_id` | UUID | Stable directory person identifier. |
| `first_name` | string or null | First name from private directory details. |
| `last_name` | string or null | Last name from private directory details. |
| `team` | string or null | HR team label from the employee directory. |
| `scheduled_employment_end_date` | date or null | Scheduled employment end date; null if not recorded. |
| `employment_type` | string or null | Employment arrangement: `abn`, `casual`, `full_time` or `part_time`, when recorded. |
| `contract_type` | string or null | HR check-in classification: `permanent` or `fixed_term`; null when none is recorded. |
| `working_weekdays` | integer array or null | ISO weekdays, `1` Monday through `7` Sunday; null means no usual weekdays are recorded. |
| `working_day_times` | array of objects | Optional intervals with `weekday`, `start_time` and `end_time` (`HH:MM`); `[]` means no exact daily times are recorded. |
| `company` | string | Company key, such as `mam` or `equipsy`. |
| `position_title` | string or null | Directory position title. |
| `employment_status` | string | `active` or `archived`. |
| `started_on` | date or null | Recorded start date. |
| `record_created_at` | timestamp | Directory record creation time. |
| `record_updated_at` | timestamp | Directory record last-update time. |

The employee `from`/`to` filters continue to use the `record_created_at`
calendar date, not the start or scheduled employment end date. `working_weekdays`
uses ISO-8601 weekday numbering. Each `working_day_times` item has this shape:

```json
{"weekday": 1, "start_time": "09:00", "end_time": "17:00"}
```

### `leave_requests`

Durable leave request facts. The projection deliberately omits leave category,
reason, notes, evidence and email addresses. An unmatched request can have a
null `employee_id`; its `company` is then `unknown`.

| Field | Type | Meaning |
| --- | --- | --- |
| `request_id` | UUID | Leave request identifier. |
| `employee_id` | UUID or null | Matched directory person identifier. |
| `company` | string | Company key, or `unknown` when no person is matched. |
| `start_date` | date | First requested date. |
| `end_date` | date | Last requested date. |
| `business_days` | number | Recorded business-day duration. |
| `hours` | number or null | Raw duration stored on the request; null when no explicit duration was recorded. |
| `business_hours` | number | Complete reported leave duration in hours. Uses stored `hours` when present; otherwise `business_days × 7.6` for `full_time` or `× 7.5` for other/unknown classifications. |
| `status` | string | Current request status. |
| `submitted_at` | timestamp | Submission time. |
| `decided_at` | timestamp or null | Decision time, if decided. |
| `created_at` | timestamp | Record creation time. |
| `updated_at` | timestamp | Record last-update time. |

`business_hours` uses the request's `employment_type_snapshot` first and falls
back to the employee's current private employment classification when the
snapshot is absent. If neither identifies `full_time`, the existing 7.5-hour
fallback applies. It uses the recorded `business_days` value: current leave
duration counts Monday–Friday and does not deduct Victorian public holidays.
Saved `working_weekdays` and `working_day_times` do not change this calculation.
For example, a two-business-day full-time request with no recorded `hours`
returns `hours: null` and `business_hours: 15.2`. This reporting value does not
write to payroll or change leave balances.

### `leave_events`

Workflow event history without leave reasons or notes.

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | UUID | Event identifier. |
| `request_id` | UUID | Related request identifier. |
| `event_type` | string | Recorded event type. |
| `occurred_at` | timestamp | Event creation time. |

### `check_ins`

Check-in schedule and delivery state, including the operational reason when a
record is held for review. Employee names and contact details are not returned.

| Field | Type | Meaning |
| --- | --- | --- |
| `reminder_id` | UUID | Reminder identifier. |
| `employee_id` | UUID | Related directory person identifier. |
| `milestone` | string | Check-in milestone. |
| `sequence` | integer | Reminder sequence number. |
| `due_date` | date | Check-in due date. |
| `notify_date` | date | Scheduled notification date. |
| `status` | string | Delivery status. |
| `needs_review_reason` | string or null | Operational hold reason, when present. |
| `attempt_count` | integer | Recorded delivery attempts. |
| `delivered_at` | timestamp or null | Delivery time, if delivered. |
| `completed_at` | timestamp or null | Completion time, if completed. |
| `created_at` | timestamp | Record creation time. |
| `updated_at` | timestamp | Record last-update time. |

### `check_in_events`

Check-in delivery/completion events.

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | UUID | Event identifier. |
| `reminder_id` | UUID | Related reminder identifier. |
| `event_type` | string | Recorded event type. |
| `error_code` | string or null | Sanitised delivery error code, if recorded. |
| `occurred_at` | timestamp | Event creation time. |

### `asset_custody`

Durable asset assignment and return periods. It includes asset identifiers and
employee IDs, but not employee names or contact details.

| Field | Type | Meaning |
| --- | --- | --- |
| `custody_id` | UUID | Custody-history identifier. |
| `asset_id` | UUID | Asset identifier. |
| `asset_code` | string | Asset code. |
| `asset_type` | string | Asset type. |
| `asset_status` | string | Asset status. |
| `employee_id` | UUID | Related directory person identifier. |
| `assigned_on` | date | Assignment date. |
| `returned_on` | date or null | Return date; null means the assignment remains open. |
| `recorded_at` | timestamp | Custody-record creation time. |
| `updated_at` | timestamp | Custody-record last-update time. |

### `subscriptions`

Register facts and aggregate membership counts. Member names and credential
values are not returned.

| Field | Type | Meaning |
| --- | --- | --- |
| `subscription_id` | UUID | Subscription identifier. |
| `subscription_code` | string | Internal subscription code. |
| `service_name` | string | Service name. |
| `plan_name` | string or null | Plan name, if recorded. |
| `status` | string | Subscription status. |
| `pricing_model` | string | Pricing model. |
| `billing_cycle` | string | Billing cycle. |
| `amount_cents` | integer or null | Amount in the smallest currency unit. |
| `currency` | string | Currency code. |
| `renewal_date` | date or null | Renewal date, if recorded. |
| `next_review_on` | date or null | Next review date, if recorded. |
| `responsible_employee_id` | UUID or null | Responsible person identifier. |
| `member_count` | integer | Number of linked members; no member identities. |
| `created_at` | timestamp | Register-record creation time. |
| `updated_at` | timestamp | Register-record last-update time. |

### `subscription_events`

Review/change history without actor names or credential values.

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | UUID | Event identifier. |
| `subscription_id` | UUID | Related subscription identifier. |
| `event_type` | string | Recorded event type. |
| `changed_fields` | array of strings | Field names changed by the event; not field values. |
| `occurred_at` | timestamp | Event creation time. |

## Error responses

Errors use `{ "ok": false, "code": "..." }`; the API does not return raw
database errors.

| HTTP status | `code` | Meaning |
| --- | --- | --- |
| `401` | `unauthorized` | Missing, invalid or revoked bearer key. |
| `400` | `invalid_dataset` | Dataset is not in the supported list; response includes `datasets`. |
| `400` | `invalid_date_range` | A date is malformed/impossible or `to` is earlier than `from`. |
| `400` | `invalid_pagination` | `limit` or `offset` is not an accepted integer. |
| `503` | `analytics_unavailable` | The approved reporting projection could not be read. Retry later; do not switch to direct database access. |

## Examples

Use a server-side environment variable or the connector's encrypted secret
store for the key:

```bash
curl --fail --silent --show-error --get \
  -H "Authorization: Bearer $MAM_ANALYTICS_API_KEY" \
  "https://mam-team-management-system-ten.vercel.app/api/analytics/v1" \
  --data-urlencode "dataset=employees" \
  --data-urlencode "limit=500"
```

Synthetic employee response (IDs and values below are examples only):

```json
{
  "ok": true,
  "api_version": "v1",
  "generated_at": "2026-09-28T01:23:45.000Z",
  "dataset": "employees",
  "from": null,
  "to": null,
  "data": [
    {
      "employee_id": "00000000-0000-4000-8000-000000000001",
      "first_name": "Alex",
      "last_name": "Example",
      "team": "Major",
      "scheduled_employment_end_date": "2027-12-31",
      "employment_type": "casual",
      "contract_type": "fixed_term",
      "working_weekdays": [1, 3, 5],
      "working_day_times": [
        {"weekday": 1, "start_time": "09:00", "end_time": "17:00"}
      ],
      "company": "mam",
      "position_title": "Coordinator",
      "employment_status": "active",
      "started_on": "2026-01-15",
      "record_created_at": "2026-01-15T00:00:00.000Z",
      "record_updated_at": "2026-01-15T00:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 500,
    "offset": 0
  }
}
```

## Data boundaries

The `employees` dataset exposes employee names, team, scheduled employment end
date, employment type, contract type and work-schedule fields for the approved
reporting use. Other datasets carry employee IDs, not names. The API does not
return work/personal email, phone, date of birth, street address, leave
type/category, leave reason, employee or manager notes, leave evidence,
authentication data, passwords, recovery codes, asset passcodes, subscription
credentials or member names. Check-in `needs_review_reason` is an operational
review reason, not a leave reason or contact field.

Employee and object UUIDs are stable identifiers for joins between approved
datasets. They are not Supabase credentials and cannot be used to query the
database directly. The API returns only eligible records present in durable
system projections; it does not reconstruct history for fields that pre-date
their durable register.

## Connector guidance

- Use `dataset=employees` as the employee dimension and join other datasets on
  `employee_id`/`responsible_employee_id` as applicable.
- Page record datasets until the returned rows are exhausted; compare the
  accumulated row count with `pagination.total` for the same filter window.
- Refresh the connector after adding fields so the downstream model discovers
  `first_name`, `last_name`, `scheduled_employment_end_date`, `team`,
  `employment_type`, `contract_type`, `working_weekdays` and `working_day_times`.
- Do not rotate a key just to refresh a model. Rotation immediately invalidates
  the old key.

## Check-ins request example

```bash
curl --fail --silent \
  -H "Authorization: Bearer $MAM_ANALYTICS_API_KEY" \
  "https://mam-team-management-system-ten.vercel.app/api/analytics/v1?dataset=check_ins&from=2026-01-01&to=2026-12-31&limit=1000"
```

Use `dataset=check_ins` to retrieve due-date check-in records. Keep the bearer
value in the connector's encrypted secret store; never place it in browser
JavaScript, a spreadsheet, chat, email or source code.
