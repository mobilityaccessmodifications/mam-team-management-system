# Performance completion guards — forward candidate only

## Scope and authority

Only `20261017103000_performance_review_completion_guards.sql` is new database source. Its exact predecessor is the already committed `20261016150000_performance_reviews_and_mail.sql`; all 196 original migrations and `deploy-performance-reviews.py` remain immutable. This candidate is not production approval. The parent remains the sole Git/hosted/production operator. UI, mail activation, secrets, real employees and test messages are outside this change.

## Text domain

The existing 8000 UTF-16-unit limit is retained. Saving rejects C0 controls other than TAB/LF/CR, DEL, unpaired surrogates and XML-unrepresentable U+FFFE/U+FFFF. PostgreSQL itself rejects NUL and unpaired JSON surrogates before a JSONB RPC body can be stored. Accepted strings are neither trimmed nor replaced; required-field checks may inspect whitespace without rewriting it. The shared TS parser covers self/manager answers, summary, private note, meeting fields and document identity fields. SQL applies the domain to every mutation, new identity snapshot and every text used by the final Word budget. Existing directory and review data are not rewritten.

The Mail owner must synchronize its duplicated domain checks. An additional *actual schema-derived* name-width counterexample is retained in the completion evidence: 101 supplementary codepoints fit the canonical 120-codepoint name constraint but occupy 202 UTF-16 units and exceed the old n8n 200-unit bound. The corresponding downstream adjustment belongs to the Mail owner; do not alter the directory or truncate names. This is not the excluded 201-ASCII fixture.

## Exact canonical attachment size

The canonical renderer/questions and document DTOs are unchanged. The renderer stores five UTF-8 ZIP parts without compression. A source-derived empty manager skeleton, including every static paragraph, question, table, package part and ZIP header/name/directory/end record, is exactly 50189 bytes for MAM and 50161 for Equipsy. The skeleton has a non-null meeting with empty dynamic fields; its constant date/time separator and ` minutes` suffix are already included.

For each dynamic text value, normalize CRLF and lone CR to LF exactly as the unchanged renderer does. After removing LF/TAB, count UTF-8 bytes after XML escaping `& < > " '`. Add 39 bytes per LF and 40 per TAB: each delimiter introduces a 32-byte extra empty-capable text element plus a 7-byte break or 8-byte tab element. All other supported scalar values have identical UTF-8 byte counts in PostgreSQL and TextEncoder.

The SQL budget enumerates the actual renderer's fields and multiplicities: employee name/role/team, manager name, review code/cycle, twelve self answers, twelve manager answers, the seven rendered ratings, summary, two overall-rating occurrences, meeting date/time twice each, duration, mode, location and notes. Manager note is deliberately excluded. Both companies and every field placement, escaping, mixed CR/LF/TAB, supplementary Unicode, 8000-unit values, reported multiline cases and exact limit−1/limit/limit+1 are compared with real canonical output.

`mutate_performance_review` retains its original role/people locks and acquires the review row before checking CAS or computing feasibility. It builds the candidate meeting in the locked row value and rejects a budget above 2097152 with SQLSTATE `22023` before any final/held/version/event/operation/outbox write. The real Action already maps that SQLSTATE to the existing safe `invalid` result. Successful finalization, snapshot, audit, operation receipt and one outbox remain atomic. Exact operation replay remains before fresh validation, and unknown delivery holds are unchanged. No approval token, upload, storage or new notification protocol is introduced.

## Finite migration preservation contract

The core admits only PostgreSQL 16/17 with the matching stored predecessor fingerprint, exact 23 predecessor functions, four tables, two sequences and authorization anchors. It changes only the text predicate, start snapshot validation and final mutation guard; two owner-only pure internal byte functions are added. Exact after metadata covers all 25 functions and unchanged table/sequence definitions, ownership, ACLs, RLS, columns, constraints, indexes, policies and full portable trigger contracts.

The complete inherited all-schema security collector is extended only for the two named new functions. Protected data hashes include all existing Public/Private/Auth/Storage tables except the intentionally updated fingerprint, including existing performance rows and receipts, plus sequence state. Deferred effects are drained before each final comparison and after ledger insertion. Unknown metadata/data changes roll back; no observed baseline is silently adopted. Core support for PG16 does not make PG16 an admitted production target.

## Dedicated release helper

`deploy-performance-review-completion.py` is version-specific. It retains seventeen byte-identical finite components from the immutable predecessor helper; provenance is in the completion evidence. The helper requires exact MAM organization `fwlmbmospuwoaosffvmw`, project `xtwlrjqbusadghavchqm`, actor/session `postgres` and **major 17** at preflight, in-lock and recorded/readback branches. It binds the 196-file local history and the original 171-row raw hosted-history fixture plus the exact native-serialized performance predecessor row. Old hashes, before frames and journals are not changed.

Five explicit inputs are required: full reviewed committed HEAD, raw new helper SHA, transport SHA, new migration SHA and predecessor SHA. The clean tree, committed blobs, exact MAM origin/author, fixed runtime closure (including unchanged canonical Word/questions, DTOs, Actions and package/lock) and complete local migration set are rechecked around every external boundary. The supplied HEAD is the eventual integrated source, not a hard-coded future commit.

Use only from the clean reviewed repository, through the existing MAM credential wrapper, by the approved parent operator:

```text
python3 scripts/deploy-performance-review-completion.py inspect HEAD HELPER_SHA TRANSPORT_SHA MIGRATION_SHA PREDECESSOR_SHA
python3 scripts/deploy-performance-review-completion.py snapshot HEAD HELPER_SHA TRANSPORT_SHA MIGRATION_SHA PREDECESSOR_SHA /absolute/owner-only-dir/before.json
python3 scripts/deploy-performance-review-completion.py apply HEAD HELPER_SHA TRANSPORT_SHA MIGRATION_SHA PREDECESSOR_SHA /absolute/owner-only-dir/before.json BEFORE_SHA
python3 scripts/deploy-performance-review-completion.py readback HEAD HELPER_SHA TRANSPORT_SHA MIGRATION_SHA PREDECESSOR_SHA /absolute/owner-only-dir/before.json BEFORE_SHA
```

The private directory must already exist with mode 0700, outside the repository. Snapshot is read-only and exclusive-create. Apply writes one fsynced `20261017103000.entered.json` intent before the single transaction. Exact raw source recording, predecessor/raw-ledger equality, lock-time state equality, finite catalog transition, protected data preservation and schema refresh are one transaction. COMMIT returns the resulting catalog hash; a separately read native state must match that attestation before `attested`/`verified` receipts admit a recorded no-write branch. Readback also validates the original intent binding. An absent or uncertain COMMIT attestation remains HOLD even if the target looks recorded; never reset the intent or retry an unknown mutation. Plain inspect of a recorded target is metadata-only and does not claim preservation verification.

## Portable checks

Use an explicit task-owned scratch TMPDIR and installed binaries on PATH. No real credential or remote transport is used by these fixtures.

```text
node --test tests/performance-review-completion-text.test.mjs tests/performance-review-completion-word.test.mjs tests/performance-review-completion-helper.test.mjs
node --test tests/performance-review-completion.native.mjs tests/performance-review-completion-races.native.mjs tests/performance-review-completion-release.native.mjs tests/performance-review-completion-envelope.native.mjs
node --test tests/performance-review-completion-replay.native.mjs
npm run typecheck
node node_modules/eslint/bin/eslint.js src/lib/performance-review-rules.ts tests/performance-review-completion-*.mjs tests/performance-review-completion.native.mjs
```

The replay fixture uses the unchanged source-derived platform/role-plan seams, replays original SQL bytes in order and compares complete effective metadata. Its business probe uses only fresh synthetic people and rollback, exercising both companies' overflow and 8000-text positives through the effective raw RPC. It also records the unresolved Unicode-name wire boundary rather than disguising it as notification acceptance. Model CLI fixtures use real isolated Git state and inert management responses; native envelope fixtures execute real generated SQL with explicitly synthetic history, not hosted-ledger or GoTrue acceptance. Each owned cluster is socket-only and stopped/read back in `finally`.

The predecessor CLI fixture copies only its own 196-migration prefix; otherwise adding this legitimate successor makes the old helper's positive fixture fail its intentionally strict later-migration guard. All predecessor fixture functions/assertions and injected later-file denials remain byte-identical. The old production helper is unchanged.

The parent must integrate these dedicated SQL checks into its final combined gates without weakening existing runners. Fresh independent source-bound review, the downstream text/name synchronization, exact clean committed-source apply rehearsal, applicable global preservation/native Auth/browser gates and production target/readback remain required. Local GREEN is neither independent review nor release PASS.
