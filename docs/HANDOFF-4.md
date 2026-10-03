# 交接文档：第四轮（改流程：去掉逐任务审查，改为阶段末审查一次）

> 写于 2026-10-03，基于 main `1f760bc`。新窗口请先读完本文档与 `CLAUDE.md`，再按需查 `NOTES.md`（已精简为 20KB，偏离记录 1–100 条，编号不变；第 100 条与"真实模型实验"表是本轮的起因）。
> 第三轮交接文档是 `docs/HANDOFF-3.md`（A–D 与后续改动均已完成）。

## 1. 当前状态

- 测试：单元 155、端到端 69，全部通过（`npm test` 约 6 分钟；端到端需要本机有 pi）。
- 环境：Pi 1.0.0。用户的 `~/.pi/agent/pi-flow.json`：architect、reviewer、orchestrator、scout 用 `openai-codex/gpt-6.1-sol`（high）；实施角色用本地 `Workbuddy/glm-5.3-flash`（low，服务在 `localhost:7863`，需用户启动），失败后升级到 gpt。gpt 额度已充值。
- 用户偏好（务必遵守）：
  - 中文沟通；用户只和主 agent 对话，流程中不手动改代码。
  - 汇报用通俗的话讲清楚；用户没看懂时举例解释，不要堆术语。
  - 交接文档里写清楚的事项可以直接做完再汇报，不必先给计划；设计上有真正需要用户拍板的分歧时先问。
  - 只跑和改动相关的测试；改动面大时再跑全量端到端。
  - 每项做完单独提交（中文提交信息，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）；同步 `README.md`、`NOTES.md`（偏离记录从第 101 条起，1–3 行）、必要时 `CLAUDE.md`。
  - 改 `agents/`、`rules/`、`skills/` 要在 NOTES"缓存提醒"追加一行并在汇报中提醒。

## 2. 起因（对照实验的结论，详见 NOTES"真实模型实验"表）

同一份需求，原生 pi（gpt-6.1-sol high，单会话）与 pi-flow 对比：
- 记账服务（中）：原生 9.7 分钟、20 个黑盒用例全过；pi-flow 64.5 分钟，质量相同。
- 团队看板（大，含一次需求变更）：原生 21.5 分钟，隐藏测试基础 39/40（唯一失败的用例超出需求，不计）、变更 6/6；pi-flow 84 分钟后仍在实施阶段（10/16），审查打回 11 次，用户叫停。

pi-flow 慢在**流程本身制造的返工**：先行验收测试写错（已在第 100 条改为实施者边写边测）、契约超出需求（第 100 条已加 extras 申报）、**每个任务一次审查、强模型每轮都能挑出新问题**（本轮要解决的）。

## 3. 用户想要的流程（本轮目标）

1. **讨论需求**：主会话访谈，一次一问，反问用户没想到的点（现有 interviewer 已做到）。
2. **落成文档**：PRD → API 契约，**按模块划分，写到函数名、输入输出参数、可能的错误**。
3. **拆 DAG**：确定软硬依赖，每个任务一个 worktree，派给 worker。
4. **worker 边写边测**：写完局部测试，报错自己修；**不要逐任务的 verify 与 reviewer**。
5. **合并时**：rebase 到最新集成分支后跑一次**全量测试**，通过就合并；不过就退回 worker（带失败日志）。
6. **每个阶段的任务全部合入后**：
   1. 一个强模型 reviewer 读本阶段**全部模块的代码**，对照规则与契约，提交一份**带编号的问题清单**（位置、问题、期望的修改，按模块归类）。
   2. 程序按模块把清单拆成修复任务，**并行**派给对应角色；每个修复任务只拿到自己那几条问题，可写范围限定在相关文件。
   3. 修复合入后，reviewer 做一次**确认**：只能对清单上已有的编号逐条回答"已解决 / 未解决"，**不能提出新问题**（用工具参数的格式锁死，不靠提示词）。未解决的只再修**一轮**，不再确认。（用户已同意的设计；"确认"这一步保留，成本低：只看清单上的几处。）
   4. 跑**全量测试**：通过 → 进入下一阶段（需要人工的阶段照旧等用户批准）；失败 → 把失败日志交给负责的模块修，最多两轮，仍失败就转为"需要你处理"。
7. 人工批准保留三处：PRD（S0）、契约与任务拆分（S1/F1）、最终合入主分支（最后阶段）。

**原则不变**：状态只由程序写；约束靠程序（工具参数、guard、转移表），不靠提示词；子进程只用本角色工具。

## 4. 现状与改动点（代码位置）

| 环节 | 现在 | 要改成 |
|---|---|---|
| 契约格式 | `skills/design-contract/SKILL.md` 只要求"路径、方法、请求与响应 schema、错误码"，architect 自定格式 | 每个模块的对外函数：名字、参数（名、类型、约束）、返回值、抛出的错误；REST 接口照旧写。拆任务时任务的 `inputs` 列出依赖的契约文件与条目。`agents/architect.md` 同步 |
| 提交之后 | `in_progress →(submit) review`；`dispatcher.ts` 的 `reviewStep` 先 `runPrecheck`（`verify-runner.ts`）再派审查；审查通过 → verifying → `runVerify` → queued_merge | **新增配置**（建议 `review.per_task: false`，默认关闭）：关闭时提交后直接进入合并（转移表需新增 `review → queued_merge` 或 `in_progress → queued_merge` 的触发，例如 `submit_direct`；或沿用 `review_skip` + 免 verify——选一种并登记偏离）。开启时保持现有逐任务审查（现有测试大量依赖它，作为可选保留） |
| 合并后验证 | `merge-queue.ts` 约第 220 行：只跑任务 verify 里有的命令，test 优先用 `test_affected`（codegraph 受影响测试） | 关闭逐任务审查时：rebase 后跑全量 `test`（以及 typecheck、lint 若在 commands 中定义且非空）；失败按 `merge_verify_fail` 退回实施，worker 接续对话修（第 93 条机制已有） |
| 阶段推进 | `dispatcher.ts` 的 `advanceStage`：本阶段任务全部 settled → `submit_gate` → `gates.ts` 的 `runStageGate` 跑闸门命令 | 在提交闸门之前插入"阶段末审查"子流程（见下） |
| 审查任务 | 每个任务一个 reviewer run，`flow_approve` pass/reject | 新增阶段级审查任务（建议程序生成的 kind=analysis 任务，角色 reviewer，类似修订任务 `replan` 的做法），新工具（建议名 `flow_review_report`）提交问题清单：`issues: [{ id(程序编号), module, location, problem, expected, files[] }]` |
| 修复任务 | `review-fix` 这个 kind 已在 `TASK_KINDS` 里但没有使用（提案与修订禁止手工创建） | 程序按清单的 module/files 生成 `review-fix` 任务：角色取可写范围覆盖这些文件的实施角色（参考 merge-fix 选角色的逻辑 `merge-queue.ts`）、writes 为问题涉及的文件、验收标准就是这几条问题、并行派发 |
| 确认 | 无 | 修复全部合入后派同一阶段的确认 run：新工具（建议 `flow_review_confirm`）参数只有 `results: [{ id, resolved: boolean, note? }]`，**id 必须是清单中已有的编号，不接受新增**；未解决的再生成一轮修复任务（不再确认） |
| 全量测试 | 闸门的 auto 命令 | 确认之后跑闸门（全量 test 等）；失败时：按失败日志生成修复任务（失败测试文件 → 按 writes 找到负责的角色；找不到就给 test-engineer 或请用户处理），最多两轮；仍失败转"需要你处理" |

需要新增的状态（经 StateStore 写入并登记哈希，加 schema、`npm run gen:schemas`）：每个阶段的审查记录，建议 `flows/<id>/stage-review-<阶段>.json`：`{ stage, status（reviewing/fixing/confirming/testing/done/needs_human）, issues[], confirm[], rounds }`。阶段推进按这个状态走，崩溃恢复（`resume.ts`）要能从中途继续。

要同步的提示与文档：
- `agents/reviewer.md`：增加"阶段审查"的工作方式（读全部模块、按模块编号、只提违反规则/契约/验收标准与明确缺陷，不提风格偏好；确认时只能回答已有编号）；新技能可选（例如 `skills/stage-review/SKILL.md`）。
- 实施角色提示：`review-fix` 任务只修分到的问题，不顺手改别处。
- `skills/decompose-dag/SKILL.md`：去掉"审查"相关表述；S4 联调任务照旧。
- 状态视图（`status-view.ts`）与 orchestrator 的下一步（`context-injector.ts`）：阶段审查中、修复中、确认中、全量测试中要有人话描述；"需要你处理"列出两轮仍失败的情况。
- README 的流程说明、`learn-demo.html`（**已过时**：仍演示"先写验收测试再实现"和逐任务审查；本轮改完后按新流程重写演示步骤）。

## 5. 建议顺序与验收

1. **契约到函数级**（技能与提示，最小改动）。
2. **逐任务审查可关闭 + 合并时全量测试**：新配置默认关闭逐任务审查；转移表新增直通合并的触发并写单元测试；`merge-queue` 关闭审查时跑全量；端到端：提交后不派审查、直接合并、合并测试失败退回并接续对话修好。现有依赖逐任务审查的端到端测试改为显式开启 `review.per_task: true`（与第 100 条处理先行验收测试的做法一致）。
3. **阶段末审查一次 + 按模块并行修复 + 只确认不新增 + 全量测试与有限重试**：端到端覆盖：
   - 审查提交 3 条问题（分属两个模块）→ 生成两个并行的 `review-fix` 任务 → 合入；
   - 确认时尝试提交清单外的编号被工具拒绝；一条未解决 → 只再修一轮 → 不再确认；
   - 全量测试失败 → 生成修复任务 → 第二轮仍失败 → "需要你处理"；
   - 崩溃恢复：在修复中、确认中强杀后 `/flow resume` 能继续。
4. 每项做完跑 `npm run typecheck` 与相关测试；第 2、3 项涉及引擎主路径，做完跑一次全量端到端。
5. **复跑对照**：用看板需求复跑 pi-flow，与原生 pi 21.5 分钟、上一轮 84 分钟未完成对比（见第 6 节命令）。估计能降到 40–50 分钟，以实测为准。

## 6. 实验与工具

- 冒烟：`node scripts/real-build.ts --keep --no-replan --desc-file ~/pi-flow-runs/kanban-input/requirement.md --feature-file ~/pi-flow-runs/kanban-input/change.md > ~/pi-flow-runs/kanban-piflow-<时间>.log 2>&1 &`（脚本会在阻塞时代用户采纳建议、"建议修订计划"时发起 replan；Ctrl-C 或 kill 会转发信号并清理子进程）。
- 原生 pi 对照：`node scripts/baseline-build.ts --desc-file … --then-file …`（`--model`、`--thinking` 可换）。原生 pi 的 bash 没有超时，跑时配一个看门狗：项目内超过 300 秒的测试进程结束并记一次人工介入（上一轮的脚本在作业临时目录，已不可用，需要时照此重写）。
- 评分：`node ~/pi-flow-runs/kanban-bench/hidden.mjs <项目目录> --change`（46 个隐藏用例；需求、变更在 `kanban-bench/` 与 `kanban-input/`）。"非法 JSON 返回 400"这条超出需求，两边都不计分。记账服务的 20 个黑盒用例在 `~/pi-flow-runs/probe.mjs`（路径写死了几个旧项目目录，按需改）。
- 看真实项目状态：`node scripts/flow-view.ts <项目目录>` 生成交互视图。
- 后台等待脚本结束时，用 `kill -0 <pid>` 轮询，不要用 `pgrep -f <脚本名>`（会匹配到等待命令自身，永远不退出）。后台任务最长 2 小时，到时会被停掉。

## 7. 工作须知

- 见 `CLAUDE.md`（Pi API 先查文档或源码、只有 `src/pi-adapter/` 调 Pi API、子进程 stdin 关闭、guard 最后加载、可擦除 TS 语法、改 schema 后 `npm run gen:schemas`、新增转移写测试并登记偏离）。
- 测试用配置 `test/helpers/config.ts` 的 `TEST_YAML`：并发 2、关闭自动派发；新配置的默认值若会改变大量测试的行为，参照这里的做法在测试配置里固定旧行为，再为新行为单独写测试。
- 子进程会话留档在 `<项目>.worktrees/.sessions/<run>/`，`/flow run <run_id>` 或 `src/core/session-log.ts` 的 `summarizeSession` 排查真实模型问题。
