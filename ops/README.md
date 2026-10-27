# ops/ · 运维资产

迁移脚本、种子数据、可观测性配置。

约定：

- 迁移文件按 `NNNN-name` 命名，只前进、不修改已发布项。
- 脚本不得引用 `@deepseek-ai/*`；运维对象是记忆核心与 Worker，不是 DSH 内部。
- 与 `docker/compose.yml` 的卷布局保持一致（`DSH_HOME`、workspace、记忆存储）。
