# Same-owned-ID performance mail continuation

## Boundary

This additive CLI corrects only the originally created inactive performance mail workflow. The parent is the sole native, credential, Git and production operator. Original creation, canonical attempt, output journal, stage packet/review, source closure and false activation/provider flags remain immutable. `AUTHORITY.json` is bound separately to the exact same-scope correction request; it is not a risk waiver.

There is no create, reset, retry, delete, credential mutation, business dispatch, webhook, identity probe or readiness operation. The fixed child is `/Volumes/UG/MAM/opencode/n8n/.performance-review-mail-v1/successor-correction-v1/`. No command accepts another namespace, journal, target, credential source or source environment. Existing correction children are rejected. Failed/uncertain operations leave a durable lock/HOLD, including fsync, source-finalization and secret-echo failures.

The new successor journal uses integer `schemaVersion: 2` and exactly `schemaVersion`, `scope`, `phase`, `versionId`, `dispatches`, `originalFailure`, `lastEnteredOperation`, and `sourceHold`. Successful continuation requires `originalFailure:null`, literal `sourceHold:false`, and a recognized completed GET operation. On failure, `originalFailure` is exactly `{type, code, operation}`: exact allowlisted built-in exception identities, literal known HOLD codes or the finite integer SystemExit codes `0/1/2/73`, and a fixed entered-operation token; unknown identities/codes become `UnknownError`/null. Each value is secret-screened before persistence. No raw exception message, provider body, header or token is retained. `sourceHold` is independently sticky and cannot replace the primary failure or its entered operation. If diagnostic persistence fails, the operation remains failed and unretryable; storage may retain only the prior unknown intent and a pending file. Durable diagnostics are not guaranteed when storage fails. Historical creation journals retain their original schema and bytes.

`prepare` is credential-free and read-only. It loads the original and current publisher into distinct byte-snapshot namespaces, verifies original stage/receipt/readback/source pins, and generates the candidate using the current measured builder and mail Code sources. It reports `nativeReady: false`. The unchanged publisher helper is pinned; the current builder/validator and entire independently reviewed current-source map are not permanently pinned to this seed. Other workflows' same-basename sources cannot shadow the mail builder inputs.

## Parent commands

First local command from the final independently reviewed checkout:

```sh
python3 -B scripts/continue-performance-review-mail-workflow.py prepare
```

Capture its stdout in a new parent-owned evidence file, not in the original stage directory. Before the first native operation, the parent follows the n8n project's required connection policy and runs its original `python3 scripts/verify.py` from `/Volumes/UG/MAM/opencode/n8n`. No implementation child performs this native step.

After independent correction admission and fresh supported safety/source evidence:

```sh
python3 -B scripts/continue-performance-review-mail-workflow.py correct-inactive --parent-correct-inactive < /absolute/parent-owned/correct-packet.json
```

This reserves/fsyncs the fixed child and intent before configuration/transport, verifies MAM using the original verifier/loader, GETs only the owned ID, and requires the original saved version, inactive state, explicit null publication, exact original graph/settings and independently approved retained baseline. It makes one PUT with exactly `name`, `nodes`, `connections`, `settings`, and explicit original `staticData`. No `active`, version/CAS, folder, metadata or ownership mutation is sent. The acknowledgement must supply a new valid saved version; the first exact GET must match that version and the entire fixed successor. The acknowledged version, not an observed latest version, is retained.

After separately authored activation admission, current source publication/deployment, provider support and safety evidence:

```sh
python3 -B scripts/continue-performance-review-mail-workflow.py activate-successor --parent-activate-successor < /absolute/parent-owned/activate-packet.json
python3 -B scripts/continue-performance-review-mail-workflow.py readback < /absolute/parent-owned/readback-packet.json
```

Activation is one POST with only `{versionId: EXACT_ACKNOWLEDGED_SUCCESSOR_VERSION}`. It requires the successful same-child correction state and exact latest inactive GET before intent. Acknowledgement plus an independent GET compare saved draft and expanded publication separately, including present/null distinctions and every supplied nested workflow/version identity. Missing inner metadata is admitted only under the pinned installed public projection contract and strict outer version. Readback is GET-only and supports inactive as well as active successors without granting activation. The verifier's sample GET is also read-only. A pre-GET is not server-side CAS.

`ACTIVATED_VERIFIED` means the REST saved/publication representation was verified. It does not mean publication-outbox drain, every trigger registration, permanent scheduler liveness, provider sending, recipient delivery or People Hub enablement completed. The existing parent observer/release gates still own those checks. Do not call the existing readiness branch to repeat AI identity verification or use a business route as a probe.

## Closed packet

Stdin is at most 1 MiB and has exactly:

```text
schemaVersion: integer 1
closure: {schemaVersion: 1, sourceHashes: map, externalHashes: map}
originSha256: prepare output
expectedGraph: prepare's entire actual builder graph
evidence: {files: map, claims: map}
review: independently authored closed consumer object
```

There is no free update payload. `expectedGraph` must equal the actual current snapshot-backed builder. Name, paths, node identity/order, credentials, topology, settings, URLs, authentication, schedules, options and non-target parameters are preserved. Only the reviewed payload validator, finite HTTP body representation fields and the exact supported send-response `outputPropertyName: body` correction may differ from the original.

`closure.sourceHashes` must cover all original publisher runtime inputs plus this CLI, its tests, both portable helpers and this document. The parent may extend it to the full independently reviewed candidate source inventory; every listed file is measured and checked. `externalHashes` are the original MAM verifier and HTTP supplement, never a credential file. Source/evidence paths are confined to the approved MAM source/evidence/captured-runtime roots; sensitive files, escape paths, nonregular files and symlinks are rejected before opening. Current review/source/body bindings are checked before reading supplemental artifact bodies, and all loaded dependencies are held as measured bytes with normal and exceptional custody checks. These checks assume a trusted Python/stdlib image and local source custody; they are not arbitrary-root-code attestation.

Each `evidence.files[ROLE]` is exactly `{path: ABSOLUTE_CANONICAL_PATH, sha256: RAW_SHA256}`. Each `evidence.claims[CLAIM]` is exactly `{file: ROLE, pointer: OBJECT_JSON_POINTER, expected: TYPED_APPROVED_VALUE}`. Empty pointer selects the whole object. The claim is compared to the actual SHA-held artifact at that pointer; Boolean substitutes cannot impersonate counts, versions, maps or grants. The independent reviewer must verify the named producer's meaning, scope, currentness and complete evidence map, not approve newly invented booleans.

Required claims and actual suppliers:

| Claim | Required value / producer |
| --- | --- |
| `baseline` | Parent's exact-ID full inactive workflow GET snapshot: original ID/version/graph/settings; explicit `activeVersionId:null`, `activeVersion:null`, `staticData`, nonempty original project sharing, `isArchived:false`; retained optional fields preserve presence and type. It is an independent oracle, not adopted from this CLI's pre-GET. |
| `mailMode` | Literal `disabled` from the current approved Hub configuration/DB observation. |
| `outboxPending` | Integer zero for the approved new performance notification queue scope, supplied by the parent DB observer. No all-database quiescence, permanent empty history or execution-retention-off proof of never-run is required. |
| `singleWriter` | Literal true from the parent current exact-owned single-writer/fence proof; the reviewer verifies that producer's actual scope. |
| `currentSource` | Exact current closure source map, extended to the full reviewed candidate when appropriate; comes from measured Git/source publication evidence, not an alias called latest. |
| `publication` | Normal parent Git publication readback: exact MAM repository, `branch: main`, full `head`, nonempty `publicationId`, `verified:true`. No future HEAD is guessed. |
| `previousDeployment` | Separately pinned original deployment/source artifact with its actual full head. It is not replaced by the successor alias. |
| `deployment` | Exact current MAM project/origin, real `deploymentId`, full head matching publication, `state: READY`, and the verified current `sourceHashes`. Normal parent publication/deployment receipts provide these fields or a separately reviewed source-bound projection. |
| `providerGraph` | Activation only: exact canonical SHA-256 of this current builder graph from the parent's independent current provider compatibility artifact. |
| `providerSupported` | Activation only: literal true from that source-bound provider support verdict, never copied from the historical false flag. |
| `providerSources` | Activation only: nonempty map of concrete captured-runtime evidence-role hashes; every entry must exist and match `evidence.files`. The reviewer checks coverage of every emitted native node/version and real callback/body/empty-202 contract. |

Required installed protocol file roles have concrete existing suppliers:

- `installed-openapi`: `Q/native-installed-runtime-r2/app/dist/public-api/v1/openapi.yml`.
- `installed-handler`: that snapshot's `app/dist/public-api/v1/handlers/workflows/workflows.handler.js`.
- `installed-manifest`: `Q/native-installed-runtime-r2/manifest.json`.
- `installed-service`: `/Volumes/UG/MAM/opencode/n8n/outputs/status-history-fresh-start-20261015/native-core-contracts/dist/workflows/workflow.service.js`.
- `installed-core-manifest`: that directory's `manifest-final.json`.

Here `Q` is the immutable original `qa-evidence/performance-release-20261016` directory. Both source acquisitions identify the same MAM container. Their manifest bytes, sizes and role hashes are checked; public documentation is not represented as installed evidence. The captured schema permits the finite PUT fields and explicit retained staticData. The handler calls update with `forceSave/publicApi/publishIfActive`; the service preserves stored settings through merge/normalization and publishes only an already-published target. Hence inactive preflight and the actual single-writer/disabled fences remain required, not optional guards.

For activation/active readback, include:

- `schedule-source`, `schedule-generic`: the same public runtime snapshot's ScheduleTrigger and GenericFunctions files, bound by its manifest.
- `workflow-static-source`: `/Volumes/UG/MAM/opencode/n8n/outputs/invoice-review-copy-20261015/runtime-source/workflow.js`.
- `workflow-runtime-metadata`: that capture's `installed-runtime-metadata.json`, which binds the same MAM container and n8n version.

For the unchanged Schedule Trigger 1.2 / every-five-minutes graph, these producers initialize only `node:Every Five Minutes.recurrenceRules` and `.recurrenceRuleSignatures` to serialized `[null]`. The validator permits original staticData or exactly that finite initialization with every existing unrelated field retained. It rejects unrelated changes, strings substituted for objects, changed types, non-null protected recurrence history or truncation of prior history. The captured actual trigger/getter oracle executes in memory with inert registration and zero emit; it is not a native activation or provider acceptance. No history is cleared to obtain a pass.

The review has exactly:

```text
schemaVersion, reviewer, independent, passed, security_concerns, logic_errors,
sourceHashes, evidenceHashes, packetSha256, gates, expectedWorkflow, validUntilUnix
```

Require integer schema 1, an independent non-owner reviewer, literal `independent/passed:true`, empty findings, and exact map coverage. `sourceHashes` equals every closure source hash, every `external:NAME` hash and `$closure = SHA256(canonical closure)`. `evidenceHashes` equals every file-role raw hash. `packetSha256` hashes canonical packet bytes excluding `review`. `expectedWorkflow` is exactly `{id, versionId}`: original version for correction, acknowledged successor for activation/readback. `gates` has exactly `correct-inactive`, `activate-successor`, `readback`, `create`, `reset`, `dispatch`; all are literal Booleans, obsolete permissions remain false, and only the current operation needs true. `validUntilUnix` is an independently authored integer expiry for the fresh evidence/approval; it is checked at admission and again after the last target GET before a PUT/POST intent. An expiry does not authorize replay or waive any current gate.

The parent can bind actual existing producer schemas using JSON pointers, or supply a separately independently reviewed projection with the original source/evidence pins retained. No new remote collector/capability is assumed. Missing actual current proof holds only its dependent external operation; synthetic positive proofs establish local executability, never fill those native gaps.

## Verification and handoff

Focused standard test entry:

```sh
node --test tests/performance-review-n8n-successor.test.mjs
```

The file is included by the existing `npm test` glob; no CI/dependency scripts are changed. Python fixture traps real network, environment, credential-file access, subprocesses and real MAM writes before product compilation, and preserves transport class identity. The actual public `main`/argument/packet/native adapter/journal path runs with synthetic HTTPS responses and real file/directory fsync. The portable gzip holds byte-exact original source and captured public runtime code; it contains no real staff or credential values. Optional test artifact indexing is a test-only collector, not an operator option.

Normal and exceptional source hashes, actual compile-buffer origins, entered API calls, operation stdout/stderr/exits, no-retry/HOLD state and original-history equality are retained. Failed tests and setup/collector failures stay failed and are reconciled separately from genuine TDD REDs. Final independent review and all actual external/publication/production gates remain parent-owned and unexecuted by this implementation owner.
