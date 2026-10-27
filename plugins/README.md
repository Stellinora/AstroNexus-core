# plugins/ · Agent 侧薄适配器

上报原始会话、调用 `knowledge.search` / `experience.search`、接收委派的适配器源码
（OpenCode、Claude Code、手机、无头 QQ）。

边界（docs/14 §3.3、docs/15 §3）：

- 跑在**本地**，不进入云端镜像。
- 只依赖 `@astronexus/protocol` 与 HTTP / MCP 契约。
- **不引用 `@deepseek-ai/*`**：DSH 只存在于 `services/dsh`。
- 不做反思、总结、归一化、同步冲突解决。
