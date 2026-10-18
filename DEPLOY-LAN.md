# TDS 单人局域网部署指南

> **读者**：三个月后回来想把这台机器重新跑起来的你。
>
> **场景**：单人使用，局域网访问，**不公网**。没有 HTTPS，没有多用户。
> 如果你的需求是公网部署 / 多用户 / 反向代理 / TLS，**这份文档不适用**。
>
> **写于**：2026-10-18。每一步都基于当时的实测契约 `local://lan-hardening-contract.md`。

---

## 目录

1. [是什么 / 不是什么](#1-是什么--不是什么)
2. [前置条件](#2-前置条件)
3. [首次部署](#3-首次部署从零到能跑)
4. [日常启动](#4-日常启动最短路径)
5. [从手机 / 另一台电脑访问](#5-从手机--另一台电脑访问)
6. [备份与恢复](#6-备份与恢复)
7. [常见问题](#7-常见问题)
8. [安全边界](#8-安全边界)

---

## 1. 是什么 / 不是什么

TDS = todos.dev 的复刻实现，仓库 `D:/AI/todos/clone/`。Free 档。

| 这份文档覆盖 | 这份文档 **不** 覆盖 |
|---|---|
| 单机启动 Postgres / server / web | 公网 / 反向代理 / TLS 终止 |
| 局域网（以太网 + ZeroTier）访问 | 多用户切换 / OAuth / 团队管理 |
| 单 Token 登录 | Prometheus / OpenTelemetry |
| 备份与恢复（人工事后演练） | 自动 cron 备份 / 异地复制 |

---

## 2. 前置条件

### 2.1 系统

- **操作系统**：Windows 11（这台机器的版本）。脚本里所有相对路径都是
  Windows 风格，正反斜杠混用但都会被 Node / Bash 正确解析。
- **没有 Docker**：本机 Docker Desktop 卡住，所以**不用** `infra/docker-compose.yml`。
  全程用 zonky 嵌入式 Postgres（`.local/pg.jar` + `initdb.exe`）。

### 2.2 已装好的工具

本机（2026-10-18）已确认：

| 工具 | 实测版本 | 说明 |
|---|---|---|
| Node.js | v23.1.0 | `package.json` 要求 `>=22.19.0` |
| pnpm | 10.6.5 | `packageManager: pnpm@10.6.5`，请勿用 npm 替代 |
| PowerShell | `powershell.exe` | 启动 Postgres 用 |

如果你换到其它机器，先把 Node（≥ 22.19）和 pnpm（10.x）装上。

### 2.3 已存在的目录（**重要**）

```
D:/AI/todos/clone/.local/
  pg.jar                # zonky 嵌入式 Postgres jar
  pgsql/bin/initdb.exe  # 已 initdb 的可执行文件
  pgsql/bin/postgres.exe
  pgsql/bin/pg_ctl.exe  # ⚠️ 没有 pg_dump.exe / psql.exe
  pgdata/               # 已 initdb 的数据目录
  backups/              # 备份默认输出目录
  init-pg.ps1           # 启动脚本（仅首次用得到）
```

如果 `.local/` 不存在或你换机部署：自行补一份 zonky portable postgres，
然后照着 §3.2 走一遍。

### 2.4 网络地址（实测 2026-10-18）

| 网卡 | IPv4 | 用途 |
|---|---|---|
| 以太网 | `10.0.0.226` | 局域网主地址 |
| ZeroTier | `172.30.48.214` | 装了 ZeroTier 的设备才能连 |
| ZeroTier | `10.147.18.61` | 同上 |
| ZeroTier | `192.168.196.61` | 同上 |
| vEthernet | `172.25.160.1` | **不是**实际网卡（Hyper-V 虚拟），别用 |

---

## 3. 首次部署（从零到能跑）

按顺序做，**不要跳**。每一步都假设你从上一节的前置条件开始。

### 3.1 装依赖

```bash
cd D:/AI/todos/clone
pnpm install
```

理论上 pnpm workspace 会按 `pnpm-workspace.yaml` 串起 `apps/*` 和 `packages/*`。
首次装可能慢（缓存冷）。**不要用 npm**，会破坏 workspace 链接。

### 3.2 启动 Postgres

只在你**换了机器**或 `.local/pgdata/` 不存在时才需要跑：
```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .local/init-pg.ps1
```

正常情况直接用 zoneky 自带 `pg_ctl` 起：
```bash
"L:/AI/todos/clone/.local/pgsql/bin/pg_ctl.exe" -D "D:/AI/todos/clone/.local/pgdata" -l "D:/AI/todos/clone/.local/pg.log" start
```

> 未验证：用 `pg_ctl start` 在另一台机器上的等价路径。理论上路径替换即可，但本机之外的实测我没做过。

如何确认 Postgres 起了：

```bash
cd D:/AI/todos/clone/packages/db
node --input-type=module -e "
import postgres from 'postgres';
const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
try {
  const r = await sql\`select 1 as ok\`;
  console.log('ok', r);
} catch (e) {
  console.error('fail', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
"
```

打印 `ok` 表示通了。

> ⚠️ **必须 `cd packages/db`** —— `postgres` 是 pnpm workspace 装在
> 这个包下的依赖，从仓库根直接 `node -e` 会报 `ERR_MODULE_NOT_FOUND`。
> 原因同 `packages/db/scripts/run-migration.ts`。

> ⚠️ 这台机器**没有 psql.exe**，所以「`psql -c 'select 1'`」这种常见命令**不能**用。
> 需要时一律用 Node 驱动连。见 §6 备份。

### 3.3 跑迁移

```bash
npx tsx packages/db/scripts/run-migration.ts
```

预期输出（按文件名排序执行）：
```
OK   0000_init.sql
OK   0001_step-machine-nullable.sql
OK   0002_chief-message.sql
OK   0003_mentions.sql
OK   0004_todo_created_by_type.sql
OK   0005_machine_pending_action.sql
```

幂等的：可以重复跑，所有迁移都用 `IF NOT EXISTS` / `DO $$` 守卫。
重启 Postgres 后再跑一次不会破坏数据。

### 3.4 创建第一个真实用户

**这一步不能省略。** 后面所有跳过的步骤都会因为这里失败。

数据库现在只有 5375 条测试残留用户（email 全是 `xxx@test.local`），
全部来自 `pnpm test` 跑过的 fixture。**这些用户对你没有任何意义**，
还会让 `TDS_WEB_USER` 解析到错的人。

#### 方法 A：Node 一行命令（推荐，实测通过）

下面这条命令插一个真实用户。`<EMAIL>` 填你自己的邮箱（建议用一个能
识别出是你个人的，例如 `jack@example.com`），`<NAME>` 是显示名。

> ⚠️ **必须从 `packages/db/` 目录跑** —— pnpm workspace 把 `postgres`
> 装在这个包下，从仓库根跑 `node -e` 会 `ERR_MODULE_NOT_FOUND`（实测）。
> 这跟 `packages/db/scripts/run-migration.ts` 必须放在 `packages/db/`
> 下是同一个原因。

```bash
cd D:/AI/todos/clone/packages/db
node --input-type=module -e "
import postgres from 'postgres';
import crypto from 'node:crypto';
const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
const id = crypto.randomBytes(18).toString('base64url');
const ts = Date.now();
const email = process.argv[1];
const displayName = process.argv[2];
await sql\`insert into \"user\" (id, email, display_name, status, locale, created_at, updated_at) values (\${id}, \${email}, \${displayName}, 'active', 'en', \${ts}, \${ts})\`;
const rows = await sql\`select id, email, display_name from \"user\" where email = \${email}\`;
console.log('created:', rows[0]);
await sql.end();
" "<EMAIL>" "<NAME>"
```

示例（注意空格在 shell 里有时会被吃，自己拼一行也行）：

```bash
cd D:/AI/todos/clone/packages/db
node --input-type=module -e "import postgres from 'postgres'; import crypto from 'node:crypto'; const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds'); const id = crypto.randomBytes(18).toString('base64url'); const ts = Date.now(); await sql\`insert into \"user\" (id, email, display_name, status, locale, created_at, updated_at) values (\${id}, \${'jack@example.com'}, \${'Jack'}, 'active', 'en', \${ts}, \${ts})\`; const rows = await sql\`select id, email, display_name from \"user\" where email = \${'jack@example.com'}\`; console.log('created:', rows[0]); await sql.end();"
```

预期输出（实测 2026-10-18）：
```
created: {
  id: 'fZz5hnfD7LBJyyFPbBQXJ55O',
  email: 'jack@example.com',
  display_name: 'Jack'
}
```

`id` 是 24 字符 base64url，对应 `apps/server/src/ids.ts:4` 的全站主键风格。

#### 方法 B：通过临时脚本（更稳，推荐如果上面命令有问题时）

把下面内容写进 `packages/db/scripts/_create-user-once.mjs`（一次性脚本，可写完后删）：

```javascript
import postgres from 'postgres';
import crypto from 'node:crypto';
const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
const [email, displayName] = process.argv.slice(2);
const id = crypto.randomBytes(18).toString('base64url');
const ts = Date.now();
await sql`
  INSERT INTO "user" (id, email, display_name, status, locale, created_at, updated_at)
  VALUES (${id}, ${email}, ${displayName}, 'active', 'en', ${ts}, ${ts})
  ON CONFLICT (email) DO NOTHING
`;
const rows = await sql`select id, email, display_name from "user" where email = ${email}`;
console.log('created/exists:', rows[0]);
await sql.end();
```

跑：

```bash
cd D:/AI/todos/clone/packages/db
node scripts/_create-user-once.mjs "jack@example.com" "Jack"
```

#### 检查

```bash
cd D:/AI/todos/clone/packages/db
node --input-type=module -e "
import postgres from 'postgres';
const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
const rows = await sql\`select id, email, display_name from \"user\" where email = \${process.argv[1]} order by created_at desc limit 3\`;
console.log(rows);
await sql.end();
" "<EMAIL>"
```

实测通过：该 `select` 在我的机器上返回 1 行。

**表名**：`"user"`（带双引号）。`packages/db/src/schema.ts:33` 把表名
定义为 `pgTable('user', ...)`，`user` 是 SQL 保留字，Drizzle 会自动
用双引号包起来。直接写 `from user` 是错的。

### 3.5 生成 KEK 与 token

#### `TDS_KEK`（加密密钥，**绝不能丢**）

必须是 base64 编码的 **32 字节**（最终字符串 44 字符）。生成（实测通过）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

复制输出。**这串要备份到本地密码管理器**——一旦换 KEK，旧 KEK 加密的
所有 secrets 与 API key 都读不出来了。

**未验证**：用其它语言/工具生成的等价值；本项目只断言「base64 解码后正好 32 字节」，来源不限。

#### `TDS_WEB_TOKEN`（Web 登录密码）

任意随机串即可，没有格式要求。建议类似：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3.6 填 `.env`

仓库根已经有 `.env.example`（首节注释里写明每个变量的用途 / 必填与否）。

```bash
cp .env.example .env
# 编辑 .env，至少填这三行：
#   TDS_KEK=<§3.5 生成的 44 字符串>
#   TDS_WEB_TOKEN=<§3.5 生成的 hex 串>
#   TDS_WEB_USER=<§3.4 创建的 EMAIL>
```

典型单机局域网部署的 `.env`：

```bash
HOST=0.0.0.0
PORT=4000

TDS_CORS_ORIGIN=http://10.0.0.226:3000,http://127.0.0.1:3000

TDS_KEK=<粘贴 §3.5 那一串>
TDS_WEB_TOKEN=<粘贴 §3.5 那一串>
TDS_WEB_USER=jack@example.com

NEXT_PUBLIC_API_BASE=http://10.0.0.226:4000
```

> **域名的精确匹配**：CORS 白名单是**逐项严格相等**比较的（见
> `apps/server/src/main.ts:91-95`）。带尾部斜杠不行（`http://...:3000/` ✗），
> host 部分大小写敏感（DNS 解析后）。
>
> 多加几条不同 IP 对应的 origin：另一台 ZeroTier 设备上看可以用
> `http://172.30.48.214:3000`，就把它也加进白名单。

### 3.7 起 server

**要在加载环境变量的 shell 里起**。`tsx src/main.ts` 启动 Fastify：

```bash
# 从仓库根
set -a; source .env; set +a
cd apps/server
npx tsx src/main.ts
```

或一行：

```bash
cd D:/AI/todos/clone
set -a && (cat .env | grep -v '^#' | grep -v '^$' | xargs) && set +a
cd apps/server && npx tsx src/main.ts
```

> 未验证：Git Bash 下 Windows `set -a` / `source .env` 的兼容性。本节命令是基于
> POSIX shell 写的（bash / zsh）；如果你用 PowerShell，请改用：
> ```powershell
> Get-Content .env | ForEach-Object { if ($_ -match '^([^#][^=]*)=(.*)$') { [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
> cd apps/server; npx tsx src/main.ts
> ```

启动成功的标志：

```
{"level":30,"time":...,"pid":...,"msg":"server listening at http://0.0.0.0:4000"}
```

**如果有 `TDS_WEB_USER is not set while binding to non-loopback ...` 的
错误打印并退出** —— 见 §7 常见问题。

### 3.8 起 web

```bash
cd D:/AI/todos/clone
set -a; source .env; set +a
cd apps/web
npx next dev -p 3000
```

启动成功的标志：

```
  ▲ Next.js 15.x (with Turbopack)
  - Local:        http://localhost:3000
  - Network:      http://10.0.0.226:3000
```

### 3.9 第一次登录

1. 浏览器开 `http://10.0.0.226:3000`（或你自己的 `<host-ip>:3000`）
2. 自动跳到 `/login` 页
3. 输入 `TDS_WEB_TOKEN`（不是 email）
4. 进入主界面。看到的是真实用户的看板

---

## 4. 日常启动（最短路径）

**前提**：所有 .env 与 Postgres 已就绪。

开两个 PowerShell / Git Bash 窗口：

**窗口 1 —— server**：
```bash
cd D:/AI/todos/clone
set -a; source .env; set +a
cd apps/server && npx tsx src/main.ts
```

**窗口 2 —— web**：
```bash
cd D:/AI/todos/clone
set -a; source .env; set +a
cd apps/web && npx next dev -p 3000
```

> **未验证**：用 PM2 / hub 长时间托管（一旦被 SIGTERM 没清理可能导致
> 端口被 orphans 占住；skill://hub-port-orphan-recovery 给出了清理手段）。
> 当前推荐手工开窗口。

### 4.1 进程在哪里

| 进程 | 端口 | 命令特征 |
|---|---|---|
| Postgres | 5433 | `postgres.exe -D .../.local/pgdata` |
| TDS server (Fastify) | 4000 | `tsx src/main.ts` |
| TDS web (Next.js) | 3000 | `next dev -p 3000` |

停的时候按相反顺序（先 web → server → Postgres）。直接关窗口即可
（`apps/server/src/main.ts:362-368` 监听了 SIGINT/SIGTERM）。

---

## 5. 从手机 / 另一台电脑访问

### 5.1 在 server 主机上的浏览器

直接 `http://127.0.0.1:3000` 即可。无需 `TDS_CORS_ORIGIN` 包含 loopback。

但！**这里有个坑**：web 上的 `NEXT_PUBLIC_API_BASE` 默认是
`http://127.0.0.1:4000`，不会随着访问来源而变化。如果：

- 你**只在本机**浏览器访问 → 默认值就够
- 你**从其它机器**访问 → 需要 `NEXT_PUBLIC_API_BASE=http://10.0.0.226:4000`（见 §3.6）

**未验证**：在 web 启动后再换 `NEXT_PUBLIC_API_BASE`，next dev 是否会按
新值重新加载；按 Next.js 文档应该会重新编译生效，但实测没做过。

### 5.2 在局域网另一台机器的浏览器

1. 在 server 主机上确认那台机器能 ping 通（防火墙可能挡）
2. 那台机器浏览器开 `http://10.0.0.226:3000`
3. 登录 → cookie 不跨设备共享，所以**那台机器也要**
   输入一次 `TDS_WEB_TOKEN`（cookie 是这台机器本地的，下次再到这台机器打开就免登）

### 5.3 ZeroTier 的另一台设备

把那台设备的 ZeroTier IP 加进 `TDS_CORS_ORIGIN`：
```
TDS_CORS_ORIGIN=http://10.0.0.226:3000,http://172.30.48.214:3000,http://127.0.0.1:3000
```

改完**重启 server**（CORS 在 server 启动时把白名单固化成闭包）。

---

## 6. 备份与恢复

**当前位置**：本项目用自写的 `packages/db/scripts/{backup,restore}.ts`
节点脚本，因为本机 Postgres 是 zonky 嵌入式版（**没有 pg_dump.exe**，
**没有 psql.exe**）。

### 6.1 备份

```bash
cd D:/AI/todos/clone
npx tsx packages/db/scripts/backup.ts
```

不传参数：输出到仓库根的 `.local/backups/tds-backup-YYYYMMDD-HHmmss/`。
传一个目录：写到那。

每个备份目录里：

```
tds-backup-20261018-053407/
├── manifest.json     # 创建时间、PG 版本、表数、行数、每表路径
├── schema.json       # 完整 schema（列 / 类型 / 可空 / 默认 / 主键 / 外键）
└── tables/
    ├── user.jsonl
    ├── team.jsonl
    └── ...
```

每行一个 JSON 对象（**JSONL**，不是 SQL INSERT / 不是 CSV）。

### 6.2 局限（**自己看一遍**）

`backup.ts` 文件头注释里逐条列了：

- ✅ 导全部业务表数据 + schema
- ❌ **不**导索引、触发器、视图、扩展、序列
- ❌ schema 用 drizzle 迁移重建，不是裸 SQL

**不**等价于 `pg_dump`。但能撑住「业务数据捞回来」这个目标，本项目里最
不可再生的就是这部分（对话、todo、secrets）。

### 6.3 恢复

```bash
cd D:/AI/todos/clone
npx tsx packages/db/scripts/restore.ts .local/backups/tds-backup-20261018-053407
```

会先打印「将恢复 N 个表 / M 行 / 表列表」，让你确认。CI 环境想跳过
确认用 `--yes`。

**恢复前的 schema** 必须已经建好 —— 先 §3.3 跑迁移。
恢复会**先 TRUNCATE 表**再导入，所以是可重放的。

反 FK 顺序写入；外键约束在导入过程暂时关掉（脚本里通过
`SET session_replication_role = replica` 实现）。

### 6.4 恢复演练

**强烈建议**至少每季度跑一次：

1. 起 Postgres + 跑完迁移（§3.2 + §3.3）
2. 跑 backup.ts 拿一份备份（§6.1）
3. **人为**删一行测试数据：
   ```bash
   cd D:/AI/todos/clone/packages/db
   node --input-type=module -e "
     import postgres from 'postgres';
     const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
     // 仅挑一行，方便精确复检。先看 list 防止误删：
     const sample = await sql\`select id, title from todo limit 1\`;
     console.log('about to delete:', sample);
     const n = await sql\`delete from todo where id = \${sample[0].id} returning id\`;
     console.log('deleted', n.length, 'rows');
     await sql.end();
   "
   ```
4. 跑 restore.ts（§6.3）
5. 复检：
   ```bash
   cd D:/AI/todos/clone/packages/db
   node --input-type=module -e "
     import postgres from 'postgres';
     const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
     const c = await sql\`select count(*)::int as total from todo\`;
     console.log('restored todo count =', c[0].total);
     await sql.end();
   "
   ```

行数与原 backup 的 `manifest.json` 对账。

---

## 7. 常见问题

### 7.1 启动时 `TDS_WEB_USER is not set while binding to non-loopback ...`

**完整错误**：
```
TDS_WEB_USER is not set while binding to non-loopback 10.0.0.226:4000: ...
```

**原因**：服务端启动时检查 HOST 非回环 + `TDS_WEB_USER` 未设 → 进程
`exit(1)`（见 `apps/server/src/main.ts:342-356`）。

**修法**：
1. 检查 `TDS_WEB_USER` 是否真的写到了进程的 env 里（不要 echo 不出来，
   跳过 shell alias）
2. 检查 `TDS_WEB_USER` 是不是 email（**不是** user id）
3. 检查库里**确实有这个 email 的用户**（见 §3.4）

### 7.2 `TDS_WEB_USER "<email>" does not match any user`

`apps/server/src/auth.ts:resolveWebUser` 在 `TDS_WEB_USER` 填了但库里
没找到时报的。错误信息会列出「First 3 candidate email(s)」，
一般就是**测试 fixture 用户的 email 列表**。

修：§3.4 创建一个真的用户，把 `.env` 里的 `TDS_WEB_USER` 换成那个 email。

### 7.3 页面能开但数据为空 / 401

看 Network 标签：
- 401 + `unauthorized` → cookie 不对 → 见 §3.5（重新生成并更新 .env，
  再重启 server 与 web 因为 cookie 是登录态发起的）
- 401 + `missing credentials` → 浏览器**没有** `tds_token` cookie，
  说明登录态丢失；刷新页面或重登

### 7.4 CORS 报错（`Access to fetch has been blocked by CORS policy`）

浏览器开发者工具里会有具体 origin（`http://10.0.0.226:3000` 之类）。
逐项核查：

1. `TDS_CORS_ORIGIN` **精确匹配**该 origin —— 域名、端口、scheme 都对
2. **没有**尾部斜杠 `http://10.0.0.226:3000/`（白名单是按 origin 整串比对）
3. server 启动的 stdout 里**没有** `[tds] CORS is rejecting ...` 一次性
   提示 —— 那个打印表示「第一次跨源请求被拒」

修：补全精确 origin，**重启 server**（CORS 固化成闭包在启动时）。

### 7.5 429 Too Many Requests

实测阈值（`apps/server/src/main.ts:186-244`）：

- 全局：600 req/min/IP
- `/api/mcp`：120 req/min/IP（叠加在全局之上，实际 = min(600, 120) = 120）

正常浏览不会触发；写脚本批量调 `mcp` 端点时容易撞 120 那条。

**临时绕过**（仅调试）：
```bash
TDS_RATE_LIMIT_DISABLED=1 npx tsx apps/server/src/main.ts
```
重启 server 时去掉。

### 7.6 `Error: listen EADDRINUSE :::4000`（端口被占）

之前起的 server 没干净退出 —— `.local/pgdata/postmaster.pid` 也可能
挡住 Postgres。

先看是谁：
```bash
netstat -ano | grep ":4000"
# 找出 LISTENING 那行的 PID
```

然后用 **PowerShell**（不是 Bash）杀进程：
```powershell
Stop-Process -Id <PID> -Force
# 等价于老式 taskkill /F /PID <PID>
```

实测我（主代理）此前在这台机器上遇到过 orphan 进程；用 `netstat -ano`
对得上。Node 进程名是 `node.exe`，可在任务管理器里看到。

### 7.7 `.env` 没生效

最常见的两个坑：

1. `.env.example` 是例子，**你得真的复制一份为 `.env`**
2. 起 server 之前**必须** `source .env`（或等价地把 env 注进当前 shell）。
   `tsx src/main.ts` 自己**不读** `.env` 文件，env 必须显式注入。
   「新开一个窗口跑 server」这种习惯会让 env 丢光——务必在 `source`
   的同一个 shell 里起进程。

### 7.8 `pnpm test` 跑完留下的「最早用户」把 `TDS_WEB_USER` 顶掉

§3.4 + §3.6 的设置就是为了避免这种情况：test 会插一堆测试用户，
跑完 test 后 `created_at` 最早的那个用户可能不是你建的真人。
解决：

- 持久办法：`TDS_WEB_USER` 必须是**显式配的 email**（这就是 §7.1 为什么
  没配就 exit(1)）
- 临时清掉：
  ```bash
  cd D:/AI/todos/clone/packages/db
  node --input-type=module -e "
  import postgres from 'postgres';
  const sql = postgres('postgres://tds:tds_local_dev@127.0.0.1:5433/tds');
  const n = await sql\`delete from \"user\" where email like '%@test.local' returning id\`;
  console.log('deleted', n.length, 'test users');
  await sql.end();
  "
  ```

  **小心**：这条 SQL 不限 created_at，可能误删如果你有真实 email 也
  用了 `.test.local` 之类的域 —— 改成 `email like '%@test.local' and
  email not like '%.real.%'` 之防御性版本再跑。

---

## 8. 安全边界

这份部署**只是单人局域网用**。**不**是公网安全部署。

| 假设 | 真实情况 |
|---|---|
| 局域网可信 | ✅ 假设；同一交换机 / 同一 WiFi / ZeroTier 全员都是「自己人」 |
| 无 HTTPS | ✅ 假设；所有 token / cookie / 数据都是明文跑在网内 |
| 没有公网用户 | ✅ 单 Token 登录，无 OAuth / SAML / 多用户切换 |
| 没有 DoS 防护 | 默认 `@fastify/rate-limit` 开（600/120 req/min），但不是防 DDoS |
| 没有审计日志归档 | Pino 日志走 stdout，没接 Loki / ELK |
| 没有 IDS / WAF | 仅 Fastify 的 `requestTimeout: 0`（SSE 长连接）+ 默认 body 限 |

### 8.1 升级到公网的最低要求

如果你**确实**要把它放到公网上，至少要加：

1. **HTTPS 终止** —— nginx / Caddy 在前面，挂证书
2. **鉴权替换** —— `TDS_WEB_TOKEN` 不能跨用户共享；改成 OAuth + 真 session
3. **`TDS_WEB_USER` 强制** —— 已做（2026-10-18）：非测试环境未配 →
   `resolveWebUser` 抛 500，且绑非回环地址时 `main.ts` 直接 `exit(1)`。
   公网多用户时还要进一步换成真 session
4. **Secrets 加密** —— `TDS_KEK` 已经做了，仍然要确保 KEK **不**进镜像 /
   仓库
5. **限流收紧** —— 按 IP + API key 维度，60 req/min 全局

这些本项目**还没**做（截至 2026-10-18）。

### 8.2 如果你踩到红线

- **被盗 Token**：`TDS_WEB_TOKEN` 重置 + 重启 server + 重新登录
- **DB 被破坏**：从 §6.4 的恢复演练捞
- **KEK 泄露**：原则上要轮换——但**所有加密数据都作废**（secrets、
  API key 的密文）。新 KEK + 重新输入明文（从你密码管理器里找）

---

## 9. 执行机接入（daemon enroll）

服务端只是控制面。**真正跑 agent 的是 daemon**，它通过 `TDS_SERVER` 指向服务端
（`apps/daemon/src/cli.ts:20`：`process.env.TDS_SERVER ?? 'http://127.0.0.1:4000'`）。
`machines` 表没有单例约束，多台执行机可以同时 enroll。

### 9.1 建 enroll key

```bash
curl -X POST "http://<服务端>:4000/api/user/api-keys?token=<TDS_WEB_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"name":"<teamId>","scopes":["machine","write"]}'
# → {"apiKey":{...},"key":"tds_xxxxxxxx"}
```

> **实测踩到的设计缺陷**：`apps/server/src/routes/machine.ts:176` 是
> `eq(apiKeys.name, body.teamId)` —— enroll 要求 **key 的 `name` 必须等于 teamId**。
> key 名叫 `worker-pc` 就必然 401 `invalid enrollment key for team`，UI 上
> 没有任何提示。建 enroll key 时 `name` 填 teamId。

### 9.2 enroll 与启动

**`enroll` 不是子命令**（`tds help` 只列 `start / status / stop / logout /
version / help`）—— 注册在 `start` 里靠 `--api-key` + `--team` 触发：

```bash
cd apps/daemon
TDS_SERVER=http://<服务端>:4000 \
  npx tsx src/cli.ts start --foreground \
  --api-key tds_xxxxxxxx --team <teamId> --name <机器名>
```

`runtimes` 不在 enroll 时写入，要等第一次 `presence`
（`PRESENCE_INTERVAL_MS = 60_000`，`apps/daemon/src/worker.ts:27`）。刚 enroll
完看库里 `runtimes = {}` 是正常的。

### 9.3 已实测 / 未实测

实测通过（2026-10-18，执行机 Windows → 服务端树莓派）：`enroll` 落库、
`presence` 写 runtimes、心跳更新、daemon 重启后复用注册（`resuming machine=…`）。

**未实测**：`claim` → 真跑 agent → 回报结果。这条要先在 `/settings/providers`
配好模型 provider 并把 todo 指派给 agent；provider 为空时 `todo` 停在
`phase='todo'`、不产生 `step`，daemon 的 claim 轮询自然拿不到活。
