---
name: design-contract
description: 先数据模型和模块边界，再功能；输出 schema 与 API 契约
---

# 设计契约

1. 先定数据模型：核心实体、字段、约束、关系。schema 只在一处定义（src/shared），类型与校验由它派生。
2. 再定模块边界与依赖方向，写入 docs/ARCHITECTURE.md。
3. 最后定接口：在 docs/contracts/ 中为每个模块写 API 契约（路径、方法、请求与响应 schema、错误码）。
4. 契约要能被测试直接引用：验收测试与实现都对着契约写，因此实现之间可以用软依赖并行。
5. 每个重大选型（框架、数据库、鉴权方式等）写一条 ADR：背景、选项对比、建议、影响。不替用户拍板，在 ADR 中写"建议"。
6. 契约在阶段批准后只读；之后的变更必须走新的 ADR。

## 规则与命令草案
技术栈定下来后，`rules/` 里的通用规则往往不够具体。你不能改 `rules/`，但可以写草案，由用户在批准阶段时决定是否应用：
- `docs/rules-draft/<名称>.md`：与 `rules/` 中同名的文件表示替换，新名字表示新增。保留原规则中仍适用的条目，补充选型相关的具体约束（例如"数据库访问统一用 Prisma Client，不写原生 SQL"）。每个文件不超过 40 行，每条可检查；能被 lint 或测试覆盖的不要写。
- `rules/` 中几处刻意留给架构决定（以 ARCHITECTURE.md 为准）：错误类型与错误响应格式、主键生成方式、是否使用外键约束、接口响应格式。在 ARCHITECTURE.md 写明，并在对应规则草案中写成具体条目，避免实施与审查时因规则含糊而阻塞。
- `docs/rules-draft/commands.yaml`：当选定的工具链与 workflow.yaml 的命令不符时（例如用 npm 而不是 pnpm），写 `commands: { test: "npm test", ... }`，只列需要改的命令。
