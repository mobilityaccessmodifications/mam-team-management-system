# MAM OpenClaw self-profile and leave plugin

This is a native OpenClaw plugin for MAM People self-profile lookup and
self-service leave. It is deliberately not a bare MCP identity boundary.

## Status and source

The self-profile and leave plugin is released through GitHub (PRs #121–124).
The historical validation notes below describe earlier artifacts, not the current
runtime. Do not use their hashes as current release verification.

### Gateway-owned delivery correction

OpenClaw 2026.9.4 can execute optional plugin tools under a tool-only registry.
Its `loadAdapter` reads that registry, which may contain no WhatsApp channel.
The `mam-leave-delivery` service now resolves the public WhatsApp adapter during
Gateway service startup. The official runtime store shares a narrowly scoped
`sendPreparedSummary` capability and pending drafts with tool-only module graphs
in that same Gateway process. Discovery cannot start or replace the owner;
stop/reload clears its pending state. No Gateway RPC scope, messaging tool,
administrator permission or additional recipient is granted.

The service sends only a registered, server-signed draft to its authenticated
sender using Gateway-owned configuration. A literal block preserves the exact
summary through WhatsApp markdown. A summary that cannot fit in one message or
would be changed by sanitization is rejected before sending. Only a real provider
receipt can mark the draft shown. Native WhatsApp quote metadata omits `isQuote`
in this version; when absent, confirmation requires both the exact receipt ID and
the exact displayed body, as well as the existing sender/account/session checks.

`scripts/verify-openclaw-leave-native.mjs` uses the installed 2026.9.4 SDK,
real WhatsApp adapter and real inbound-hook mapper, but replaces the underlying
network listener and People bridge with synthetic fixtures and blocks sockets.
It reproduces the tool-only registry lookup failure and tests separate module
graphs, full prepare/display/quoted-confirm flow, duplicate confirmation,
formatting/length boundaries and service stop. Run only with isolated
`OPENCLAW_STATE_DIR=/tmp/mam-leave-native.<suffix>` and its matching config path;
pass the installed OpenClaw root, installed WhatsApp root and staged plugin root.
This is not a live WhatsApp or production database test.

### Historical build evidence

The base leave plugin was released separately through MAM PR #121. The
`mam_self_profile` extension in this branch is **local source only**: it has not
been merged, migrated, deployed or enabled. The source-controlled location is
`integrations/openclaw-leave/` in the MAM People repository. Build output,
dependencies, environment files and temporary developer harnesses do not belong
in Git. Source inclusion does not authorize deployment.

The coordinating OpenClaw task reported `build` and `validate` success using
OpenClaw 2026.9.4 in a temporary directory on the MAM VPS; validation returned
`valid=true` and `errors=[]`. This task did not rerun those VPS commands.
Imported `index.js` SHA-256:
`211933ae8c8fb334d8b5455c29c3d7af27733910729a7aeb46fdaf44a4d9fc0e`.
This evidence is not a real WhatsApp/People integration test or release approval.
The runtime has since been locally corrected following external review (delivery
pending state, session-bound receipt matching and safe receipt retries). The
hash above identifies the initial import only. The corrected artifact was
subsequently verified directly on 2026-09-18 with Node 24.19.0 and OpenClaw
2026.9.4 in `/tmp/mam-leave-reviewed.PYXBLX` on the MAM VPS. Only plugin source
was uploaded; an empty process environment plus isolated state/config paths
kept real gateway credentials/channels out of this check. `node --check`,
`plugins build --entry ./index.js` and `plugins validate --root . --entry
./index.js --json` passed (`valid=true`, `errors=[]`). SDK-generated manifest
and package formatting were copied into this source tree, not gateway config.

Verified artifact SHA-256:

- `index.js`: `ad1ef9f0dca924fcb0a365587294cade5aafa0bc4e1bd481f82e44d135e3ac5e`
- `package.json`: `0ef58599c67e5fa06d7ff20856ab3bbaf718722bc10847fe1614968aa1aa2615`
- `openclaw.plugin.json`: `df166c265f699330d47dd682c4673b204c643c97e97ce0c92ddf945711c1ed47`

This is native build/validation evidence, not real-channel E2E. No install,
enable, service restart or live messages were performed.

The model-visible tools are deliberately narrow:

- `mam_self_profile` has no arguments. It obtains the canonical sender, account,
  direct-chat route and session from OpenClaw's trusted tool context, then asks
  the People backend to resolve that sender. It returns only the caller's
  `{name, employmentType}`. Phone numbers and internal person/user IDs are never
  returned to the model.
- `mam_leave_prepare` accepts only leave details. It gets identity and chat
  context from the same trusted source, signs a short-lived request to the MAM
  bridge, sends the exact confirmation summary, and records the real outbound
  WhatsApp message ID through `message_sent`.

Neither tool accepts a phone number, name, employee ID or user ID. A
`before_dispatch` hook consumes only an exact `CONFIRM <challenge>` reply from
the same approved direct chat, quoting that exact summary. It then calls the
server bridge; approval, rejection, cancellation, editing, and selected-person
operations are not registered. The assistant should call `mam_self_profile`
before collecting leave details. When the returned employment type is `casual`
or `abn`, it must choose Unpaid leave without asking the employee to choose
between paid and unpaid leave; the backend independently enforces that rule.

The plugin fails closed when the bridge is disabled, the secret is missing, the
endpoint is not the exact HTTPS leave path, the sender/session/DM route is
missing, a message receipt has no provider ID, or the Gateway restarts before a
pending in-memory conversation is completed. A restart requires the employee to
start a new request.

## Gateway environment

These are process environment variables, not model/tool arguments:

- `MAM_OPENCLAW_LEAVE_ENABLED=false` (keep false throughout build/install checks)
- `MAM_OPENCLAW_LEAVE_BRIDGE_URL=https://<MAM-production-host>/api/internal/integrations/openclaw/leave`
- `MAM_OPENCLAW_LEAVE_BRIDGE_SECRET=<independent random base64url secret>`
- `MAM_OPENCLAW_LEAVE_ACCOUNT=default` (the current single WhatsApp account)

Keep the secret in a root-readable/owner-only environment file loaded by the
Gateway service. Never place it in a tool schema, prompt, transcript, log, or
WhatsApp message. It must be different from the read-only allowlist secret.

## Offline repository checks

Run from the repository root; these commands do not install the native SDK,
contact a gateway, send a message or submit leave:

```bash
node --check integrations/openclaw-leave/index.js
node --test tests/openclaw-leave-plugin.test.mjs
npm run lint
npm run typecheck
```

The smoke test uses minimal fake TypeBox and registration adapters and a fake
fetch against `.invalid`. It tests registration intent, trusted identity,
self-profile data minimization, rejection of model-supplied identity, HMAC
signing, exact summary/quote handling and restart failure. It does not prove
actual SDK compatibility, hook delivery or production permissions. It reads no
host environment credentials. The temporary VPS harness is not included.

## Native build and validation (not installation)

Use a disposable build directory with dependencies provisioned for the verified
OpenClaw 2026.9.4 host and pinned TypeBox 1.3.18. Do not install a fresh unpinned
OpenClaw from npm as a side effect of resolving peer dependencies. A reproducible
dependency lock/build artifact still needs to be prepared and reviewed before
release. Run from that directory. These exact commands were reported successful
by the coordinating task on the MAM VPS:

```bash
/home/codex/.openclaw/tools/node-v24.19.0/bin/node --check ./index.js
/home/codex/.openclaw/tools/node-v24.19.0/bin/node /home/codex/.openclaw/tools/node-v24.19.0/lib/node_modules/openclaw/openclaw.mjs plugins build --entry ./index.js
/home/codex/.openclaw/tools/node-v24.19.0/bin/node /home/codex/.openclaw/tools/node-v24.19.0/lib/node_modules/openclaw/openclaw.mjs plugins validate --root . --entry ./index.js --json
```

Consult the [official plugin CLI reference](https://docs.openclaw.ai/cli/plugins)
for the exact installed version; a successful build/validate does not install
or activate the integration.

## Self-profile release — STOP gate

The base leave plugin's prior release does not authorize this extension. Do not
copy the changed runtime to the live gateway or apply the new profile migration
until the exact branch has passed review and the production target/release has
been explicitly approved.

After separate release approval, the operator must:

1. Verify the MAM GitHub identity, production Supabase/Vercel target, MAM VPS,
   running OpenClaw version and reviewed artifact hashes.
2. Apply only the reviewed additive self-profile migration and verify that its
   public snapshot facade is executable only by `service_role`; the private
   function must remain inaccessible to all API roles. Run the hash-pinned
   `scripts/deploy-openclaw-self-profile.mjs inspect|apply` only through the MAM
   `codex-project-credential exec supabase` route.
3. Merge through the reviewed GitHub flow and verify the resulting Vercel
   deployment. Never direct-deploy application code from a local checkout.
4. Build and validate the exact plugin artifact in an isolated gateway profile,
   then update the existing plugin while preserving messaging restrictions and
   unrelated configuration.
5. Verify tool registration and configuration without sending a real WhatsApp
   message or querying another employee's data. A real-channel test requires
   separate authorization.

Only `mam_self_profile` and `mam_leave_prepare` may be model-visible. Keep every
approval/review tool denied, WhatsApp groups disabled, and service-role/database
credentials off the VPS. See [backend release blockers](../../docs/openclaw-leave-bridge.md).
