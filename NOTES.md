# pi-flow 开发笔记

记录已核实的事实（版本、Pi API）、偏离原始需求的决定、真实模型实验的结论。实现细节以代码与测试为准，这里只写"为什么这样做"。
偏离记录的编号不变（其他文档按编号引用）；新增条目往后追加，一条 1–3 行，被后来的条目修订时注明。

## 已验证版本

| 组件 | 版本 | 说明 |
|---|---|---|
| Node | 24.18.0 | 要求 ≥22；测试用原生 TS 类型剥离（只用可擦除语法） |
| Pi | `@earendil-works/pi-coding-agent` **1.0.0** | 2026-10-02 由 0.99.2 升级，扩展接口无变化（第 86 条）；最低 0.99.0，验证 0.99.x–1.x（`src/core/dependencies.ts`） |
| typebox | 1.3.27 | Pi 内置核心包，`peerDependencies: "*"`，不打包 |
| proper-lockfile 4.1.2、minimatch 10.2.6、yaml 2.9.0 | | 与 Pi 自身依赖同版本，不引入新的供应链来源 |
| 插件 | pi-serena 0.9.x、pi-codegraph 0.1.x、pi-web-access 0.35.x；Serena 1.x；codegraph 命令行 1.x | 只在角色用到时检查，不兼容只提醒（第 87 条） |

## Pi API（已核实）

**实测**＝用真实 pi 进程（探针在 `playground/probes/`，假模型在 `test/fixtures/fake-llm/`）；**源码**＝读 `.d.ts`、源码或官方文档。

| 能力 | 结论 | 核实 |
|---|---|---|
| 安装 | `pi install <npm:包 \| 本地路径>`，`-l` 写项目 `.pi/settings.json`（需信任项目）；本地路径不复制、不替你装依赖 | 源码、实测 |
| 包清单 | `package.json` 的 `pi.extensions/skills/prompts`；扩展 .ts 由 jiti 加载，能解析包自己的 node_modules | 实测 |
| 斜杠命令 | `registerCommand(name, {handler(args, ctx)})`，`args` 是原始字符串；`pi -p "/cmd"` 不调用模型 | 实测 |
| 交互 UI | `ctx.ui.select/confirm/input/notify`；RPC 模式经 `extension_ui_request/response`；print 无 UI | 实测 |
| 工具 | `registerTool({name, parameters, execute})`；`setActiveTools` 在 `session_start` 中生效 | 实测 |
| 拦截工具调用 | `on('tool_call')` 返回 `{block, reason}`；**按扩展加载顺序执行，后面的看到前面改过的 input**，guard 必须最后加载；`event.input` 可原地修改（用于补 bash 超时） | 实测、源码 |
| 追加系统提示 | `before_agent_start` 改 `systemPromptOptions.appendSystemPrompt` | 实测 |
| 事件 | `session_start`、`before_agent_start`、`turn_end`、`message_end`（assistant 消息带 usage）、`agent_end`、`session_shutdown` | 源码、实测 |
| 子进程 | `pi --mode json -p --session-dir <目录> [--fork <会话文件>] --no-extensions --no-skills --no-prompt-templates --no-context-files -e <扩展>… --model p/id --thinking <级别> --tools a,b --append-system-prompt <文件> -- "<提示>"`；**stdin 必须关闭**；`--fork` 复制旧对话为新会话，系统提示按本次参数重建 | 实测 |
| 用量 | assistant `message_end.message.usage = {input, output, cacheRead, cacheWrite, cost}`，`input` 不含缓存；另有 `provider/model/stopReason/errorMessage` | 实测 |
| 重试 | Pi 对限流、过载、5xx、网络错误自动重试 3 次；额度用完类不重试，错误在 `errorMessage` | 源码（pi-ai `retry.js`） |
| bash | `timeout` 单位秒；超时对整个进程组 SIGKILL；`pi -p` 收到 SIGTERM 会结束自己跟踪的 bash 进程组 | 源码、实测 |
| 思考级别 | `off/minimal/low/medium/high/xhigh/max`，按模型收窄（glm-5.3-flash 只支持 low/high/xhigh） | 实测 |
| codemode | `-e builtin:codemode` 且 `--tools` 含 codemode；脚本里每个工具调用都经过 `tool_call`（guard 照常拦截计违规） | 实测 |
| 配置目录 | `getAgentDir()` = `~/.pi/agent`（`PI_CODING_AGENT_DIR` 可改）；导出 `VERSION` | 源码 |
| 路径解析 | Unicode 空格归一、去 `@`、展开 `~`、`file://`；guard 按同样规则 | 源码 |

第三方插件（读源码核实）：pi-serena 0.9.20（20 个工具，文件参数 `relative_path`；`serena_rename_symbol` 等不分配给角色）；pi-codegraph 0.1.10（8 个工具，参数是符号）；pi-web-access 0.35.0（默认不激活，需 `setActiveTools`）；pi-rules 0.6.0（不能按角色挑规则，所以不用）；pi-subagents 0.74.0（对照实验用）。

## 待确认与已知局限

- serena 的 `prepareArguments`（修正参数名）在 `tool_call` 之前还是之后，影响 guard 看到的参数名。
- `tool_result` 层未过滤敏感内容（`grep -r` 等可能读到 `.env`）。
- guard 管不到脚本文件内部（`bash x.sh`、`node x.js`、`npm run`），兜底是提交时的 diff 检查。

## 偏离记录

**状态机与任务**
1. 新增 `merging → queued_merge`（`merge_requeue`）：恢复时回滚未完成的合并，放回队首。
2. "进行中"指 in_progress、review、verifying、queued_merge、merging；pending、ready 不能 flow_block。
3. 被打回或验证失败回到 in_progress 时清空租约、保留 worktree，由调度器重新派发。
4. 互斥判断也比较 review、verifying、queued_merge、merging 中的任务（改动未合入）。
5. unblock 回到 ready 时清空 worktree、分支与 base_sha（第 82 条起，审查中阻塞的回到审查）。
6. 任务新增 `lease_expirations`、`impl_run`、`blocked_reason`、`last_failure`、`merge_fix_for`、`conflict_files`。
7. run 新增 `violations`、`version`；outcome 可为 null（运行中）。
8. 阶段状态机：active → awaiting_gate → (awaiting_human →) done；approve、reject、abort 只接受 human。
9. 流程 approvals 含 S1 或 F1 时契约锁定（第 100 条起，批准的修订可建"改 API 文档"任务）。

**角色、guard 与配置**

10. 所有子进程角色隐式拥有 `flow_block`（及第 72 条起的 `flow_learn`）。
11. guard 比规格更严：禁止所有 git push 与改 refs/config 的命令、打印环境变量、含变量或通配的命令名与重定向目标、无法解析的命令；写工具只能写当前 worktree 且受角色与任务 writes 交集约束；路径大小写不敏感、先解析符号链接。
12. 配置层检查越权：orchestrator 只能有查看与等待类工具；`flow_approve` 只给 reviewer，`flow_propose_tasks` 只给 architect；没有可写范围的角色不能有写工具。
13. 主工作区越权检测在 M5 实现（见第 38 条）。
14. 配置里的 `read` 只对应 Pi 的 read，不隐含 grep、find、ls。
15. `/flow-config` 设置各角色模型与思考级别，存 `~/.pi/agent/pi-flow.json`，优先于 workflow.yaml 档位。
16. 规则不经 pi-rules：由 prompt-assembler 按任务 scopes 选出，经 `--append-system-prompt` 注入。
17. `serena_rename_symbol`、onboarding、restart 类工具不分配给角色（rename 会改所有引用处）。
18. 角色文件的档位字段叫 `tier`，避免与 pi-subagents 的 `model` 冲突。
19. 端到端测试用本地假模型服务（OpenAI 兼容），注册为 `fakellm/<脚本名>`，不依赖真实模型。

**引擎与合并**

20. 新增 `run_failed`：子进程没提交就退出，清租约、计一次失败。
21. guard 允许 `git checkout <提交> -- <文件>`，用于还原越界文件。
22. 并发上限只计实施 run，审查与 verify 不占名额。
23. 程序步骤自动执行：提交后派审查、审查通过后 verify、失败后重新派发。
24. `pi -p` 下 `/flow next` 等全部步骤结束才返回。
25. orchestrator 工具只在项目有 `.flow/` 时注册。
26. 子进程加载插件（第 57 条落实）。
27. 状态提交原在当前分支（已被第 79 条修订：改到 `refs/pi-flow/state`）。
28. merge-fix 挂起原任务时让出合并名额，避免死锁。
29. merge-fix 的基线是集成分支加原任务改动（含冲突标记），合入即代表原任务合入。
30. 合并：先 squash，再 rebase、检查冲突标记、合并后验证，CAS 快进集成分支。
31. 冲突涉及契约或受保护路径一律转 blocked。
32. 受影响测试用 `codegraph affected`，为空或出错退回全量 test；每次合并后 `codegraph sync`。
33. 有 `flow_submit` 的角色隐式拥有 `flow_claim`。
34. `.runs/` 下的提示文件由 `/flow doctor --fix` 清理。

**恢复与调度模式**

35. 会话启动不自动恢复，只提示 `/flow resume`；新增引擎锁，同一项目只允许一个会话运行引擎。
36. 未过期但已中断的租约按 run_failed（已被第 67 条修订：不计失败）。
37. 调度模式显式进入：只启用 orchestrator 工具，所有调用经 guard，每轮注入"状态与唯一允许的下一步"。
38. 主工作区越权按"轮"检测：本轮新出现的 `.flow/` 外改动记违规。
39. `/flow init` 不生成 `.pi/settings.json`、不同步 `.pi/rules/`。
40. `/flow doctor --fix` 只做安全清理，不改 `.flow/`。
41. `flow_wait` 等的任务已结束时立即返回。

**阶段与 fix**

42. 设计阶段任务（S0、S1、F0、F1）由程序生成；architect 用 flow_block 一次问一个问题；新增 `/flow reject`。
43. 任务提案先存 `proposal.json`，批准 S1/F1 后才落为任务并锁定契约。
44. 闸门由程序执行：auto 命令在集成分支的临时 worktree 中跑；最后一个阶段一律需要人工；失败不自动重跑。
45. 合并后验证只跑任务 verify 里有的命令。
46. 最终合入：批准最后阶段时先把集成分支 `--no-ff` 合入主分支，冲突则中止。
47. 技能由程序按阶段注入（子进程 `--no-skills`）。
48. 流程标题即用户描述。
49. fix 流程：编号 X-NNN、单阶段、集成分支即主分支、不占活动流程指针。
50. 新增 `report`：只读 analysis 任务提交结论直接完成。
51. 新增 `repro_confirmed`：复现测试必须先失败，确认后随修复一起合入。
52. fix 升级判断：要改契约、文件数超 `fix_max_files`、没有角色能写，暂停并建议改用 feature。
53. 修复角色取 scout 建议且可写范围覆盖影响文件的角色。
54. fix 在主工作区 cherry-pick 合入主分支。
55. fix 日志 `.flow/fixes/<日期>-<序号>.md`。
56. `/flow status --cost`：按流程、阶段、角色、模型、任务汇总，列出返工最多的任务。

**M8 之后**

57. 子进程按角色工具组加载插件（项目级优先），放在 guard 之前。
58. 插件产物（`.serena/`、`.codegraph/`）写入仓库本地 `info/exclude`。
59. 修复并发重复派发：`acquireLease` 事务内检查，pump 按流程串行。
60. `/flow approve`、`/flow unblock` 后直接派发 ready 任务。
61. 假模型脚本支持按首条用户消息选择 variants。
62. 对外只呈现高层阶段（需求 → 规划 → 实施 → 验收 → 完成），细节在 `--detail`。
63. 调度模式切换主会话模型；新增 `/flow off`。
64. 开流程前先访谈（interviewer），`--confirm` 才开工；`--direct`、`--from` 跳过。
65. `/flow answer`：用户在输入框亲手回答阻塞问题。
66. 规则与命令草案：architect 写 `docs/rules-draft/`，用户批准时由程序应用到 `rules/` 与 workflow.yaml。
67. 新增 `run_interrupted`：会话中断不计失败，只计中断次数，连续 5 次转 blocked。
68. 重新派发时提示"工作区已有的改动"。

**第二轮（2026-10-01）**

69. 先行验收测试必须先失败，由承载它的实现任务一并合入（已被第 100 条修订：默认关闭）。
70. pump 每个任务处理前重新读取最新状态。
71. 下游任务的提示附上游 handoff（每个 800 字，合计 4000 字）。
72. 项目知识库 `.flow/knowledge.json`：`flow_learn` 提交即生效；按 scope 与路径注入；`/flow knowledge` 管理与提升为规则草案。
73. 租约心跳续租：剩余不足一半时，工具调用时续租。
74. 子进程会话留档到 `<项目>.worktrees/.sessions/<run>/`；`/flow run` 查看。
75. 每个阶段开始时把主分支同步进集成分支；冲突在可写范围内生成 merge-fix，否则暂停派发请用户处理。
76. 执行中修订计划：`flow_replan`、`/flow replan` → architect 用 `flow_revise_plan` 提交新增、调整、取消 → 用户批准生效；新增 `cancel` 转移。
77. 按风险审查：低风险用便宜模型或免审查（`review_skip`）；审查并发上限。
78. 失败后升级模型；run 记录金额；流程预算（超出后暂停派发新任务）。
79. 状态存储提速（尾读事件、缓存）；状态提交改到 `refs/pi-flow/state`，`.flow/` 写入 info/exclude。
80. 调度模式下终端状态栏显示进度。
81. 合并列车：测量后暂不实现（已被第 116 条修订）（合并本身每次不到 1 秒，瓶颈是合并后验证，`scripts/measure-merge.ts`）。

**真实模型冒烟后**

82. 第一次真实冒烟（2026-10-02，待办清单）后的修订：每个 run 的临时目录；rm、mv 在临时目录与 writes 内放行；字面量变量代入；只读角色不跑测试；约束类要求不写成验收测试；cancel 可作用于 blocked；rewire 可指向新增任务；审查中阻塞的回到审查（`blocked_from`）；知识候选默认不自动提炼。
83. 违规上限默认 3 → 5；默认规则改为与技术栈无关。
84. 新增技能 `write-rules`。
85. 启用 Pi codemode（architect、reviewer、scout）。
86. 升级到 Pi 1.0.0：接口无变化；`pi-durable` 暂不引入（实验性，插件不兼容）。
87. 依赖检查（`src/core/dependencies.ts`）：Pi 过低拒绝开始，插件只提醒。

**第三轮（2026-10-02 起）**

88. 模型额度用完、限流时暂停该模型而不判失败（`run_paused`、`.flow/model-pauses.json`）；到点自动恢复，`/flow models resume`、`/flow-config` 换模型立即继续。
89. 第二轮起的审查只核对上次的问题与之后的改动；可选 `review.max_rounds`。
90. 审查分三档：低风险便宜模型、普通用审查者模型（模板 reviewer 改为中等档）、高风险用强模型；没做"闸门前最后一次审查用强模型"。
91. 拆任务尽早并行：底座合并，切片之间软依赖；DAG 报告提醒"开头只能串行"，关键路径阈值 0.6 → 0.5。
92. 先验证再审查：派审查前程序先跑 verify（`precheck_fail`），审查后代码没变就沿用结果；`review.verify_first` 可关。
93. 返工时接着上次的对话（`pi --fork`），换模型或会话过大时从头开始；`limits.continue_session` 可关。
94. 模板默认并发 2 → 3（实施任务；审查另计）。
95. 审查提示直接附 diff（≤2 万字符）；run 记录轮数。
96. 自动派发 ready 任务（`limits.auto_dispatch`，偏离第 15 节"orchestrator 派发"——它本来就没有决策权）；`flow_wait` 只在值得汇报时返回；主会话用量记成 orchestrator run。
97. 第二次中型冒烟后的修复：任何命令启动引擎都检查租约（原来只有 `/flow resume`）；bash 默认超时 `limits.bash_timeout_s`（300 秒）；提交前清理可写范围外的未跟踪文件；模板去掉 Serena 严格模式；测试规则补四条；先行验收测试不算高风险；接续对话上限 1.5 MB → 400 KB；被 ≥3 个任务依赖的底座第一次就用升级模型（`escalation.critical_fanout`）；引擎退出时结束子进程。
98. 对照实验：原生 pi（gpt）做同一个记账项目，见下方"真实模型实验"。
99. 对照实验：原生 pi 只用本地 glm，见下方。
100. 看板对照实验后用户决定的三项改动：
     ① 实施者边写边测、合并后跑全量：先行验收测试改为可选（`testing.leading_tests`，默认关闭，提案与修订中拒绝该拆法）；test-engineer 只做实现之后的联调、端到端与复现测试。
     ② 契约不超出需求：提案用 `extras` 申报超出需求的设计，批准时列给用户确认，审查时未申报的按缺陷打回。
     ③ 运行中改 API 文档：修订必须附影响分析（`impact`）；可新增 `contract_change` 文档任务修改已锁定的契约（只有批准的修订能建）；受影响的未开始任务取消并换成依赖新文档的任务，进行中的做完再接修改任务，已完成的新增修改任务。

**第四轮（2026-10-03 起，`docs/HANDOFF-4.md`）**

101. 契约到函数级（第 108、113 条修订：只写模块边界、按需写细）：每个模块一个契约文件，写对外函数的名字、参数、返回值、错误（REST 照旧）；任务 inputs 列出依赖的契约条目。只改技能与提示，程序不校验格式。
102. 逐任务审查可关闭（`review.per_task`，默认 false）：新增 `in_progress → queued_merge`（`submit_direct`，检查同 submit）；合并时 verify 非空的任务跑全量 typecheck、lint、test（不再用受影响测试），失败按 merge_verify_fail 退回并接续对话。设计阶段文档、fix 流程、先行验收测试照旧逐任务审查（设计阶段只有一个任务，审查兼查 extras）。修订第 45 条（关闭审查时）。测试配置固定 `per_task: true`。
103. 阶段末审查（第 117 条修订：按角色分批提前开始；`review.stage_end`，默认 true；测试配置固定 false）：实施阶段（非设计阶段、非 fix）任务全部结束后由程序推进 `flows/<id>/stage-review-<阶段>.json`（reviewing → fixing → confirming → refixing → gating → test_fixing / needs_human → done），每步的记录、新任务与 handoff 在同一事务内写入，崩溃后从中途继续。审查与确认是程序生成的只读 analysis 任务（`stage_review`，角色 reviewer，审查用强模型、确认用普通档），经 `report` 转 done。
104. 新工具 `flow_review_report`（问题文件必须是具体路径、不能是契约或受保护文件、要有实施角色能写，否则拒绝）与 `flow_review_confirm`（参数只有 `{id, resolved, note}`，id 必须在清单中且每个都要回答；Pi 自己也按 schema 拒绝多余字段）；reviewer 角色隐式拥有。修复任务用已有的 kind `review-fix`，按（模块，角色）分组、writes = 问题涉及的文件。
105. 闸门失败（auto 命令）时从输出中提取仓库里的文件，按写过它的任务找角色（writes 取那些任务的 writes），生成第 n 轮修复任务；两轮后或定位不到时转 needs_human（"需要你处理"，`/flow gate` 重跑不再自动修）。阶段审查结束后被修订重新打开的阶段不再审查。
106. `/flow next` 先 pump 再派发（复跑看板时发现）：提交直接进合并队列后，引擎在"提交"与"合并"之间重启，任务会停在 queued_merge，只有 pump 会处理它。
107. 原地打转检测（复跑看板时 glm 连续 281 次执行同一条命令，心跳续租让租约永不过期）：被放行的工具调用连续 5 次完全相同就拦下并提示换思路，10 次结束本次运行（计失败、重新派发）。
108. 契约只写模块之间的边界（全 gpt 复跑中一个前端内部回调引出 3 次计划修订）：技能、architect 提示与 S1 验收标准写明前端只写它调用的后端接口与页面入口，组件装配不写；同一模块内部互相调用的部分不拆成对着契约并行的任务。
109. 阶段审查的修复任务（review-fix）可以补契约：guard 放行写 `docs/contracts/`（不受角色可写范围限制、不计入 writes，避免修复任务互斥），提交时有删除或修改已有行的契约文件被拒（只能新增）；确认任务的 handoff 附上补充的契约，由审查者核对是否改变需求。
110. 残留进程防护：guard 拦下后台运行（单独的 `&`）、`setsid`、`disown`（`nohup` 不带 `&` 无害，仍按前缀处理）；子进程结束后用 lsof 找出工作目录在该任务 worktree 或临时目录里的进程并结束（`killStrayProcesses` 可关），记一条事件。
111. 修复任务接着原作者的对话：review-fix 任务记录 `fork_from_task`（写过这些文件最多的同角色已完成任务），派发时 fork 它最后一次提交的会话（同模型、≤400 KB，否则从头开始），提示说明"对话是之前的任务、现在是新 worktree"。
112. architect 少提问：有合理默认方案时直接采用，S1/F1 写进提案的 `assumptions`（批准时与 extras 一起列给用户，"需要你处理"里提示条数），S0/F0 写进文档的"约束与假设"；只有无法合理假设、会改变数据模型或多个接口的才 flow_block（全 gpt 复跑中 F1 连问三次停住）。
113. 契约按需写细（修订第 101 条）：只有被别的任务直接调用的函数写到函数级；只通过自己 REST 接口对外的模块只写接口与数据模型（全 gpt 复跑中 760 行契约用了 30 分钟）。只改技能与提示。
114. 任务粒度跟实施模型走：拆任务（S1/F1、修订）的提示列出各实施角色的模型（与 architect 同模型或 strong 档算强模型）；`decompose-dag` 规定强模型按模块或按层拆大任务，小项目（四五千行内）每个角色一个任务，弱模型按切片拆小任务。程序不强制任务数。
115. 纯测试阶段的审查（`review.test_stages`，默认 skip）：阶段内合入的任务都是 test/integration 时不做阶段审查（闸门照样跑全量测试；全 gpt 复跑中这类审查 0 个问题），light 用普通档，strong 用强模型。
116. 批量合并（`limits.merge_batch`，默认 3；修订第 81 条"合并列车暂不实现"：不逐任务审查后每次合并都跑全量测试，瓶颈变了）：队首连续的普通任务先在临时 worktree 依次 cherry-pick，只跑一次全量验证，通过后逐个 merging → done、集成分支依次快进（仍只有一个 merging）；冲突、验证失败或含 merge-fix、承载先行测试、同步修复、fix 流程时退回逐个合并。
117. 阶段审查按角色分批提前开始（修订第 103 条）：某角色在本阶段的实施任务全部合入就开一批审查（与其他角色的任务并行），记录改为 `batches[]`，每批各自审查 → 修复 → 确认 → 再修一轮，问题编号跨批连续；修复任务不再触发新批；所有批次完成、阶段任务全部结束后才进入 gating。全 gpt 复跑中功能阶段的审查要等最后一个前端任务（第 101 分钟）才开始。
118. 适配已有测试（`testing.adjust_tests`，默认开）：实施类任务（不含只读、文档、merge-fix）可以修改基线上已有、writes 之外的测试文件（guard 按基线 ls-tree 放行，只改不增删，flow_submit 用 `diff --name-status` 只认 M），改过的记在任务 `test_adjustments`，逐任务审查与阶段审查/确认要求核对没有削弱；冲突时算任务自己的文件交给 merge-fix。复跑三中合并全量测试与可写范围冲突（后端加字段让旧验收测试失败，有权改的任务排在后面）。

### 第五轮（2026-10-04 起，`docs/HANDOFF-5.md`；分支 round5-simplify）

修订第 101–105、108、109、113–115、117 条：函数级契约、逐任务审查、阶段审查、先行验收测试、需求访谈、按层拆角色全部删除，相关条目只作历史记录。

119. 新流程 D0 需求 → D1 原型 → D2 规划 → E 实施（build 与 feature 同一套阶段）。D0：user-advocate 与 dev-advocate 并行（只读，意见写在 handoff），程序再派 analyst 读两份意见（上游 handoff 放进提示，上限放宽到 8000/16000 字）写 `docs/requirements.md`，含风格与是否需要原型；用户界面阶段为"需求 → 原型 → 规划 → 实施 → 完成"。
120. 原型由 designer 角色写 `prototype/*.html`（用户可用 `/flow-config set designer <模型>` 换成审美更好的模型）；analyst 判定不需要或用户 `/flow-approve --no-prototype` 时 D1 加入 `skip_stages`，状态栏显示"原型（跳过）"。
121. D2 由 architect 写 `docs/modules.md`、`docs/interfaces/`、`docs/rules-draft/project.md`（必写）、命令草案与 AGENTS.md，用 `flow_propose_modules`（architect 专用）提交模块任务：每个模块一个 implementer 任务（kind impl，带 writes、负责的验收条目、依赖、登记的公共文件 `shared`、`needs_acceptance`）。批准 D2 时提供应用草案（无界面时默认全部应用），生成 `rules/project.md`。
122. 模块实施：implementer 在 worktree 中分步本地提交（guard 放行 `git commit`），`flow_sync` 把集成分支合进任务分支（冲突留标记、再调一次完成）；`flow_submit` 直接 `in_progress → queued_merge`（trigger submit），不再有 review、verifying 状态与 `flow_approve`。
123. 合并验证：verify 非空的任务一律跑全量 typecheck、lint、test 加可选的 `commands.merge_check`（项目自定，例如 Alembic 单 head；程序不写死框架）；删除 `test_affected` 与受影响测试（`MergeHooks.affectedFiles` 改为只供测试用的 `beforeVerify`）。批量合并（第 116 条）保留。
124. 独立验收（`acceptance.ts`）：模块合入后程序派只读 acceptor 任务，`flow_accept` 逐条给结论与证据；没通过的生成修复任务接着 implementer 的会话（fork），合入后 `flow_accept_confirm` 只复查没通过的编号；两轮仍不过转 needs_human，`/flow accept <任务> [--note]` 人工放行。依赖它的模块等验收通过才开工。复用第 103 条"清单 → 修复 → 只确认已有编号"的机制。
125. 实施阶段闸门失败沿用第 105 条：按日志定位文件所属模块生成修复任务，两轮后 needs_human。
126. 跨模块接口 `docs/interfaces/` 对 impl 任务只能追加（沿用第 109 条的检查，guard 放行写入、提交时拒绝删改已有行）。
127. notes 与 history：所有 agent（含主会话）都有 `notes`（goal/current/done/todo/决定/坑，存 `.flow/flows/<流程>/notes/<任务>.json` 与 `.flow/notes/main.json`，由 StateStore 写）与 `history`（检索本任务所有运行或主会话的完整历史）。笔记每次请求由扩展放在消息末尾（不改系统提示，保缓存）；上下文到 `context.compact_at`（默认 0.7）时压缩，接近时提醒先更新笔记。任务开始时程序填 goal 与验收标准。
128. 子进程改为 `pi --mode rpc`（提示经 RPC 发送，不在参数里），`/flow-add "<需求>" [--task]` 用 steer 送进运行中的模块会话并写进其 notes 的 goal；多个模块在做或没有运行中的模块时交给 architect 判断。
129. fix 流程改为：一个 implementer 定位、修复并加回归测试 → 合并（直接合入主分支）→ acceptor 复现确认（同第 124 条的两轮上限）→ 修复日志。删除 scout 定位与复现测试先失败的步骤。
130. 适配已有测试（第 118 条）保留，偏离 HANDOFF-5 第 6 节"删除 test-adjust.ts"：模块的 writes 有限，接口变化仍会让别的模块已有的测试失败。
131. 知识候选只来自合并后验证失败（`source.kind = merge`，审查来源已删除，schema 保留 review 枚举以兼容旧数据）。
132. 测试夹具：运行时机制测试仍用旧的按层角色，放在 `test/fixtures/agents/` 与 `test/fixtures/workflow-legacy.yaml`（`AGENTS` 为包内与夹具目录的 `path.delimiter` 列表）；包内 `agents/` 只有新角色。`.flow/` 格式变化，旧流程不能续跑。
133. 未做（HANDOFF-5 第 3.1 节、第 4 节）：`/flow-status --detail` 还没有按模块显示 notes 的 current 与 todo；`shared_files` 只能由 D2 按模块登记（`shared`），workflow.yaml 里没有全局列表。

## 真实模型实验

第四轮的完整实验记录（各阶段用时、暴露的问题、之后的优化）见 `docs/EXPERIMENTS-4.md`。

脚本：`scripts/real-build.ts`（pi-flow 全流程，`--desc`/`--desc-file`、`--feature-file`、`--dir` 续跑）、`scripts/baseline-build.ts`（原生 pi 对照）、`node scripts/demo.ts --real-fix`。日志在 `~/pi-flow-runs/`，评测用例与看板需求、隐藏测试也在那里（不进仓库）。pi-flow 一侧：architect、reviewer 用 gpt-6.1-sol（high），实施角色用本地 glm-5.3-flash（low），失败后升级到 gpt。

| 日期 | 项目 | 做法 | 耗时 | token（输入/输出/缓存读） | 结果 |
|---|---|---|---|---|---|
| 10-02 | 待办清单（小） | pi-flow | 约 59 分钟 | 738k / 80k / 2.7M | 完成；暴露的问题见第 82 条 |
| 10-02 | 记账服务（中） | pi-flow（第三轮 A–D 前） | 105 分钟 | — | 7/13，Codex 额度用完空耗，引出第 88 条 |
| 10-02 | 记账服务 | pi-flow（第三轮全部改动） | 10 小时后叫停 | 1164k / 202k / 28.7M | 8/15；挂起的测试卡死数小时、测试产物卡住提交、Serena 严格模式拖慢 glm、底座测试锁死后续任务，引出第 97 条 |
| 10-02 | 记账服务 | pi-flow（第 97 条修复后） | **64.5 分钟** | 1588k / 178k / 10.8M（gpt 部分 3.79 美元） | 15/15 合入主分支，65 个测试；审查打回 14 次（多为先行验收测试写错） |
| 10-02 | 记账服务 | 原生 pi，gpt-6.1-sol high | **9.7 分钟** | 66k / 17k / 355k（0.33 美元） | 25 次工具调用，12 个测试；未用 subagent |
| 10-02 | 记账服务 | 原生 pi，glm high | 37.4 分钟 | 114k / 28k / 1.07M（本地） | 9 个测试；测试挂住需 1 次人工中断 |
| 10-03 | 团队看板（大，含变更） | 原生 pi，gpt-6.1-sol high | **21.5 分钟**（17.6 + 变更 3.9） | 82k / 37k / 1.03M（约 0.5 美元） | 隐藏测试基础 39/40（唯一失败的用例超出需求，不计）、变更 6/6 |
| 10-03 | 团队看板 | pi-flow（第 100 条改动前） | 84 分钟后叫停 | 1738k / 291k / 21.1M（gpt 部分 3.62 美元） | 10/16；审查打回 11 次（7 次先行验收测试写错、3 次底座未达自定的超出需求的契约），2 个阻塞，引出第 100 条 |
| 10-03 | 团队看板 | pi-flow（第四轮，实施用 glm） | 约 4 小时后停掉（未完成） | — | 卡在功能阶段收尾：glm 原地打转（281 次同一命令）、后台测试死循环留下孤儿进程、阶段审查 27 个问题；引出第 106、107 条 |
| 10-03 | 团队看板 | pi-flow（第四轮，全部 gpt-6.1-sol high） | **新建 253.6 分钟**；变更停在 F1 | 2209k / 425k / 24.4M（约 11 美元，按 run 记录的单价估算） | 隐藏测试基础 39/40（唯一失败同原生，不计）；变更未完成（F1 architect 三次要求确认契约细节，脚本停止）。规划 42 分钟；阶段审查 S2/S3/S4 各 2/2/0 个问题，一轮修好；修 S3 问题时契约缺口引出 3 次修订（约 1.5 小时） |
| 10-03 | 团队看板 | pi-flow（第 108–117 条后，全部 gpt-6.1-sol high） | **新建 75.4 分钟 + 变更 62.1 分钟** | 1675k / 257k / 16.4M（约 7.5 美元，按比例估算） | 隐藏测试基础 38/40（多出的一条是 PRD 把登录定为 200、评测要 201，放宽后 39/40）、变更 6/6；规划约 17 分钟、5 个任务、17 次运行、0 次修订，architect 未提问；批量合并未触发。详见 `docs/EXPERIMENTS-4.md` 第 9 节 |

记账服务的 20 个黑盒用例：pi-flow 20/20、原生 gpt 20/20、原生 glm 18/20（接受金额 0；超大请求体断开连接而非 413）。

结论（第四轮复跑后）：去掉逐任务审查后，"审查来回打回"不再出现，阶段审查的问题少且一轮修好，质量与原生持平；但总耗时 4.2 小时，是原生的 12 倍。时间主要花在：函数级契约让规划变长（42 分钟），契约锁定后任何接口缺口都要走"修订 → 改契约 → 再实现"（这次 3 次，约 1.5 小时），以及多角色交接的固定开销。四五千行、需求写清楚的项目，单会话强模型仍然明显更合适。

结论（到第 100 条为止）：需求写清楚、四五千行以内的项目，强模型单会话又快又好；pi-flow 的开销主要来自"先写测试再实现"与"契约超出需求"制造的返工，第 100 条针对这两点。改动后的效果待复跑看板对照。

## 缓存提醒

修改 `agents/`、`rules/`、`skills/` 会改变子进程系统提示的稳定前缀，提供商的提示缓存失效一次；`rules/` 的改动只影响之后 `/flow init` 的新项目。改动时在此追加一行。

- 10-04（第五轮，第 119–129 条）：`agents/`、`skills/`、`rules/` 全部重写。新角色 user-advocate、dev-advocate、analyst、designer、architect（重写）、implementer、acceptor；researcher、orchestrator 修改（含代词中性化）；删除 backend、frontend、db、infra、test-engineer、ui-designer、reviewer、scout、interviewer。技能新增 write-requirements、write-prototype、plan-modules，重写 revise-plan、write-rules，删除 decompose-dag、design-contract、write-prd、write-feature-spec。`rules/` 只剩 global.md（项目规则由规划阶段生成 project.md）。工具声明多了 notes、history、flow_sync、flow_propose_modules、flow_accept、flow_accept_confirm。
- 10-04（第 118 条）：backend、db、frontend、infra、test-engineer 角色提示（可以适配别的角色已有的测试）；reviewer（核对适配没有削弱测试）；`decompose-dag`（不必为兼容旧测试单独拆任务）。
- 10-03（第 112–114 条）：architect 角色提示；`decompose-dag`（粒度）；`design-contract`、`write-prd`、`write-feature-spec` 技能；工具参数多了 assumptions。
- 10-03（第 108、109 条）：architect 与各实施角色、reviewer 角色提示；`design-contract`、`decompose-dag` 技能。
- 10-03（第 103 条）：reviewer（阶段审查）、orchestrator、backend、frontend、db、infra、test、ui 角色提示（review-fix 只修分到的问题）；`decompose-dag` 技能；工具声明多了 flow_review_report、flow_review_confirm。
- 10-03（第 101 条）：architect 角色提示；`design-contract`、`decompose-dag` 技能。
- 10-03（第 100 条）：backend、frontend、db、test、reviewer 角色提示；`rules/testing.md`；`decompose-dag`、`revise-plan`（重写）、`design-contract` 技能。
- 10-02（第 97 条）：`rules/testing.md` 增加四条。
- 10-02（第 96 条）：`agents/orchestrator.md`（主会话）。
- 10-02（第 92 条）：`agents/reviewer.md`。
- 10-02（第 91 条）：`decompose-dag`。
- 10-02（第 89、90 条）：`agents/reviewer.md`（多轮审查、tier 改 medium）。
- 10-02（第 82–85 条）：reviewer、scout、architect 角色提示；`rules/` 全部重写；新增 `write-rules`；codemode 用法。
- 10-01（第二轮）：test-engineer、reviewer、scout、orchestrator、interviewer 角色提示；`write-handoff`、`decompose-dag`、新增 `revise-plan`；`rules/testing.md`；工具声明多了 flow_learn、flow_replan、flow_revise_plan。
- 10-01（M8）：scout、researcher、architect 角色提示；技能注入。
