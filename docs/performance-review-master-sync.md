# Performance Review → MasterReviews

## Status and boundaries

This candidate implements the local automatic integration. It is not a production installation, provider acceptance or release approval. `target.json`, the database target and the application mode all default to disabled. The approved synthetic TEST workbook is not a production staff-data destination. No file creation, workbook resizing, ACL changes, email, calendar or historical backfill is implemented.

The source of truth is `private.performance_reviews`. A deferred row trigger reads the final committed row shape, builds an explicit 53-value projection, and changes the durable desired generation only when that visible projection changes. Finalisation's intermediate UPDATE and its frozen-document UPDATE consolidate into one generation. No event-ID watermark is used.

The column order is `deploy/n8n/performance-review-master-sync-v1/schema.json`. It matches the accepted preview exactly:

- Identity, company, team, year, title and manager name are always projected.
- Employee answers appear only after employee submission.
- Manager answers, seven ratings, overall rating and summary appear only while manager completion is current. Saving manager edits clears completion and removes that assessment from the projection.
- Committed meeting metadata is projected without implying that the meeting was held. Meeting notes appear only in the frozen final record; held date is the meeting date, not the later confirmation date.
- The private manager note is never selected into the Master projection, content hash, job or Excel payload. Employee DTOs, Word and Careers code are unchanged.

The cutover is a commit-time boundary. Disabled installation scans no existing reviews. A later visible committed change to an older review can create its first desired generation. Draft-only, private-note-only changes while incomplete, failed commands, receipt replays and rolled-back writes do not create new visible work. Archiving, access revocation and missing query membership are not deletion commands.

## Independent delivery protocol

The three new private tables force RLS and deny direct access to PUBLIC, anon, authenticated and service_role. Four SECURITY DEFINER public RPCs are granted only to service_role:

1. `claim_performance_review_master_sync(text,integer)` reserves one target-wide writer and one stable slot. The claim carries the closed job, its content hash, target fingerprint and reserved slot identities.
2. `begin_performance_review_master_sync(uuid,uuid,bigint,text,text)` durably enters once. An unentered superseded generation can be coalesced; an entered generation is never reclaimed by age.
3. `finish_performance_review_master_sync(uuid,uuid,bigint,text,text,jsonb)` settles only an exact target/key/generation/range/value receipt. SQL NULL and JSON null are both accepted for outcomes without a receipt. Old exact receipts are idempotent and cannot lower a newer applied generation.
4. `reconcile_performance_review_master_sync(uuid,uuid)` returns a no-write decision. A known settled write awaiting readback admits GET-only reconciliation. An unknown or merely entered attempt remains HOLD, even if a later GET happens to match.

An active attempt blocks every later writer to the same target. Desired generations continue to accumulate while the writer is active. `unknown` is sticky and never releases the target. Lost claim/begin acknowledgements have no automatic expiry or resend path. There is deliberately no general reset/retry RPC.

`POST /api/performance-reviews/master-sync` has its own dedicated Header Auth secret, fixed application origin, exact path, bounded JSON reader and phase/field allowlists. It uses non-retrying SDK RPCs. `readiness` is structural and does not claim work or read employee rows. Browser cookies, role labels and caller-selected identities or URLs confer no authority. The exact Proxy exception does not bypass sibling paths; the handler still authenticates every call. Sandbox startup refuses the new outbound secret and any non-disabled Master mode.

## Excel and n8n

`validate-job.mjs`, `project-row.mjs` and `classify-result.mjs` form a pure target/schema-bound adapter and its executable orchestration. The independent builder embeds the same validators/planner in a Master-only graph:

```sh
python3 -B scripts/build-performance-review-master-sync-workflow.py
```

It emits an inactive graph with a disabled five-minute schedule for the sealed default target. It contains separate placeholder Header Auth bindings for the Hub and the approved AI Gateway connection; no credential value is embedded or loaded by the builder. The graph has no Careers, Outlook, Word, calendar, row-add or workbook-creation branch. Execution persistence, progress persistence and retries are explicitly disabled.

Before and after the one range PATCH, the adapter verifies the exact drive/item/document/parent, worksheet, table, 53 column IDs and names, headers, totals state, data-body dimensions, key census and owned row. Addresses derive from the bound table offsets, including non-A1 tables. Duplicate keys, unknown UUIDs, foreign rows, capacity/schema drift, formulas and unproved cell formats stop the write. PATCH acknowledgements and subsequent GET readback are validated separately. A malformed acknowledgement becomes unknown; a valid known-settled acknowledgement followed by a failed GET becomes readback_pending.

Writes contain only `values`, never formulas or apostrophe-altered comments. String cells must already have Text format; a numeric meeting duration requires the approved numeric format. Local inert-provider tests preserve literal `=`, Unicode and line breaks exactly. **These tests do not prove Microsoft Excel's native formula/text semantics.** Native formula safety and the exact production formats remain admission conditions.

**GET → PATCH → GET is not CAS.** The database fence coordinates only callers using this protocol. It cannot exclude a human coauthor, table sort, another workflow or an administrator with provider credentials. Production stays disabled until the real target has an independently accepted exclusive-writer/coauthor boundary. A matching read after a transport-unknown write does not establish remote quiescence and cannot clear HOLD.

## Local verification

Use an active-profile scratch TMPDIR and PostgreSQL 17 binaries on PATH. No database URL, hosted secret or installed Auth service is required:

```sh
node --test tests/performance-review-master-sync.test.mjs tests/performance-review-master-sync-route.test.mjs tests/performance-review-master-sync-workflow.test.mjs
node --test tests/performance-review-master-sync.native.mjs
npm run check
```

The native suite uses the existing owned socket-only PostgreSQL harness, synthetic identities and ordinary authenticated SQL claims. It executes real business RPCs, the actual Proxy/handler exports, real service SQL and the inert Excel writer. Separate concurrent connections exercise one-writer admission. The inverse-event-commit case uses native-shaped owner fixture transactions: existing business RPCs hold the unchanged global role-control lock and serialize that scenario before event allocation. It is not a claim that those business RPCs committed concurrently.

Migration `20261019000000` preserves old table data, routine/catalog/security metadata, roles, memberships, default ACLs, policies, RLS and sequence state around its additive change. It checks the captured purge predecessor, holds existing user tables NOWAIT, validates the new feature's complete native PostgreSQL 16/17 metadata and advances the purge fingerprint only inside the protected transaction. The before/after checks do not establish global provider-DDL exclusion after the final observation. That installation-authority boundary remains a parent release gate.

## Release and recovery gates

Do not replay migrations 196/197 or loosen their pending-version guards. The new migration is unpublished. This candidate does not supply a production migration/ledger installer or an n8n publisher. A source/ledger/security-bound successor installer, publication path and independent review are still required before external application; none may reuse the stopped original initial-operation route.

Before real records flow, the parent must also resolve production target/readers, fresh exact schema and format readback, provider write capability, exclusive writer admission, new dedicated credential bindings, inactive graph readback, application publication and forward cutover. Do not promote TEST sample rows or its ACL to that acceptance.

Retain unknown attempts and their target HOLD. For readback_pending, use the original job/claim and the adapter's read-only reconciliation mode; it cannot PATCH. Unknown/entered outcomes need separately approved remote-settlement evidence and recovery authority; this candidate intentionally cannot clear them. Never change Careers state, repeat finalisation or send compensation mail to repair Master.

The frozen handoff records actual RED/GREEN logs, interrupted/failed gates and remaining conditions. A focused local PASS is not a passing full release gate or permission to commit, push, merge or activate.
