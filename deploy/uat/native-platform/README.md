# UAT 平台 SQL：角色、Storage 兼容结构、原生 Auth 后授权

范围仅限全新独立 UAT PostgreSQL 16：数据库固定 `mam_uat_people_hub`。这里不是通用 Supabase/Auth 安装器，也不是部署、secret-manager、迁移 runner 或生产操作入口。父协调者仍是唯一远程、秘密及部署 writer；独立审查和目标核验之前不得执行到远程。

## 三个阶段

1. `001-pre-auth.sql`：单一事务，先拒绝错误数据库/major/current_user/session_user/非原有 superuser postgres、JWT request context、非初始角色或 membership、额外数据库/namespace/public 对象或 CREATE 授权、default ACL、event trigger、publication、foreign server 和非初始 extension。只接受 postgres/template0/template1/目标数据库；不是复用已有业务 cluster 的入口。任何重复执行均拒绝，不用 `IF NOT EXISTS` 吞掉已有状态。
2. 由已钉住的真实 GoTrue `v2.196.0` 自行迁移 auth。这里不提供 Auth 表、uid/jwt/role body 或 migration-history。首次安装前不得创建用户、session 或其他 Auth 业务行。
3. `002-post-auth-grants.sql`：独立事务，核验六个角色及精确 SET ROLE membership、auth owner、三个零参 SQL STABLE/invoker helper 的 owner/返回类型、users/identities/sessions/schema_migrations 的 owner、bootstrap 所需十五个列、非空 provider migration ledger，以及所有 Auth 业务表和两个 Storage 表为空。全部通过才给三种 API role auth schema USAGE 和 uid/jwt/role EXECUTE。没有 Auth 表 DML、函数重写、owner 改写、业务控制表或特权 RPC。
4. `003-readback.sql`：`BEGIN READ ONLY`，固定目标，10 秒 statement/2 秒 lock 限制，只输出固定角色 flags/membership、schema/relation owner/ACL、必要列、四个 helper 的 definition SHA256（不输出 body）、public/provider default ACL、pgcrypto metadata 和六个表的行数。密码只输出 `passwordConfigured` Boolean；不输出密码/verifier、Auth 行、token、role config 或 secret GUC。

`001` 不改变 postgres 属性。anon/authenticated 为 NOLOGIN/NOINHERIT，service_role 仅额外 BYPASSRLS。authenticator 为 LOGIN/NOINHERIT，只获 anon/authenticated/service_role 的 `ADMIN FALSE, INHERIT FALSE, SET TRUE` membership；不属于 postgres/Auth owner。supabase_auth_admin 为 LOGIN/NOINHERIT、auth owner，search_path 固定 auth，无 super/createDB/createRole/replication/bypass。supabase_storage_admin 为 NOLOGIN/NOINHERIT，拥有 storage namespace、两个兼容表及 foldername。

post-auth SQL 是有限结构/授权 gate，**不能证明 ledger 或 helper 真的来自 GoTrue**。父必须读真实 provider observer 两次并独立审核 Native baseline；helper 源码文件 hash 不是实际数据库 fingerprint，更不是 Native PASS。授权前后只允许预期的 schema/helper ACL 增量，helper body/type/owner 不变。最终 provider baseline 应在此授权后冻结；随后才执行原样 generated-v5 installer，再按原合同独立 readback。这里不修改原 installer/catalog/purge pins，不重新生成或替代其 195 个 migration 证明。

## 密码入口与日志边界

两个临时 child-process 环境名：

- `MAM_UAT_AUTH_DB_PASSWORD`：与父批准 `.env` 中 `MAM_UAT_AUTH_DATABASE_URL` 的解码密码完全相同。
- `MAM_UAT_REST_DB_PASSWORD`：与 `MAM_UAT_REST_DATABASE_URL` 的解码密码完全相同。

这里只声明命名契约，不读取 `.env`，不增加持久配置项。父日后通过批准的进程内 secret 路径私下提取/注入；不把值或完整 DSN 放 argv、源文件、命令历史、日志或聊天。两者必须分别新生成、互不相同，使用 43–128 个 `[A-Za-z0-9_-]` 字符；格式检查不证明随机熵或实际 DSN 一致性，这两项仍由父验证。

SQL 在目标 guard 之后才用 psql 16 `\getenv` 读取这两个命名值；缺失先落到空值并受同一拒绝 gate，空值绝不是默认密码。用安全 quoted psql literal，验证不返回密码，CREATE ROLE 后 unset。实际只在同一事务中写入角色密码，并显式使用 SCRAM-SHA-256。

应使用 psql 16、`-X` 和 `ON_ERROR_STOP=1`，从父已经核验的唯一 UAT postgres socket/session 执行整个文件，不拆分、不去掉 BEGIN/COMMIT、不用于自动 initdb 或宽泛 Compose 启动。`001` 成功之后不能再次执行；失败时保留证据并核对是否全部回滚，不 drop/reset 试图修复未知环境。

禁止 psql `-a/-e/-E`、shell tracing、完整 config/inspect、环境 dump 和 unfiltered tee。脚本设置 ECHO none/terse/context 隐藏，并在密码读取前限制本 session 的 statement/parameter 日志；这些措施和 Docker logging=none **都不构成外层永不泄漏的保证**。native CLI、扩展审计、代理或 parent wrapper 仍可能回显输入/错误。父须在持久化/显示前捕获并按实际注入值及其敏感片段 redaction stdout/stderr，失败时不得回显完整 SQL/配置。这里没有实现 SSH 或通用 secret wrapper。

## Source 依据与兼容边界

- 本仓库 `tests/migrations/0001-supabase-platform.sql:37–58`：只取 buckets/objects/foldername、schema usage、Storage grants 和 postgres public default ACL 兼容契约；不采用其中 fake Auth block、role 条件复用或 publication 创建。
- generated-v5 `preflight.sql`：十五个 Auth 依赖列、三个 helper 类型、Auth/Storage 空表及角色前提。`auth-storage-application.sql` 和其 inventory 仅依赖 auth.users、storage.buckets/objects 的受控触发器/策略；没有 analytics/vector/multipart Storage 的安装依赖。
- generated-v5 manifest SHA256：`34e5cc38746506f05a5cd39bfc027b3d946d13c46113ccf732aece2167154e8f`；application-schema SQL SHA256：`cd258ef1afcb3695ba14a0606f722cfc5bced876221dd5f011bf4013c5b779f2`。其完整事务、空数据检查和 PG16 guard 不变。
- `tests/run-unified-role-auth.mjs:186–206` 是只读原生顺序依据：Auth owner/schema → GoTrue 原生迁移 → application replay，不能复制其中 Docker/密码处理方式或运行旧 PG17 runner。
- 父保留 `qa-evidence/uat-20261016/discovery/native-auth-migration-sources/manifest.json` 中 GoTrue v2.196.0 四份官方 SQL 的原始字节、Git blob SHA 和 SHA256。本任务离线重新核验了四份来源；没有执行或把这些迁移/helper body 复制进交付 SQL。

这是**最小 Storage SQL 兼容层，不是 Native Storage**：仅 buckets/objects/foldername，objects RLS 默认无 policy，service_role/all 与 authenticated/objects CRUD grants 来自既有 replay 契约。namespace 和对象由明确的 storage owner 持有，不开放 CREATE。public 默认 ACL 是历史 application ACL replay 的输入，不能误写成“所有未来对象默认最小权限”；原 installer 必须原样恢复最终授权。这里不提供 Storage/Realtime HTTP 服务；gateway 本来拒绝它们，performance Word 使用 Blob 路径不依赖它们。实际 generated-v5 的 application-schema.sql/install-new-uat.sql 不包含 publication 创建或变更；本平台不额外创建 publication。历史 195 migrations 曾 ALTER supabase_realtime，不表示这里会直接从空平台重新跑那条历史路径；父应继续用已冻结的 generated-v5 schema-only installer，不把 SQL_ONLY 历史 replay 证明混用为此平台上的 Native replay。

## 本地检查

标准 Node 单元入口（只读源合同，不启动 PostgreSQL/网络）：

```sh
node --test tests/uat-native-platform.test.mjs
```

真实本机 PG16 SQL-only integration（标准库、独有新 cluster、仅 Unix socket；显式提供已审核 preflight，不硬读私人 QA 路径）：

```sh
python3 -B tests/uat-native-platform.test.py \
  --pg-bin /path/to/postgresql16/bin \
  --scratch /path/to/owned/short/scratch \
  --evidence-dir /path/to/new/evidence \
  --bootstrap-preflight /path/to/reviewed/generated-v5/preflight.sql \
  --bootstrap-preflight-sha256 REVIEWED_SHA256
```

执行前先用该 bin 的 `postgres --version`/`psql --version` 确认 16。集群路径使用当前任务新建的 `np` + 随机 alphanumeric suffix，port 55436 仅在该私有 socket 路径，`listen_addresses=''`，LC_ALL/LANG=C。没有 TCP/HTTP、Docker、browser 或 provider；所有 child env 显式构造，HOME/PGPASSFILE/PGSERVICEFILE 指向自有 scratch，不复制宿主环境。测试完整保存每条命令的输入 SQL、stdout、stderr、实际 exit、source snapshot/hash 和 server log，不保存注入的密码。

`tests/uat-native-platform-fixture.sql` **只在 SQL_ONLY 测试中**创建 native-shaped 空表、NULL-return helper 和显式 SQL_ONLY ledger marker，用来测试 shape/ACL gate；不是官方 Auth，绝不可用于真实 UAT 初始化或当作 GoTrue PASS。真实 PostgreSQL SQL/role/ACL 与真实 GoTrue/provider/HTTP 是不同证据。

测试包括缺失/不合规/相同密码、错误目标/owner/JWT/已有环境、重复、事务中途故障回滚、有限 post-auth 拒绝和正项、readback、以及原样 B preflight 的有限形状通过。major 反例是在实际 PG16 上改变测试副本的期望 major，不是执行 PG17。集群停止后用 pg_ctl status 和 socket 消失 readback，保留本任务数据目录，不删除任何他人/旧/在线 cluster。

## 后续父 gate（本次未执行）

独立源码审查 → 精确远程 UAT 目标/daemon/volume/credentials 验证 → pre-auth → 真实 GoTrue 迁移及零业务行 → post-auth 有限授权和独立 Native provider 双读/baseline → 原样 bootstrap installer/readback → 独立 performance delta/合成 seed → 真实 PostgREST/Auth HTTP、gateway、browser/HR acceptance。任何 SQL_ONLY PASS 都不能替代这些阶段；未执行不是源码缺陷，也不是自动获得执行/发布权限。
