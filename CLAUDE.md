# pi-flow 项目说明（给 Claude Code）

## 需求与记录
- 第二轮优化（`docs/HANDOFF.md`，A–L）已完成，完成情况见该文档第 0 节与 `NOTES.md` 第 69–81 条；新工作开始前先读这两处。
- 原始需求见 `docs/BUILD_PROMPT.md`（不要修改它）。所有偏离规格的决定、已核实的 Pi API、已验证的版本号都记在 `NOTES.md`；新增偏离时在"偏离记录"中追加编号条目，并在对应里程碑的"设计要点"中补充。
- M0–M8 已全部完成。之后的每项改动：先给计划，完成后汇报（做了什么、偏离、待确认项），等用户确认再做下一项；用户明确要求连续完成时例外。
- Pi 的 API 一律先查文档或源码再使用，不凭记忆。Pi 安装在 `$(npm root -g)/@earendil-works/pi-coding-agent`，文档在其 `docs/`，类型在 `dist/**/*.d.ts`。当前以 Pi 0.99.2 为准。

## 结构
- `src/core/`：业务逻辑，不依赖 Pi。`state-store.ts` 是 `.flow/` 唯一的读写入口；`state-machine.ts` 是转移表（不在表中的转移一律拒绝）；`dispatcher.ts` 是引擎（派发与程序步骤 pump）。
- `src/modes/`：各模式的阶段计划（`plan.ts`）与 fix 流程（`fix.ts`）。
- `src/tools/`：`flow_*` 工具的业务实现；`src/commands/`：斜杠命令的业务实现。
- `src/pi-adapter/`：**唯一**可以调用 Pi API 的目录。`extension.ts` 是主会话扩展，`subagent.ts` 是子进程扩展（含 guard，必须最后加载），`pi-api.d.ts` 是已核实 API 的最小类型声明。
- `agents/`、`rules/`、`skills/`、`prompts/`、`templates/`：角色提示、规则、技能、提示模板、项目骨架模板。
- `schemas/*.json` 由 `npm run gen:schemas` 从 `src/core/schemas.ts` 生成，改 schema 后要重新生成。

## 约定
- 状态只能由程序写；agent 只通过 `flow_*` 工具提交申请。约束靠移除能力与程序校验，不靠提示词。
- 测试不得依赖真实 LLM：单元测试 + `test/fixtures/fake-subagent`（进程内脚本）+ `test/fixtures/fake-llm`（真实 pi 子进程配合本地假模型）。真实模型冒烟用 `node scripts/demo.ts --real-fix`，不进自动化测试。
- 改动后运行 `npm run typecheck` 与 `npm test`（约 5 分钟；端到端测试需要本机有 pi）。
- 代码只用可擦除的 TypeScript 语法（Node 原生类型剥离运行）：不用参数属性、enum、namespace。
- 标识符、文件名用英文；面向用户的提示、错误信息、文档用中文。用户界面只呈现高层阶段（需求 → 规划 → 实施 → 验收 → 完成），底层阶段与任务 DAG 留在 `--detail`。
- 修改 `agents/`、`rules/`、`skills/` 会让子进程系统提示的稳定前缀变化，在 `NOTES.md` 的"缓存提醒"中记一笔，并在汇报中提醒用户。
- 真实模型测试用 `Workbuddy/glm-5.3-flash`（本地服务 `localhost:7863`，需用户先启动；只支持 low/high/xhigh 思考级别）。不读取、不打印任何密钥。
