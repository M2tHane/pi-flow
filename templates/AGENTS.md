# AGENTS.md

本项目使用 pi-flow 管理开发流程（需求 → 原型 → 规划 → 实施 → 完成）。规划阶段由 architect 改写本文件，写入项目的结构、命令与约定。

- 项目命令见 `workflow.yaml` 的 `commands`。
- 流程状态在 `.flow/`（只读，由程序维护）；查看用 `/flow-status`。
- 规则在 `rules/`：`global.md` 是通用规则，`project.md` 是项目专属规则（规划阶段生成，只有用户可以修改）。
- 文档：需求说明 `docs/requirements.md`（功能另见 `docs/requirements/`）、原型 `prototype/`、模块规划 `docs/modules.md`、模块之间的接口 `docs/interfaces/`。

小改动（单文件、几十行以内）直接用 pi 更划算。
