# People Hub UAT runtime

仅用于 `mam-people-hub-uat-v1`。Compose project 固定 `mam-people-hub-uat`；App 为 `https://people-hub-uat.srv1866578.hstgr.cloud`，API 为 `https://supabase-uat.srv1866578.hstgr.cloud`。这是新的独立 UAT 配置，不是正式 Vercel、生产 Supabase 或现有 n8n 的变更。

## 文件与本地验收

- `compose.json`：标准 JSON Compose 文档，精确五个 service。
- `images.json`：最初五个官方 registry metadata 的原样公开副本，保留旧 PG17 候选溯源，不代表现在 DB 的有效选择。
- `postgres16.json`：父新核验的 `16-bookworm` amd64 补充 pin，生成器只覆盖有效 DB image；其余四个镜像仍用原 pins。所有有效引用使用 `platformManifestDigest`，不使用 `imageConfigDigest`。generated-v5 严格锁 PostgreSQL 16（父原生来源 16.15），不修改其版本 guard。数据库固定 `mam_uat_people_hub`，满足 `mam_uat_[a-z0-9_]+`；不能使用 `postgres` 数据库。首次 15 个输入和所有 PG17 候选 RED/GREEN 证据保持原样，新增补充输入单独 hash 绑定。
- `ingress.json`：从父的入口只读证据提取；只选择实际已有的 `websecure` entrypoint 和 `mytlschallenge` certresolver，external network 为 `n8n_default`。它不修改现有 Traefik/n8n service。
- `generate.py`：仅生成 Compose 与 Nginx template，不读取 `.env`、不启动服务、不连接网络。
- `check-database-targets.py`：只校验 GoTrue/PostgREST DSN 的 role/host/port/database/sslmode，不认证、不连接数据库、不输出 URL。父可从已批准的秘密注入进程传入两个命名环境值，或用 `--compose-stdin` 读取渲染后的 Compose JSON；不能把完整 JSON 输出到日志/文件。它不验证 DSN 密码是否有效。
- `web/`：Node 24 multi-stage Dockerfile 和仅允许构建所需文件的 Dockerfile-specific ignore。
- `gateway/`：受限 Nginx image、非 root main config、template 和 fail-closed entrypoint。
- `.env.example`：只有六个空变量名，不包含任何密码或 JWT 示例值。

在仓库根运行，均为 inert gate：

```sh
python3 -B deploy/uat/runtime/generate.py --check
python3 -B tests/uat-runtime-config.test.py
python3 -B tests/uat-runtime-config-policy.test.py
node --test tests/uat-runtime-config.test.mjs
```

需要更新生成文件时运行 `python3 -B deploy/uat/runtime/generate.py`，再重跑上述 gate。Node entrypoint 使现有 `tests/*.test.mjs` glob 覆盖这两组 Python 合同，不修改 package scripts，也不继承调用方的秘密环境。测试使用标准库；不需要 PyYAML 或新增 npm 依赖。

测试解析实际 Compose 和实际生成的 Nginx maps/server/location；用不含密码/JWT 的符号参数检查放行到原生 upstream 和拒绝分支。这个受限配置解释器不是 Nginx，不证明原生语法、PCRE、Docker DNS/TLS、JWT 签名、真实身份或业务授权。它不会启动 Docker、浏览器或 PostgreSQL。

## 网络、写路径和日志

`uat-db`、`uat-auth`、`uat-rest`、`uat-web` 只连 `internal: true` 的 `mam-people-hub-uat-backend`，并显式 `traefik.enable=false`，不依赖共享入口的 auto-discovery 默认值；只有 `uat-gateway` 额外加入已有入口网络并启用两个 UAT router。所有 service、backend network、DB volume 都有 owner/instance labels。没有 host port、host network、bind mount、Docker socket、SSH agent 或生产配置。

唯一持久数据卷是 `mam-people-hub-uat-db-data`，挂到 PostgreSQL data 路径。其余写入只有有界 tmpfs；Web `.next/cache` 临时存在，重启可丢弃。所有 service 固定 CPU、memory、PID 上限，drop ALL capabilities、`no-new-privileges`、read-only rootfs 和 `restart: unless-stopped`。DB 保留官方 root entrypoint 的 chown/gosu 所需有限 capabilities；其他 service 都是非 root。未增加依赖自动启动或 bootstrap 容器。

Docker logging driver 全部为 `none`；Nginx access log 关闭，error log 指向 `/dev/null`，PostgreSQL 禁止 statement/parameter 日志。这减少诊断信息，不能以 `docker logs` 代替明确健康/授权验收。禁止打印 `.env`、完整 `docker inspect`、`docker compose config` 输出、`nginx -T`、query/header/body 或 token。

Gateway 有两个 listener：

- `8081`：Traefik 两个精确 Host router 使用的公共入口；未知 Host 关闭连接。App 保留 Host、Origin 和固定 `X-Forwarded-Proto: https`，转发到 `uat-web:3000`。Next 登录/Server Action 的正常重定向不套用 API 的拒绝重定向策略。
- `uat-gateway-private:8080`：绑定仅在 backend 上配置的网络 alias；父 SDK 的 URL 仍是 `http://uat-gateway:8080`。未知 Host 拒绝。部署时必须验证实际解析/监听确实只落在 backend 地址，不能把这个 inert 解析结果当成已验证的网络隔离。

网关非通用代理；upstream 固定为 Web、GoTrue 和 PostgREST，禁止请求参数选择目的地，不运行 Lua。IPv4 forwarding 关闭。双网卡 gateway 本身仍有入口网络能力；这里不是容器被攻陷后的主机级 packet firewall，也没有做真实网络抓包或生产不可达验证。应用其他副作用封锁由父/另一 owner 集成，不能由此配置的单元测试替代。

## API policy

公共 API 必须有精确 anon `apikey`。私有 API 可用 anon 或 service key；检测到 service token 的请求只允许私有 listener 上、无 query 的 POST：

- `claim_portal_login_attempt`
- `resolve_portal_login_auth_email`
- `clear_portal_login_rate_limit`

这三个名称由测试对照真实 `src/app/login/actions.ts` 的 admin RPC 调用核验。其他 worker/业务 RPC、Auth Admin 和 relation 均不能使用 service key 穿过网关。把 service bearer 与 anon apikey 混用也拒绝。`apikey` 只控制网关准入，不是用户身份；JWT 签名、过期、audience 和 SQL/RLS 权限仍由真实 GoTrue/PostgREST 验证。实际用户 `Authorization` 原样传给原生服务，不用 anon key 覆盖。

只开放以下原生 API 路由，前缀在代理前剥离：

- POST `/auth/v1/token?grant_type=password` 或 `refresh_token`；不接受其他 query、重复 grant 或其他 grant。
- POST `/auth/v1/logout`，可选唯一 `scope=local|global|others`。
- GET `/auth/v1/user`、`/auth/v1/settings`、`/auth/v1/.well-known/jwks.json`，无 query。
- GET/HEAD/POST `/rest/v1/<relation>` 或 `/rest/v1/rpc/<function>`，名称为小写下划线 identifier。PostgREST query 原样保留，数据库只暴露 `public`。

PUT/PATCH/DELETE、signup/recover/verify/invite/admin/OTP/user update/SSO、Storage、Realtime 及未知路径拒绝。不存在 Storage/Realtime service，不能声称旧模块的 HTTP 结构就是可用服务。

只接收精确 App Origin；缺 Origin 的 server 请求仍须通过 apikey 和原生认证。OPTIONS 只对精确 Origin 和已允许路由/目标 method 返回 CORS；不要求浏览器预检携带 apikey，也不把 Origin 当成唯一认证。原生 300–399 响应改为 502，并隐藏 Location/Refresh、上游 CORS 与 X-Accel-Redirect；不跟随跳转或转发上游指定的内部 redirect。请求上限 2 MiB，覆盖 12×8000 UTF-16-unit 表单及额外字段。

Envsubst 只替换 `MAM_UAT_ANON_KEY` 和 `MAM_UAT_SERVICE_ROLE_KEY`。entrypoint 固定 `NGINX_ENVSUBST_FILTER`，因此保留 `$http_origin`、`$request_uri`、`$uri` 等 Nginx 变量；Compose 中 `$$` 是传递字面 `$` 的转义。空 key、非法字符/segment 数或相同 anon/service key 启动前拒绝，且错误不包含其值。完整 JWT metadata/签名不能以这个形状检查代替。

## 秘密和原生数据库先决

只有父可以在批准的远程 project root `/home/codex/mam-people-hub-uat` 创建/读取权限受限的 `.env`，不是本任务的本地执行步骤。不要复制任何生产秘密；不要 `source` 不可信 `.env`、打开 shell tracing、把真实值写入本仓库或工单。

| 变量名 | 唯一用途 / 必须满足的约束 |
|---|---|
| `MAM_UAT_POSTGRES_PASSWORD` | 新 UAT PostgreSQL 管理员密码；只注入 DB。 |
| `MAM_UAT_AUTH_DATABASE_URL` | URL-encoded 原生 GoTrue DB 登录；host 必须为 `uat-db`、port `5432`、database `mam_uat_people_hub`、user `supabase_auth_admin`，内部 `sslmode=disable`。 |
| `MAM_UAT_REST_DATABASE_URL` | 独立 URL-encoded PostgREST 登录；相同 host/port/database，user `authenticator`，不能是 postgres/superuser。 |
| `MAM_UAT_JWT_SECRET` | 仅本 UAT 新生成的 HS256 signing secret；只注入 GoTrue/PostgREST。 |
| `MAM_UAT_ANON_KEY` | 同一新 secret 签发，`iss=mam-people-hub-uat-v1`、`role=anon`、`aud=authenticated`、未来 `exp`；公共 bundle 可见。 |
| `MAM_UAT_SERVICE_ROLE_KEY` | 同一新 secret 签发，issuer/audience 相同，`role=service_role`、未来 `exp`；只在 Web runtime 和 gateway，不进 build/public env。 |

Compose 对全部六项使用非空必填插值，不把整个 `.env` 传给 app。父必须在内存中校验目标 URL、issuer/audience、role、expiry、HS256 和新 secret 的一致性，禁止记录实际值。Next 的父-owned guard 对 public 配置及 runtime service key 再做校验。

原生角色/namespace 前置 SQL 由 bootstrap owner 和父提供；本目录没有 role DDL、业务 seed、fake Auth、COPY 初始化脚本或 migration-history 合成。最少需要独立管理角色 `postgres`、GoTrue 的 `supabase_auth_admin`、非 superuser 的 `authenticator`，以及 `anon`、`authenticated`、`service_role` API roles。由已审查的 bootstrap 明确角色属性和 authenticator 的 SET ROLE membership，不由本配置扩大权限。

GoTrue 自己迁移并拥有 `auth` schema 中真实用户/identity/session 等对象。顺序必须是 DB → 父提供 roles/extensions → GoTrue 原生迁移且 Auth users=0、sessions=0 → 父审核 provider baseline → `install-new-uat.sql` 完整事务 → base 独立 readback → 新 performance delta / 合成 Auth / profile seed → rest/web/gateway。安装前不能创建测试用户；不能用 CI 假 Auth 先决或合成 migration history，不能拆事务或弱化 generated-v5 的 PG16/database-name guard。原生安装、SQL readback、provider baseline 和 seed 仍由父负责，本目录不代执行。

Signup 关闭；email password provider 保持开启，但 magic link、phone/SMS、OAuth/custom OAuth、SAML/SSO、Web3、passkey 和通知邮件关闭。没有 SMTP 用户/密码/发送目标，SMTP 固定 `127.0.0.1:1`；Auth 所在 internal network 不给公网出口。`mailer autoconfirm=false`；父使用审核过的原生 Admin seed，显式 `email_confirm=true`，不得调用 invite/send。现有环境不继承任何 webhook、cron、邮件、会议或 provider-file 配置。

## Web build 与 runtime

构建使用锁文件的 `npm ci --ignore-scripts --no-audit --no-fund --include=dev`，随后 `npm run build`；项目既有 prebuild 会执行已钉住的 DayFlow DST patch，所以 Dockerfile 显式复制其 script 和 patch manifest。source COPY 为白名单，没有 `COPY . .`，不传入 `.env`、Git、QA、bootstrap SQL 或 build-time service key。

Builder 的 `MAM_UAT_BUILD_ONLY=true` 只允许编译时缺 service key，public/target 仍须校验。Runner 镜像自身和 Compose 都固定 UAT mode，runtime `MAM_UAT_BUILD_ONLY=false`，不能缺 service key。父 Next config 在该 UAT mode 下产生 standalone；运行 `node server.js`，并显式复制 public 和 `.next/static`，不使用 `next start`。`MAM_PERFORMANCE_REVIEW_ENABLED=true` 由 server 派生 UI；正式部署默认 off 的源代码不在本目录改动。

本地未进行 image build。原 layout 使用 `next/font/google`：父构建时需要 npm/public font 下载，禁止把依赖/字体下载误称为业务 provider 访问，或把 build-only 传播到运行期。运行时字体来自构建产物，没有字体外域进入父的 self + UAT API CSP。构建可重现性/下载可达性、standalone 完整性仍需父的实际 build 证明。

## 父操作顺序（本任务没有执行）

只在独立审查、资源/账号/daemon/目录/labels/证据 hash、DNS 与相同批准范围全部通过后，从批准远程 root 的已审查完整源码运行。父是唯一 SSH/provider/secret/deployment writer；不要用本目录代替 bootstrap/frontend/effect owners 的集成或正式发布审批。

```sh
uat() {
  docker compose \
    --project-name mam-people-hub-uat \
    --env-file /home/codex/mam-people-hub-uat/.env \
    -f deploy/uat/runtime/compose.json "$@"
}

python3 -B deploy/uat/runtime/generate.py --check
uat config --quiet
set -o pipefail
uat config --format json | python3 -B deploy/uat/runtime/check-database-targets.py --compose-stdin
uat pull uat-db uat-auth uat-rest
uat build uat-web uat-gateway
uat up -d --no-deps --wait uat-db
```

此时只应有 DB，数据库必须是 `mam_uat_people_hub`，实际 `server_version` 必须满足 generated-v5 的原生 PG16 guard。上述 pipe 仅让父在进程内校验 DSN，不能加 tee、重定向保存 Compose JSON 或 shell tracing。执行父批准的 roles/extensions 前置步骤，然后：

```sh
uat up -d --no-deps --wait uat-auth
```

核验 GoTrue 真实迁移、ownership、URL/issuer/邮件禁用，并确认 Auth users=0、sessions=0。父审核 provider baseline 通过后，完整事务执行 bootstrap owner 提供的 `install-new-uat.sql`，再做独立 base readback。只有它通过后，才应用新的 performance delta 和显式有限 synthetic control/Auth/profile seed；原生 Admin 创建账号时显式 `email_confirm=true`，不 send/invite。安装前禁止创建测试用户。没有完成这些步骤时，禁止未限定 service 的 `uat up`；本配置不会自动运行 bootstrap/seed。

```sh
uat up -d --no-deps --wait uat-rest uat-web
uat exec -T uat-web node --input-type=module -e '
for (const url of ["http://uat-auth:9999/health", "http://uat-rest:3001/ready"]) {
  const result = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(4000) });
  if (!result.ok) throw new Error("UAT native readiness refused.");
}
console.log("UAT native readiness OK");
'
uat run --rm --no-deps --use-aliases --label traefik.enable=false uat-gateway nginx -t -q
uat up -d --no-deps --wait uat-gateway
uat ps
```

一次性 `nginx -t` container 用 `traefik.enable=false` 避免验语法时发布 router，`--use-aliases` 让 backend-only listener alias 可解析。不要运行 `nginx -T`。PostgREST admin `3001/ready` 只在 backend；没有公共 route。DB 的 pg_isready 只证明接收连接，gateway health 只证明 `nginx -t`，不能当成登录、SQL/RLS 或业务全链通过。

启动后逐目标最小化 readback：五个 service 精确名称/labels/platform/image、DB 唯一 named volume、internal network 和各 service 的实际网络成员、无 PortBindings/binds/特权、资源/capabilities/只读/tmpfs、8080 仅 backend 监听、Traefik 两个精确 Host/TLS router、真实证书及 public API 的拒绝矩阵。检查本 UAT 目标，不查询/调用现有 n8n，不打印 container environment。

父随后必须实际验证：TLS、原生 password/refresh/logout/getUser/JWKS、真实用户 bearer 保留、三条 service login RPC、public service-key/匿名权限拒绝、authenticator 非 superuser、SQL/RLS/CAS、SSR cookie 和 Server Action Origin、出站禁用及 HR/员工/经理隔离。记录 native/browser/HR self-test 与此处 inert 证据的区别。源码集成、原生启动和这些 gate 未通过前，不能宣称 HR 可用了。

停止只作用于新 UAT：

```sh
uat stop uat-gateway uat-web uat-rest uat-auth uat-db
```

不包含 `down -v`、全局 prune、删除/重置已有 volume、修改现有服务、邮件/会议/业务 webhook 测试或密钥轮换。任何恢复/重置/更新都保留原证据和该 UAT 独占目标；不得扩大到生产。
