# ADR 0001: Next.js, Supabase and Vercel

- Status: accepted
- Date: 2026-08-03
- Updated: 2026-08-13

## Decision

Use one Next.js App Router application on Vercel with Supabase providing username/password authentication, the real MAM/Equipsy directory and Postgres authorisation data.

The browser uses only a publishable key constrained by RLS. A server-only Supabase secret key is permitted solely for username resolution and account-management Server Actions after the caller has been authenticated and authorised by controlled database records.

## Why

- One TypeScript codebase keeps a small internal system maintainable.
- Vercel provides Git-based deployments and separated environment-variable scopes.
- Supabase provides managed Auth, Postgres, Storage and RLS without a separate API service.
- Next.js Server Actions provide a narrow boundary around Auth Admin operations while database functions and RLS remain the authorisation source of truth.
- Supabase Auth stores passwords non-reversibly, so administrators can set replacements without the application retaining or revealing existing passwords.
- Sydney is the preferred production region for Australian staff, subject to MAM account and data-residency confirmation.

## Constraints

- RLS is mandatory on every table exposed through the Data API.
- Client code receives only browser-safe publishable values.
- The secret/service-role credential is server-only and may never use a `NEXT_PUBLIC_*` variable.
- Server Actions re-check authentication, administrator permission, input and optimistic version.
- Account login names and status are visible to authorised administrators; existing password values are not retrievable.
- A View-as selection never impersonates a Supabase user or changes database permission.
- Real production roster and account data cannot be copied into Development or Preview.
- Durable leave and People workflow persistence waits for confirmed business and privacy rules.
