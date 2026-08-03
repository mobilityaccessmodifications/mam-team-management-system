# ADR 0001: Next.js, Supabase and Vercel

- Status: accepted for foundation
- Date: 2026-08-03

## Decision

Use a single Next.js App Router application on Vercel with Supabase providing passwordless authentication and Postgres.

## Why

- One TypeScript codebase keeps a small internal system maintainable.
- Vercel provides Git-based previews and separate environment-variable scopes.
- Supabase provides managed Auth, Postgres and RLS without requiring a separate API server for the first phase.
- Sydney is the preferred Supabase region for Australian staff, subject to MAM account and data-residency confirmation.

## Constraints

- RLS is mandatory on every exposed table.
- Client code receives only the publishable key.
- Manager authorization will not be invented before MAM confirms reporting lines and delegation.
- Production staff data cannot be used in development or preview.
