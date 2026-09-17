# OpenClaw WhatsApp employee allowlist

## Implementation status

Implementation is undergoing authorized review/release; do not assume production
is wired until the release evidence is recorded below. Migration:
`supabase/migrations/20260917045203_openclaw_phone_allowlist.sql`.
The CLI profile-name parsing error was resolved by supplying the existing MAM
profile's explicit path (`--profile /Users/nixon/.supabase/mam.yaml`) to
`supabase migration new openclaw_phone_allowlist`. No credential was changed.
The generated UTC filename is retained even though some older migrations have
future-dated filenames; use the scoped, hash-checked deployment helper to apply
only this migration and record it transactionally, not a bulk `db push`.

## People System contract

`GET /api/internal/integrations/openclaw/whatsapp-allowlist`

Send `Authorization: Bearer <MAM_OPENCLAW_ALLOWLIST_SECRET>` over HTTPS. Provision
at least 32 cryptographically random bytes encoded base64url (43–128 characters
accepted). Length checks cannot prove entropy: provisioning must generate it.
No browser session, query parameters, caller-selected company, pagination or
CORS. All handler responses are `private, no-store`; secrets never enter URLs.
The exact route bypasses cookie refresh/redirects, not its own authentication.

Successful response (synthetic example):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-17T00:00:00.000Z",
  "digest": "<64 lowercase hex SHA-256 characters>",
  "phones": ["+61400000001"]
}
```

Digest is SHA-256 UTF-8 of compact JSON `{"schemaVersion":1,"phones":[...]}`,
with sorted phones and exactly that key order. It is a content identifier,
not an HMAC/signature, ownership proof, or authorization by itself. `generatedAt`
is request time before database retrieval, not employee modification time.
It can advance without digest changes. Only these four fields leave the server.

Errors: 401 invalid/missing bearer; 400 query parameters; 503 missing/malformed
server secret, missing RPC, DB errors, timeout, malformed/partial/oversize snapshot.
Error bodies contain only a generic `code`. No names, emails, IDs, other HR fields,
credentials, exclusion counts or DB error details. Other methods cannot mutate
anything (Next.js supplies HEAD/OPTIONS and rejects unsupported methods).

## Data and authorization boundaries

- Scope is **exactly** active `public.internal_org_people` with `company_key =
  'mam'`, joined on ID/person_id to `private.employee_directory_details.phone`.
  Equipsy and inactive rows are excluded in SQL. No details row means no number.
- Phone normalization requires explicit international `+` notation. ASCII spaces
  and hyphens between digit groups are removed. A leading nonzero digit and
  8–15 total digits are required. Local `04...`, `00...`, optional trunk-prefix
  parentheses, extensions, letters and multiple numbers are rejected, not guessed.
  This validates conservative E.164 **syntax**, not country numbering plans,
  ownership, reachability, or WhatsApp registration. Source data must be verified
  by HR; phone reassignment remains an operational risk.
- Missing/invalid numbers are excluded. If multiple active MAM records normalize
  to the same number, **all copies are excluded** as ambiguous. An inactive or
  non-MAM row does not participate in this active-MAM snapshot.
- Private SECURITY DEFINER implementation has an empty search path and only
  service_role EXECUTE. Public RPC wrapper is SECURITY INVOKER and service-role
  only. No private table grants are added. Browser roles cannot call either.
  Existing People System server admin credential stays inside People System;
  OpenClaw receives only the new integration credential.
- SQL returns one scalar JSON aggregate from one consistent query; PostgREST
  set-returning pagination cannot truncate it. The server validates completion,
  schema, shape and count; >10,000 rows or malformed rows fail the whole request.
  RPC timeout is 8 seconds. Failures never become successful empty lists.
- A successfully validated empty result is authoritative: revoke all employee
  access immediately. All-invalid source records can legitimately produce empty.

## Separate VPS synchronizer (not implemented here)

1. Use a dedicated OS-controlled process/timer on the verified MAM VPS. Store its
   secret outside OpenClaw's agent/workspace/config-readable locations, with
   owner-only permissions. Do not put credentials in CLI arguments, logs or Git.
2. Fetch the fixed HTTPS URL every five minutes, with bounded timeout/response
   size, certificate verification and **no redirects**. Never forward the bearer
   to another host. Reject non-200, HTML, unknown schema, extra fields, invalid
   timestamps, unsorted/duplicate/noncanonical numbers and mismatched digest.
3. Require a timestamp no more than five minutes old (and at most 60 seconds in
   the future), never older than the last accepted snapshot. Keep clocks synced.
   A digest match alone does not renew freshness: require a fresh validated fetch.
4. Derive only the installed version's documented WhatsApp `allowFrom` list.
   Verify its allowlist policy, account-level overrides and empty-list semantics;
   an empty list must mean deny-all, **never pairing/open fallback**. Do not map
   payload strings to commands, filenames, paths, tool policy or other settings.
5. Serialize updates with a lock. Validate the full candidate before touching
   live configuration; use a same-filesystem temporary file, restricted mode,
   fsync and atomic rename. Preserve unrelated configuration; use only the
   documented reload mechanism. Confirm the running gateway accepted the policy
   before recording success. Failure to apply a restrictive update must disable
   inbound WhatsApp until fixed, not silently retain permissive access.
6. Suggested outage policy (confirm at rollout): keep the last-known-good list
   for at most 15 minutes from the last validated successful fetch. Independent
   watchdog must disable inbound WhatsApp when stale, even if the sync timer
   crashes. On cold start deny-all until a valid fetch; never resurrect an expired
   disk cache. This permits up to 15 minutes of delayed revocation during outages.
   Successful empty snapshots clear immediately, not after TTL. For stricter
   revocation requirements choose zero grace and deny on any failure.
7. Optional authenticated, replay-protected webhook may **trigger a fresh fetch**
   only; it must not carry authoritative access/config changes. Periodic sync and
   watchdog remain mandatory. No webhook or email is added by this implementation.
8. Keep all WhatsApp tester restrictions: no shell/process, files, configuration,
   gateway control, automation, cross-session/agent tools, elevated or database
   access. A trusted out-of-band synchronizer is not a tool exposed to the bot.

Test on an isolated synthetic OpenClaw configuration before real access: missing
secret, timeout, bad JSON, stale/replayed snapshot, shared phone, inactive person,
company switch, removal, empty list, atomic-write/reload failure, process crash,
restart, watchdog expiry and nonemployee denial. Never send real staff messages
as a smoke test. Log status/digest/timestamps, not bearer tokens or phone lists.

## Release/wiring checklist

- User authorized this specific internal diff's external read-only Codex review
  and production wiring/release on 2026-09-17. Review code/SQL and rerun tests;
  approval alone is not evidence of review or deployment success.
- Verify MAM GitHub target, Supabase project `xtwlrjqbusadghavchqm`, and Vercel
  `ai-7033s-projects/mam-team-management-system` with scoped credentials.
- Authorize/apply versioned production migration, provision distinct integration
  secret on People System and trusted VPS process, without exposing the existing
  Supabase secret to OpenClaw. Separate nonproduction credentials/data for previews.
- Push reviewed branch, PR to main, authorized merge triggers Vercel production.
  Never direct-deploy the local checkout. Verify READY/commit before wiring URL.
- Separately approve/install VPS timer/watchdog and confirm grace period, config
  schema, deny-all semantics, secret rotation and rollback. Rotating/disabling the
  integration secret alone leaves old access until TTL; immediate revocation also
  requires disabling the channel. Never roll back to an open access policy.

## Verification

`node --test tests/openclaw-allowlist.test.mjs` exercises auth, normalization,
duplicate exclusion, strict snapshot validation, digest, handler failure and
proxy isolation. `psql -v ON_ERROR_STOP=1 -f tests/openclaw-allowlist.sql` must run
ONLY in a fresh disposable database/cluster (creates synthetic roles and tables).
It verifies source filtering, service-only function grants, scalar completeness
past 1,000 rows and authoritative empty results. Also run normal npm tests,
lint, typecheck and build. Hosted advisors/live PostgREST/VPS verification are
separate deployment checks, not evidence claimed by these local tests.

Local verification on 2026-09-17: all 6 focused tests and all 226 Node tests
passed; `npm run check` passed lint, typecheck and production build. SQL fixture
passed in isolated local PostgreSQL databases, including the final
pre-existing-role/CI variant. The temporary PostgreSQL server was stopped.
`git diff --check` passed. Formal migration SQL, all 226 tests and build were
rerun successfully after resolving the CLI profile path. External read-only
Codex autoreview passed on 2026-09-17: helper exit 0, no findings, `patch is
correct` (confidence 0.93). No code changes were required after review.
Review command: `autoreview --mode local --engine codex --no-web-search
--stream-engine-output`, with a prompt limiting inspection to this diff and
related local source/synthetic tests, excluding credentials and live services.
Local review evidence: `/private/tmp/mam-openclaw-review.IPobtR/review.json`.
Hosted advisor, real PostgREST, VPS synchronization and production deployment
results must be recorded separately; local verification does not establish them.
