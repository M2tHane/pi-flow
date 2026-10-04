# 第五轮：精简为"讨论 → 原型 → 模块规划 → 按模块实施与验收"

> 记于 2026-10-04。起因见 `docs/BENCHMARK-5.md`：在已有的 7 万行仓库上，原生 Pi 单会话 30 分钟完成 3 个需求加 1 次追加，隐藏验收 43/43、0 回归、0 误改。按预先定的判定标准，现有多角色流程不可能证明价值，因此按"持平"精简。
> 设计参考了 my-work-flow 的 `/supie-dev`：保留它的需求辩论、原型、独立验收；不要它的契约钉死、逐任务双审查、按层拆角色和 HTML 报告。
> **保留 pi-flow 的运行时**：状态与事件、租约与恢复、越界拦截、合并队列、多模型调度。这部分是原生 Pi 和提示词工作流都没有的硬保证。

## 0. 用户已定的决定

1. 需求要先讨论：双视角辩论**一轮**，用户看过结果后再提意见完善，可以来回多次。
2. 原型不做三选一：需求讨论结束时写明打算用的风格和理由，原型直接按这个风格生成一套。
3. 不要 drawio、带溯源矩阵的测试报告 HTML、验收报告 HTML。
4. 不是一个模型从头做到尾：项目分阶段、分模块，**一个模块交给一个模型**，前端、后端、测试都由它写。互不依赖的模块可以并行。
5. 去掉函数级契约、逐任务审查、阶段审查、按层拆角色（前端、后端、数据库各一个模型）。

## 1. 新流程（用户视角）

```
/flow-build "<想法>"               新项目；已有项目加功能用 /flow-build --feature "<想法>"
  │
  ▼ 需求（D0）
  用户视角、开发视角两个只读 agent 并行各写一版（一轮）
  → 汇总者写 docs/requirements.md：需求清单与优先级（MVP / 以后 / 不做）、
    每条 done-when 验收标准、分歧清单、打算用的风格与理由
  → 你审：/flow reject "<意见>" 让汇总者接着原会话修改（可多次）；满意后 /flow approve
  │
  ▼ 原型（D1，有界面时；纯后端或你说不要就跳过）
  按定下的风格生成 prototype/*.html：填示例数据、每个功能可点击演示、含加载 / 空 / 错误 / 无权限四态
  → 你点一遍：/flow reject "<意见>" 修改；需求要改就回到 D0；满意后 /flow approve
  │
  ▼ 模块规划（D2）
  architect 写 docs/modules.md：模块清单、每个模块负责的需求与验收标准、可写范围、
  模块之间的接口（只写 A 要调用 B 的哪些 API 或服务）、阶段顺序（用依赖表达）
  → 你审：/flow approve 或 /flow reject "<意见>"
  │
  ▼ 实施（E）：按依赖逐层推进，同一层里互不依赖的模块并行
  每个模块：
    ① 一个强模型实施：前端、后端、迁移、测试都由它写（独立工作区，越界拦截）
       模块太大时分步提交：做完一部分先合并，再接着原会话做下一部分
    ② 合并：rebase 到集成分支最新，跑全量测试，失败退回同一会话
    ③ 独立验收：没参与实现的 agent 在集成分支上实际运行，对照该模块的验收标准逐条确认
       不通过 → 交回实现者的会话修复 → 只复查没通过的条目；两轮仍不通过转"需要你处理"
  依赖它的模块要等它验收通过才开工
  中途：/flow add "<追加>" 送到正在做的模块；/flow resume 恢复；额度用完自动换后备模型或等待
  │
  ▼ 完成：全部模块验收通过、全量测试通过后，/flow approve 合入主分支
```

**已有项目加功能**：流程相同。D1 视情况跳过；D2 简化为"这次涉及哪几个模块、各自改什么、验收标准是什么"。
**修 bug**（`/flow-fix`）：一个任务，由负责相关模块的实现者定位并修复，合并后由验收者复现确认已修好。不再单独拆定位、复现测试、审查几个任务。

用户界面的高层阶段改为：**需求 → 原型 → 规划 → 实施 → 完成**。

## 2. 角色

| 角色 | 读写 | 模型 | 做什么 |
|---|---|---|---|
| orchestrator（主会话） | 不能改代码 | 用户的主会话 | 和用户对话、转达意见、查状态、派发 |
| user-advocate | 只读 | 强 | D0：谁用、核心场景、必须有和可选、用户级验收标准 |
| dev-advocate | 只读 | 强 | D0：可行性、成本热点、风险、更省的做法 |
| analyst | 写 `docs/requirements.md` | 强 | D0：汇总两份意见，写需求说明和风格；按用户意见修改 |
| designer | 写 `prototype/**` | 强 | D1：原型 |
| architect | 写 `docs/modules.md`、`docs/interfaces/**`、`AGENTS.md`、规则草稿 | 强 | D2：模块规划；执行中修订计划 |
| implementer | 写本模块可写范围 + 登记的公共文件 | 强（可配后备） | E：一个模块的前后端与测试 |
| acceptor | 只读仓库；可在临时目录运行程序、跑测试 | 强 | E：独立验收 |

旧的 interviewer、scout、reviewer、test-engineer、backend / frontend / db / infra-engineer、ui-designer 删除。researcher 保留（联网查资料），按需由 architect 或 implementer 的任务调用。

## 3. 保留的部分（运行时）

| 部分 | 文件 | 说明 |
|---|---|---|
| 状态与事件 | `state-store.ts`、`event-log.ts`、`schemas.ts`、`state-machine.ts` | 事务写入、哈希链事件、状态提交到独立引用；转移表收缩到新流程需要的状态与触发器 |
| 引擎 | `dispatcher.ts`、`scheduler.ts`、`engine-lock.ts` | 自动派发、程序步骤推进（pump）、并发上限、单引擎锁 |
| 租约与恢复 | `resume.ts`、`subagent-runtime.ts`（心跳续租）、看守 | run token、租约、心跳；`/flow resume` 只依赖 `.flow/` 与 git |
| 接着原会话 | `launcher.ts`、`session-log.ts` | 返工、验收修复、分步提交都 fork 原会话（同模型、会话不太大时） |
| 越界拦截 | `guard.ts`、`shell.ts`、`paths.ts`、`strays.ts` | 路径与受保护文件、危险命令、敏感读取、后台进程、原地打转检测、残留进程清理 |
| 合并队列 | `merge-queue.ts`、`worktree.ts`、`verify-runner.ts`、`git.ts` | squash、rebase、全量验证、失败退回、冲突交给原会话（merge-fix）、批量合并、CAS 更新集成分支、同步主分支 |
| 多模型调度 | `model-pause.ts`、`role-settings.ts`、`cost-control.ts` 中的升级与预算部分 | 额度或限流暂停与自动恢复、后备模型、失败后升级、流程预算 |
| 闸门与发布 | `stages.ts`、`gates.ts`、`release.ts` | 用户批准、打回、自动检查命令、合入主分支 |
| 主会话约束 | `context-injector.ts`、`orchestrator-tools.ts` | 每轮注入"唯一允许的下一步"、主工作区越权检测 |
| 度量 | `metrics.ts`、`cost.ts` | 每次运行的 token、花费、工具调用 |
| 知识库 | `knowledge.ts` | 长期、多模块项目里跨会话积累约定与坑，保留 |
| 计划修订 | `revision.ts` | 长期项目要增删模块；改为修订模块清单与依赖 |
| 工具链 | `init.ts`、`preflight.ts`、`doctor.ts`、`dependencies.ts`、`codegraph.ts`、`flow-config.ts` | 不变 |

## 4. 删除的部分

| 删除 | 文件或内容 |
|---|---|
| 阶段审查 | `stage-review.ts` 的"代码审查"语义（机制改造成第 5 节的模块验收）、两个审查工具中的代码审查部分 |
| 逐任务审查与风险分级 | `cost-control.ts` 的审查部分、`review`/`verifying` 路径、`flow_approve` |
| 函数级契约与契约锁定 | `design-contract` 技能、契约锁定、`contract_rewrites`、`test-adjust.ts`（模块内部不再有契约，跨模块接口改为可追加） |
| 先行验收测试 | `dag.ts` 中 leading / carried test 的逻辑、`testing.leading_tests` |
| 旧的设计阶段 | S0–S5、F0–F4 的阶段计划（`modes/plan.ts` 重写）、PRD 与 ARCHITECTURE 模板、`write-prd`、`write-feature-spec`、`decompose-dag` |
| 需求访谈 | `modes/interview.ts`（被 D0 辩论替代） |
| 旧的修 bug 流程 | `modes/fix.ts` 的定位、复现、审查多任务结构 |
| 角色与技能 | 第 2 节列出的旧角色；`rules/` 中按层的规则（backend、frontend、database 等）合并为 global 加项目自己的 AGENTS.md |

预计源码从约 1.16 万行降到 7 千行左右：运行时基本不动，删的主要是流程与审查。

## 5. 新增与改造

| 编号 | 内容 | 要点 |
|---|---|---|
| N1 | **需求讨论（D0）** | 两个 advocate 任务并行（只读，结论写进 handoff）→ 程序派 analyst 写 `docs/requirements.md`（含风格）→ 用户闸门。`/flow reject "<意见>"` 让 analyst 接着原会话修改，可以多次 |
| N2 | **原型（D1）** | designer 写 `prototype/*.html` 与导航页；无框架、无构建；用户闸门。workflow.yaml 或 D0 结论里标明"无界面"时跳过 |
| N3 | **模块规划（D2）** | architect 用 `flow_propose` 提交模块任务：每个模块一个任务，带可写范围、负责的验收标准、依赖（阶段顺序用依赖表达）、登记的公共文件。`dag.ts` 保留依赖类型、环检测、ready 计算、可写范围互斥 |
| N4 | **跨模块接口** | `docs/interfaces/<模块>.md` 只写模块之间的调用。实施中可以**追加**（沿用第 109 条的"只能新增"检查），改动已有内容要走计划修订 |
| N5 | **模块实施** | 一个 implementer 一个模块；可写范围 = 模块目录 + `shared_files`（路由注册、菜单、迁移目录、文案等，由 workflow.yaml 或 D2 登记）。提交后直接进合并队列，合并时跑全量测试 |
| N6 | **分步提交** | `flow_submit` 增加 `next_step`：这次只合并一部分，合并后程序接着原会话派发下一步（同一任务，次数有上限）。用于一个会话装不下的大模块 |
| N7 | **独立验收** | 复用第四轮阶段审查的"清单 → 修复 → 只确认已有编号"机制，改成按模块：模块合并后派 acceptor，在集成分支上构建、启动、实际调用，按验收标准逐条给出 `{id, passed, evidence}`；不通过的交给实现者会话修复（fork），合并后只复查没通过的条目；两轮仍不过转"需要你处理"。依赖它的模块等验收通过才开工 |
| N8 | **运行中追加**（`/flow add`） | 子进程启动方式从 `pi --mode json -p` 改为 `pi --mode rpc`，追加需求用 steer 送到正在运行的会话（Homebox 实验里原生 Pi 就是这样收到 R4 的）；没有运行中的任务时，由 architect 判断归哪个模块或新增模块 |
| N9 | **合并检查钩子** | workflow.yaml 增加 `commands.merge_check`（可选），合并验证时和全量测试一起跑。例如 Alembic 项目配置"只能有一个 head"的检查，多个 head 时退回实现者把迁移接到最新的 head 后面。程序里不写死任何框架 |
| N10 | **状态视图与文档** | 高层阶段改为"需求 → 原型 → 规划 → 实施 → 完成"，实施阶段按模块显示进度与验收结果；README、NOTES、CLAUDE.md、learn-demo 同步 |

## 6. 提交顺序

每步跑相关测试，最后跑全量。新流程先和旧流程并存，最后再删旧代码，避免中途不能运行。

| 步 | 内容 |
|---|---|
| 1 | 新角色提示与 workflow.yaml 模板（D0、D1、D2、E 的阶段定义；`shared_files`、`merge_check`） |
| 2 | N1 需求讨论：两个 advocate 并行 → analyst 汇总 → 闸门与"打回接着原会话改" |
| 3 | N2 原型 |
| 4 | N3、N4 模块规划与跨模块接口（追加检查） |
| 5 | N5、N6 模块实施与分步提交 |
| 6 | N7 独立验收（改造 `stage-review.ts`） |
| 7 | N8 RPC 启动方式与 `/flow add` |
| 8 | N9 合并检查钩子 |
| 9 | 删除第 4 节的旧机制，收缩 schema 与转移表，清理测试 |
| 10 | N10 状态视图与文档 |
| 11 | 验证（第 7 节） |

## 7. 验证

1. **看板新建**（约 4000 行，有界面）：完整走一遍 D0–E，看讨论、原型、模块规划、实施和验收是否顺畅；对比原生 Pi 的 17.6 分钟和第四轮的 75 分钟。
2. **Homebox 加功能**（已有 7 万行仓库）：同样的 R1–R4 需求，用 `/flow-build --feature`，用隐藏测试打分；对比原生 Pi 的 30.4 分钟、43/43。
3. **supie_llm_dev 的一个真实功能**（约 137 万行，Python + React，Alembic）：选一个跨两个模块的小功能，重点看模块划分、可写范围、Alembic 合并检查、独立验收在真实大仓库上是否可用。这个项目依赖 PostgreSQL、Redis、Milvus，跑之前要确认本机环境。

前两项是自动打分的对照；第三项是可用性检查，不做量化对比。

## 8. 风险与待定

- **精简后能不能比原生 Pi 好，仍然没有证据。** 新流程的价值主要在大项目上：分模块并行、硬约束、可恢复、需求先讨论清楚。验证第 3 项是第一次真正检验这一点。
- **并行模块改同一批公共文件**（路由、菜单、迁移、文案）：靠合并队列串行合并，冲突交给原会话解决；迁移靠 N9 的检查。冲突多的项目，并行收益可能被抵消。
- **验收者要能把程序跑起来。** 依赖外部服务（数据库、消息队列、向量库）的项目，验收需要 workflow.yaml 提供启动命令和测试环境；跑不起来时降级为"只跑测试"，并在结论里注明。
- **`.flow/` 格式变化**：旧流程不能续跑。当前没有进行中的流程。
- **缓存**：`agents/`、`skills/`、`rules/` 全部重写，子进程提示的缓存会失效一次。
