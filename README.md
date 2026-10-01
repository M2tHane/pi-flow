# pi-flow

把"个人开发一个中型项目"的工作流固化成 [Pi](https://pi.dev) 插件。

- **程序负责调度、守卫、验收和合并**：选哪个任务、派给哪个角色、并行几个、何时合并，都由代码决定；状态只由程序写入 `.flow/`，每次转移都追加带哈希链的事件并提交 git。
- **LLM 只负责与你沟通和完成各自的任务**：每个角色（架构、后端、前端、测试、审查等）在独立的 pi 子进程和独立的 git worktree 中工作，只能使用本角色的工具、只能写本任务允许的文件。
- **人工闸门只有你能批准**：任何 agent 都没有批准阶段闸门的工具。
- **会话可以随时中断**：恢复只依赖 `.flow/` 与 git，不依赖对话历史。

> **逃生口**：单文件、几十行以内的小改动，直接用 pi 更划算，不必走流程。pi-flow 只在你执行它的命令后才接管会话。

---

## 安装

要求：Node 22 以上、git 2.30 以上、Pi 0.99 以上（已在 0.99.2 上验证）。

```bash
# 从本地目录安装（全局）；加 -l 则只装到当前项目的 .pi/settings.json
pi install /path/to/pi-flow
```

可选插件（子进程按角色自动加载，未安装则对应工具不可用）：

| 插件 | 用途 | 安装 |
|---|---|---|
| pi-serena | 符号级读取与编辑（实施、审查、探查角色） | `pi install npm:@bacnh85/pi-serena`（另需安装 Serena） |
| pi-codegraph | 调用关系与影响面分析；合并后只跑受影响的测试 | `pi install npm:@vndv/pi-codegraph`，`npm i -g @colbymchenry/codegraph`，项目内 `codegraph init -i` |
| pi-web-access | 联网调研（仅 researcher） | `pi install npm:pi-web-access` |

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
| S1 架构 | architect 写 ARCHITECTURE、ADR、契约，提交任务 DAG（显示任务数、关键路径、并行宽度、硬依赖占比），并针对选定的技术栈写规则与命令草案 | **你批准** + typecheck。批准后契约变为只读，任务正式创建；草案由你选择是否应用到 `rules/` 与 `workflow.yaml` |
| S2 基础设施 | 脚手架、依赖、迁移框架 | install、typecheck、lint |
| S3 切片 | 先验收测试后实现；软依赖并行，integration 任务联调 | 全部任务完成 + test |
| S4 集成 | 端到端测试 | e2e |
| S5 发布 | — | **你批准**，随后集成分支合入主分支 |

每个任务的生命周期：派发 → 实施（独立 worktree）→ 提交（程序检查改动是否越界）→ 审查（只读 reviewer）→ verify（程序在 worktree 里跑命令）→ 合并队列（串行：squash、rebase、合并后验证、快进集成分支）。

**验收测试必须先失败**：有实现任务硬依赖的验收测试（kind=test），审查通过后程序运行它的测试命令并**要求失败**；"必然通过"的测试会被打回，原因写明"验收测试没有失败"。确认失败后它不单独合入，而是由硬依赖它的实现任务（承载者）从测试分支开工，合并时测试与实现作为两个提交一次快进进入集成分支，集成分支不会因为未实现的测试变红。一个验收测试只对应一个承载者：提交 DAG 时，程序把其余硬依赖它的任务改为硬依赖承载者；一个实现任务不能承载多个验收测试。没有下游实现任务的测试（例如 S4 的端到端、回归测试）照常验证通过后合入。

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
| `/flow approve [--yes]` | 批准当前阶段闸门（仅你可以）。最后一个阶段会把集成分支合入主分支 |
| `/flow reject "<意见>"` | 打回设计阶段（S0/S1/F0/F1），生成修订任务 |
| `/flow answer [<任务>]` | 回答阻塞任务提出的问题：弹出输入框由你作答，回答交给该任务后它继续 |
| `/flow unblock <任务> ["<回答>"] [--attempts N]` | 解除阻塞，任务回到 ready（没有交互界面时用它回答） |
| `/flow gate` | 闸门失败并修复后重跑闸门 |
| `/flow rules [apply [all\|<草案文件>...]]` | 查看或应用架构师提出的规则与命令草案（`docs/rules-draft/`）；由程序写入 `rules/` 与 `workflow.yaml` 并提交 |
| `/flow abort [--yes]` | 中止当前修复或流程（集成分支保留，主分支不受影响） |
| `/flow resume` | 会话丢失后恢复，并进入调度模式 |
| `/flow off` | 退出调度模式，恢复原来的模型与工具（流程状态不变） |
| `/flow doctor [--fix]` | 状态完整性与前置条件检查；`--fix` 清理残留 worktree 与提示文件 |
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

高层阶段与底层阶段的对应写在 `workflow.yaml` 每个阶段的 `phase` 字段（discovery、planning、execution、acceptance），可以按需调整。pi-flow 只在进入新阶段、出现需要你处理的事、任务第一次未通过、流程结束时主动提醒你。

开始流程或执行 `/flow resume` 后，当前会话进入**调度模式**：会话切换到你在 `/flow-config` 中为 orchestrator 设置的模型，只能查看状态、派发任务和等待结果，不能自己改代码；每轮开头会看到"当前状态与唯一允许的下一步"。流程结束、中止或执行 `/flow off` 后恢复原来的模型与工具。普通的 pi 会话不受影响。

---

## 项目里会多出什么

```
workflow.yaml        命令、并发与失败上限、模型档位、阶段、scope 与可写范围、角色与工具（只有你修改）
rules/               按模块注入的规则（只有你修改）
docs/                PRD、ARCHITECTURE、DESIGN、adr/、contracts/、features/、research/
AGENTS.md            极简说明
.flow/               运行时状态（程序维护，纳入 git，状态提交以 flow-state: 开头）
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
