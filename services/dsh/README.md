# services/dsh · DSH 宿主与插件

云端唯一长期进程。三个插件与纯 TS 内核在同一个进程内运行。

```text
services/dsh/
├─ profile/                 # headless：$DSH_HOME/profiles/astronexus
│  ├─ package.json          # dsh.profile.bundles
│  └─ cordis.patch.yml      # 用户层覆盖（空层写 []）
├─ profile-web/             # Web：$DSH_HOME/profiles/astronexus-web
│  ├─ package.json          # base + web-app + bundle
│  └─ cordis.patch.yml      # 关闭 session-log-deepseek
├─ bundle/                  # 安装为 @astronexus/dsh-bundle
│  ├─ src/domain/           # 纯 TS 内核；禁止 @deepseek-ai
│  ├─ src/memory/           # 插件入口：ingest / 检索 / MCP / sync
│  ├─ src/reflect/          # 插件入口：反思流水线
│  ├─ src/orchestrate/      # 插件入口：任务与委派
│  └─ cordis.patch.yml      # 插入三个插件行
├─ docker-entrypoint.sh     # 按 DSH_PROFILE 选择 profile 与监听参数
└─ Dockerfile
```

## 插件

| 插件 | 入口 | ctx 注册 |
|---|---|---|
| memory | `@astronexus/dsh-bundle/memory` | `ctx.memory` 服务 + 模型工具 + MCP |
| reflect | `@astronexus/dsh-bundle/reflect` | 定时/租约循环，消费 memory 的 jobs |
| orchestrate | `@astronexus/dsh-bundle/orchestrate` | 任务状态 + ACP 委派 + 检索注入 |

入口文件只做 `apply(ctx)` 注册；算法与存储都在 `src/domain/`，不 import `@deepseek-ai/*`。

## 组装顺序

1. `dsh.profile.bundles` 的 bundle patch（按列表顺序）
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. `--patch <path>`

## 命令

```bash
dsh --profile astronexus --dump-config
dsh --profile astronexus-web --dump-config
dsh plugin --profile astronexus-web add ./bundle
dsh --profile astronexus-web --no-open --port 3080
```

## 约束

- 版本由 `Dockerfile` 的 `ARG DSH_VERSION` 与 `bundle/package.json` 的 `engines.dsh` 锁定为同一精确版本。
- 升级或 patch 前先读 `docs/15-DSH依赖策略.md`。
- 插件入口不写反思、归一化、存储算法。
