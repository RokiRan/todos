# 树莓派部署（服务端）

本文是 `DEPLOY-LAN.md` 的**树莓派特化版**。所有命令与数字都是 2026-10-18 在
`ubuntu@10.0.0.191`（Raspberry Pi 4 / 4GB）上实测跑出来的，不是照抄通用流程。

架构分工：**树莓派跑服务端（Postgres + Fastify + Next.js），执行机（跑 agent CLI
的电脑）在别处**。理由见 §7。

---

## 1. 目标机器规格（实测）

| 项 | 实测值 | 含义 |
|---|---|---|
| 型号 | `Raspberry Pi 4 Model B Rev 1.2` | `/proc/device-tree/model` |
| 架构 | `Linux aarch64` | 64 位系统，arm64 原生包可用 |
| 系统 | `Ubuntu 20.04.6 LTS` | 标准支持已结束（ESM 阶段），但对本应用够用 |
| glibc | `2.31-0ubuntu9.18` | **Node 22 官方 arm64 二进制要求 ≥2.28 → 可用** |
| CPU | Cortex-A72 ×4 @1500MHz | 4 核，构建/服务够用 |
| 内存 | 3.7 GiB（`free` 报 available 2279 MB） | **实测三件套 RSS 合计 425 MB**（含 PG 容器） |
| swap | `/swapfile` 4G | 已在 SD 卡上 |
| 磁盘 | SD 卡 59.5G，已用 41G，剩 16G（72%） | 本应用占 ~700 MB（node_modules + build） |
| 温度 | 60.4 °C（被动散热） | 长时间 `next build` 会顶到 70+ °C，正常 |

**结论：4GB 的 Pi 4 完全跑得动服务端。2GB 的会紧，不建议。**

---

## 2. 前置条件

### 2.1 必须有

- **Docker**（本机 24.0.7）。Postgres 用容器跑 —— 这台机器上 **没有 `psql`/`pg_dump`/`java`**，
  所以仓库自带的 zonky 嵌入式 Postgres（`pg.jar` 需要 JVM）**在这台机器上根本用不了**。
  用 Docker 是唯一现实路径。
- **SSH 可达 + sudo 免密**（`sudo -n true` 通过）。下面的命令全部假定可以直接 `sudo`。

### 2.2 这台机器上已有的服务（实测端口占用）

部署前必须知道会撞什么。`sudo ss -tlnp` 实测：

| 端口 | 占用者 | 影响 |
|---|---|---|
| **3000** | `new-api`（`calciumion/new-api`，docker-proxy） | **Next.js 不能用 3000 → 改用 3100** |
| 8989 | `oxmux-server-1` | 无冲突 |
| 9001 | `oxmux-minio-1` | 无冲突 |
| 1200 | `rsshub`（只绑 127.0.0.1） | 无冲突 |
| 8790 / 8088 / 11436 | python 服务 | 无冲突 |
| 3456 | node 服务 | 无冲突 |
| 9993 | `zerotier-one` | 无冲突 |
| **4000 / 3100 / 5433** | **空闲（实测确认）** | 本应用使用 |

另外有 5 个自启服务在跑：`agent-bus-node` / `agent-bus-registry` / `agent-gateway` /
`agent-harness-web` / `agent-inbox`。本应用是**追加**，不动它们。

---

## 3. 部署步骤

### 3.1 传代码

`clone/` **不是 git 仓库**（`git rev-parse` 报 not a git repository），所以不能
`git clone`，只能打包传输。

开发机（Windows）上：

```bash
# Windows 自带 tar 是 bsdtar，不认 git-bash 的 /tmp —— 用仓库内路径
tar -czf .local/tds-src.tar.gz \
  --exclude=node_modules --exclude=.next --exclude=.local \
  --exclude=.git --exclude=dist --exclude=.turbo .
scp .local/tds-src.tar.gz ubuntu@<派IP>:/home/ubuntu/
```

实测：压缩后 **1.5 MB**（源码 7 MB），scp 传输 2.6 秒。

派上解压：

```bash
mkdir -p /home/ubuntu/tds
tar xzf /home/ubuntu/tds-src.tar.gz -C /home/ubuntu/tds
```

> **无害警告**：bsdtar 会写 `SCHILY.fflags` 扩展头，GNU tar 解压时每个文件打一条
> `tar: Ignoring unknown extended header keyword 'SCHILY.fflags'`。几百行刷屏，
> 但**解压结果正确**。想清屏就加 `2>/dev/null`。

### 3.2 装 Node 22（**不要动系统 node**）

系统 node 是 `v20.20.2`，而 `package.json` 的 `engines` 要求 `>=22.19.0`。

**关键：这台机器上已有 5 个服务在用系统 node 跑。直接 `apt upgrade node` 或
NodeSource 全局安装会把它们一起换掉 —— 有搞挂别人服务的风险。** 所以装成
用户级、独立目录：

```bash
VER=$(curl -s https://nodejs.org/dist/index.json \
      | sed -n 's/.*"version":"\(v22\.[0-9.]*\)".*/\1/p' | head -1)   # 实测 → v22.23.3
mkdir -p /home/ubuntu/.local && cd /home/ubuntu/.local
curl -sS -o node.tar.xz "https://nodejs.org/dist/$VER/node-$VER-linux-arm64.tar.xz"  # 30 MB
tar xJf node.tar.xz && rm -f node.tar.xz
mv node-$VER-linux-arm64 node22
/home/ubuntu/.local/node22/bin/node -v      # → v22.23.3
node -v                                      # → v20.20.2（系统未变）
```

### 3.3 起 Postgres

用仓库自带的 `infra/docker-compose.yml`（`postgres:16-alpine`，绑 `127.0.0.1:5433`）：

```bash
cd /home/ubuntu/tds
sudo docker compose -f infra/docker-compose.yml up -d postgres
```

实测：`PostgreSQL 16.15 on aarch64-unknown-linux-musl`，宿主侧
`127.0.0.1:5433` 可连。首次 `initdb` 在 SD 卡上约 30–60 秒，`pg_isready`
前几秒会报 `no response` —— **等它变 accepting 再往下走**。

> **为什么绑 127.0.0.1 而不是 0.0.0.0**：BFF 架构下 web 与 server 同机，数据库
> 只需本机可达。绑 0.0.0.0 会把数据库暴露给整个局域网。

> **卷名陷阱**：compose 不加 `name:` 时卷叫 `<项目名>_tds-pgdata`。如果你先用
> `docker run -v tds-pgdata:...` 起过，再改用 compose，会拿到一个**空卷**，
> 数据看起来"丢了"。`infra/docker-compose.yml` 已显式写 `name: tds-pgdata`
> 让两种方式共用同一份数据（实测：换过来后 `select count(*) from "user"` 仍是 1）。

### 3.4 装依赖

```bash
export PATH=/home/ubuntu/.local/node22/bin:$PATH
cd /home/ubuntu/tds
corepack enable pnpm && corepack prepare pnpm@10.6.5 --activate
pnpm install --no-frozen-lockfile
```

实测：**2 分 13 秒**。arm64 平台包全部自动装上了（`@esbuild/linux-arm64`、
`@next/swc-linux-arm64-gnu`、`@img/sharp-linux-arm64`）—— 不需要手工指定。

`--no-frozen-lockfile` 是必需的：lockfile 是在 Windows/x64 上生成的，pnpm 要给
arm64 补可选依赖条目，frozen 模式会拒绝。

> **警告但无害**：`Ignored build scripts: @google/genai, esbuild, protobufjs`。
> esbuild 的平台二进制是通过**可选依赖包**装的（上面已确认存在），不是靠
> postinstall 脚本，所以这个警告不影响。实测 `tsx v4.23.15` 能真执行 TS。

### 3.5 跑迁移

```bash
cd /home/ubuntu/tds/packages/db
export DATABASE_URL="postgres://tds:tds_local_dev@127.0.0.1:5433/tds"
pnpm exec tsx scripts/run-migration.ts
```

实测输出：

```
OK   0000_init.sql
OK   0001_step-machine-nullable.sql
OK   0002_chief-message.sql
OK   0003_mentions.sql
OK   0004_todo_created_by_type.sql
OK   0005_machine_pending_action.sql
```

> **必须从 `packages/db/` 里跑**，不能从仓库根跑 `pnpm exec tsx packages/db/scripts/...`
> —— 根目录的 `.bin` 里没有 `tsx`（它是各包的 devDependency），会报
> `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found`。

### 3.6 建第一个真实用户 + 团队

**库里没有任何真实用户**（`TDS_WEB_USER` 要有值可配，所以必须先建）。

`team` 没有 `POST /api/teams` 端点 —— 团队只能 SQL 建（实测：全仓只有测试文件
insert team，无生产种子脚本）。

```bash
sudo docker exec -i tds-postgres psql -U tds -d tds <<'SQL'
insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
values ('tdsowner0000000000000001', 'jack@lan.local', 'Jack', 'active', 'en',
        1760000000000, 1760000000000)
on conflict (email) do nothing;

insert into team (id, name, plan, storage_quota, created_at)
values ('tdsteam000000000000000001', '我的团队', 'free', 1073741824, 1760000000000);

insert into member (id, team_id, actor_id, member_type, role, joined_at, v)
values ('tdsmem0000000000000000001', 'tdsteam000000000000000001',
        'tdsowner0000000000000001', 'user', 'admin', 1760000000000, 0);

insert into agent (id, team_id, display_name, default_skill_ids, grants,
                   active_task_count, created_at, updated_at)
values ('tdsagent0000000000000001', 'tdsteam000000000000000001', 'Chief',
        '{}'::text[], '{}'::jsonb, 0, 1760000000000, 1760000000000);
SQL
```

三个坑，都是实测踩到的：

1. **`docker exec` 必须加 `-i`**，否则 heredoc 的 SQL **根本不会进 psql**，
   三条 insert 静默消失（我第一次跑完，`select ... from team` 返回 0 行）。
2. **`"user"` 必须加双引号** —— 它是 SQL 保留字，裸写报
   `syntax error at or near "user"`。
3. 枚举取值实测：`member_role` = `admin, member`；`member_type` = `user, agent`。
   写 `owner` 会报无效枚举值。

### 3.7 写 `.env`

```bash
KEK=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
TOK=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')
cat > /home/ubuntu/tds/.env <<EOF
HOST=0.0.0.0
PORT=4000
TDS_KEK=$KEK
TDS_WEB_TOKEN=$TOK
TDS_WEB_USER=jack@lan.local
TDS_CORS_ORIGIN=http://<派IP>:3100,http://127.0.0.1:3100
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4000
DATABASE_URL=postgres://tds:tds_local_dev@127.0.0.1:5433/tds
LOG_LEVEL=info
EOF
chmod 600 /home/ubuntu/tds/.env
```

实测：`TDS_KEK` 44 字符（base64 解出来正好 32 字节），token 32 字符。

> **`NEXT_PUBLIC_API_BASE` 用 `127.0.0.1` 而不是派自己的 IP**：BFF 架构下浏览器
> 只跟 web 同源通信，是 **web 的服务端**去调 Fastify。同机 → 127.0.0.1 最快且
> 不出机器。这个值在 `next build` 时被内联，**改了必须重新 build**。

### 3.8 构建前端

```bash
cd /home/ubuntu/tds/apps/web
set -a; . /home/ubuntu/tds/.env; set +a   # 让 NEXT_PUBLIC_* 进 build 环境
pnpm build
```

实测：**173 秒**（Cortex-A72 ×4）。19 个页面全部产出。

> **不要用 `set -e`**：`... | head -1` 会让上游收到 SIGPIPE 退出 141，`set -e`
> 直接中止脚本（我实测这样丢过一次 Node 下载）。

### 3.9 装 systemd 单元

```bash
sudo cp infra/systemd/tds-server.service infra/systemd/tds-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tds-server tds-web
```

两个单元里**必须显式设 `Environment=PATH=...node22/bin:...`**。原因（实测）：
`node_modules/.bin/tsx` 的 shebang 从 PATH 解析 `node`，不设 PATH 时
`systemctl show` 出来的进程用的是**系统 node v20.20.2**，违反 `engines >=22.19`。

---

## 4. 运行状态（实测）

```bash
sudo systemctl is-active tds-server tds-web     # → active / active
sudo journalctl -u tds-server -n 3 --no-pager
```

server 日志：`tds server listening on http://0.0.0.0:4000`
web 日志：`✓ Ready in 1593ms`，`Network: http://10.0.0.191:3100`

从另一台机器（开发机 Windows）实测：

```bash
curl http://<派IP>:4000/api/health
# {"ok":true,"ts":...,"protocol":"machine-v1"}

curl -X POST http://<派IP>:3100/api/auth/login \
  -H "content-type: application/json" -d '{"token":"<TDS_WEB_TOKEN>"}'
# HTTP 200 + set-cookie: tds_token=...; HttpOnly; SameSite=lax

curl -H "Cookie: tds_token=<cookie>" http://<派IP>:3100/api/user/context
# {"ready":true,"data":{"userId":"tdsowner...","email":"jack@lan.local",
#   "teams":[{...}],"agents":[...]}}
```

> **别被 `systemctl is-active tds-postgres` 骗了**：它返回 `inactive`，因为
> Postgres 是 **docker 管的**（`--restart unless-stopped` + compose），
> 没有 `tds-postgres.service` 这个单元。查它要用
> `sudo docker ps --filter name=tds-postgres` —— 实测状态是
> `Up 15 minutes (healthy)`。

实测资源占用（跑过 15 分钟后）：三件套 RSS 合计 **425 MB**，
`free` 报 available **2279 MB**，温度 63.8 °C。

---

## 5. 实测踩到的坑（按严重程度）

### 5.1 Secure cookie 在局域网 HTTP 下被浏览器丢弃（真 bug，已修）

`apps/web/src/lib/auth.ts` 原本写 `secure: process.env.NODE_ENV === 'production'`。
`next start` 时 `NODE_ENV` 就是 `production`，但局域网部署**没有 HTTPS 证书** →
cookie 带 `Secure` → 浏览器在 `http://` 下**直接丢弃**。

症状极具迷惑性：登录 POST 返回 `200 {"ok":true,"required":true}`，但页面永远停在
登录页，`/api/user/context` 一直 401。

**为什么在开发机上没暴露**：Chrome 把 `http://127.0.0.1` 当安全上下文，Secure
cookie 照样存。换成局域网 IP 才露馅。

修法：`secure` 跟**实际协议**走（`x-forwarded-proto` → 请求 URL 的 scheme），
不再跟 `NODE_ENV` 走。见 `requestIsSecure()`。

### 5.2 `docker exec` 不加 `-i` → SQL 静默丢失

见 §3.6。这是最阴的一个：不报错，也不生效。

### 5.3 系统 node 是 v20，engines 要 22.19

不能靠 `PATH` 默认值。systemd 单元必须显式设 PATH（§3.9）。

### 5.4 3000 端口已被占用

`new-api` 容器在用。改 3100，并同步改 `TDS_CORS_ORIGIN`。

### 5.5 compose 卷名与 `docker run` 卷名不同

见 §3.3。已在 `infra/docker-compose.yml` 里用显式 `name:` 解决。

### 5.6 从仓库根跑 `pnpm exec tsx` 会失败

见 §3.5。

---

## 6. 备份

服务端在派上，备份脚本照用：

```bash
cd /home/ubuntu/tds
export PATH=/home/ubuntu/.local/node22/bin:$PATH
export DATABASE_URL="postgres://tds:tds_local_dev@127.0.0.1:5433/tds"
cd packages/db && pnpm exec tsx scripts/backup.ts        # 默认写 .local/backups/
pnpm exec tsx scripts/restore.ts <备份目录> --yes
```

> **SD 卡提醒**：Postgres 数据卷在 SD 卡上。SD 卡的写入寿命是这台机器最真实的
> 风险（`smartctl` 在派上不可用，实测读不到寿命数据）。建议：① 定期把备份目录
> scp 到别的机器；② 考虑把数据卷挪到 USB SSD。

---

## 7. 客户端接入（执行机 / daemon）—— 已实测

服务端在派上，**执行机留在装有 agent CLI 的电脑上**（本例是 Windows 开发机）。
理由：`claude-code` / `codex` / `omp` 这些 CLI 在那台机器上已装好并登录，迁到
arm64 Linux 要重装重登；而且模型推理走外部 API，派不需要算力。

`apps/daemon/src/cli.ts:20` 是 `process.env.TDS_SERVER ?? 'http://127.0.0.1:4000'`，
`machines` 表没有单例约束（只有 `id` 主键 + `deviceId`），多台机器 enroll 支持。

### 7.1 先建 enroll 用的 api key

```bash
curl -X POST "http://<派IP>:4000/api/user/api-keys?token=<TDS_WEB_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"name":"<teamId>","scopes":["machine","write"]}'
# → {"apiKey":{...},"key":"tds_xxxxxxxx"}
```

> **实测踩到的设计缺陷**：`apps/server/src/routes/machine.ts:176` 是
> `eq(apiKeys.name, body.teamId)` —— enroll 要求 **key 的 `name` 必须等于 teamId**
> （把 key 名字当团队绑定用）。key 名叫 `worker-pc` 就必然 401
> `invalid enrollment key for team`。所以建 enroll key 时 `name` 要填 teamId，
> 不能填人类可读的名字。这条在 UI 上没有任何提示。

### 7.2 enroll 与启动

**`enroll` 不是子命令**（实测 `tds help` 只列 `start / status / stop / logout /
version / help`）—— 注册发生在 `start` 里，靠 `--api-key` + `--team` 触发：

```bash
cd apps/daemon
TDS_SERVER=http://<派IP>:4000 \
  npx tsx src/cli.ts start --foreground \
  --api-key tds_xxxxxxxx --team <teamId> --name worker-win
```

实测输出：

```
[INFO] enrolled machine=BEY5B8CGNFMuSzN393NGX7Z7 team=tdsteam000000000000000001 reused=false
[INFO] runtime claude-code: installed (2.1.226 (Claude Code))
[INFO] runtime omp: installed (omp/18.2.11)
[INFO] daemon up — server=http://10.0.0.191:4000 host=<执行机主机名>
[INFO] worker started — concurrency=6 runtimes=claude-code,omp
```

之后服务端侧的 `machine` 行（实测）：

```
BEY5B8CGNFMuSzN393NGX7Z7|worker-win|{claude-code,omp}|t|f|C:\Users\<你的用户名>\.tds\workspaces
```

> **`runtimes` 不会在 enroll 时写入**，要等第一次 `presence`。
> `PRESENCE_INTERVAL_MS = 60_000`（`apps/daemon/src/worker.ts:27`），
> 所以**刚 enroll 完看库里 `runtimes = {}` 是正常的**，等 60 秒再看。
> 服务端写它的地方是 `routes/machine.ts:637`。

### 7.3 已验证 / 未验证的边界

实测通过的：`enroll` → `machine` 行落库 → `presence` 写 runtimes → 心跳更新
`last_heartbeat_at` → daemon 重启后 `resuming machine=...`（复用注册，不重复建机器）。

**没验证的：`claim` → 真跑 agent → 回报结果**。要跑这条得先配模型 provider
（`/settings/providers`）并把 todo 指派给 agent —— 新库里 provider 是空的，
而且要用你自己的 API key。`todo` 的 `phase` 是 `todo`，`agent_id` 为空时
不会产生 `step`，daemon 的 claim 轮询自然拿不到活。

顺带实测到的状态机事实：`/api/todos/:id/move` **不能** `todo → queued`
（409 `not expressible as a known trigger`）；`approve` 只能在 `confirm` 闸门
（409 `approve is only valid at confirm gate; current phase is todo`）。
合法 `phase` 枚举：`todo / queued / planning / confirm / implement / review /
reviewing / done / failed / closed`。

---

## 8. 未验证事项（诚实清单）

| 事项 | 状态 |
|---|---|
| daemon 的 `enroll` / `presence` / 心跳 | **已实测通过**（§7.2、§7.3） |
| daemon 的 `claim` → 真跑 agent → 回报 | **未验证**（要先配 provider + 指派 agent；新库 provider 为空） |
| 断电后 SD 卡上 PG 卷能否完整恢复 | **未验证**（没做真断电测试） |
| SD 卡写入寿命 | **未验证**（`smartctl` 不可用，读不到） |
| 7×24 长期运行的内存走势 | **未验证**（本次只跑了分钟级） |
| Ubuntu 20.04 的 ESM 安全更新是否已开 | **未验证**（没查 `pro`） |
| 派上 `pnpm test` 是否通过 | **未验证**（本次只跑服务端构建与冒烟，没跑测试套件） |
| HTTPS / 反向代理 | **未验证**（当前纯 HTTP，`Secure` cookie 靠 §5.1 的修复才成立） |

---

## 9. 一句话总结

**4GB 的 Pi 4 跑这套服务端实测可行**：三件套常驻实测 425 MB（`ps` 累加 RSS，含
PG 容器），`next build` 3 分钟、`next start` 1.6 秒就绪。从局域网其它机器登录、
取数、看板渲染、写路径（建
项目 / 建 todo）全部实测通过；执行机 daemon 指向派的 `enroll` / `presence` /
心跳也已实测通过。

三个必须注意的点：
① **别动系统 node**（派上 5 个服务在用系统 node v20），用独立目录 +
systemd 显式 `PATH`；
② **`Secure` cookie 的判定必须跟实际协议走**，否则局域网 HTTP 下登录永远不生效
（这条是本次修的真 bug）；
③ **enroll key 的 `name` 必须等于 teamId**（`machine.ts:176` 的实现如此），
否则 401 且 UI 无提示。
