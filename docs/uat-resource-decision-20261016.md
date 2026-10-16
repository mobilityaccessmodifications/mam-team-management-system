# UAT resource decision — 2026-10-16

The coordinator asked which independent UAT backend route to use after a fresh read-only capacity check.

Question: “独立 UAT 的测试后端采用哪条路线？自托管会在现有 MAM 服务器上新增隔离服务，但不改现有 n8n 或正式数据库；实际部署前仍须通过安全检查。”

The clarification outcome was submitted. The response status was answered. The user's selected answer was exactly:

> 使用现有 MAM 服务器自托管，避免新增云订阅

This prospectively selects self-hosted UAT infrastructure on the approved `CODEX-MAM-VPS` SSH route. It does not authorize billing changes, a new subscription, modification of existing n8n/production databases or a bypass of review, target and isolation checks. No other company's server, account, key or DNS zone may be used.

- Existing MAM Supabase remains Free, with two listed projects and no branching entitlement. No upgrade/project creation was attempted.
- The approved server readback confirmed `codex`, Linux, available Docker access and capacity. This is discovery, not deployment or isolation acceptance.
- Use task-owned containers, volumes, private backend network and credentials. Do not mount host directories, Docker sockets, SSH agents or production configuration into UAT services. Shared ingress, if needed, requires bounded read-only verification and must not change the existing n8n service or production routing rules.
- Pin the exact remote owner/root, Docker daemon, service identities, image digests, ingress origin and allowlists before running the reviewed installer. Verify real Auth/HTTP and no-production-egress separately.
- Remote UAT must remain usable without the Mac. Local providers and intercepted Auth are not the delivered HR login.
- Keep outgoing mail, Auth email, business webhooks, calendar and provider-file operations disabled. Test account secrets must be held and delivered only through approved secret-handling paths, never in chat/Git.

The confirmed feature/access scope in `uat-confirmed-scope-20261016.md` is unchanged. This resource choice does not authorize the production merge or any formal People Hub data/Auth change.
