# pi-flow

把"个人开发一个中型项目"的工作流固化成 [Pi](https://pi.dev) 插件。

- **程序负责调度、守卫、验收和合并**：选哪个任务、派给哪个角色、并行几个、何时合并，都由代码决定；状态只由程序写入 `.flow/`，每次转移都追加带哈希链的事件并提交 git。
- **LLM 只负责与你沟通和完成各自的任务**：每个角色（需求讨论、原型、规划、模块实现、独立验收）在独立的 pi 子进程和独立的 git worktree 中工作，只能使用本角色的工具、只能写本任务允许的文件。
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

- 开始流程后，当前会话进入**调度模式**：切换到 orchestrator 的模型，你只和主 agent 对话，它向你汇报进度、转达你的修改要求；写代码的是后台的各个角色。`/flow-status` 随时看进度，`/flow off` 退出调度模式（流程不受影响）。
- 关掉 pi 后流程不会丢：重新打开 pi，执行 `/flow-resume` 接着做。
- **已有项目请先确认 `workflow.yaml` 的 `commands`**：模板写的是 pnpm 命令，规划阶段 architect 会按项目的技术栈起草命令（`docs/rules-draft/commands.yaml`），你批准规划时一并应用；也可以自己先改。
- 只是小改动（单文件、几十行）时不必走流程，直接用 pi 即可：pi-flow 只在你执行它的命令后才接管会话。

### 为各角色选择模型：`/flow-config`

在 pi 中输入 `/flow-config` → "设置各角色的模型与思考级别"，依次选择角色、模型（只列出你在 Pi 中已配置可用的模型）、思考级别（只列出该模型支持的级别）。设置保存在 `~/.pi/agent/pi-flow.json`，优先于项目 `workflow.yaml` 中的模型档位。

没有交互界面时（`pi -p`）用子命令：

```
/flow-config show                                       查看各角色的模型与来源
/flow-config models                                     列出可用模型及支持的思考级别
/flow-config set designer google/gemini-3-pro high      例如原型交给前端审美好的模型
/flow-config set acceptor default low                   模型用 workflow.yaml 默认，只改思考级别
/flow-config unset designer | all
```

---

## 流程

### 1. 新项目：`/flow-build ["<想法>"]`

在一个 git 仓库中执行（空仓库也可以，会自动 `/flow init`）。不给描述时由主 agent 先问你想做什么。流程分四个阶段，用户界面显示为 **需求 → 原型 → 规划 → 实施 → 完成**：

| 阶段 | 内容 | 闸门 |
|---|---|---|
| D0 需求 | 主 agent 直接和你逐轮讨论：每轮把能问的问题一次问完，每个问题给出推荐答案；需要的事实（已有代码、技术栈）它自己读代码查，决定交给你。谈清楚后它把需求说明（需求清单与优先级、done-when 验收标准、术语、关键决策、界面风格、范围外）用 `flow_requirements` 提交，程序写入集成分支上的 `docs/requirements.md`，同时记下要不要原型。已经写好需求文档时用 `/flow-build --from <文件>` 跳过讨论（`--no-prototype` 不做原型） | **你批准**；`/flow-reject "<意见>"` 后主 agent 带着意见继续和你讨论、重新提交，可以来回多次 |
| D1 原型 | designer 按需求里定下的风格写 `prototype/*.html` 与导航页（无框架、无构建，浏览器直接打开）。没有界面或你选择不要时跳过，状态栏显示"原型（跳过）" | **你批准**（或打回修改） |
| D2 规划 | architect 写 `docs/modules.md`（模块划分：每个模块是能单独验收的纵向切片，铺垫性重构单独成模块排在前面，每个模块写明测试接口）、`docs/glossary.md`（术语表）、`docs/interfaces/<模块>.md`（只写模块之间的调用）、项目专属规则草案 `docs/rules-draft/project.md`、命令草案与 `AGENTS.md`，然后用 `flow_propose_modules` 提交模块：每个模块一个任务，带可写范围、负责的验收标准、依赖、登记的公共文件（路由注册、菜单等多个模块都要追加的文件）。模块大小跟实现者的模型走：强模型一个模块可以是一块完整的业务功能 | **你批准**；批准时程序把规则草案写成 `rules/project.md`、应用命令草案（`--rules none` 不应用） |
| E 实施 | 每个模块交给一个 implementer（先写测试再实现，见技能 tdd），在自己的 worktree 里写前端、后端和测试；互不依赖的模块并行。模块完成后合并、独立验收（见下）；开启 `review.final` 时最后再做一次代码审查 | 全部模块验收通过（+ 可选的最终代码审查）+ 全量测试 + **你批准**，随后集成分支合入主分支 |

**模块的生命周期**：
1. **分步开发**：implementer 每完成一部分就在 worktree 里本地 `git commit`，并更新 notes。进程被杀后 `/flow-resume`，工作区和本地提交都在，接着原会话继续。需要依赖的模块刚合入的代码、或想提前发现冲突时，调用 `flow_sync` 把集成分支最新代码合进来，有冲突就在工作区里解决后再调用一次。
2. **合并**：整个模块完成后 `flow_submit`，进入合并队列（串行）：squash、rebase 到集成分支最新、跑**全量** typecheck、lint、test 和可选的 `commands.merge_check`（例如迁移只能有一个 head），通过后快进集成分支。队列里同时有几个模块时最多 3 个一起叠加、只跑一次全量测试（`limits.merge_batch`），失败再逐个合并。失败就带着日志退回同一会话修。别的模块已有的测试因为接口变化而失败时，implementer 可以直接修改那些已有测试来适配（`testing.adjust_tests`，默认开；只能改不能增删，改过哪些记在任务上）。
3. **独立验收**：合并后程序派一个 acceptor，在集成分支最新代码上构建、启动、实际调用，按模块负责的验收标准逐条给出"通过 / 未通过 + 证据"（`flow_accept`）。没通过的条目交回 implementer 的会话修复，合并后 acceptor 只复查没通过的条目（`flow_accept_confirm`，不能提新问题）。两轮修复仍不过就列进"需要你处理"：你可以 `/flow replan` 调整，或者确认可以接受后 `/flow accept <任务>` 放行。依赖这个模块的模块等它验收通过才开工。
4. **最终代码审查（可选，`review.final: true` 开启，默认关闭）**：全部模块验收通过后，程序派一个只读的 reviewer 审查整个流程的改动（`git diff <分叉点>..<集成分支>`，不含原型，不拆分），对照 `rules/`、`AGENTS.md` 与常见坏味道（技能 code-review）逐条给出级别（必须改 / 建议）、依据、文件、位置、问题、期望（`flow_review_report`），写到集成分支的 `docs/review/final.md`。"必须改"自动交给负责的模块修一轮（接着 implementer 的会话，不再复审）；其余的由你挑：`/flow review fix R-3 R-5` 交给模块修，`/flow review done` 都不修。功能是否做到由验收负责，审查只看代码写得好不好。
5. **阶段闸门**：全部模块验收通过后跑全量测试；失败时程序从日志里找出出错的文件，交给负责的模块修，最多两轮，仍失败就转"需要你处理"（处理后 `/flow gate` 重跑）。

**跨模块接口**：`docs/interfaces/` 在实施中只能**追加**（程序拒绝修改或删除已有内容）；要改已有接口走计划修订。

**集成分支跟上主分支**：每个阶段开始时，程序把主分支（你在流程期间的提交、fix 合入的修复）合并进集成分支，与合并队列互斥。冲突文件都在某个模块的可写范围内时，生成 merge-fix 任务解决；涉及受保护路径或没有模块能写时，暂停派发并在"需要你处理"中提示，你解决后 `/flow sync` 恢复。

### 2. 加功能：`/flow-build --feature ["<功能描述>"]`

流程相同。主 agent 讨论前会先读相关的已有代码；需求说明写到 `docs/requirements/<功能>.md`；D1 视情况跳过；D2 只规划这次涉及哪几个模块、各改什么、各负责哪些验收标准。

### 3. 修复：`/flow-fix ["<问题描述>"]`

不建 DAG，由程序依次推进：一个 implementer 定位并修复，同时加回归测试 → 合并（全量测试，直接合入主分支）→ acceptor 复现确认已修好（不过就交回 implementer 的会话修，两轮仍不过转"需要你处理"）→ 写 `.flow/fixes/<日期>-<序号>.md`（问题、改动、验收结果、成本）。预计改动超过 `limits.fix_max_files` 个文件时暂停，建议改用 `/flow-build --feature`；你决定 `/flow-approve`（仍按修复）或 `/flow abort`。

没有进行中的流程时可以随时修复；build/feature 流程等待你审批时也可以修复（会请你确认）。

### 中途追加需求：`/flow-add "<需求>"`

子进程以 RPC 方式运行（`pi --mode rpc`），追加的需求直接送进正在做的模块的会话（steer），同时写进该模块 notes 的目标。只有一个模块在做时自动送给它；有多个时交给 architect 判断归哪个模块或新增模块（`--task <任务>` 可以直接指定）。在调度模式下直接告诉主 agent 也可以。

### notes 与 history

所有 agent（包括主 agent）都有两个工具：
- **notes**：结构化笔记（goal、current、done、todo、决定、坑），每次请求由程序原样放回上下文末尾（不改系统提示，不影响缓存）。任务开始时程序填好目标与验收标准，之后由模型自己维护。上下文用到 `context.compact_at`（默认 70%）时压缩，压缩前提醒先更新笔记，压缩后笔记原样还在。
- **history**：检索完整的会话历史（subagent 查本任务所有运行，返工前的也能查到；主 agent 查主会话），压缩掉的细节可以查回来。

---

## 管理命令：`/flow`

| 命令 | 作用 |
|---|---|
| `/flow-status` | 当前处于哪个阶段（需求 → 原型 → 规划 → 实施 → 完成）、进度、正在做什么；需要你处理的事排在最上面 |
| `/flow-status --detail` | 完整的任务列表与内部状态（底层阶段、任务 DAG、失败原因、验收结果） |
| `/flow-status --cost` | 按流程、阶段、角色、模型、任务汇总 token 与耗时；返工最多的任务；修复日志 |
| `/flow next` | 由程序选择 ready 任务并派发 |
| `/flow-approve [--yes]` | 批准当前阶段闸门（仅你可以）；有待批准的计划修订时先批准修订。实施阶段批准时把集成分支合入主分支 |
| `/flow-reject "<意见>"` | 打回需求、原型或规划阶段：需求由主 agent 带着意见继续和你讨论；原型、规划由写作者接着原会话修改 |
| `/flow-add "<需求>" [--task <任务>]` | 中途追加需求 |
| `/flow accept <任务> [--note "<说明>"]` | 验收两轮不过、转"需要你处理"时人工放行这个模块 |
| `/flow review [fix <R-编号>... \| done]` | 最终代码审查（`review.final` 开启时）：查看结论；挑选要修的建议交给负责的模块；其余不修、结束审查 |
| `/flow answer [<任务>]` | 回答阻塞任务提出的问题：弹出输入框由你作答，回答交给该任务后它继续 |
| `/flow unblock <任务> ["<回答>"] [--attempts N]` | 解除阻塞，任务回到 ready（没有交互界面时用它回答） |
| `/flow gate` | 闸门失败并修复后重跑闸门 |
| `/flow rules [apply [all\|<草案文件>...]]` | 查看或应用规则与命令草案（`docs/rules-draft/`，来自架构师或知识提升）；由程序写入 `rules/` 与 `workflow.yaml` 并提交 |
| `/flow budget [tokens\|cost <数值>]` | 查看或设置本流程的预算；用到 80% 时提醒，超出后暂停派发新任务，提高预算后继续 |
| `/flow models [resume <模型>\|all]` | 查看因额度用完、限流、服务连不上而暂停的模型；`resume` 立即恢复派发（模型名可只写 id） |
| `/flow replan "<要改什么>"` | 执行中修订模块清单：architect 起草（新增模块、调整或取消未开始的模块），你用 `/flow-approve` 批准（`/flow-reject "<意见>"` 打回重做）。在调度模式下直接告诉主 agent 也可以 |
| `/flow sync` | 把主分支同步进集成分支（每个阶段开始时自动执行）；同步冲突由你处理后用它恢复 |
| `/flow run [<run_id>]` | 某次子进程运行的工具调用摘要（含被拦下的调用）与最后的回复；不给 id 时列出最近的运行。会话文件保存在 `<项目>.worktrees/.sessions/<run>/` |
| `/flow knowledge [<搜索词>] [--all]` | 列出、搜索项目知识；`accept <K-编号> ["<改写>"]` 确认候选，`retire <K-编号>...` 废弃，`promote <K-编号>... [--rule <规则名>]` 提升为规则草案 |
| `/flow abort [--yes]` | 中止当前修复或流程（集成分支保留，主分支不受影响） |
| `/flow-resume` | 会话丢失后恢复，并进入调度模式 |
| `/flow off` | 退出调度模式，恢复原来的模型与工具（流程状态不变） |
| `/flow doctor [--fix]` | 状态完整性与前置条件检查；`--fix` 清理残留 worktree、提示文件与超过保留期（`limits.session_retention_days`，默认 14 天）的会话留档 |
| `/flow init` | 初始化项目骨架（可重复执行，只补缺，不覆盖） |

平时只需要看 `/flow-status`：

```
需要你处理：无

B-001「做一个待办应用」
需求 ✓ → 原型（跳过） → 规划 ✓ → [实施] → 完成

实施阶段：一个模块交给一个模型实现，合并时跑全量测试，合并后独立验收
进度：2 / 4 个任务完成

正在进行：
- T-003 看板与卡片（implementer）实现中
- T-004 用户与登录（acceptor）验收中

阻塞：无
```

### 成本与模型

- **返工接着上一次的对话**：合并失败、验收没通过、会话中断后，implementer 不从头开始，而是复制上一次运行的对话（`pi --fork`）接着做，只收到"为什么没通过"和新的临时目录。换了模型（例如失败后升级）或会话太长（超过约 400 KB）时仍从头开始。`limits.continue_session: false` 关闭。
- **并发**：模板默认同时进行 3 个模块（`limits.max_parallel`）。实施用本地模型时，确认本地服务能承受这么多并发请求。
- **失败后升级模型**：同一任务失败 2 次后（`escalation.after_failures`），下一次换成升级模型：`/flow-config escalate <角色> <模型>` 或菜单"设置失败后升级用的模型" > `roles.<角色>.escalate_model` > 上一档（cheap → medium → strong）。`escalation.critical_fanout` 设为 N 时，被至少 N 个模块硬依赖的模块第一次就用升级模型。
- **模型额度用完、限流时暂停，不判失败**：子进程因模型额度用完或暂时不可用（限流、过载、5xx、本地服务没启动）而结束时，任务不计失败，而是暂停这个模型：用它的任务先不派发，用其他模型的照常进行。"需要你处理"里会列出被暂停的模型、原因、受影响的任务。错误信息里带恢复时间时到点自动恢复；限流、过载从 5 分钟起自动重试（间隔加倍，最多 60 分钟）；额度用完又没给时间的等你 `/flow models resume <模型>`；也可以用 `/flow-config` 换模型。
- **预算**：`workflow.yaml` 的 `budget`（tokens 计输入 + 输出、cost 计金额）或 `/flow budget` 为单个流程设置。用到 `warn_ratio`（默认 80%）时提醒，超出后暂停派发新任务（返工照常）。

### 执行中修订计划

实施过程中要改需求、发现漏了功能、或者某个模块划分得不对，直接告诉主 agent。主 agent 调用 `flow_replan` 把你的原话交给 architect；不在调度模式时用 `/flow replan "<要改什么>"`。architect 先写影响分析（要改哪些接口和模块，受影响的模块哪些已完成、在做、没开始），再提交修订：未开始的取消或调整，进行中的做完后接一个修改任务，已完成的新增修改任务。程序校验合并后的任务图（角色、范围、无环），你 `/flow-approve` 后在一个事务里生效。

### codemode（Pi 0.99 内置）

architect 默认启用 Pi 的 codemode：模型可以写一段脚本并行调用 read、serena、codegraph 等工具，在脚本里过滤后只把需要的结果带回。脚本里的每个工具调用都照常经过 pi-flow 的安全检查。需要给其他角色启用时，在 `workflow.yaml` 该角色的 `tools` 中加上 `codemode`。

### 项目知识库

项目在多次流程中积累的经验（约定、踩过的坑、做出的决策、环境注意事项）保存在 `.flow/knowledge.json`，跨流程保留。notes 只属于一个任务，知识库跨任务、跨流程，两者互补。

- **谁来写**：各角色用 `flow_learn` 提交，程序去重、限长、检查范围后写入并立即生效，每次运行最多 3 条。可选：`knowledge: { auto_candidates: true }` 时，合并后验证失败的原因会由程序截取为**候选**，由你 `/flow knowledge accept`（可改写）或 `retire`。agent 不能直接改这个文件。
- **怎么用**：派发任务时，程序按任务的 scopes、writes、inputs 选出相关条目，放在子进程系统提示的规则与技能之后，注明"不是规则，与规则冲突时以规则为准"。条目按编号只追加。下游任务的提示中还会附上上游任务的 handoff 摘要。
- **变成规则**：`/flow knowledge promote K-003 K-007` 把条目追加进规则草案 `docs/rules-draft/<规则名>.md`，你确认后用 `/flow rules apply` 应用。

高层阶段与底层阶段的对应写在 `workflow.yaml` 每个阶段的 `phase` 字段（requirements、prototype、planning、execution），可以按需调整。pi-flow 只在进入新阶段、出现需要你处理的事、任务第一次未通过、流程结束时主动提醒你。

调度模式下，终端底部的状态栏实时显示流程、当前阶段、本阶段进度、正在进行的任务和需要你处理的事项数，例如 `pi-flow B-001 实施 · 1/3 · 进行中：T-002 实现中，T-001 验收中`。

开始流程或执行 `/flow-resume` 后，当前会话进入**调度模式**：会话切换到你在 `/flow-config` 中为 orchestrator 设置的模型，只能读文件、查看状态、派发任务和等待结果，不能自己改代码（需求说明经 `flow_requirements` 由程序写入）；每轮开头会看到"当前状态与唯一允许的下一步"。ready 的任务默认由程序自动派发（`limits.auto_dispatch`），主 agent 只在任务完成或阻塞、需要你处理、阶段变化时醒来向你汇报；主会话的 token 用量记在 `/flow-status --cost` 的 orchestrator 一行。流程结束、中止或执行 `/flow off` 后恢复原来的模型与工具。普通的 pi 会话不受影响。

---

## 设置文件一览

| 文件 | 位置 | 谁来写 | 作用 |
|---|---|---|---|
| `settings.json` | `~/.pi/agent/` | `pi install` | Pi 加载哪些包（pi-flow 与插件）。项目级的在 `<项目>/.pi/settings.json`（`pi install -l`） |
| 模型与账号 | `~/.pi/agent/`（`models.json`、`/login` 保存的凭据） | Pi 的 `/login` 或你手写 | 有哪些模型可用；pi-flow 只通过 Pi 查询可用的模型，不读取也不打印密钥 |
| `pi-flow.json` | `~/.pi/agent/` | `/flow-config` | **各角色用哪个模型、思考级别、失败后升级用的模型**。全局，所有项目共用，优先于项目里的模型档位 |
| `workflow.yaml` | 项目根目录 | `/flow init` 生成，**你修改** | 项目的流程配置，见下表 |
| `rules/*.md` | 项目根目录 | 你（或批准 architect 起草的草案） | `global.md` 加上规划阶段生成的项目专属 `project.md`，注入给实现者与验收者 |
| `docs/`、`AGENTS.md` | 项目根目录 | 流程中的各角色 | 需求（`requirements.md`，主 agent 和你讨论后由程序写入）、术语表（`glossary.md`）、模块划分（`modules.md`）、模块之间的接口（`interfaces/`，实施中只能追加）、最终审查（`review/final.md`）；`prototype/` 原型 |
| `.flow/` | 项目根目录 | **只有程序** | 流程状态、任务、运行记录、事件日志；不要手改（会被完整性校验发现） |
| `<项目>.worktrees/` | 项目目录旁边 | 只有程序 | 每个任务的 worktree、子进程会话留档、临时目录 |

`~/.pi/agent` 可用环境变量 `PI_CODING_AGENT_DIR` 改到别处（`pi-flow.json` 随之移动）。

`workflow.yaml` 各部分：

| 部分 | 内容 |
|---|---|
| `main_branch`、`commands` | 主分支名；install、typecheck、lint、test 的实际命令，可选的 `merge_check`（合并时一起跑的额外检查）。闸门只能引用这里的命令名 |
| `limits` | 模块并发 `max_parallel`、批量合并 `merge_batch`、失败上限 `max_attempts`、租约 `lease_minutes`、单条 bash 超时 `bash_timeout_s`、自动派发 `auto_dispatch`、返工接续对话 `continue_session`、违规上限等 |
| `models` | 档位（strong、medium、cheap）对应的具体模型；`/flow-config` 设置过的角色以它为准 |
| `context` | 触发压缩的上下文占比 `compact_at`（默认 0.7） |
| `testing` | 适配已有测试 `adjust_tests`（默认开） |
| `review` | 最终代码审查 `final`（默认关；开启后实施阶段末多一次审查，必须改的自动修，建议由你挑选） |
| `escalation` | 失败几次后升级模型 `after_failures`、关键底座第一次就升级 `critical_fanout` |
| `budget` | 每个流程的 token 或金额预算（可选） |
| `modes` | build、feature 的阶段（D0 需求、D1 原型、D2 规划、E 实施）与闸门 |
| `scopes`、`tool_groups`、`roles` | 每个 scope 的可写路径与规则；工具组；每个角色的档位、scope、可用工具与环境变量 |

## 项目里会多出什么

```
workflow.yaml        命令、并发与失败上限、模型档位、阶段、scope 与可写范围、角色与工具（只有你修改）
rules/               global.md 与规划阶段生成的 project.md（只有你修改，或批准草案时由程序写入）
docs/                requirements.md、modules.md、interfaces/、adr/、research/、rules-draft/
prototype/           原型（D1，可跳过）
AGENTS.md            项目说明（architect 在规划阶段起草）
.flow/               运行时状态（程序维护；不进入分支历史，每次状态变化提交到专用引用 refs/pi-flow/state，
                     用 git log refs/pi-flow/state 查看；需要备份时 git push origin refs/pi-flow/state）
  flows/<流程>/notes/  各任务的结构化笔记；notes/main.json 是主会话的（notes 工具经程序写入）
  knowledge.json     项目知识库（跨流程；只经 flow_learn 与 /flow knowledge 由程序写入）
  model-pauses.json  因额度用完、限流而暂停的模型（程序写入；/flow models 查看与恢复）
../<项目>.worktrees/  每个任务的 worktree（在项目目录之外）
```

`workflow.yaml` 中闸门只能引用 `commands` 里的命令名；scope 决定每个角色能写哪些路径。

---

## 安全边界

- 每个子进程只启用本角色的工具；写操作（write、edit、serena 编辑）只能落在本任务的 `writes` 内。
- `.flow/`、`.git/`、`workflow.yaml`、`rules/`、`.pi/` 对所有 agent 只读；`docs/interfaces/` 在实施中只能追加，修改或删除已有内容的提交会被拒。
- bash 拦截重定向到受保护路径、`tee`、`sed -i`、`mv`、`cp`、`rm`、改写 git 历史、切到 worktree 之外、联网命令；只读角色只能执行只读命令。
- 禁止读取 `.env*`、`*.pem`、`secrets/**`，禁止打印环境变量。
- 这一层不可能拦全（例如脚本文件内部的行为），所以**提交时的 diff 检查是兜底**：改动越出 `writes` 或碰到受保护路径一律被拒。
- 每次违规都记入事件日志；单次运行违规达到上限会被终止，任务转为阻塞等你处理。
- run token 只经环境变量交给子进程，`.flow/` 只存哈希；没有有效 token 的提交和验收结论一律被拒。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 关掉了 pi（或 pi 崩溃），流程还在吗 | 在。重新打开 pi，执行 `/flow-resume`：清理残留子进程、处理中断的任务和合并，然后继续。subagent 的对话不会恢复，而是新起一个 subagent 在原 worktree 上接着做：已写的文件都还在，新的 subagent 会被告知"工作区已有的改动"。会话中断不计入失败次数（同一任务连续中断 5 次才转为阻塞） |
| "另一个 pi 会话正在运行该项目的流程" | 同一项目同一时间只允许一个会话运行引擎。到那个会话中操作，或关闭它后再 `/flow-resume` |
| "状态完整性校验失败" | `.flow/` 被手工修改或损坏，程序已停止。执行 `/flow doctor` 查看具体文件；用 `git log -- .flow` 找回上一次正确的状态 |
| 任务反复失败后转为阻塞 | `/flow-status` 顶部会列出阻塞原因，`/flow-status --detail` 查看每次失败的详情；修正需求或环境后 `/flow unblock <任务>`。失败上限在 `workflow.yaml` 的 `limits.max_attempts` |
| "角色 X 没有设置模型" | 执行 `/flow-config` 为该角色选择模型 |
| 验收两轮修复后仍不过 | `/flow-status` 列出没通过的条目与验收者的证据；`/flow replan` 调整，或确认可以接受后 `/flow accept <任务>` 放行 |
| 闸门失败 | `/flow-status` 显示失败命令与输出摘要（evidence 在 `.flow/flows/<流程>/evidence/stage-<阶段>/`）。修复后 `/flow gate` |
| 合并冲突转为阻塞 | 冲突涉及受保护文件时需要你人工合并；只在任务范围内的冲突会自动生成 merge-fix 任务 |
| 合入主分支失败 | 主工作区有未提交改动，或主分支在流程期间被修改。提交或暂存后重试 `/flow-approve` |
| 残留的 worktree 或临时文件 | `/flow doctor --fix` |
| 想看每个任务花了多少 | `/flow-status --cost` |
| 想直观地看整个流程（状态机与转移次数、任务 DAG、运行时间线、成本、事件日志） | 在 pi-flow 仓库里执行 `node scripts/flow-view.ts <项目目录>`，生成 `<项目目录>.flow-view.html`，用浏览器打开（自包含，不联网，只读） |

---

## 开发

```bash
npm install
npm run typecheck
npm test            # 单元测试 + 端到端测试（真实 pi 子进程配合本地假模型，不依赖真实 LLM）
node scripts/demo.ts             # 演示：用假模型跑完一个 build 流程（需求 → 规划 → 实施与验收）
node scripts/demo.ts --real-fix  # 演示：用你在 /flow-config 中配置的真实模型跑一次 /flow-fix
```

设计说明、偏离记录、已验证的 Pi API 与版本见 [NOTES.md](NOTES.md)。
