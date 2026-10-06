# 第五轮：精简为"讨论 → 原型 → 模块规划 → 按模块实施与验收"

> 记于 2026-10-04。起因见 `docs/BENCHMARK-5.md`：在已有的 7 万行仓库上，原生 Pi 单会话 30 分钟完成 3 个需求加 1 次追加，隐藏验收 43/43、0 回归、0 误改。按预先定的判定标准，现有多角色流程不可能证明价值，因此按"持平"精简。
> 设计参考了 my-work-flow 的 `/supie-dev`（保留需求辩论、原型、独立验收；不要契约钉死、逐任务双审查、按层拆角色、HTML 报告）和 `@llblab/pi-state-flow`（借鉴"结构化笔记原样放回上下文"的做法，不直接使用）。
> **保留 pi-flow 的运行时**：状态与事件、租约与恢复、越界拦截、合并队列、多模型调度。这部分是原生 Pi 和提示词工作流都没有的硬保证。

> **完成情况（2026-10-05）**：第 8 节第 1–11 步已在分支 `round5-simplify` 完成，记在 `NOTES.md` 第 119–133 条；第 12 步（第 9 节的真实模型验证）未做。与本文不同的地方：
> - 原型由 designer 角色负责（可单独配置模型，例如前端审美好的模型）。
> - `test-adjust.ts` 保留（第 6 节原定删除）：模块的可写范围有限，接口变化仍会让别的模块已有的测试失败（NOTES 第 130 条）。
> - 未做：`/flow-status --detail` 按模块显示 notes 的 current 与 todo（第 3.1 节）；workflow.yaml 里的全局 `shared_files` 列表（第 4 节），公共文件只能由 D2 按模块登记。
> - 命令按用户的要求是 `/flow-approve`、`/flow-reject "<意见>"`、`/flow-add "<需求>"`、`/flow-resume`、`/flow-status --detail`；验收人工放行是 `/flow accept <任务>`。
>
> **之后的改动（2026-10-06，吸收 mattpocock/skills，MIT；NOTES 第 134–138 条）**：
> - 需求讨论（D0）改为**主 agent 直接和用户逐轮讨论**（技能 grilling、write-requirements），用 `flow_requirements` 提交，程序写入需求说明；不再有 user-advocate、dev-advocate、analyst（下文第 1、2、7 节的 D0 描述已被取代）。`/flow-build --from <文件>` 跳过讨论。
> - architect 多写术语表 `docs/glossary.md`（技能 domain-modeling）；模块切分规则改为纵向切片、铺垫性重构排前、每个模块写测试接口（技能 plan-modules）；implementer 用技能 tdd。
> - 可选的最终代码审查（`review.final`，默认关）：模块都验收后一个 reviewer 审查整个流程的改动，必须改自动修一轮，建议由用户 `/flow review fix` 挑选。

## 0. 用户已定的决定

1. 需求先讨论：双视角辩论**一轮**，用户看过结果后再提意见完善，可以来回多次。
2. 需求讨论结束时写明打算用的风格和理由；原型直接按这个风格生成一套，不做三选一。
3. 不要 drawio、带溯源矩阵的测试报告 HTML、验收报告 HTML。
4. 项目分阶段、分模块，**一个模块交给一个模型**，前端、后端、测试都由它写；互不依赖的模块并行。
5. 去掉函数级契约、逐任务审查、阶段审查、按层拆角色（前端、后端、数据库各一个模型）。
6. 模块在自己的工作区里分步开发、本地提交；**整个模块做完才合并**，合并时跑全量测试。
7. 上下文超过阈值就压缩；压缩后靠 **notes**（结构化笔记）和 **history**（检索完整历史）延续。两者自己实现，**所有 agent 都用，包括主 agent**。

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
    ① 一个强模型在自己的工作区里开发：前端、后端、迁移、测试都由它写
       做完一部分就本地提交、更新 notes，再做下一部分；上下文超过阈值时压缩，靠 notes 与 history 延续
       需要别的模块刚合入的代码时，用 flow_sync 把集成分支合进自己的工作区
    ② 整个模块完成 → 合并：rebase 到集成分支最新，跑全量测试与合并检查，失败退回同一会话
    ③ 独立验收：没参与实现的 agent 在集成分支上实际运行，对照该模块的验收标准逐条确认
       不通过 → 交回实现者的会话修复 → 只复查没通过的条目；两轮仍不通过转"需要你处理"
  依赖它的模块要等它验收通过才开工
  中途：/flow add "<追加>" 送到正在做的模块；/flow resume 恢复；额度用完自动换后备模型或等待
  │
  ▼ 完成：全部模块验收通过、全量测试通过后，/flow approve 合入主分支
```

- **已有项目加功能**：流程相同。D1 视情况跳过；D2 简化为"这次涉及哪几个模块、各自改什么、验收标准是什么"。
- **修 bug**（`/flow-fix`）：一个任务，由负责相关模块的实现者定位并修复，合并后由验收者复现确认已修好。

用户界面的高层阶段：**需求 → 原型 → 规划 → 实施 → 完成**。

## 2. 角色

| 角色 | 读写 | 做什么 |
|---|---|---|
| orchestrator（主会话） | 不能改代码 | 和用户对话、转达意见、查状态、派发 |
| user-advocate | 只读 | D0：谁用、核心场景、必须有和可选、用户级验收标准 |
| dev-advocate | 只读 | D0：可行性、成本热点、风险、更省的做法 |
| analyst | 写 `docs/requirements.md` | D0：汇总两份意见，写需求说明和风格；按用户意见修改 |
| designer | 写 `prototype/**` | D1：原型 |
| architect | 写 `docs/modules.md`、`docs/interfaces/**`、`AGENTS.md`、规则草稿 | D2：模块规划；执行中修订计划 |
| implementer | 写本模块可写范围 + 登记的公共文件 | E：一个模块的前后端与测试 |
| acceptor | 只读仓库；可在临时目录运行程序、跑测试 | E：独立验收 |
| researcher | 只读，可联网 | 按需查资料（保留） |

模型都默认用强模型，可在 `/flow-config` 里按角色改，并配后备模型。旧的 interviewer、scout、reviewer、test-engineer、backend / frontend / db / infra-engineer、ui-designer 删除。

## 3. notes 与 history（所有 agent，包括主 agent）

### 3.1 notes：结构化笔记

一个工具 `notes`，参数 `action`：
- `read`：读当前笔记；
- `update`：按分区增量修改（追加、替换、删除某一条）。

分区固定：

| 分区 | 内容 |
|---|---|
| `goal` | 目标与约束（任务的验收标准、用户的要求） |
| `done` | 已完成的部分（含对应的本地提交） |
| `todo` | 待完成的部分 |
| `current` | 正在做什么、做到哪 |
| `decisions` | 关键决策与理由 |
| `pitfalls` | 踩过的坑、不要再试的做法 |

- **放回上下文**：每次请求都把当前笔记放进上下文（借鉴 state-flow），压缩后笔记原样还在，不依赖摘要。为保持提示缓存，笔记放在消息末尾，不改动系统提示。
- **初始内容由程序填**：任务开始时，`goal` 填入任务说明与验收标准，`todo` 填入模块的需求清单。之后由模型自己维护。
- **存放位置**（都在 `.flow/` 里，由 StateStore 读写）：
  - 任务：`.flow/flows/<流程>/notes/<任务>.json`。同一任务的多次运行（返工、恢复、验收修复）共用一份。
  - 主 agent：`.flow/notes/main.json`，跨流程保留，记录用户偏好、讨论结论、进行中的事项。
- **程序也会读**：`/flow status --detail` 显示各模块的 `current` 与 `todo`；验收修复、`/flow resume`、计划修订的提示里附上笔记。

### 3.2 history：检索完整历史

一个工具 `history`，参数 `action`：
- `search`：用关键词在本次会话的完整历史里查（包括已被压缩、不在上下文里的部分），返回命中的条目编号、时间、角色、片段；
- `read`：按条目编号取回完整内容（消息或工具输出），过长时分段返回。

- 数据来自 Pi 的会话文件：压缩不会删除会话文件里的条目。
- 用本地文本检索，不需要嵌入模型和额外的模型调用，结果确定。
- **范围**：subagent 查本任务所有运行的会话（返工前的历史也能查到），主 agent 查主会话。

### 3.3 压缩

- 阈值写在 workflow.yaml：`context.compact_at`（上下文占比，默认 0.7）。
- 在回合结束时检查上下文占用，超过阈值就让 Pi 压缩。Pi 生成的摘要照常保留，notes 另外原样放回上下文。
- 压缩时，程序把"压缩前的提醒"放进上下文：先用 `notes update` 记下当前进度，再继续。
- 实施前要核实 Pi 1.0 的对应接口（`session_before_compact`、上下文占用查询、触发压缩），按 CLAUDE.md 先查文档和源码。

## 4. 模块实施细节

- **工作区**：从集成分支拉出，可写范围 = 模块目录 + `shared_files`（路由注册、菜单、迁移目录、文案等，由 workflow.yaml 或 D2 登记）。越界拦截照旧。
- **分步开发**：实现者每完成一部分就 `git commit`（工作区内的本地提交，越界拦截允许），并更新 notes。本地提交就是检查点：进程被杀后 `/flow resume`，工作区和本地提交都在，接着原会话继续。
- **同步集成分支**（可选）：工具 `flow_sync`。程序把集成分支最新代码合进任务分支：没有冲突就直接完成；有冲突时在工作区里留下冲突标记，由实现者解决后再调用一次 `flow_sync` 完成提交。用于依赖的模块刚合入，或者想提前发现冲突的时候。
- **提交**：模块全部完成后 `flow_submit`，进入合并队列。squash 成一个提交，rebase 到集成分支最新，跑全量测试与合并检查。失败带日志退回同一会话。
- **跨模块接口**：`docs/interfaces/<模块>.md` 只写模块之间的调用。实施中可以**追加**（沿用第 109 条"只能新增"的检查）；改动已有内容要走计划修订。

## 5. 保留的部分（运行时）

| 部分 | 文件 | 说明 |
|---|---|---|
| 状态与事件 | `state-store.ts`、`event-log.ts`、`schemas.ts`、`state-machine.ts` | 事务写入、哈希链事件、状态提交到独立引用；转移表收缩到新流程需要的状态与触发器 |
| 引擎 | `dispatcher.ts`、`scheduler.ts`、`engine-lock.ts` | 自动派发、程序步骤推进（pump）、并发上限、单引擎锁 |
| 租约与恢复 | `resume.ts`、`subagent-runtime.ts`（心跳续租）、看守 | run token、租约、心跳；`/flow resume` 只依赖 `.flow/` 与 git |
| 接着原会话 | `launcher.ts`、`session-log.ts` | 返工、验收修复、恢复都 fork 原会话（同模型、会话不太大时） |
| 越界拦截 | `guard.ts`、`shell.ts`、`paths.ts`、`strays.ts` | 路径与受保护文件、危险命令、敏感读取、后台进程、原地打转检测、残留进程清理 |
| 合并队列 | `merge-queue.ts`、`worktree.ts`、`verify-runner.ts`、`git.ts` | squash、rebase、全量验证、失败退回、冲突交给原会话（merge-fix）、批量合并、CAS 更新集成分支、同步主分支 |
| 多模型调度 | `model-pause.ts`、`role-settings.ts`、`cost-control.ts` 中的升级与预算部分 | 额度或限流暂停与自动恢复、后备模型、失败后升级、流程预算 |
| 闸门与发布 | `stages.ts`、`gates.ts`、`release.ts` | 用户批准、打回、自动检查命令、合入主分支 |
| 主会话约束 | `context-injector.ts`、`orchestrator-tools.ts` | 每轮注入"唯一允许的下一步"、主工作区越权检测 |
| 度量 | `metrics.ts`、`cost.ts` | 每次运行的 token、花费、工具调用 |
| 知识库 | `knowledge.ts` | 跨流程、跨任务积累的项目约定与坑（notes 只属于一个任务，两者互补） |
| 计划修订 | `revision.ts` | 改为修订模块清单与依赖 |
| 工具链 | `init.ts`、`preflight.ts`、`doctor.ts`、`dependencies.ts`、`codegraph.ts`、`flow-config.ts` | 不变 |

## 6. 删除的部分

| 删除 | 文件或内容 |
|---|---|
| 阶段审查 | `stage-review.ts` 的代码审查语义（"清单 → 修复 → 只确认已有编号"的机制改造成模块验收）、两个审查工具中的代码审查部分 |
| 逐任务审查与风险分级 | `cost-control.ts` 的审查部分、`review` 与 `verifying` 路径、`flow_approve` |
| 函数级契约与契约锁定 | `design-contract` 技能、契约锁定、`test-adjust.ts`（模块内部没有契约；跨模块接口改为可追加） |
| 先行验收测试 | `dag.ts` 中 leading / carried test 的逻辑、`testing.leading_tests` |
| 旧的设计阶段 | S0–S5、F0–F4 的阶段计划（`modes/plan.ts` 重写）、PRD 与 ARCHITECTURE 模板、`write-prd`、`write-feature-spec`、`decompose-dag` |
| 需求访谈 | `modes/interview.ts`（被 D0 辩论替代） |
| 旧的修 bug 流程 | `modes/fix.ts` 的定位、复现、审查多任务结构 |
| 角色与规则 | 第 2 节列出的旧角色；`rules/` 中按层的规则（backend、frontend、database 等）合并为 global 加项目自己的 AGENTS.md |

预计源码从约 1.16 万行降到 7 千多行：运行时基本不动，删的主要是流程与审查，新增 notes、history、模块验收等约 1 千行。

## 7. 新增与改造

| 编号 | 内容 | 要点 |
|---|---|---|
| N1 | 需求讨论（D0） | 两个 advocate 并行（只读，结论写进 handoff）→ 程序派 analyst 写 `docs/requirements.md`（含风格）→ 用户闸门。`/flow reject "<意见>"` 让 analyst 接着原会话修改，可多次 |
| N2 | 原型（D1） | designer 写 `prototype/*.html` 与导航页；无框架、无构建；用户闸门。无界面时跳过 |
| N3 | 模块规划（D2） | architect 用 `flow_propose` 提交模块任务：每个模块一个任务，带可写范围、负责的验收标准、依赖、登记的公共文件。`dag.ts` 保留依赖类型、环检测、ready 计算、可写范围互斥 |
| N4 | 跨模块接口 | 见第 4 节 |
| N5 | 模块实施 | 一个 implementer 一个模块；分步本地提交；`flow_sync`；完成后合并（见第 4 节） |
| N6 | notes 与 history | 见第 3 节；子进程扩展与主会话扩展都注册；笔记由 StateStore 读写 |
| N7 | 独立验收 | 模块合并后派 acceptor：在集成分支上构建、启动、实际调用，按验收标准逐条给出 `{id, passed, evidence}`；不通过的交给实现者会话修复（fork），合并后只复查没通过的条目；两轮仍不过转"需要你处理"。依赖它的模块等验收通过才开工。复用第四轮阶段审查的机制 |
| N8 | 运行中追加（`/flow add`） | 子进程启动方式从 `pi --mode json -p` 改为 `pi --mode rpc`，追加需求用 steer 送到正在运行的会话，同时写进该任务 notes 的 `goal`；没有运行中的任务时，由 architect 判断归哪个模块或新增模块 |
| N9 | 合并检查钩子 | workflow.yaml 的 `commands.merge_check`（可选），合并验证时和全量测试一起跑，例如 Alembic"只能有一个 head"。程序里不写死任何框架 |
| N10 | 状态视图与文档 | 高层阶段改为"需求 → 原型 → 规划 → 实施 → 完成"，实施阶段按模块显示进度（来自 notes）与验收结果；README、NOTES、CLAUDE.md、learn-demo 同步 |

## 8. 提交顺序

每步跑相关测试，最后跑全量。新流程先和旧流程并存，最后再删旧代码，避免中途不能运行。

| 步 | 内容 |
|---|---|
| 1 | N6 notes 与 history（独立于流程，先做，旧流程也能用上） |
| 2 | 新角色提示与 workflow.yaml 模板（D0、D1、D2、E 的阶段定义；`shared_files`、`merge_check`、`context.compact_at`） |
| 3 | N1 需求讨论 |
| 4 | N2 原型 |
| 5 | N3、N4 模块规划与跨模块接口 |
| 6 | N5 模块实施（分步本地提交、`flow_sync`、完成后合并） |
| 7 | N7 独立验收 |
| 8 | N8 RPC 启动方式与 `/flow add` |
| 9 | N9 合并检查钩子 |
| 10 | 删除第 6 节的旧机制，收缩 schema 与转移表，清理测试 |
| 11 | N10 状态视图与文档 |
| 12 | 验证（第 9 节） |

## 9. 验证

1. **看板新建**（约 4000 行，有界面）：完整走一遍 D0–E，看讨论、原型、模块规划、实施与验收是否顺畅；对比原生 Pi 的 17.6 分钟和第四轮的 75 分钟。
2. **Homebox 加功能**（已有 7 万行仓库）：同样的 R1–R4，用 `/flow-build --feature`，用隐藏测试打分；对比原生 Pi 的 30.4 分钟、43/43。
3. **supie_llm_dev 的一个真实功能**（约 137 万行，Python + React，Alembic）：选一个跨两个模块的小功能，看模块划分、可写范围、Alembic 合并检查、独立验收、notes 与 history 在真实大仓库上是否可用。依赖 PostgreSQL、Redis、Milvus，跑之前确认本机环境。

前两项是自动打分的对照；第三项是可用性检查，不做量化对比。

## 10. 风险与待定

- **精简后能不能比原生 Pi 好，仍然没有证据。** 新流程的价值主要在大项目上：分模块并行、硬约束、可恢复、需求先讨论清楚。验证第 3 项是第一次真正检验这一点。
- **并行模块改同一批公共文件**（路由、菜单、迁移、文案）：靠合并队列串行合并、冲突交给原会话解决、迁移靠 N9 的检查；模块做完才合并，冲突会更晚暴露，`flow_sync` 可以提前发现。冲突多的项目，并行收益可能被抵消。
- **验收者要能把程序跑起来。** 依赖外部服务的项目需要 workflow.yaml 提供启动命令与测试环境；跑不起来时降级为"只跑测试"，并在结论里注明。
- **notes 依赖模型自觉更新。** 程序会填初始内容、在压缩前提醒，但更新得好不好取决于模型。
- **`.flow/` 格式变化**：旧流程不能续跑。当前没有进行中的流程。
- **缓存**：`agents/`、`skills/`、`rules/` 全部重写，子进程提示的缓存会失效一次。
