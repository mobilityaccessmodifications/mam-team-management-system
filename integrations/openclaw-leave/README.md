# MAM OpenClaw Leave plugin

This is a native OpenClaw plugin for the MAM People self-service leave bridge.
It is deliberately not a bare MCP identity boundary.

## Status and source

**Local source only: not installed or enabled.** The source-controlled location
is `integrations/openclaw-leave/` in the MAM People repository. Build output,
dependencies, environment files and the temporary developer harness do not
belong in Git. Source inclusion does not authorize deployment.

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

The only model-visible tool is `mam_leave_prepare`. The tool gets the sender,
account, direct-chat route, and session from OpenClaw's trusted tool context;
none of those values are accepted as model arguments. It signs a short-lived
request to the MAM bridge. The plugin sends the exact confirmation summary and
records the real outbound WhatsApp message ID through `message_sent`. A
`before_dispatch` hook consumes only an exact `CONFIRM <challenge>` reply from
the same approved direct chat, quoting that exact summary. It then calls the
server bridge; approval, rejection, cancellation, editing, and selected-person
operations are not registered.

The plugin fails closed when the bridge is disabled, the secret is missing, the
endpoint is not the exact HTTPS leave path, the sender/session/DM route is
missing, a message receipt has no provider ID, or the Gateway restarts before a
pending in-memory conversation is completed. A restart requires the employee to
start a new request.

## Gateway environment (future, separately approved activation)

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
HMAC signing, exact summary/quote handling and restart failure, not actual SDK
compatibility, hook delivery or production permissions. It reads no host
environment credentials. The temporary VPS harness is not included.

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

## Future installation while remaining disabled — STOP gate

No `plugins install`, `--link`, `--force` or `enable` command has been run or
validated for this plugin. **Installer default activation and link semantics
remain unverified. Do not use an install-then-disable sequence on a live gateway.**

After separate installation approval, the operator must:

1. Verify the MAM VPS/account, running host version, reviewed source hash and
   dependency artifact. Do not overwrite an existing plugin or force an install.
2. Keep gateway and People `MAM_OPENCLAW_LEAVE_ENABLED=false`, and the database
   release gate false. Do not add the tool to the messaging allowlist yet.
3. In an isolated gateway profile with no real channels or credentials, verify
   the installed-version procedure preserves an explicit disabled plugin entry
   throughout installation. If not provable, stop before any live installation.
4. Only then document and execute the verified installation procedure on the
   approved target, preserving unrelated plugin configuration. Inspect effective
   plugin state and confirm `mam-openclaw-leave` remains disabled and its tool is
   unavailable. `activation.onStartup` in the manifest is not proof of disabled
   installation.
5. End at installed-but-disabled. Actual enablement requires completed backend
   release checks, external-review authorization and non-production end-to-end
   host identity/receipt/quote tests, plus explicit activation approval.

At eventual activation only `mam_leave_prepare` may be allowed. Keep every
approval/review tool denied, WhatsApp groups disabled, and service-role/database
credentials off the VPS. See [backend release blockers](../../docs/openclaw-leave-bridge.md).
