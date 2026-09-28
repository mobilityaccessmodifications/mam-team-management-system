# Analytics API

`GET /api/analytics/v1` is the MAM server-to-server reporting API. It is for
an approved dashboard connector or analytics backend, not for browser code.

## Authentication

Send the dedicated Analytics API key as a bearer token:

```http
Authorization: Bearer <ANALYTICS_API_KEY>
```

System Admin manages the key from People → Analytics API. A generated key is
shown once, then only its hash is retained by the system. Rotate it whenever
the dashboard connection changes; revoking it stops access immediately.

Do not use or share a Supabase secret key, a Supabase Management API token, an
HR portal account, or a subscription credential. The route does not enable
browser CORS so the key cannot be used from client-side JavaScript.

## Query parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| `dataset` | `overview` | One approved dataset below. |
| `from` | all available history | Inclusive `YYYY-MM-DD`. |
| `to` | all available history | Inclusive `YYYY-MM-DD`. |
| `limit` | `500` | `1`–`1000` rows for record datasets. |
| `offset` | `0` | Use with `limit` for pagination. |

Datasets:

- `overview` — current headcount, asset and subscription totals plus
  date-filtered leave/check-in totals.
- `employees` — employee_id, first_name, last_name, company, position_title,
  employment_status, started_on, record_created_at, record_updated_at. The name
  fields are null when no private directory detail is stored for that employee.
- `leave_requests` and `leave_events` — durable leave workflow history.
- `check_ins` and `check_in_events` — schedule and delivery/completion history.
- `asset_custody` — every durable device assignment and return period.
- `subscriptions` and `subscription_events` — register facts and review/change
  history.

The API returns every eligible historical record stored by the system. It does
not invent a timeline for fields that pre-date their durable register.

## Data deliberately excluded

The analytics layer never returns personal/work email, phone, date of birth,
address, leave type, leave reason, manager note, leave evidence, authentication
data, passwords, recovery codes, asset passcodes, or subscription credentials.

Employee and object UUIDs are stable operational identifiers for joins between
the approved datasets. They are not Supabase credentials and cannot be used to
query the database directly.

## Example

```bash
curl --fail --silent \
  -H "Authorization: Bearer $MAM_ANALYTICS_API_KEY" \
  "https://mam-team-management-system-ten.vercel.app/api/analytics/v1?dataset=check_ins&from=2026-01-01&to=2026-12-31&limit=1000"
```

Responses include `data` and `pagination`. Store the bearer key in the
dashboard platform's encrypted connection-secret facility. Never place it in
browser JavaScript, a spreadsheet, chat, email or source code.
