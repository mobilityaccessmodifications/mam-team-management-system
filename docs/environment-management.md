# Environment and secret management

## The rule

An AI/chat session is not an environment. Use the stable deployment targets below:

| Environment | Purpose | Storage |
|---|---|---|
| Development | Local work | Project `.env.local` with a development Supabase project or branch |
| Preview | Branch/PR verification | Vercel Preview values with isolated, non-production Supabase data |
| Production | Approved staff system | MAM Vercel Production values and MAM production Supabase project |

Do not split credentials by chat session. Do not copy Production secrets into Development or Preview.

## Application variables

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
NEXT_PUBLIC_APP_URL
```

The values change by environment; the names and code do not.

## Storage rules

- `.env.example`: committed names and safe explanations only.
- `.env.local`: gitignored values for this project's Development environment only.
- Vercel: encrypted values stored separately for Development, Preview and Production.
- Supabase publishable key: browser-safe only when every exposed table/function is protected by RLS and controlled grants.
- `SUPABASE_SECRET_KEY`: server-only Auth Admin credential. It is needed for username resolution and authorised account-management Server Actions. It must never use a `NEXT_PUBLIC_*` name, enter a Client Component, appear in logs/screenshots or be committed.
- Login passwords: held by Supabase Auth, not by environment variables. Never store a staff/admin password in `.env.local`, Vercel, GitHub, source, logs or screenshots.
- Real directory rows: import directly into the verified authenticated Supabase project. Do not place them in environment files, migrations, fixtures, screenshots or client constants.
- Private HR employee details and HR CSV exports follow the same rule: they remain in the verified protected data boundary and must not be placed in environment files, Git, fixtures, screenshots or client constants.
- A source workbook is staged and reconciled privately before import. It must not automatically replace identities, deactivate people or relink existing portal accounts.
- GitHub Actions: repository/environment secrets only when CI genuinely requires them.
- Password manager or macOS Keychain: recovery copies and credentials used by approved local tooling.
- Never create `.env.save`; use controlled platform history or the password manager.

## Account secret boundary

The browser uses the publishable key and the signed-in user's cookie-backed session. Account-management operations cross a Server Action that first verifies the session and database-controlled administrator permission. Only then may server code create/read an Auth user, set a password or change the Auth ban state with `SUPABASE_SECRET_KEY`.

The administrator may receive a newly supplied create/reset password once so it can be handed over securely. The secret key cannot reveal an existing password: Supabase Auth stores password hashes and does not provide a password-read API.

## HR employee-data boundary

The organisation tree is deliberately limited to safe structural information: name, position, company and reporting relationship. Private employee details are available only to a database-controlled HR role through authenticated server actions and controlled database functions. The HR CSV is generated on demand for that HR session using the agreed 12-column shape; it excludes login names, Auth aliases and password data, and the application does not retain the export.

## Environment verification

Before any production migration, Auth change, secret update or deployment:

1. Verify GitHub login `mobilityaccessmodifications` and repository `mobilityaccessmodifications/mam-team-management-system`.
2. Verify Supabase organisation `fwlmbmospuwoaosffvmw` and project `xtwlrjqbusadghavchqm` with the MAM CLI profile.
3. Verify Vercel target `ai-7033s-projects/mam-team-management-system` using `/Users/nixon/.vercel-profiles/mam`.
4. Confirm the operation's exact environment scope.
5. Avoid printing secret values or private roster rows.

## Session workflow

Every AI session should:

1. Open the canonical project directory.
2. Read `AGENTS.md` and `README.md`.
3. Load `.env.local` only through the application or a locked helper.
4. Verify the expected account/project before external reads or writes.
5. Never copy credentials into chat, Memory, shell profiles or another project.
