# Analytics API

`GET /api/analytics/v1` is the MAM server-to-server reporting API. It is for
an approved dashboard connector or analytics backend, not for browser code.

## Authentication

Send the dedicated environment secret as a bearer token:

```http
Authorization: Bearer <MAM_ANALYTICS_API_KEY>
```

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
- `employees` — current directory record facts and archived/active status.
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
dashboard platform's encrypted connection-secret facility and rotate it by
replacing the Vercel environment value.
