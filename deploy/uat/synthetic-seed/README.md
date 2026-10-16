# 有限合成身份初始化器（UAT only）

这是全新隔离 People Hub UAT 的一次性 profile/person 初始化器，不是 Auth 服务、迁移器、账号修复器或可重复执行的 reset。它只生成 SQL，不建立数据库连接、不访问网络、不读运行环境或凭据。真实 Auth、部署和后续验收仍由父集成 owner 执行。

## 固定目录

`generate.py catalog` 返回全部固定字段。输入不能改变角色、姓名、公司、person UUID 或 parent；Auth UUID 必须来自真实 GoTrue Admin 创建后的独立读回。

| fixtureKey | app_role | company | parent fixtureKey |
|---|---|---|---|
| p0 | system_admin | 无（standalone） | 无 |
| hr | admin | mam | 无 |
| mam_upper_manager | manager | mam | 无 |
| mam_manager | manager | mam | mam_upper_manager |
| mam_employee | employee | mam | mam_manager |
| mam_account | account | mam | mam_manager |
| mam_other_manager | manager | mam | mam_upper_manager |
| equipsy_upper_manager | manager | equipsy | 无 |
| equipsy_manager | manager | equipsy | equipsy_upper_manager |
| equipsy_employee | employee | equipsy | equipsy_manager |

所有 email 固定为 `uat.` + fixtureKey 中下划线替换为点 + `@mam-uat.invalid`。P0 没有 person；其余九个确定性 person UUID 相互独立，且不能等于任何 Auth UUID。HR 使用 canonical `admin`，不是 legacy `hr`。Admin/P0 的绩效只读身份不改变其他 Hub 权限。

## 父 owner 的操作顺序

以下是真实 UAT 的交接要求，本交付没有执行这些真实 Auth/HTTP 操作。

1. 核实隔离 UAT 目标、无出站策略、PostgreSQL major **16** 和精确数据库名 **`mam_uat_people_hub`**。不能复用生产或本任务的 SQL-only fixture/集群。
2. 真实 GoTrue 完成其 Auth migrations；Auth/Storage 业务表为空。父完成原生平台与 provider baseline 审核，保留真实 `auth.uid()` / `auth.jwt()` / `auth.role()`，不得复制本地 SQL fixture 的 Auth DDL/helpers。
3. 先执行并独立读回已审核的完整基础 installer，再安装/验证 `deploy/uat/performance-review-schema.sql`。不得改原 195 migrations、已有保护或 purge 指纹。基础包 manifest SHA 为 `34e5cc38746506f05a5cd39bfc027b3d946d13c46113ccf732aece2167154e8f`，`application-schema.sql` SHA 为 `cd258ef1afcb3695ba14a0606f722cfc5bced876221dd5f011bf4013c5b779f2`。
4. 父按固定 catalog，通过真实 Admin createUser 建立全部十个 email/password 身份并确认 email，再逐个 Admin readback。不得 invite、发邮件、signIn、传入角色 metadata 或自选 Auth UUID。密码仅由父的授权保密通道持有，不进入 metadata、SQL 或证据。若创建结果不确定，先 reconciliation，不盲目再创建。
5. 验证总共恰好十个全新、confirmed、非 anonymous、未删除、未 ban、未 signIn 的 Auth users，零 sessions，且 profiles/people/review/event/operation 都为空。实际 provider 若意外建了 profile，立即停止并保留拒绝；不能 UPSERT、先 employee 再升 P0、删除现有行或关闭 trigger。
6. 形成下述严格 metadata，仅生成一次 seed 与独立 after SQL。以已核验的既有 superuser `postgres`（session_user 和 current_user 均相同）在无 JWT claims 的新连接执行 seed。不得为通过检查改变角色属性、清除/伪造 claims，或回拨 `credentials_valid_after`。
7. COMMIT 后、任何 signIn/review 创建前，用第二个新连接执行 after，检查返回 JSON 的 `allMatch` **确为 true**。psql exit 0 本身不代表资格匹配；失败的资格读回可以正常返回 `allMatch:false`。
8. 此后父才进行真实 signIn/getUser、current account/canonical capability、PostgREST/HTTP 正反和浏览器验收。review 必须由真实 assigned Manager 的现有 start Action 创建，seed 不直接创建 review。根 upper manager 没有上级，不因此获得自我分配的 review。

本目录不提供真实 GoTrue、provider、Docker、SSH、环境密钥或部署命令。

## 严格 metadata 与 CLI

UTF-8 JSON 顶层只能有 `identities`，数组必须恰有上述十个 fixtureKey，每项只能包含三个字符串字段：`fixtureKey`、`authUserId`、`email`。`authUserId` 必须是独立真实 readback 的 canonical 小写 UUIDv4（RFC variant）；email 必须与 catalog 完全一致。重复 JSON 键、重复 UUID/key、额外字段（包括 password/JWT/role）、错误类型、非有限常量、超出 16384 bytes 或 malformed JSON 都拒绝，不回显输入、不输出部分 SQL。

从仓库根目录生成（`identities.metadata.json` 只能是父审核后的非凭据 readback 投影）：

```sh
python3 -B deploy/uat/synthetic-seed/generate.py catalog > catalog.json
python3 -B deploy/uat/synthetic-seed/generate.py seed < identities.metadata.json > seed.generated.sql
python3 -B deploy/uat/synthetic-seed/generate.py after < identities.metadata.json > after.generated.sql
```

每一步均检查实际 exit 为 0 后才能使用输出。无效命令/metadata 返回 2。catalog 不是 seed 输入：它不包含真实 Auth readback UUID，且有固定的额外目录字段。生成文件应留在父批准的私有 UAT 操作目录，不提交账号 readback 或凭据。

仅在前述所有 native 前置与目标审批成立后，父使用已确认的 UAT 本地 socket/port，分别执行以下两条命令；尖括号参数不是可直接使用的默认值：

```sh
psql -X -h '<verified-UAT-socket>' -p '<verified-port>' -U postgres -d mam_uat_people_hub -v ON_ERROR_STOP=1 -f seed.generated.sql
psql -X -h '<verified-UAT-socket>' -p '<verified-port>' -U postgres -d mam_uat_people_hub -v ON_ERROR_STOP=1 -f after.generated.sql
```

## SQL 行为与失败处理

- seed 是一个事务；在固定上下文、try-advisory 初始化锁、表锁与新身份/空应用/惰性 control 检查后，明确 INSERT 十个 profiles，再按父链次序 INSERT 九个 people。最后强制 deferred constraints、逐身份验证和 controls 不变检查，才 COMMIT。
- 没有 UPSERT、已有 P0 UPDATE、seed Auth DDL、禁用 RLS/trigger 或 JWT 注入。原产品 profile→Auth `org_role` 同步、onboarding/check-in/subtree 触发器保持；其数据库队列/授权副作用不是“零业务行”。不发送、不 claim、不消费任何队列；NULL started_date 不是出站隔离措施。
- wrong target、existing profile/person/session、缺失/额外/不合格 Auth、重复 seed、锁竞争或中途错误均拒绝；事务内 profile/person/trigger 效果回滚。真实 Admin 创建在该 SQL 事务之外，不能因 SQL 失败就盲目重建 Auth、清空数据或重试写入。
- after 是单独的 `BEGIN READ ONLY` 事务，要求严格十 Auth/十 profile/九 people、零 session/review/event/operation，无额外身份。它只证明 **TARGET_RECORD_QUALIFICATION_NOT_CURRENT_ACTOR**；显式目标的 `portal_role_policy(uuid)` 读回不是 native actor、JWT、HTTP 或浏览器证明。
- after 不用于登录或 review 开始后的健康检查；已出现 sessions/reviews 时会失去初始状态资格，不能为让它变绿删除真实验收进度。

## 已验证与未运行

最终完整源绑定与原始收据见 `qa-evidence/uat-20261016/synthetic-seed-owner/handoff.json`、`HANDOFF.md`。

- 保留原 TDD/失败阶段和已通过结果，原八文件未改。本轮仅补一次当前源 SQL-only 最终 gate：真实退出 0，PG 16.15，完整基础 installer（绑定 195 原 migration 源）+ performance delta，十 profiles/九 people/十身份 readback、23 个拒绝场景、10 个 manager 资格表达式、5 个 major 守卫表达式，以及额外身份使 after 返回 false。不是重放 195 条历史迁移或原生 Auth。
- 既有 Node wrapper gate 1/1、exit 0，绑定当前八源码；内部校验 Python child exit 0 和 `Ran 5 tests`，不将 wrapper 与嵌套方法相加。
- 本地旧四个与本轮新一个自有 socket-only 集群均已停止、无 pid/socket，并保留完整归档；**stopped，不是 dropped**。不可直接重启旧集群。
- **NOT_RUN**：真实 GoTrue/Admin/signIn/getUser、真实 JWT/PostgREST/HTTP、浏览器、hosted/HR、实际 provider、发送、独立集成 review、父当前集成源的完整 check/build。父必须在接纳八文件后补对应的当前源集成门槛，不能继承未包含它们的旧 133 文件 check/build 作为整体验收。
