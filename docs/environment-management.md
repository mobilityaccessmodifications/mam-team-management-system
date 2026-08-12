# Environment and API key management

## The rule

An AI/chat session is not an environment. Sessions are temporary work contexts; environments are stable deployment targets.

Use exactly these environments:

| Environment | Purpose | Storage |
|---|---|---|
| Development | Local work with synthetic data | Project `.env.local`, pulled from Vercel Development when linked |
| Preview | Branch/PR testing | Vercel Preview variables and a non-production Supabase project/branch |
| Production | Approved live system | Vercel Production variables and the production Supabase project |

## Multiple APIs in one project

It is normal for one project environment to contain several API configurations:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_SHARED_DEMO
MAM_ALLOWED_EMAIL_DOMAINS
AROFLO_API_BASE_URL
AROFLO_API_KEY
MAM_DEMO_EMAIL_ENABLED
MAM_N8N_LEAVE_WEBHOOK_URL
MAM_N8N_LEAVE_WEBHOOK_SECRET
```

Group variables by provider name and use the same variable names in development, preview and production. The values change; the names and code do not.

Do not split them by chat session. Session-specific files create drift, make rotation unreliable and leave orphaned credentials.

## When separate sandboxes are correct

Keep separate sandboxes when the identity or permission boundary is genuinely different. MAM's admin Outlook and marketing Outlook are a good example: each represents a different mailbox and should keep its own key, account assertion and allowlisted apps.

That is identity isolation, not session isolation.

## Storage rules

- `.env.example`: committed variable names and safe explanations only.
- `.env.local`: gitignored development values for this project only.
- Vercel: encrypted values separated by Development, Preview and Production.
- Supabase: publishable key may reach the browser; secret/service-role keys are server-only and are not needed by this foundation app.
- `NEXT_PUBLIC_SHARED_DEMO=true`: permits only the shared synthetic demo path. It is not suitable for real staff data because the role selector is not authentication.
- Real organisation rows belong only in the authenticated, RLS-protected Supabase table. Import them directly into the verified project; do not place them in `.env*`, migrations, source fixtures, Vercel variables, screenshots or the shared-demo tables.
- `MAM_ALLOWED_EMAIL_DOMAINS` is a required, comma-separated server-only allowlist for the exact MAM and Equipsy work-email domains. Login fails closed when it is absent or empty.
- `MAM_DEMO_EMAIL_ENABLED`, `MAM_N8N_LEAVE_WEBHOOK_URL` and `MAM_N8N_LEAVE_WEBHOOK_SECRET` are server-only. They must never use a `NEXT_PUBLIC_*` name or enter client code, screenshots or logs.
- GitHub Actions: repository/environment secrets only when CI genuinely needs them.
- Password manager or macOS Keychain: recovery copies and credentials used by local scripts.
- Never create `.env.save`; use the password manager or deployment platform's controlled history instead.

## Approved synthetic email-review environment

The email path is deliberately narrower than the general three-environment model:

| Environment | Email-review setting |
|---|---|
| Development | `MAM_DEMO_EMAIL_ENABLED=false`; webhook values blank unless a separate, explicitly approved isolated test is introduced |
| Preview | `MAM_DEMO_EMAIL_ENABLED=false`; no provider delivery |
| Production | May be `true` only for the approved synthetic review test, with the MAM n8n webhook and shared secret configured as server-only Vercel variables |

The Next.js route derives the message from canonical synthetic Supabase records and calls n8n with the shared secret. n8n owns the Outlook credential named `Microsoft Outlook - ai@mobilityaccess.com.au`; the Outlook credential does not belong in Vercel. Both the server route and n8n workflow must hard-lock the physical recipient to `ai@mobilityaccess.com.au` regardless of the intended Team Leader, employee, HR or Accounts template. The Team Leader link uses the fixed production origin `https://mam-team-management-system-ten.vercel.app`.

These variables do not authorise real employee addresses, authentication, a database migration, attachment delivery or live HR data. Rotate the webhook secret in both Vercel Production and n8n if it is exposed. A provider failure is operational telemetry only and must not undo a successfully stored leave request or decision.

## Session workflow

Every AI session should:

1. Open the canonical project directory.
2. Read `AGENTS.md` and `README.md`.
3. Load that project's `.env.local` only through the application or a locked helper.
4. Verify the expected account/project before external reads or writes.
5. Never copy credentials into chat, Memory, shell profiles or another project.
