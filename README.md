# AstroNexus Core · 云端 Docker 实现

> 状态：**目录骨架**。技术栈：**TypeScript + Node >= 22**（ESM / NodeNext）+ **pnpm**。
> 架构依据 `docs/14-云端记忆与多Agent编排.md`，DSH 依赖边界见 `docs/15-DSH依赖策略.md`。

## 职责边界

| 在 core 内（进云端镜像） | 不在 core 内 |
|---|---|
| 统一存储与检索 API / MCP | OpenCode / Claude Code 本地执行 |
| 跨框架会话归一化 | 手机 App、无头 QQ 客户端 |
| 异步反思 Worker | MCP 能力的第三方实现 |
| DSH 组装层（profile / bundle / 薄插件） | 反射、归一化逻辑写在 DSH 插件里 |

`plugins/` 例外：源码放在本仓库便于联调，但它是**本地侧产物，不进入云端镜像**。

原则：**跨框架差异、反思总结、同步归一化全部封在 Docker 内部，插件永远保持薄。**

## 目录

```text
core/
├─ docker/                  # compose、entrypoint、健康检查
├─ services/
│  ├─ memory/               # 记忆核心：ingest、归一化、存储、检索 API / MCP
│  ├─ worker/               # 异步反思：评分/去重/矛盾检测/摘要/晋升/衰减
│  └─ dsh/                  # 唯一允许接触 DSH 的组装层
│     ├─ profile/           # $DSH_HOME/profiles/astronexus
│     ├─ bundle/            # @astronexus/dsh-bundle（层内容）
│     ├─ plugins/           # 跑在 DSH 进程内的薄插件
│     └─ Dockerfile
├─ packages/
│  ├─ protocol/             # 统一数据模型与 API 契约（docs/14 §5）
│  └─ schema/               # 框架无关会话 schema + 各框架解析适配器
├─ plugins/                 # Agent 侧薄适配器源码（本地运行，不进镜像）
├─ mcp/                     # MCP 能力层挂载配置（按项目隔离）
├─ patches/                 # 必要时的 DSH 上游 patch（需登记）
└─ ops/                     # 迁移脚本、种子数据、可观测性配置
```

## DSH

- 版本：`@deepseek-ai/dsh@0.2.1-rc.2`（exact）。
- Profile：`base + headless + @astronexus/dsh-bundle`，可用 `web / sdk / acp` 替换或追加。
- `@deepseek-ai/*` 只允许出现在 `services/dsh`，由 `.dependency-cruiser.cjs` 守卫生效。
- 升级、patch、fork 门槛：见 `docs/15-DSH依赖策略.md`。

## 落地顺序（docs/14 §8）

1. 统一协议与数据模型：会话、记忆、知识、经验、任务状态
2. Docker 核心最小闭环：上报 → 归一化 → 存储 → 检索 API/MCP
3. 接入第一个本地 Agent（OpenCode 薄插件）
4. 反思 Worker：异步反思、知识/经验生产
5. DSH 云端编排：对话入口、记忆注入、委派
6. 手机 App v1 / 无头 QQ / MCP 能力层 / 对话树归档 / 多 Agent 扩展

## 硬约束

- 反思异步执行，**不进对话热路径**。
- 实时对话走会话服务 / SSE；记忆整理异步消费，不参与实时同步。
- 知识库（事实类、主动注入）与经验库（过程类、按需检索）分开建模。
- 委派只面对统一 `agent_id`；ACP / SSH / HTTP 差异由适配层封装。
- 任务状态统一为 `pending / running / done / failed`。
- 权限按 `visibility: private | project | global` 隔离。

## 当前状态

- [x] 技术栈：TypeScript + Node >= 22 + pnpm（`package.json` / `tsconfig.json`）
- [x] 目录骨架；`services/dsh` 的 profile / bundle / Dockerfile 已就位
- [x] 依赖守卫 `no-dsh-outside-adapter`
- [x] 本地验证：`dsh plugin add` + `--dump-config` 组合成立
- [ ] 依赖与依赖注入方式（HTTP 框架、MCP SDK、存储驱动）
- [ ] 存储选型：SQLite FTS5 / Postgres + pgvector
- [ ] 是否采用 monorepo 工作区（当前为单包 + `paths` 别名）
- [ ] 基础镜像 digest 固定
- [ ] 首次 `docker build` 验证

## 校验

```bash
pnpm install --frozen-lockfile
pnpm run check                                   # typecheck + 依赖守卫

docker compose -f docker/compose.yml config

# DSH 组合（不启动、不调模型）
DSH_HOME=<临时目录> dsh --profile astronexus --dump-config
```
