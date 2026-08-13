# ADR 0001: Next.js, Supabase and Vercel

- Status: accepted for foundation
- Date: 2026-08-03

## Decision

Use a single Next.js App Router application on Vercel with Supabase providing username/password authentication and Postgres. The foundation review uses one pre-provisioned administrator account; its password is managed only in Supabase Auth and is never stored in source or environment variables.

## Why

- One TypeScript codebase keeps a small internal system maintainable.
- Vercel provides Git-based previews and separate environment-variable scopes.
- Supabase provides managed Auth, Postgres and RLS without requiring a separate API server for the first phase.
- Next.js can verify the authenticated account server-side before opening the HR master view, while Supabase RLS and the database HR allowlist remain the write-authorisation boundary.
- Sydney is the preferred Supabase region for Australian staff, subject to MAM account and data-residency confirmation.

## Constraints

- RLS is mandatory on every exposed table.
- Client code receives only the publishable key.
- Manager authorization will not be invented before MAM confirms reporting lines and delegation.
- Production staff data cannot be used in development or preview.
- The administrator's View-as selector changes only synthetic demo context; it never impersonates a Supabase user or changes database permissions.
- Supabase authentication and the separately approved synthetic email-review transport remain independent boundaries.
