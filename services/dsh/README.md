# services/dsh · DSH 组装层

本目录是 **唯一允许 import `@deepseek-ai/*`** 的地方（见 `docs/15-DSH依赖策略.md`）。

```text
services/dsh/
├─ profile/                 # 复制到 $DSH_HOME/profiles/astronexus
│  ├─ package.json          # dsh.profile.bundles 有序列表
│  └─ cordis.patch.yml      # 用户层覆盖（空层写 []）
├─ bundle/                  # 安装为 @astronexus/dsh-bundle
│  ├─ package.json          # dsh.bundle.patch → cordis.patch.yml
│  └─ cordis.patch.yml      # 叠加在 base/headless 之后的层
├─ plugins/                 # 跑在 DSH 进程内的薄插件源码（待实现）
└─ Dockerfile
```

## 组装顺序

profile 层按以下顺序叠加，后者覆盖前者：

1. `dsh.profile.bundles` 里每个 bundle 的 patch（按列表顺序）
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`（机器级）
4. `--patch <path>` 覆盖

## 命令

```bash
# 预览组合后的配置（不启动、不调用模型）
dsh --profile astronexus --dump-config

# 把本地 bundle 装进 profile（dsh 会把 pnpm 转交给 profile 目录）
dsh plugin --profile astronexus add ./bundle

# 启动
dsh --profile astronexus "<task>"
```

## 约束

- 版本由根 `package.json` 与 `bundle/package.json` 的 `engines.dsh` 锁定为 `0.2.1-rc.2`。
- 升级或 patch 前先读 `docs/15-DSH依赖策略.md`。
- 插件里不写反思、归一化、存储逻辑；那些在 `services/memory` 与 `services/worker`。
