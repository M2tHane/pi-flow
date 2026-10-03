# pi-flow

把"个人开发一个中型项目"的工作流固化成 [Pi](https://pi.dev) 插件。

- **程序负责调度、守卫、验收和合并**：选哪个任务、派给哪个角色、并行几个、何时合并，都由代码决定；状态只由程序写入 `.flow/`，每次转移都追加带哈希链的事件并提交 git。
- **LLM 只负责与你沟通和完成各自的任务**：每个角色（架构、后端、前端、测试、审查等）在独立的 pi 子进程和独立的 git worktree 中工作，只能使用本角色的工具、只能写本任务允许的文件。
- **人工闸门只有你能批准**：任何 agent 都没有批准阶段闸门的工具。
- **会话可以随时中断**：恢复只依赖 `.flow/` 与 git，不依赖对话历史。

> **第一次用？** 用浏览器打开仓库根目录的 [`learn-demo.html`](learn-demo.html)：跟着一个示例项目一步步看你输入什么、主 agent 怎么回、程序做了什么、状态和 git 分支怎么变，另有架构图、任务状态机、概念速查和上手清单（自包含，不联网）。

> **逃生口**：单文件、几十行以内的小改动，直接用 pi 更划算，不必走流程。pi-flow 只在你执行它的命令后才接管会话。

---

## 安装

按顺序做下面几步。装好后在任意项目里执行 `/flow doctor` 自检，它会逐项报告"已安装 / 未安装 / 版本未经验证"，并给出安装命令和链接。

### 1. 基础环境

| 依赖 | 要求 | 安装 |
|---|---|---|
| Node | 22 以上 | https://nodejs.org |
| git | 2.30 以上（需要 worktree） | https://git-scm.com |
| Pi | 0.99 以上，已验证 0.99.x – 1.x | `npm install -g @earendil-works/pi-coding-agent` |

低于 0.99 时 `/flow-build`、`/flow-fix` 会拒绝开始；高于验证范围时只提醒。

### 2. 获取并安装 pi-flow

目前从源码安装，尚未发布到 npm。

```bash
git clone <pi-flow 仓库地址> ~/tools/pi-flow
cd ~/tools/pi-flow
npm install --omit=dev          # 必须：Pi 不会替本地包安装依赖（minimatch、proper-lockfile、yaml）
pi install ~/tools/pi-flow      # 全局安装：所有项目都能用
pi list                         # 确认列表里有 pi-flow
```

- `pi install` 把这个目录登记到 `~/.pi/agent/settings.json`，**不复制文件**，Pi 每次启动直接从这个目录加载。以后 `git pull` 更新后重启 pi 即生效；`package.json` 的依赖有变化时再执行一次 `npm install --omit=dev`。
- 只想在某个项目里用：在那个项目目录执行 `pi install -l ~/tools/pi-flow`，登记到项目的 `.pi/settings.json`（Pi 会先请你信任这个项目）。
- 不想安装、临时试用：`pi -e ~/tools/pi-flow/src/pi-adapter/extension.ts`。
- 卸载：`pi remove ~/tools/pi-flow`。
- 要跑 pi-flow 自己的测试（开发用）时执行完整的 `npm install`。

### 3. 在 Pi 中配置模型

pi-flow 不管理模型账号，只使用你在 Pi 中已经能用的模型：在 pi 里执行 `/login` 登录提供商，或在 `~/.pi/agent/models.json` 中添加自定义提供商（例如本地代理）。配置好后 `pi --list-models` 能看到它们。

然后在 pi 中执行 `/flow-config`，为各角色选择模型和思考级别（见下文"为各角色选择模型"）。这是全局设置，只需做一次，所有项目共用。

### 4. 安装插件（按需）

只有 `workflow.yaml` 中有角色用到的插件才会被检查；没装时对应工具不可用，流程照常运行（开始流程时会提醒）。

| 插件 | 用途 | 已验证版本 | 安装 | 链接 |
|---|---|---|---|---|
| pi-serena | 符号级读取与编辑 | 0.9.x（0.9.20） | `pi install npm:@bacnh85/pi-serena` | [npm](https://www.npmjs.com/package/@bacnh85/pi-serena) · [GitHub](https://github.com/bacnh85/pi-extensions/tree/main/pi-serena) |
| Serena（pi-serena 依赖） | 语义代码分析后端 | 1.x（1.7.0） | `uv tool install serena-agent`（先装 [uv](https://docs.astral.sh/uv/)） | [GitHub](https://github.com/oraios/serena) |
| pi-codegraph | 调用关系与影响面分析 | 0.1.x（0.1.10） | `pi install npm:@vndv/pi-codegraph` | [npm](https://www.npmjs.com/package/@vndv/pi-codegraph) · [GitHub](https://github.com/vndv/pi-codegraph) |
| codegraph 命令行 | 索引；合并后只跑受影响的测试 | 1.x（1.6.0） | `npm i -g @colbymchenry/codegraph`，项目内 `codegraph init -i` | [npm](https://www.npmjs.com/package/@colbymchenry/codegraph) |
| pi-web-access | 联网调研（researcher） | 0.35.x（0.35.0） | `pi install npm:pi-web-access` | [npm](https://www.npmjs.com/package/pi-web-access) · [GitHub](https://github.com/nicobailon/pi-web-access) |

版本不在验证范围时只提醒：pi-flow 只启用配置里列出的工具名，写操作取不到路径就阻断，所以插件改了工具名或参数时，相关工具会失效，但安全检查不会放宽。想用验证过的版本，在安装命令后加 `@版本号`（例如 `pi install npm:@vndv/pi-codegraph@0.1.10`）。子进程启动时如果发现角色配置的工具没有注册，会记一条事件，`/flow doctor` 会提示是哪个角色缺了哪些工具。

验证过的版本登记在 `src/core/dependencies.ts`，升级依赖并验证后只改那里。

### 5. 在一个项目里开始

```bash
cd ~/code/my-app            # 必须是 git 仓库；全新项目先 git init
pi                          # 正常启动 pi，pi-flow 随之加载
```

然后在 pi 里：

```
/flow init                                   可选：生成 workflow.yaml、规则与文档骨架并自检（/flow-build 会自动做）
/flow-build "做一个个人记账服务……"           新项目
/flow-build --feature "给导出加上按月筛选"     已有项目加功能
/flow-fix "导出的 CSV 中文乱码"                修复问题
```

- 开始流程后，当前会话进入**调度模式**：切换到 orchestrator 的模型，你只和主 agent 对话，它向你汇报进度、转达你的修改要求；写代码的是后台的各个角色。`/flow status` 随时看进度，`/flow off` 退出调度模式（流程不受影响）。
- 关掉 pi 后流程不会丢：重新打开 pi，执行 `/flow resume` 接着做。
- **已有项目请先改 `workflow.yaml` 的 `commands`**：模板写的是 pnpm 命令（`pnpm test` 等），换成你项目真实的安装、类型检查、lint、测试命令。新项目可以不改：S1 阶段 architect 会按选定的技术栈起草命令和规则，你批准时一并应用。
- 只是小改动（单文件、几十行）时不必走流程，直接用 pi 即可：pi-flow 只在你执行它的命令后才接管会话。

### 为各角色选择模型：`/flow-config`

在 pi 中输入 `/flow-config` → "设置各角色的模型与思考级别"，依次选择角色、模型（只列出你在 Pi 中已配置可用的模型）、思考级别（只列出该模型支持的级别）。设置保存在 `~/.pi/agent/pi-flow.json`，优先于项目 `workflow.yaml` 中的模型档位。

没有交互界面时（`pi -p`）用子命令：

```
/flow-config show                                       查看各角色的模型与来源
/flow-config models                                     列出可用模型及支持的思考级别
/flow-config set reviewer Workbuddy/glm-5.3-flash high
/flow-config set scout default low                      模型用 workflow.yaml 默认，只改思考级别
/flow-config unset reviewer | all
```

---

## 三种工作模式

### 开始之前：需求访谈

三个入口命令（`/flow-build`、`/flow-build --feature`、`/flow-fix`）默认先和你**访谈**：当前会话一次问一个问题并给出建议答案，把谈定的内容记成需求摘要（新项目问目标、用户与场景、功能范围、非目标、验收标准、约束；功能问目标、非目标、验收标准、影响模块、是否改契约；修复问现象、复现步骤、期望与实际行为、出现范围）。清单问完后，由你执行 `--confirm` 才开工，摘要交给后续的角色作为输入。

- `--direct "<描述>"`：跳过访谈直接开始。
- `--from <文件>`：用写好的需求文档直接开始。
- `--cancel`：放弃当前访谈。

访谈期间会话只能读 `docs/` 下的文档和记录需求，不能写文件或执行命令。

### 1. 新项目：`/flow-build ["<项目描述>"]`

在一个 git 仓库中执行（空仓库也可以，会自动 `/flow init`）。访谈确认后，流程按阶段推进，每个阶段内的任务由程序按 DAG 调度：

| 阶段 | 内容 | 闸门 |
|---|---|---|
| S0 需求 | architect 依据访谈摘要写 `docs/PRD.md`。仍有疑问时任务转为阻塞并提一个问题，你用 `/flow answer` 回答 | **你批准**（或 `/flow reject "<意见>"` 打回修订） |
| S1 架构 | architect 写 ARCHITECTURE、ADR、契约（每个模块一个文件，写到函数级：对外函数的名字、参数、返回值、可能的错误；REST 接口写路径、请求响应与错误码；任务的输入列出依赖的契约条目），提交任务 DAG（显示任务数、关键路径、并行宽度、硬依赖占比；开头几层只能串行或关键路径过长时提醒 architect 调整，让任务尽早并行），并针对选定的技术栈写规则与命令草案 | **你批准** + typecheck。批准后契约变为只读，任务正式创建；草案由你选择是否应用到 `rules/` 与 `workflow.yaml` |
| S2 基础设施 | 脚手架、依赖、迁移框架 | install、typecheck、lint |
| S3 切片 | 每个功能一个实现任务，实施者边写边测；功能之间对着契约并行（软依赖） | 全部任务完成 + test |
| S4 集成 | 端到端测试 | e2e |
| S5 发布 | — | **你批准**，随后集成分支合入主分支 |

每个任务的生命周期（默认）：派发 → 实施（独立 worktree，边写边测）→ 提交（程序检查改动是否越界）→ 合并队列（串行：squash、rebase 到集成分支最新、跑**全量** typecheck、lint、test、快进集成分支）。全量测试不过就带着失败日志退回实施者，接着上一次的对话修。不逐个审查任务。

设计阶段（S0、S1、F0、F1）的文档与 fix 流程照旧逐任务审查。想恢复以前每个任务都审查的做法，在 `workflow.yaml` 设 `review.per_task: true`：提交 → verify（失败直接退回，不派审查）→ 审查（只读 reviewer）→ 合并队列（合并后只跑任务 verify 里的命令，测试优先跑受影响的）。

**集成分支跟上主分支**：每个阶段开始时，程序把主分支（你在流程期间的提交、fix 合入的修复）合并进集成分支，与合并队列互斥，只有状态提交（`.flow/`）时不合并。有冲突时：
- 冲突文件都在某个角色的可写范围内：程序保留含冲突标记的合并结果，生成 merge-fix 任务解决，审查、验证后合入，集成分支保留与主分支的合并关系；
- 涉及契约或受保护路径，或没有角色能写：暂停派发新任务，在"需要你处理"中提示。你在集成分支上合并主分支并解决冲突后，执行 `/flow sync` 恢复。

这样冲突在流程中途就被处理，最终合入主分支时不再爆发。

**测试：实施者边写边测，合并后跑全量**：每个功能是一个实现任务，实施者实现功能的同时为它写测试（放在自己可写范围内的测试目录，覆盖任务的每条验收标准），写一部分跑一部分，提交前跑通。合并进集成分支前，程序在 rebase 后的代码上跑全量测试；每个阶段结束时，闸门再跑一次。跨模块的联调与端到端测试放在最后的阶段，由 test-engineer 对着已经实现的功能写。审查者检查实施任务是否带了覆盖验收标准的测试。

> 以前的做法是"先由 test-engineer 写验收测试（必须先失败），再由实施者实现"。真实冒烟中，这些先于实现写的测试跑不出对错，写错了只能靠审查读出来，是返工的最大来源，所以默认关闭。确实需要时，在 `workflow.yaml` 设 `testing.leading_tests: true`：测试任务会被要求先失败，然后由硬依赖它的实现任务一并带入集成分支。

### 2. 加功能：`/flow-build --feature ["<功能描述>"]`

在已有项目上加一个中等规模的功能：F0 功能说明（你批准）→ F1 影响面分析与本功能 DAG（你批准 + typecheck）→ S3 实施 → S4 新功能验收测试 + 全量回归（你批准，随后合入主分支）。跳过 S2。

### 3. 修复：`/flow-fix ["<问题描述>"]`

不建 DAG，由程序依次派发：

1. **scout** 只读定位：问题位置、根因假设、需要改的文件、建议的实施角色。
2. **升级判断**：需要改契约、或预计改动超过 `fix_max_files` 个文件时暂停，建议改用 `/flow-build --feature`；你决定 `/flow approve`（仍按修复）或 `/flow abort`。
3. **test-engineer** 写复现测试，程序运行它并**要求失败**。
4. 实施角色在复现测试的基础上修复，只能改 scout 给出的文件。
5. 审查、verify 后**直接合入主分支**，写 `.flow/fixes/<日期>-<序号>.md`（问题、根因、改动、验证结果、成本）。

没有进行中的流程时可以随时修复；build/feature 流程等待你审批时也可以修复（会请你确认）。

---

## 管理命令：`/flow`

| 命令 | 作用 |
|---|---|
| `/flow status` | 当前处于哪个阶段（需求 → 规划 → 实施 → 验收 → 完成）、进度、正在做什么；需要你处理的事排在最上面 |
| `/flow status --detail` | 完整的任务列表与内部状态（底层阶段、任务 DAG、失败原因） |
| `/flow status --cost` | 按流程、阶段、角色、模型、任务汇总 token 与耗时；返工最多的任务；修复日志 |
| `/flow next` | 由程序选择 ready 任务并派发 |
| `/flow approve [--yes]` | 批准当前阶段闸门（仅你可以）；有待批准的计划修订时先批准修订。最后一个阶段会把集成分支合入主分支 |
| `/flow reject "<意见>"` | 打回设计阶段（S0/S1/F0/F1），生成修订任务 |
| `/flow answer [<任务>]` | 回答阻塞任务提出的问题：弹出输入框由你作答，回答交给该任务后它继续 |
| `/flow unblock <任务> ["<回答>"] [--attempts N]` | 解除阻塞，任务回到 ready（没有交互界面时用它回答） |
| `/flow gate` | 闸门失败并修复后重跑闸门 |
| `/flow rules [apply [all\|<草案文件>...]]` | 查看或应用规则与命令草案（`docs/rules-draft/`，来自架构师或知识提升）；由程序写入 `rules/` 与 `workflow.yaml` 并提交 |
| `/flow budget [tokens\|cost <数值>]` | 查看或设置本流程的预算；用到 80% 时提醒，超出后暂停派发新任务，提高预算后继续 |
| `/flow models [resume <模型>\|all]` | 查看因额度用完、限流、服务连不上而暂停的模型；`resume` 立即恢复派发（模型名可只写 id） |
| `/flow replan "<要改什么>"` | 执行中修订计划：architect 起草新增任务、调整或取消未开始的任务，你用 `/flow approve` 批准（`/flow reject "<意见>"` 打回重做）。在调度模式下直接告诉主 agent 也可以 |
| `/flow sync` | 把主分支同步进集成分支（每个阶段开始时自动执行）；同步冲突由你处理后用它恢复 |
| `/flow run [<run_id>]` | 某次子进程运行的工具调用摘要（含被拦下的调用）与最后的回复；不给 id 时列出最近的运行。会话文件保存在 `<项目>.worktrees/.sessions/<run>/` |
| `/flow knowledge [<搜索词>] [--all]` | 列出、搜索项目知识；`accept <K-编号> ["<改写>"]` 确认候选，`retire <K-编号>...` 废弃，`promote <K-编号>... [--rule <规则名>]` 提升为规则草案 |
| `/flow abort [--yes]` | 中止当前修复或流程（集成分支保留，主分支不受影响） |
| `/flow resume` | 会话丢失后恢复，并进入调度模式 |
| `/flow off` | 退出调度模式，恢复原来的模型与工具（流程状态不变） |
| `/flow doctor [--fix]` | 状态完整性与前置条件检查；`--fix` 清理残留 worktree、提示文件与超过保留期（`limits.session_retention_days`，默认 14 天）的会话留档 |
| `/flow init` | 初始化项目骨架（可重复执行，只补缺，不覆盖） |

平时只需要看 `/flow status`：

```
需要你处理：无

B-001「做一个待办应用」
需求 ✓ → 规划 ✓ → [实施] → 验收 → 完成

实施阶段：按任务拆解实现，逐个审查、验证并合入集成分支
进度：7 / 11 个任务完成

正在进行：
- T-008 实现 UserService（backend-engineer）实现中
- T-009 用户列表页面（frontend-engineer）等待重新派发（第 2 次，上次：审查打回）

阻塞：无
```

### 成本控制

- **按风险审查（三档，只在开启逐任务审查 `review.per_task: true` 时，以及设计阶段的文档审查中生效）**：
  - 低风险：只改文档或测试、改动不超过 3 个文件和 100 行、不涉及契约与 shared，用便宜模型审查（`review.low_risk.model`，取不到时用原来的审查模型）；设 `mode: skip` 则只做程序检查、不派审查。之前失败过的任务不算低风险。
  - 普通：用 reviewer 自己的模型。模板中 reviewer 默认是**中等档**（以前是强档）。
  - 高风险：解决合并冲突、改动契约或 shared、改动 `review.high_risk.paths` 中的路径、改动超过 400 行（`review.high_risk.max_lines`），用强模型审查（先行验收测试不算高风险：它必须先失败已由程序在审查前验证，审查用普通档）。强模型取 `/flow-config escalate reviewer <模型>` > `review.high_risk.model` > reviewer 档位的上一档。
  - 用 `/flow-config` 为 reviewer 显式指定过模型的（例如设成强模型），普通审查就用那个模型；想省成本时把 reviewer 改成中等模型，再用 `/flow-config escalate reviewer <强模型>` 指定高风险审查用的模型。run 记录的 `review_mode` 是 light、full（普通）、strong。同时进行的审查数受 `review.max_parallel` 限制。
- **返工接着上一次的对话**：任务被打回（审查、验证、合并后验证）后，实施者不再从头开始读任务和代码，而是复制上一次运行的对话（`pi --fork`）接着做，只收到"为什么没通过"和新的临时目录。换了模型（例如失败后升级）或会话太长（超过约 400 KB）时仍从头开始。`limits.continue_session: false` 关闭。run 记录的 `forked_from` 标明接着的是哪次运行。
- **并发**：模板默认同时进行 3 个实施任务（`limits.max_parallel`，以前是 2），审查另计（`review.max_parallel`，默认 2）。实施用本地模型时，确认本地服务能承受这么多并发请求；已有项目的 `workflow.yaml` 不受影响，需要时自己改。
- **审查提示直接附 diff**：改动不超过约 2 万字符时，diff 直接放进审查提示（第二轮起只附上次审查之后的改动），审查者不用再花一轮去 `git diff`。`/flow status --cost` 的每行显示平均每次运行几轮，便于找出来回多的角色。
- **先验证再审查**：提交后程序先跑 verify，typecheck 或测试不过直接退回实施者，不派审查；先行验收测试、复现测试在这一步确认"先失败"。通过后再派审查，审查通过时代码没变，就沿用这次结果，不重跑。`review.verify_first: false` 可恢复旧顺序（审查通过后才跑 verify）。
- **多轮审查只核对上次的问题**：任务被审查打回后，下一轮审查的提示附上上次打回的问题清单和之后的改动（`git diff <上次审查的提交> HEAD`），要求审查者先逐条核对，只为"上次的问题没解决"或"新改动引入的明确缺陷"打回，新的改进建议写在通过时的备注里。可选的 `review.max_rounds` 设轮次上限：到达后只剩建议类问题就通过。
- **关键底座第一次就用升级模型**：被至少 3 个任务硬依赖的实施任务（`escalation.critical_fanout`，0 关闭）第一次派发就用升级模型。它卡住时后面的任务全部等待，交给弱模型风险太大。
- **失败后升级模型**：同一任务失败 2 次后（`escalation.after_failures`），下一次实施换成升级模型：`/flow-config escalate <角色> <模型>` 或菜单"设置失败后升级用的模型" > `roles.<角色>.escalate_model` > 上一档（cheap → medium → strong）。run 记录标明升级。
- **模型额度用完、限流时暂停，不判失败**：子进程因模型额度用完（usage limit、insufficient_quota 等）或暂时不可用（限流、过载、5xx、本地服务没启动）而结束时，任务不计失败、不会被推向阻塞，而是暂停这个模型：用它的实施、审查、升级都先不派发，用其他模型的照常进行。"需要你处理"里会列出被暂停的模型、原因、受影响的角色与任务。恢复方式：错误信息里带恢复时间（如 Codex 的 "Try again in ~120 min"）时到点自动恢复；限流、过载从 5 分钟起自动重试，再失败时间隔加倍（最多 60 分钟）；额度用完又没给时间的等你 `/flow models resume <模型>`；也可以用 `/flow-config` 给受影响的角色换模型，换后立即继续。
- **预算**：`workflow.yaml` 的 `budget`（tokens 计输入 + 输出、cost 计金额）或 `/flow budget` 为单个流程设置。用到 `warn_ratio`（默认 80%）时在"需要你处理"中提醒，超出后暂停派发新任务（返工与审查照常），提高预算后继续。`/flow status --cost` 显示用量。

### 执行中修订计划

实施过程中要改需求、发现漏了功能、或者某个任务拆得不对，直接告诉主 agent（例如"账户要支持多币种"）。主 agent 调用 `flow_replan` 把你的原话交给 architect；不在调度模式时用 `/flow replan "<要改什么>"`。实施者发现 API 文档有缺口、或上游的测试写错时，也会阻塞并写"建议修订计划"，由你转给 architect。

architect 按这个顺序提交修订：
1. **分析影响**：要改哪些 API 接口和模块，受影响的任务里哪些已完成、哪些在进行、哪些还没开始。这段分析会原样给你看。
2. **先改 API 文档**：新增一个"改 API 文档"的任务（批准规划后契约是锁定的，只有这种任务能改它）。
3. **处理受影响的任务**：未开始的取消，换成按新文档实现的新任务；进行中的不打断，做完后再接一个修改任务；已完成的新增修改任务。新任务都等 API 文档改完再开工。

程序校验合并后的任务图（角色、范围、无环、测试方式），在"需要你处理"中列出影响分析和修订内容。修订待批准期间本阶段闸门不运行。你执行 `/flow approve` 后，程序在一个事务里新增任务（重新编号）、改依赖、取消任务；`/flow reject "<意见>"` 让 architect 按意见重做。

### codemode（Pi 0.99 内置）

architect、reviewer、scout 默认启用 Pi 的 codemode：模型可以写一段脚本并行调用 read、serena、codegraph 等工具，在脚本里过滤后只把需要的结果带回，减少来回轮次和上下文。脚本里的每个工具调用都照常经过 pi-flow 的安全检查。需要给其他角色启用时，在 `workflow.yaml` 该角色的 `tools` 中加上 `codemode`。

### 项目知识库

项目在多次流程中积累的经验（约定、踩过的坑、做出的决策、环境与外部依赖的注意事项）保存在 `.flow/knowledge.json`，跨流程保留，build、feature、fix 都会用到。

- **谁来写**：
  - 实施、审查、探查角色用 `flow_learn` 提交，程序去重、限长、检查范围后写入并立即生效，每次运行最多 3 条。
  - 可选：在 `workflow.yaml` 中设 `knowledge: { auto_candidates: true }`，审查打回意见、合并后验证失败原因会由程序截取为**候选**，在"需要你处理"中提示，由你 `/flow knowledge accept`（可改写）或 `retire`。默认关闭（真实模型冒烟中这些候选多是一次性的细节）。
  - agent 不能直接改这个文件，它和其他状态文件一样受完整性校验。
- **怎么用**：派发任务时，程序按任务的 scopes、writes、inputs 选出相关条目，放在子进程系统提示的规则与技能之后，并注明"不是规则，与规则冲突时以规则为准"。条目按编号只追加，新增条目只让它之后的提示缓存失效。下游任务的提示中还会附上它依赖的上游任务的 handoff 摘要。
- **变成规则**：`/flow knowledge promote K-003 K-007` 把条目追加进规则草案 `docs/rules-draft/<规则名>.md` 并提交，你确认后用 `/flow rules apply` 应用。应用后条目标为"已成为规则"，不再作为知识注入。
- 访谈新功能或修复时，访谈者会先读相关条目。

高层阶段与底层阶段的对应写在 `workflow.yaml` 每个阶段的 `phase` 字段（discovery、planning、execution、acceptance），可以按需调整。pi-flow 只在进入新阶段、出现需要你处理的事、任务第一次未通过、流程结束时主动提醒你。

调度模式下，终端底部的状态栏实时显示流程、当前阶段、本阶段进度、正在进行的任务和需要你处理的事项数，例如 `pi-flow B-001 实施 · 3/7 · 进行中：T-004 实现中，T-005 审查中`。

开始流程或执行 `/flow resume` 后，当前会话进入**调度模式**：会话切换到你在 `/flow-config` 中为 orchestrator 设置的模型，只能查看状态、派发任务和等待结果，不能自己改代码；每轮开头会看到"当前状态与唯一允许的下一步"。ready 的任务默认由程序自动派发（`limits.auto_dispatch`），主 agent 只在任务完成或阻塞、需要你处理、阶段变化时醒来向你汇报，审查、验证、合并这些中间步骤不会唤醒它；主会话的 token 用量记在 `/flow status --cost` 的 orchestrator 一行（它的"耗时"是会话跨度）。自动派发之后主 agent 只负责沟通，可以用 `/flow-config` 给 orchestrator 选中等模型。流程结束、中止或执行 `/flow off` 后恢复原来的模型与工具。普通的 pi 会话不受影响。

---

## 设置文件一览

| 文件 | 位置 | 谁来写 | 作用 |
|---|---|---|---|
| `settings.json` | `~/.pi/agent/` | `pi install` | Pi 加载哪些包（pi-flow 与插件）。项目级的在 `<项目>/.pi/settings.json`（`pi install -l`） |
| 模型与账号 | `~/.pi/agent/`（`models.json`、`/login` 保存的凭据） | Pi 的 `/login` 或你手写 | 有哪些模型可用；pi-flow 只通过 Pi 查询可用的模型，不读取也不打印密钥 |
| `pi-flow.json` | `~/.pi/agent/` | `/flow-config` | **各角色用哪个模型、思考级别、失败后升级用的模型**（reviewer 的升级模型用于高风险审查）。全局，所有项目共用，优先于项目里的模型档位 |
| `workflow.yaml` | 项目根目录 | `/flow init` 生成，**你修改** | 项目的流程配置，见下表 |
| `rules/*.md` | 项目根目录 | 你（或批准 architect 起草的草案） | 按 scope 注入给各角色的编码规则 |
| `docs/`、`AGENTS.md` | 项目根目录 | 流程中的各角色 | PRD、架构、ADR、契约、功能说明；批准后的 `docs/contracts/` 只读 |
| `.flow/` | 项目根目录 | **只有程序** | 流程状态、任务、运行记录、事件日志；不要手改（会被完整性校验发现） |
| `<项目>.worktrees/` | 项目目录旁边 | 只有程序 | 每个任务的 worktree、子进程会话留档、临时目录 |

`~/.pi/agent` 可用环境变量 `PI_CODING_AGENT_DIR` 改到别处（`pi-flow.json` 随之移动）。

`workflow.yaml` 各部分：

| 部分 | 内容 |
|---|---|
| `main_branch`、`commands` | 主分支名；install、typecheck、lint、test、test_affected、e2e 的实际命令。verify 与闸门只能引用这里的命令名 |
| `limits` | 实施并发 `max_parallel`、失败上限 `max_attempts`、租约 `lease_minutes`、单条 bash 超时 `bash_timeout_s`、自动派发 `auto_dispatch`、返工接续对话 `continue_session`、违规上限等 |
| `models` | 档位（strong、medium、cheap）对应的具体模型；`/flow-config` 设置过的角色以它为准 |
| `review` | 逐任务审查 `per_task`（默认关闭）、审查并发、先验证再审查 `verify_first`、低风险与高风险的判定和模型、轮次上限 |
| `escalation` | 失败几次后升级模型 `after_failures`、关键底座第一次就升级 `critical_fanout` |
| `budget` | 每个流程的 token 或金额预算（可选） |
| `modes` | build、feature 的阶段与闸门 |
| `scopes`、`tool_groups`、`roles` | 每个 scope 的可写路径与规则；工具组；每个角色的档位、scope、可用工具与环境变量 |

## 项目里会多出什么

```
workflow.yaml        命令、并发与失败上限、模型档位、阶段、scope 与可写范围、角色与工具（只有你修改）
rules/               按模块注入的规则（只有你修改）
docs/                PRD、ARCHITECTURE、DESIGN、adr/、contracts/、features/、research/
AGENTS.md            极简说明
.flow/               运行时状态（程序维护；不进入分支历史，每次状态变化提交到专用引用 refs/pi-flow/state，
                     用 git log refs/pi-flow/state 查看；需要备份时 git push origin refs/pi-flow/state）
  knowledge.json     项目知识库（跨流程；只经 flow_learn 与 /flow knowledge 由程序写入）
  model-pauses.json  因额度用完、限流而暂停的模型（程序写入；/flow models 查看与恢复）
../<项目>.worktrees/  每个任务的 worktree（在项目目录之外）
```

`workflow.yaml` 中 verify 与闸门只能引用 `commands` 里的命令名；scope 决定每个角色能写哪些路径。

---

## 安全边界

- 每个子进程只启用本角色的工具；写操作（write、edit、serena 编辑）只能落在本任务的 `writes` 内。
- `.flow/`、`.git/`、`workflow.yaml`、`rules/`、`.pi/`、已批准的 `docs/contracts/` 对所有 agent 只读。
- bash 拦截重定向到受保护路径、`tee`、`sed -i`、`mv`、`cp`、`rm`、改写 git 历史、切到 worktree 之外、联网命令；只读角色只能执行只读命令。
- 禁止读取 `.env*`、`*.pem`、`secrets/**`，禁止打印环境变量。
- 这一层不可能拦全（例如脚本文件内部的行为），所以**提交时的 diff 检查是兜底**：改动越出 `writes` 或碰到受保护路径一律被拒。
- 每次违规都记入事件日志；单次运行违规达到上限会被终止，任务转为阻塞等你处理。
- run token 只经环境变量交给子进程，`.flow/` 只存哈希；没有有效 token 的提交和审查结论一律被拒。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 关掉了 pi（或 pi 崩溃），流程还在吗 | 在。重新打开 pi，执行 `/flow resume`：清理残留子进程、处理中断的任务和合并，然后继续。subagent 的对话不会恢复，而是新起一个 subagent 在原 worktree 上接着做：已写的文件都还在，新的 subagent 会被告知"工作区已有的改动"。会话中断不计入失败次数（同一任务连续中断 5 次才转为阻塞） |
| "另一个 pi 会话正在运行该项目的流程" | 同一项目同一时间只允许一个会话运行引擎。到那个会话中操作，或关闭它后再 `/flow resume` |
| "状态完整性校验失败" | `.flow/` 被手工修改或损坏，程序已停止。执行 `/flow doctor` 查看具体文件；用 `git log -- .flow` 找回上一次正确的状态 |
| 任务反复失败后转为阻塞 | `/flow status` 顶部会列出阻塞原因，`/flow status --detail` 查看每次失败的详情；修正需求或环境后 `/flow unblock <任务>`。失败上限在 `workflow.yaml` 的 `limits.max_attempts` |
| "角色 X 没有设置模型" | 执行 `/flow-config` 为该角色选择模型 |
| 闸门失败 | `/flow status` 显示失败命令与输出摘要（evidence 在 `.flow/flows/<流程>/evidence/stage-<阶段>/`）。修复后 `/flow gate` |
| 合并冲突转为阻塞 | 冲突涉及契约或受保护文件时需要你人工合并；只在任务范围内的冲突会自动生成 merge-fix 任务 |
| 合入主分支失败 | 主工作区有未提交改动，或主分支在流程期间被修改。提交或暂存后重试 `/flow approve` |
| 残留的 worktree 或临时文件 | `/flow doctor --fix` |
| 想看每个任务花了多少 | `/flow status --cost` |
| 想直观地看整个流程（状态机与转移次数、任务 DAG、运行时间线、成本、事件日志） | 在 pi-flow 仓库里执行 `node scripts/flow-view.ts <项目目录>`，生成 `<项目目录>.flow-view.html`，用浏览器打开（自包含，不联网，只读） |

---

## 开发

```bash
npm install
npm run typecheck
npm test            # 单元测试 + 端到端测试（真实 pi 子进程配合本地假模型，不依赖真实 LLM）
node scripts/demo.ts             # 演示：用假模型跑完一个 build 流程 S0→S5
node scripts/demo.ts --real-fix  # 演示：用你在 /flow-config 中配置的真实模型跑一次 /flow-fix
```

设计说明、偏离记录、已验证的 Pi API 与版本见 [NOTES.md](NOTES.md)。
