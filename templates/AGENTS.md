# AGENTS.md

本项目使用 pi-flow 管理开发流程。

- 项目命令见 `workflow.yaml` 的 `commands`。
- 流程状态在 `.flow/`（只读，由程序维护）；查看用 `/flow status`。
- 规则在 `rules/`（按模块作用域注入，只有用户可以修改）。
- 文档：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/DESIGN.md`、`docs/adr/`、`docs/contracts/`。

小改动（单文件、几十行以内）直接用 pi 更划算。
