# 交接文档：第三轮优化（效率）

> 写于 2026-10-02，基于 main 分支 `e8c7fe5` 之后。新对话请先读完本文档与 `CLAUDE.md`，再按需查阅 `NOTES.md`（偏离记录 1–87 条，第 82 条起是真实模型冒烟的发现）。第二轮的交接文档是 `docs/HANDOFF.md`（已全部完成）。

## 1. 当前状态

- 第二轮 A–L 全部完成；之后又做了：真实模型冒烟后的修订（临时目录、受限文件操作、审查者提问回到审查等）、默认规则重写与 `write-rules` 技能、启用 Pi 的 codemode、升级到 Pi 1.0.0、依赖检查（`src/core/dependencies.ts`）。
- 测试：单元 140、端到端 58，全部通过（`npm test`，约 6 分钟；端到端需要本机有 pi）。
- 环境：
  - Pi 1.0.0（全局安装）。
  - 用户的 `~/.pi/agent/pi-flow.json`：architect、reviewer、orchestrator、scout 用 `openai-codex/gpt-6.1-sol`（high）；实施角色用 `Workbuddy/glm-5.3-flash`（low），失败后升级到 gpt-6.1-sol。旧配置备份在 `pi-flow.json.bak-20261002`。
  - **gpt-6.1-sol（Codex）的用量额度在 2026-10-02 用完**，恢复前不能做真实模型测试；glm 的本地服务在 `localhost:7863`（需用户启动）。
- 用户偏好：
  - 中文沟通；用户只和主 agent 对话，流程中不手动改代码。
  - 每项先给计划，做完汇报（做了什么、偏离、待确认），等确认再做下一项；用户说"一直往下做"时连续完成。
  - 每项做完提交（中文提交信息，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）；同步更新 `README.md`、`NOTES.md`（偏离编号从 88 开始）、必要时 `CLAUDE.md`。
  - 改 `agents/`、`rules/`、`skills/` 要在 NOTES 的"缓存提醒"记一笔并在汇报中提醒。
  - 汇报要用通俗的话讲清楚；用户没看懂时要举例解释，不要只给术语。

## 2. 起因：中型项目冒烟的数据

用 `node scripts/real-build.ts --keep --no-replan --desc "<个人记账服务：账户、收支记录、分类、月度统计、Node http REST API、JSON 文件存储、CSV 导出>"` 从零跑一个中型项目（架构师拆出 13 个任务）。项目目录保留在 `/var/folders/87/538dtvdd6013gnp3w4qpz5jw0000gn/T/pi-flow-real-build-1gAnPk`（额度恢复后可用 `--dir <目录>` 接着跑），日志在本次会话的临时目录（已不可用）。

跑了 105 分钟后因 Codex 额度用完暂停，完成 7/13 个任务：

| 角色 | 运行次数 | 输入 token（不含缓存） | 输出 | 耗时 |
|---|---|---|---|---|
| reviewer（gpt） | 28 | 741k | 26k | 23 分钟 |
| test-engineer（glm） | 10 | 329k | 75k | 34 分钟 |
| backend-engineer（glm） | 8 | 271k | 79k | 42 分钟 |
| architect（gpt） | 4 | 109k | 34k | 22 分钟 |
| 合计 | 51 | 1457k | 214k | 122 分钟（运行时长合计） |

缓存读合计 13600k。异常：审查打回 9 次（T-004 两次、T-005 三次后转阻塞、T-008 两次）；`run_failed` 11 次，**全部是 "Codex error: The usage limit has been reached"**；被拦下的违规 9 次（无一次越界成功，无运行被终止）；升级模型 3 次；低风险审查 0 次（所有任务都改业务代码）。

## 3. 本轮要做的四件事（按优先级）

### A. 识别模型额度用完、限流等"服务不可用"错误：暂停而不是失败

> **已完成（2026-10-02）**，见 NOTES 第 88 条。待真实模型验证：Codex 额度恢复前用 `--dir` 续跑暂停的中型项目，确认额度错误被识别为暂停。

**问题**：子进程因为提供方额度用完、限流、服务不可用而退出时，引擎按 `run_failed` 处理（`src/core/dispatcher.ts` 的 `onExit` → `failRun`，转移表 `run_failed` 计一次失败），马上重新派发，又失败，直到 attempts 达上限转 blocked。冒烟中 11 次审查就这样空耗，还把任务推向阻塞。

**做法**：
- 识别：子进程结束时 `RunOutcome.error`（来自 `src/core/metrics.ts` 的 `UsageAccumulator`：最后一条 assistant 的 `errorMessage`，`stopReason` 为 error）与 `stderrTail`。按关键词与状态码判定"服务不可用"：usage limit、quota、rate limit、429、insufficient_quota、overloaded、503 等。规则集中放在一个函数里并写单元测试；判定不了的仍按 `run_failed`。
- 处理：
  - 不计入 attempts：复用 `run_interrupted` 转移（只增加 interruptions），或新增一个触发；在 NOTES 登记偏离。注意 `MAX_INTERRUPTIONS = 5` 的上限不应被额度问题触发（额度问题可能持续很久），需要单独计数或不计数。
  - 记录"模型暂停"：例如在 `.flow/` 中（经 StateStore 写入并登记）保存 `{ model, reason, since, retry_after? }`；用这个模型的派发（实施、审查、升级）暂停，用其他模型的照常。
  - 恢复：用户执行一个命令（例如 `/flow resume-model <模型>` 或 `/flow models`），或到了 `retry_after`（有的提供方返回重试时间）自动恢复；也可以提供"改用备用模型"的选项（`/flow-config` 为角色设置备用模型，或临时把该角色切到另一个模型）。
  - 提示：在"需要你处理"中列出被暂停的模型、原因、受影响的角色与任务，以及恢复方法；orchestrator 每轮注入的"下一步"说明在等用户处理。
- 验收：
  - 假模型返回额度错误时：任务 attempts 不增加、不转 blocked；同一模型不再被派发；"需要你处理"出现提示；用户恢复后继续派发并完成。
  - 只影响这个模型：其他模型的角色照常工作。
  - 假模型（`test/fixtures/fake-llm/server.ts`）需要支持返回 429 或错误消息，用来写端到端测试。

### B. 审查第二轮起只核对上次的问题，减少来回

**问题**：每轮审查都从头审，强模型每次都能找到新的问题，T-005 被连续打回 3 次。审查打回的内容可在知识库候选（已关闭）与事件日志中看到。

**做法**：
- 审查提示（`src/core/prompt-assembler.ts` 的 review 模式与 `agents/reviewer.md`）：第二轮起附上"上次打回的问题清单"（`task.last_failure` 或事件日志中最近一次 `review_reject` 的 reason），明确要求：
  - 先逐条核对上次的问题是否已解决；
  - 只为"上次的问题没解决"或"新改动引入的明确缺陷"打回，不提新的改进建议（写在 pass 的 notes 里）；
  - 验收标准本身有问题时 flow_block 交给用户（已有）。
- 可选：可配置的"审查轮次上限"，到上限后若只剩建议类问题就通过并记录（需在 workflow.yaml 增加可选配置并校验，默认保守）。
- 验收：第二轮审查的提示中出现上次的问题清单；提示中有"只核对上次问题"的要求；有测试覆盖提示组装。最好用真实模型复跑一个返工多的任务对比（等额度恢复）。

### C. 审查默认用中等模型，强模型只留给架构与最终验收

**问题**：审查占了一半的 token（28 次运行、741k 输入）。

**做法**：
- 模板 `templates/workflow.yaml` 中 reviewer 的档位从 strong 改为 medium；保留"高风险任务"用强模型的能力：例如在 `review` 配置中新增 `high_risk_model`（高风险任务、先行验收测试、合并冲突修复、阶段闸门前的最后审查用强模型），由 `src/core/cost-control.ts` 的 `assessRisk` 判定（现在只分 light 与 full）。
- 注意用户的 `pi-flow.json` 里 reviewer 显式设为 gpt-6.1-sol，模板改动不影响已有设置；汇报时说明用户需要用 `/flow-config` 调整，或提供"审查分级模型"的设置入口。
- 验收：普通任务的审查 run 使用中等模型，高风险的使用强模型，run 记录的 `review_mode` 区分三档（light、normal、strong 或类似）；配置校验与单元测试。

### D. 拆任务时尽早并行

**问题**：架构师拆出的 DAG 前两层完全串行（基础验收测试 → 基础实现 → 再分三条功能），实施阶段大部分时间只有一个任务在跑。

**做法**：
- `skills/decompose-dag/SKILL.md`：
  - 基础设施与公共底座合并为尽量少的任务（一个 infra 加一个基础实现），不要为底座再拆"先行验收测试 → 实现"两层；底座的验证放在 infra 的 verify 与后续切片的测试里。
  - 切片之间默认对着契约开发（软依赖 + integration），尽早并行；报告关键路径长度与并行宽度时，提醒"关键路径占比过高"的阈值可以更严格。
- `flow_propose_tasks` 返回的 DAG 报告（`src/core/dag.ts` 的 `dagReport`）可以增加一条提醒：前 N 层的并行宽度为 1 时建议合并或改为软依赖。
- 验收：技能文本修改并在 NOTES 记缓存提醒；`dagReport` 新提醒有单元测试。真实效果等额度恢复后复跑中型项目（相同描述）对比总耗时与并行度。

## 4. 建议顺序与验证

1. A（最急，额度问题随时会再出现）；
2. B、C（一起改审查相关：提示与模型分级）；
3. D（拆任务）。

每项做完跑 `npm run typecheck` 与 `npm test`。真实模型复跑等 Codex 额度恢复后进行：先用 `--dir` 把暂停的中型项目跑完（验证 A 的恢复路径），再用相同描述从零跑一次，对比本文档第 2 节的数据。

## 5. 工作须知

- 见 `CLAUDE.md` 与 `docs/HANDOFF.md` 第 4 节（Pi API 先查文档、只有 `src/pi-adapter/` 调 Pi API、子进程 stdin 关闭、guard 最后加载、测试用异步 spawn、可擦除 TS 语法、改 schema 后 `npm run gen:schemas`、新增转移写测试并登记偏离）。
- 真实模型冒烟脚本：`scripts/real-build.ts`（`--desc`、`--dir`、`--no-replan`、`--keep`；阻塞时代替用户采纳 agent 的建议，同一任务最多 3 次）；`node scripts/demo.ts --real-fix`（修复流程）。
- 子进程会话留档在 `<项目>.worktrees/.sessions/<run>/`，`/flow run <run_id>` 或 `src/core/session-log.ts` 的 `summarizeSession` 可看工具调用与最后回复，排查真实模型问题很有用。
- 全量端到端并发运行时，真实 pi 子进程首次启动偶尔很慢；崩溃恢复测试的等待上限已放宽到 180 秒。
