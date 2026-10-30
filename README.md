# AstroNexus Core · 云端 Docker 实现

> 状态：**结构已切换为 DSH 宿主形态**（代码待写）。
> 技术栈：TypeScript + Node >= 22（ESM / NodeNext）+ pnpm。
> 架构依据 `docs/14-云端记忆与多Agent编排.md`，依赖边界见 `docs/15-DSH依赖策略.md`。

## 工程形态

云端只跑一个长期进程：**DSH**。记忆、反思、编排不再是独立服务，而是同一个进程里的插件，共享 `ctx` 与一个 SQLite 连接。

```text
DSH 进程（profile: astronexus）
├─ memory       插件：ingest / 归一化 / 存储 / 检索 / sync / MCP 工具
├─ reflect      插件：异步反思流水线（租约、评分、去重、摘要、晋升、衰减）
├─ orchestrate  插件：任务状态 / 委派 / 记忆注入 / 结果汇总
└─ domain       纯 TS 内核：SQLite + schema + 检索 + 流水线算法（禁止 DSH 依赖）
```

**分层规则**：`domain/` 不 import `@deepseek-ai/*`；插件入口只做注册与适配，不写业务算法。这样 DSH 预览版 API 变更时，内核不用改。

## 组件与职责

| 组件 | 位置 | 负责 | 不负责 |
|---|---|---|---|
| **memory 插件** | `src/memory/` | 会话上报、幂等、归一化调度、存储、知识/经验检索、可见性、sync、MCP 工具 | 反思、对话、委派 |
| **reflect 插件** | `src/reflect/` | 领租约、评分、去重、矛盾检测、摘要、偏好提取、晋升、衰减 | 在线请求、改 schema |
| **orchestrate 插件** | `src/orchestrate/` | 对话入口、检索注入、任务拆解、ACP 委派、任务状态 | 记忆整理、归一化 |
| **domain 内核** | `src/domain/` | 存储实现、schema、FTS 检索、流水线算法 | DSH 上下文、HTTP 传输 |
| **契约层** | `packages/protocol` | 类型、JSON Schema、错误码、版本 | 任何运行时依赖 |
| **会话 Schema** | `packages/schema` | 框架无关事件模型 + 各框架解析器 | 存储、检索 |
| **薄插件** | `plugins/` | Agent 侧上报 / 检索 / 收委派（本地运行） | 反思、归一化、冲突解决 |
| **MCP 能力层** | `mcp/` | 文档搜索、Word 处理等挂载配置 | 能力实现 |
| **运维 / 打包** | `ops/`、`docker/` | 迁移、种子、可观测性、镜像与卷 | 业务逻辑 |

合并说明：原 `services/memory` 与 `services/worker` 已并入 DSH 插件；知识库与经验库共用一套存储与检索入口，sync 状态归 memory，任务状态归 orchestrate。

## 目录

```text
core/
├─ services/dsh/
│  ├─ bundle/
│  │  ├─ src/domain/        # 纯 TS 内核（禁止 @deepseek-ai）
│  │  ├─ src/memory/        # DSH 插件入口
│  │  ├─ src/reflect/       # DSH 插件入口
│  │  ├─ src/orchestrate/   # DSH 插件入口
│  │  └─ cordis.patch.yml   # 挂载三个插件
│  ├─ profile/              # headless：$DSH_HOME/profiles/astronexus
│  ├─ profile-web/          # Web：$DSH_HOME/profiles/astronexus-web
│  └─ Dockerfile
├─ packages/{protocol,schema}/
├─ plugins/                 # 本地 Agent 薄插件（不进镜像）
├─ mcp/ ops/ docker/
└─ patches/
```

## DSH

- 版本：`@deepseek-ai/dsh@0.2.1-rc.2`（exact）。
- Profile：`base + headless + @astronexus/dsh-bundle`；对外 API 阶段换 `sdk` 或追加 `acp`。
- 插件入口是 `services/dsh/bundle/src/{memory,reflect,orchestrate}`，其余目录禁止 `@deepseek-ai/*`。
- 升级、patch、fork 门槛：`docs/15-DSH依赖策略.md`。

## Web

- Profile：`astronexus-web` = `base + web-app + bundle`，监听 3080；`astronexus` 仍用于 headless/CLI。
- 隐私：`profile-web/cordis.patch.yml` 关闭 `session-log-deepseek`；compose 设置
  `DSH_TELEMETRY_MODE=DISABLED`、`DSH_TELEMETRY_DISABLED=1`。
- 对外由 Caddy 终结 TLS（`docker/Caddyfile`）；**先单用户**，token URL 不公开分发。
- 多用户、APK/PC 客户端、gateway 不在 core 范围，见 `docs/16-Web界面.md`。

## 落地顺序

1. `domain`：SQLite store + FTS 检索 + 幂等 ingest（纯 TS，可单测）
2. `memory` 插件：`ctx` 服务 + 工具 + MCP 暴露
3. `reflect` 插件：规则版流水线，再接模型做摘要/经验提取
4. `orchestrate` 插件：任务状态与 ACP 委派
5. profile 切 `sdk`/`acp`，端到端联调
6. 手机 App / 无头 QQ / MCP 能力层 / 多 Agent 扩展

## 硬约束

- 反思异步执行，**不进对话热路径**；写入路径不做 LLM、不做 embedding。
- 知识库（事实类、主动注入）与经验库（过程类、按需检索）分开建模。
- 委派只面对统一 `agent_id`；ACP / SSH / HTTP 差异由适配层封装。
- 任务状态统一为 `pending / running / done / failed`。
- 权限按 `visibility: private | project | global` 隔离。
- `domain/` 不依赖 DSH；插件入口不写业务算法。

## 当前状态

- [x] DSH 宿主形态与目录骨架
- [x] profile / bundle / Dockerfile / compose / CI / 依赖守卫
- [x] `astronexus-web` profile、Caddy 示例、隐私开关
- [x] 本地验证：`dsh plugin add` + `--dump-config` 组合成立
- [ ] `domain` 内核（SQLite、FTS、ingest）
- [ ] 三个插件入口与 `cordis.patch.yml` 挂载行
- [ ] 契约测试、迁移脚本
- [x] 基础镜像 digest 固定（`node:24-bookworm-slim@sha256:c86ecead…`）
- [x] 首次 `docker build` 与容器 3080 验证（WSL + Docker Desktop）

## 校验

```bash
pnpm install --frozen-lockfile
pnpm run check                                   # typecheck + 依赖守卫
docker compose -f docker/compose.yml config

# DSH 组合（不启动、不调模型）
DSH_HOME=<临时目录> dsh --profile astronexus --dump-config
DSH_HOME=<临时目录> dsh --profile astronexus-web --dump-config

# 本机 Web
DSH_HOME=<临时目录> dsh --profile astronexus-web --no-open --port 3080
```
