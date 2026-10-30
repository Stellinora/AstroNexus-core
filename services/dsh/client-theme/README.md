# @astronexus/dsh-client-theme

浏览器侧主题插件。只覆盖 `--dsw-*` token，不改 DOM 结构，跟随 DSH 升级。

- 入口：`lib/client.js`（手写 DSH client bundle，无需构建工具链）
- 宿主侧：`lib/index.js` 空 `apply`，仅用于成为 Loader 条目
- 由 `@astronexus/dsh-bundle` 的 `cordis.patch.yml` 插入

配色对齐 DeepSeek 官方网页版：品牌蓝 `#4d6bfe`，浅色白底、深色 `#1b1b1d`。
