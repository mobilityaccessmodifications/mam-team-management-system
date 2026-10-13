# MAM OpenClaw self-service leave

## Current protocol: standalone Confirm (v3)

Only `mam_leave_prepare` is model-visible. It accepts leave details, never a
phone, name, person/user ID, employment classification, manager or confirmation.
The trusted WhatsApp account, sender and direct-chat session select the caller.
The model calls it only after explicit leave intent, never for greetings,
startup or general policy questions. No standalone profile tool is registered.

Preparation reads a complete authoritative People snapshot, defaults casual/ABN
to Unpaid leave where no type was supplied, and asks only for missing fields.
An unavailable explicitly requested type is not silently changed. A nonblank
employee note is required; missing notes return `needs_input`. The server renders Name, Dates, Type and Note, plus times/timezone for
part-day requests. The summary contains no repeated submission instructions.

Preparation also checks the portal's 14-calendar-day notice policy using the
current Melbourne date and the authenticated sender's authoritative employment
type. Non-ABN Annual/Unpaid requests starting earlier are stopped as soon as
type and start date are known, without collecting the remaining fields. The
existing `needs_input` response carries an English manager-contact instruction
and no missing fields, summary or draft token. The unchanged native adapter
clears any older draft and passes the instruction to the model; Confirm cannot
submit that blocked preparation. ABN unpaid and Sick/Carer's requests retain
their existing eligibility rules. The database insert-time notice guard remains
the final enforcement layer, including for older drafts. No manager override
or on-behalf capability is exposed through WhatsApp.

The follow-up says: "Send Confirm within 10 minutes to submit your latest summary
for manager approval, or tell me what to change." WhatsApp Reply is not required.
A quoted Confirm is also accepted only if it refers to the current summary;
an explicit old quote never falls back to a newer application.

### No People database writes before confirmation

v3 preparation is read-only. An authenticated, encrypted ten-minute draft token
and the actual summary delivery receipt remain in the single Gateway owner's
memory. The token is never included in model-visible content/details, logs or
WhatsApp messages. There is no v3 `shown`, `revise` or profile HTTP operation.
This does not change OpenClaw's separate conversation-history retention policy.

An incoming non-Confirm turn invalidates the previous unsubmitted draft before
the model collects edits. New preparation replaces it, including when input is
missing or validation/delivery fails. Stale tool factories and late preparation
results cannot restore old drafts. Sends are serialized per conversation so an
earlier in-flight summary cannot arrive after its replacement.

Only the trusted inbound handler may submit. It requires a real later Confirm,
the same sender/account/session, the latest memory draft, a real provider
receipt, current send permission and an unexpired token. No quote is invented.
Latest-draft selection is a single-Gateway memory guarantee, not a database
current-draft pointer. Restart loses pending drafts and requires new preparation.

The People backend verifies the token, current identity/name/employment, leave
rules and actual signed confirmation packet. One confirm-only transaction
creates the formal Pending request, normal reviewers/outbox, and successful
replay/nonce records. No new database draft exists before human confirmation.
After a verified submission (including a successful confirmation replay), the
HTTP route schedules the same request-scoped notification dispatcher used by
the portal through Next.js `after`. Mail does not delay the WhatsApp submission
response or turn an already-committed request into a reported failure. The
existing queue claims, recipient rules and stable delivery keys remain in force;
the MAM n8n five-minute queue worker remains the retry fallback. Preparation and
rejected confirmations never schedule email, and this path never drains unrelated
requests or creates another notification event.
Existing v1/v2 HTTP packets are refused with a restart-required response; old
stored protocol records follow the existing cleanup schedule, not ad-hoc deletion.
Approval, rejection, cancellation and applying for another person remain absent.

### Retry and ordering

Once a draft exists, repeated preparation with the same normalized tool payload
in the same incoming turn reuses its delivery receipt, including waiting
for an in-flight send. It does not call the bridge again, send another summary,
or extend expiry. A new incoming message or changed payload retains the existing
replacement flow; no cross-turn or cross-person response cache is introduced.
If callers overlap read-only bridge requests before either produces a draft,
the existing latest-revision check allows only the winning result to send.

A Confirm freezes its token, provider event ID and exact payload before network
work. Duplicate delivery never selects a later draft. Parallel confirms share
one submission; subsequent confirmations return the completed result. A lost
response retains the same packet for retry and blocks replacement until the
outcome is known. An edit received after confirmation cannot undo that submission.
The database revalidates identity, serializes nonce/event retries and protects
against overlap; confirmation records and leave/outbox changes roll back together.

Native WhatsApp timestamps guard against an old delayed Confirm selecting a new
summary. No receipt, missing provenance, expiry or restart fails closed with a
short English instruction, not a fabricated success.

## Native delivery and permissions

Tested target: OpenClaw 2026.9.4. Tool-only registries may lack WhatsApp adapters.
The Gateway service resolves the public adapter once and shares only its narrow
capabilities/state through the official runtime store. Discovery cannot start,
replace or stop an existing owner.

Codex's `message_tool` default suppresses automatic text returned from
`before_dispatch`. Confirmation feedback therefore uses a narrow explicit send
to the authenticated current DM and returns only `{handled:true}`, avoiding
duplicate automatic replies. Before submission and sending, the plugin reads the
current native session entry and applies the SDK's `resolveSendPolicy`. Missing
sessions and real deny policies remain denied. No global visible-reply, exec,
allowlist, group, model or automation permission is broadened.

Only fixed employee-facing status text is sent by this path. Draft summaries
use a literal block, exact digest and a verified provider receipt; truncation or
sanitization changes are rejected before sending. Errors log fixed stage/code
labels only, never exceptions, employee data, tokens or notes.

## Verification

Offline unit checks (synthetic identities, fake fetch, no environment credentials):

```sh
node --check integrations/openclaw-leave/index.js
node --test tests/openclaw-leave-plugin.test.mjs
npm test
npm run lint
npm run typecheck
npm run build
```

`scripts/verify-openclaw-leave-native.mjs` runs the installed SDK, public native
session-store/send-policy functions, real WhatsApp adapter and inbound mapper
with an offline listener and synthetic People responses. It blocks sockets,
reproduces Codex automatic-reply suppression, verifies an explicit reply reaches
the simulated channel, checks native session deny, and exercises hidden tokens,
standalone confirmation, duplicate events, formatting and service stop.
It is not a real-channel or production-database E2E test.

Use an isolated `OPENCLAW_STATE_DIR=/tmp/mam-leave-native.<suffix>` and matching
`OPENCLAW_CONFIG_PATH=<state>/config.json`, an empty process environment, and
the installed OpenClaw root, WhatsApp root and staged plugin root as arguments.
Native plugin build/validate also run only against a staged directory and
isolated state. Never resolve an unpinned new OpenClaw package during validation.

## Authorized release sequence

1. Verify exact MAM GitHub, Supabase, Vercel and saved SSH targets.
2. Complete focused/full tests, synthetic PostgreSQL, native checks and review.
3. Apply only reviewed additive `20260921150000_openclaw_confirm_only.sql`
   through the hash-pinned MAM credential-helper deployment script.
4. Merge the reviewed GitHub PR to main and verify GitHub-triggered Vercel
   production; never deploy local application code directly to Vercel.
5. Copy only the matching reviewed plugin source and MAM workspace-rule block
   to the approved VPS, keeping a rollback backup, then restart the service.
6. Verify hashes, plugin registration, service/channel health and unchanged
   access restrictions without creating leave or sending WhatsApp test messages.

Existing process-only settings remain `MAM_OPENCLAW_LEAVE_ENABLED`,
`MAM_OPENCLAW_LEAVE_BRIDGE_URL`, `MAM_OPENCLAW_LEAVE_BRIDGE_SECRET` and
`MAM_OPENCLAW_LEAVE_ACCOUNT`. The secret stays in the protected service
environment, separate from allowlist credentials. No People database credential
is placed on the VPS. A successful build alone does not authorize release.
