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
AROFLO_API_BASE_URL
AROFLO_API_KEY
OUTLOOK_TENANT_ID
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
- GitHub Actions: repository/environment secrets only when CI genuinely needs them.
- Password manager or macOS Keychain: recovery copies and credentials used by local scripts.
- Never create `.env.save`; use the password manager or deployment platform's controlled history instead.

## Session workflow

Every AI session should:

1. Open the canonical project directory.
2. Read `AGENTS.md` and `README.md`.
3. Load that project's `.env.local` only through the application or a locked helper.
4. Verify the expected account/project before external reads or writes.
5. Never copy credentials into chat, Memory, shell profiles or another project.
