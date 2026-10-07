<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# MAM Team Management System

This is the internal team-management portal for Mobility Access Modifications (MAM). The first product area is leave visibility and manager approval. It is not a public customer portal.

## Source of truth

- Trello card: project priority, owner, due date, and delivery status.
- `README.md`: setup, commands, deployment, and current phase.
- `docs/business-rules.md`: confirmed workflow rules and open decisions.
- `docs/architecture.md`: technical boundaries and data flow.
- `supabase/migrations/`: versioned database schema.
- Git history: implementation history. Do not store current status only in chat or Memory.

## Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Lint: `npm run lint`
- Type-check: `npm run typecheck`
- Production build: `npm run build`
- Full verification: `npm run check`
- Discover Supabase CLI commands: `npx supabase@latest --help`

## Account targets

- GitHub owner/repository: `mobilityaccessmodifications/mam-team-management-system`.
  Run every GitHub command with the MAM-scoped profile:
  `env GH_CONFIG_DIR='/Users/nixon/.github-profiles/mam' gh <command>`.
  Before any GitHub write (push, PR, merge, or release), run the exact
  read-only identity check
  `env GH_CONFIG_DIR='/Users/nixon/.github-profiles/mam' gh api user --jq .login`
  and require exactly `mobilityaccessmodifications`. If sandbox, Keychain, or
  network isolation prevents the check, retry the identical command with
  system-level execution. Never substitute an unscoped `gh auth status`, run
  `gh auth login`/`logout`, or start browser/device authentication from an
  ambiguous failure.
- Vercel project: `ai-7033s-projects/mam-team-management-system`. Always use
  `npx vercel --global-config '/Users/nixon/.vercel-profiles/mam' <command>`.
  Production is deployed only by merging the reviewed GitHub branch into the
  configured production branch. Never run `vercel deploy` or `vercel --prod`.
- Supabase organization/project: `fwlmbmospuwoaosffvmw` /
  `xtwlrjqbusadghavchqm`. Run every remote Supabase command from this repository
  through the credential helper:
  `"$HOME/Documents/Codex/bin/codex-project-credential" exec supabase -- <command>`.
  For CLI discovery, the child command may be
  `npx --yes supabase@latest projects list --output-format json`. Verify the
  exact organization and project ref before reads or writes. Never run
  `supabase login`, an unwrapped remote command, or native `--profile`.
  Retry sandbox, Keychain, and network failures system-level through the same
  wrapper. When the approved Management API database-query route supports the
  task, use the saved access token and do not request a database password.
- For every People System n8n operation, follow
  `/Volumes/UG/MAM/opencode/n8n/AGENTS.md` and its Required n8n connection
  policy. Run `python3 scripts/verify.py` from that n8n project root, and retry
  the exact verification system-level after a sandbox/network failure. Never
  use a global n8n MCP/browser session or request a key from an unverified
  failure.

### GitHub and Vercel write preflight (mandatory)

GitHub login and the Git author are separate identities. Complete every check
at the stage where it applies: checks 1, 3, and 4 are local branch/commit
preflight; add checks 2 and 5 before push/PR/merge; add checks 6 and 7 before a
release. GitHub connectivity is not required to branch, edit, test, or commit
locally. If the system-level API check is unavailable, continue safe local work
and stop only the affected remote operation. Classify authentication failures
under the global evidence rules and never "correct" them by starting a login
flow.

1. Confirm the remote is exactly
   `https://github.com/mobilityaccessmodifications/mam-team-management-system.git`:
   `git remote get-url origin`.
2. Run the exact MAM GitHub identity check defined above. Never rely on the
   default/global `gh` profile or treat a sandbox-only failure as an invalid
   session.
3. Set and verify this repository's local commit identity (never a global
   identity):
   `git config --local user.name mobilityaccessmodifications`
   `git config --local user.email
   '310802599+mobilityaccessmodifications@users.noreply.github.com'`.
   Then verify both values with `git config --local --get`.
4. Inspect the author before pushing:
   `git show -s --format='%an <%ae>' HEAD`.
   It must be the MAM identity above. Never push commits authored as
   `forgerealestate`, Forge, Insider Leads, a personal account, or another
   project identity. A correct GitHub API identity check does not fix a wrong
   commit author.
5. Verify the branch and PR target are `main`; inspect PR metadata with
   `env GH_CONFIG_DIR='/Users/nixon/.github-profiles/mam' gh pr view <number>
   --json baseRefName,headRefName,author,mergeCommit`.
6. Treat any Vercel author/access or project mismatch as a hard stop. Fix the
   commit identity or target project instead of bypassing the integration.
7. Before a production release, verify the MAM Vercel project with
   `npx vercel --global-config '/Users/nixon/.vercel-profiles/mam' project inspect
   mam-team-management-system`.

Never use Forge, Insider Leads, or another project's GitHub/Vercel/Supabase
profile for this repository. A project-local `.mcp.json`, when present, is for
read-only inspection and is not authentication evidence; never use a global or
unverified MCP connection as a fallback.

## Architecture

- Next.js 16 App Router with TypeScript.
- `src/app/`: routes and server-rendered pages.
- `src/components/`: shared UI and small client boundaries.
- `src/lib/supabase/`: browser/server Supabase clients.
- `src/proxy.ts`: cookie refresh and optimistic authentication redirect only; authorization still belongs in server code and RLS.
- `supabase/migrations/`: RLS-first schema migrations.
- Vercel: hosting and development/preview/production environment variables.

## Safety

- Never commit `.env`, `.env.local`, `.vercel/`, Supabase secret keys, service-role keys, staff records, leave reasons, or exports.
- Frontend code may use only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Never put a Supabase secret/service-role key in any `NEXT_PUBLIC_*` variable.
- Enable RLS on every table exposed through Supabase's Data API. Authentication alone is not authorization.
- Never authorize from user-editable `user_metadata`; use database membership/role records or controlled `app_metadata`.
- Every Server Action must re-check authentication, authorization, and input.
- Production database migrations, authentication settings, and deployments require an explicit target check and approval.
- Treat HR, leave and employee information as confidential. Use synthetic fixtures in tests and screenshots.

## Environment model

- An AI/chat session is not an environment.
- Supported environments are `development`, `preview`, and `production`.
- Local development reads one gitignored `.env.local` for this project.
- Vercel stores separate encrypted values per environment; do not copy production secrets into local development.
- Separate sandboxes are appropriate only for genuine identity boundaries, such as MAM admin Outlook versus marketing Outlook.
- `.env.example` contains variable names and safe descriptions only.

## Business rules

- The portal uses durable, authenticated Supabase projections for its released directory, account, leave, check-in, asset and subscription surfaces; it does not use synthetic preview tables.
- Before expanding live leave or People workflows, confirm the remaining delegation, overlap, category, retention, credential-handover and onboarding/offboarding decisions in `docs/business-rules.md`.
- Employees must not see another employee's private leave reason by default.
- A due date on the delivery project is not the same as a staff leave date.
- The manager rollout date must be distinguished from the all-staff release date.
