# patches/ · DSH 上游补丁

仅在必要时使用，判定门槛见 `docs/15-DSH依赖策略.md` §6。

## 生成

```bash
pnpm patch @deepseek-ai/dsh@0.2.1-rc.2
# 编辑 pnpm 打印的临时目录
pnpm patch-commit <临时目录>
```

把产出的 `.patch` 复制到本目录。容器里由 `services/dsh/Dockerfile` 在安装后应用，
本地开发可 `git apply` / `patch -p1`。

## 登记

每个 patch 必须在本表登记；没有登记的 patch 不允许合入：

| patch | 目标包 | 原因 | 影响面 | 移除条件 |
|---|---|---|---|---|
| （暂无） | | | | |

## 要求

- 能提上游 PR 就先提；上游不接或等不及才落 patch。
- 每次升级 DSH：先删 patch 再跑 `pnpm run check` 与
  `dsh --profile astronexus --dump-config`，通过则不要保留 patch。
- patch 内容只改 DSH 自身，不夹带业务逻辑。
