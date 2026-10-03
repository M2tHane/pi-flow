# pi-flow 开发笔记

## 已验证版本号

| 组件 | 版本 | 来源 / 说明 |
|---|---|---|
| Node | 24.18.0 | 本机；package.json 要求 >=22。测试直接用 Node 原生 TS 类型剥离运行（要求 erasable syntax，不用参数属性、enum、namespace） |
| Pi | `@earendil-works/pi-coding-agent` **1.0.0**（2026-10-02 用户由 0.99.2 升级，以此为准；见第 86 条） | 旧包名 `@mariozechner/pi-coding-agent` 停在 0.73.1 |
| typebox | 1.3.27（devDependency，与 Pi 0.99.2 内置版本一致） | Pi `docs/packages.md`：typebox 属于 Pi 内置核心包，作为 `peerDependencies: "*"` 声明，不打包 |
| proper-lockfile | 4.1.2 | 与 Pi 自身依赖同版本；npm 官方包，作者 moxystudio；用途：`.flow/` 跨进程文件锁 |
| minimatch | 10.2.6 | 与 Pi 自身依赖同版本；isaacs 维护；用途：glob 匹配 |
| yaml | 2.9.0 | 与 Pi 自身依赖同版本；eemeli 维护；用途：解析 workflow.yaml 并定位行号 |
| typescript | 5.9.3 | devDependency，仅 typecheck |

依赖选择理由：上述运行时依赖均是 Pi 本身已使用的库，版本对齐，装 pi-flow 不会引入新的供应链来源。测试框架用 Node 内置 `node:test`，不另装。

## M0：Pi API 矩阵（Pi 0.99.2 核实；1.0.0 中接口未变）

核实方式：**实测**＝在 playground 中用真实 pi 进程运行（探针在 `playground/probes/`，假模型在 `test/fixtures/fake-llm/`）；**源码**＝读 0.99.2 的 `.d.ts` / 源码或官方文档、示例。

| 能力 | 结论 | 核实 |
|---|---|---|
| 包名与安装 | `@earendil-works/pi-coding-agent`；`pi install npm:<pkg>`、本地路径、`-l` 写项目 `.pi/settings.json` | 源码（docs/packages.md） |
| package 清单 | `package.json` 的 `pi.extensions/skills/prompts/themes`；Pi 核心包放 `peerDependencies: "*"`；扩展 .ts 由 jiti 直接加载 | 源码；实测（-e 加载本仓库 .ts，能解析本仓库 node_modules 中的 yaml/minimatch，`typebox` 由 Pi 提供） |
| 注册斜杠命令与参数 | `pi.registerCommand(name, {description, getArgumentCompletions, handler(args, ctx)})`；`args` 是**原始字符串**，需自行拆分（`src/commands/args.ts`） | 实测 |
| 非交互运行命令 | `pi -p "/cmd args"` 直接执行扩展命令，不调用模型；`ctx.hasUI=false` | 实测 |
| 交互 UI | `ctx.ui.select/confirm/input/notify`；RPC 模式经 `extension_ui_request/response` 转发（`hasUI=true`, `mode="rpc"`）；json/print 无 UI | 实测（`test/e2e/rpc-driver.ts` 驱动 `/flow-config` 菜单） |
| 注册工具 | `pi.registerTool({name, label, description, parameters, execute(id, params, signal, onUpdate, ctx)})`，返回 `{content, details}` | 实测 |
| 拦截工具调用 | `pi.on('tool_call')` 返回 `{block: true, reason}`；reason 作为错误结果交给模型；handler 抛错按阻断处理 | 实测；源码；真实模型收到阻断原因后按指示停止、未换方式重试 |
| 多个 tool_call handler 的顺序 | **按扩展加载顺序执行；后面的 handler 看到前面修改过的 input，且不再校验**。guard 必须最后加载 | 实测（A 改参数，B 看到改后的值） |
| 动态启用工具 | `pi.setActiveTools(names)` 在 `session_start` 中调用即生效；请求里声明的工具随之收窄 | 实测 |
| 追加系统提示 | `before_agent_start` 中修改 `event.systemPromptOptions.appendSystemPrompt`，每轮请求都带上 | 实测 |
| 会话与每轮钩子 | `session_start`、`before_agent_start`、`turn_start/turn_end`、`agent_settled`、`session_shutdown` 等 | 源码；实测（session_start、before_agent_start、turn_end） |
| 子进程 | `pi --mode json -p --session-dir <留档目录>（原为 --no-session，见第 74 条） --no-extensions --no-skills --no-prompt-templates --no-context-files -e <ext>... --model provider/id --thinking <level> --tools a,b --append-system-prompt <file> "<prompt>"`；**stdin 必须关闭**（否则 -p 等待输入）；工作目录 = spawn 的 cwd；环境变量直接继承到工具执行 | 实测；官方 subagent 示例同此用法 |
| token 用量 | 每条 assistant `message_end.message.usage = {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`；`input` 不含缓存命中；同时给出 `provider`、`model`、`thinkingLevel`、`stopReason`、`errorMessage` | 实测（假模型；真实模型 Workbuddy/glm-5.3-flash：单轮 input 523/output 3；含工具调用的 3 轮合计 input 1736、output 67、cacheRead 768，缓存命中可计入） |
| 模型与思考级别 | 思考级别 `off/minimal/low/medium/high/xhigh/max`；`getSupportedThinkingLevels(model)`（pi-ai）给出每个模型支持的级别，例如 Workbuddy/glm-5.3-flash 只支持 `low/high/xhigh` | 实测 |
| 用户配置目录 | `getAgentDir()` = `~/.pi/agent`（`PI_CODING_AGENT_DIR` 可覆盖）；官方 preset 示例把全局配置放在这里，项目配置放在 `<cwd>/.pi/` | 实测；源码 |
| 内置工具参数 | `read{path}`、`write{path,content}`、`edit{path,edits[]}`、`bash{command}`、`grep{pattern,path?,glob?}`、`find{pattern,path?}`、`ls{path?}`；另有 `powershell` | 源码 |
| codemode（0.99 内置） | `-e builtin:codemode` 在 `--no-extensions` 下显式加载；`--tools` 中列出 `codemode` 即启用；脚本里的 `tools.<名称>()` 只能调用已启用的工具，且每个调用都经过 `tool_call` 处理函数（guard 拦截、计违规），被拦时脚本以 `Script failed` 结束；`bash` 在脚本中返回 `{ output, exit_code, … }` | 实测（docs/cli.md、extensions.md；假模型探针与端到端测试） |
| 路径解析 | Unicode 空格归一、去掉 `@` 前缀、展开 `~`、`file://`；guard 按同样规则解析 | 源码 |

### 第三方插件（只下载 tarball 读源码，未安装、未执行）

| 插件 | 版本 | 来源 | 结论 |
|---|---|---|---|
| `@bacnh85/pi-serena` | 0.9.20 | github.com/bacnh85/pi-extensions，维护者 bacnh85 | 20 个工具。读：`serena_get_symbols_overview`、`find_symbol`、`find_referencing_symbols`、`search_for_pattern`、`find_declaration`、`find_implementations`、`get_diagnostics_for_file`。编辑：`replace_symbol_body`、`insert_before_symbol`、`insert_after_symbol`、`safe_delete_symbol`、`replace_content`、`rename_symbol`。其他：`status`、`list_tools`、`restart_language_server`、`restart_worker`、`get_current_config`、`check_onboarding_performed`、`onboarding`（均带 `serena_` 前缀）。文件参数是 `relative_path`（相对 serena 项目根），已在 guard 的 `DEFAULT_PATH_KEYS` 中 |
| `@vndv/pi-codegraph` | 0.1.10 | github.com/vndv/pi-codegraph | 8 个工具：`codegraph_search`、`callers`、`callees`、`impact`、`explore`、`node`、`status`、`files`；参数是符号或查询，不是文件路径 |
| `pi-web-access` | 0.35.0 | github.com/nicobailon/pi-web-access | 默认工具名 `web_search`、`fetch_content`、`get_search_content`、`source_check`（源码中可配置重命名） |
| `@tigorhutasuhut/pi-rules` | 0.6.0 | github.com/tigorlazuardi/pi-rules | 支持 `paths`（glob）frontmatter；`pi-rules:config` 补丁只能改 `enabled`、`sources`（目录来源）、`nudges`，**不能按角色或任务挑选规则** |
| `pi-subagents` | 0.74.0 | github.com/nicobailon/pi-subagents | 角色文件 frontmatter：`name`、`description`、`tools`（逗号分隔）、`model`（provider/id）、`thinking`、`systemPromptMode`、`inheritProjectContext`、`inheritSkills`、`skills`、`extensions` |

## 待确认

| 项 | 状态 |
|---|---|
| serena 的 `prepareArguments`（修正参数名）发生在 `tool_call` 之前还是之后 | 待确认；影响 guard 看到的参数名 |
| `tool_result` 层过滤敏感内容（grep -r 等递归读取可能读到 .env） | 未实现，列为后续改进 |
| 在 worktree 中 serena 的项目根是否等于子进程 cwd | 待 M3 实测 |

## 偏离记录

1. **新增转移 `merging -> queued_merge`（触发 `merge_requeue`）。** 第 18 节第 4 步要求恢复时把未完成的 merging 回滚到 queued_merge，但第 10 节转移表未列出。按"不在表中一律拒绝"的原则，必须显式加入。回滚时任务放回队首。
2. **"任一进行中状态"取 `in_progress`、`review`、`verifying`、`queued_merge`、`merging`。** `pending`、`ready` 不能被 `flow_block` 转 blocked（没有 run 在处理它们）。
3. **review 打回、verify 失败、合并后验证失败回到 `in_progress` 时清空租约**，表示"等待重新派发"：worktree 保留，由调度器重新派发一个新 run 继续在原 worktree 上工作（不经状态转移，只记 `dispatch` 事件）。M3 实现调度时按此处理。
4. **互斥判断范围扩大**：ready -> in_progress 时，不仅与 `in_progress` 任务比较，也与 `review`、`verifying`、`queued_merge`、`merging` 中的任务比较（它们的改动尚未合入，同时开工必然冲突）。
5. **`blocked -> ready`（unblock）清空 worktree、分支、base_sha**，与 ready 的定义一致（重新从集成分支 HEAD 建 worktree）。旧 worktree 的回收由调用方（M3 worktree 模块）负责；如需保留旧工作，由 `/flow unblock` 在 M5/M6 提供选项。
6. **任务文件新增字段**：`lease_expirations`（租约过期两次转 blocked）、`impl_run`（校验审查 run 不同于实施 run）、`blocked_reason`、`last_failure`（打回意见与失败原因，供下一次派发使用）、`merge_fix_for`、`conflict_files`（merge-fix 专用）。`lease` 结构为 `{run_id, role, token_hash, acquired_at, expires_at}`。
7. **run 记录新增 `violations` 与 `version` 字段**；`outcome` 允许 null（运行中）。
8. **阶段状态机**（M1 先实现，M6 使用）：`active -> awaiting_gate -> (awaiting_human ->) done`，自动闸门失败回 `active`，用户可 reject 回 `active` 或 abort。`approve`、`reject`、`abort` 只接受 actor=`human`。`done` 后由 `advanceStage` 进入下一阶段；最后一个阶段完成后清除 `active_flow`。
9. **契约锁定判定**：流程 `approvals` 含 `S1` 或 `F1` 时 `docs/contracts/**` 视为受保护路径。

10. **所有 subagent 角色隐式拥有 `flow_block`**（orchestrator 除外）。第 8 节模板的工具列表里没有它，但第 13、16 节要求"遇到歧义先 flow_block"。
11. **guard 比第 14 节更严的地方**：
    - `git push` 全部禁止（不止 `--force`），推送由引擎完成。
    - 额外禁止 `git fetch/pull/remote/config（写）/tag/clean/worktree/switch`，以及创建、删除分支。原因：worktree 与主仓库共享 refs 和 config。
    - 额外禁止 `scp`、`sftp`、`rmdir`、`eval`、`popd`。
    - 禁止打印环境变量（`env`、`printenv`、`export -p`、`set`），因为可能含密钥。
    - 命令名、重定向目标、`cd` 目标含变量或通配时一律阻断，无法解析的命令一律阻断。
    - 写工具（write、edit、serena 编辑）只能写当前 worktree；主工作区整体不可写，worktree 之外也不可写。bash 重定向到 worktree 之外的普通路径（如 `/tmp/x.log`）放行，主工作区与受保护路径阻断。
    - 写路径同时受角色 writes 与任务 writes（merge-fix 为冲突文件）约束，取两者交集。
    - 受保护路径与敏感路径按大小写不敏感匹配（macOS 默认文件系统大小写不敏感）；路径先解析符号链接。
12. **配置层的越权检查**（`config.ts`）：orchestrator 只能有 `read`、`flow_status`、`flow_dispatch`、`flow_wait`；`flow_approve` 只能给 reviewer，`flow_propose_tasks` 只能给 architect；没有可写范围的角色不能有写工具；`bash` 与 `bash_readonly` 不能同时声明；未知工具名报错。
13. **第 20 节第 6 条（主工作区出现未提交改动视为越权）推迟到 M5**，与 context-injector 每轮检查一起实现。
14. **配置里的 `read` 只对应 Pi 的 `read` 工具**，不隐含 `grep`、`find`、`ls`；需要时在角色工具列表中显式写出。

15. **新增 `/flow-config`（用户需求）**：为各角色设置模型与思考级别，保存到用户级 `~/.pi/agent/pi-flow.json`。**优先级：pi-flow.json > workflow.yaml 的档位**。`workflow.yaml` 的 `roles.<role>.thinking` 现在按思考级别枚举校验。设置时只允许选 `modelRegistry.getAvailable()` 中的模型，以及该模型支持的思考级别。
16. **规则注入不经 pi-rules**：pi-rules 无法按角色或任务挑选规则；写入 worktree 的 `.pi/rules/` 又会出现在 diff 中并碰到受保护路径。改为由 prompt-assembler 按任务 scopes 选出规则文件，经 `--append-system-prompt` 注入。子进程不加载 pi-rules（`--no-extensions`，只用 `-e` 显式加载 pi-flow 自己的扩展与所需插件，guard 最后）。
17. **`serena_rename_symbol`、`serena_onboarding`、`serena_restart_*` 不分配给任何角色**：rename 会改动所有引用处，guard 只能看到一个 `relative_path`。
18. **角色文件的模型档位用 `tier:` 字段**，不用 pi-subagents 的 `model:`（后者是 provider/id），避免语义冲突。
19. **测试用假模型**：`test/fixtures/fake-llm/` 是 OpenAI 兼容的本地流式服务，按脚本返回文本或工具调用，并记录每次请求的系统提示与工具声明；通过 `registerProvider` 注册为 `fakellm/<脚本名>`。端到端测试走 Pi 的真实 provider 链路，不依赖真实模型。

20. **新增转移 `run_failed`**（`in_progress→in_progress`、`review→review`）：子进程未提交或未给出审查结论就退出（崩溃、模型放弃、连接失败）时，清空租约并计一次失败，达上限转 blocked。第 10 节未覆盖这一情况；不计数会导致无限重派。
21. **guard 允许 `git checkout <提交> -- <文件>`**：提交被拒后，越界文件已进入快照提交，需要按 base_sha 恢复；该形式只恢复文件、不切换分支。新增文件用 `git rm`。
22. **并发上限只计实施 run（in_progress）**，审查 run 与 verify 不占名额。
23. **程序步骤自动执行**：提交后自动派审查、审查通过后自动 verify、被打回或失败后自动重新派发实施（受 attempts 上限约束）。orchestrator 的 `flow_dispatch` 只接受 ready 任务。
24. **`/flow next` 在非交互模式（`pi -p`）下等待全部运行与程序步骤结束**再返回，否则进程退出会丢失后续步骤；交互模式立即返回。
25. **orchestrator 工具只在项目已有 `.flow/` 时注册**，不影响普通 pi 会话。orchestrator 会话的 guard、工具收窄与每轮注入在 M5/M6 实现。
26. **子进程加载第三方插件（serena、codegraph、web）尚未实现**：引擎预留 `extraExtensions(role)`，插件安装路径的解析放到 M6/M8；未加载的插件工具在 `--tools` 中被 Pi 忽略。
27. **状态提交落在主工作区当前分支**（通常是 main），前缀 `flow-state:`。单个任务走完一轮约 13 个状态提交；如嫌多，后续可改为按阶段合并提交（需同时调整完整性校验）。**已由第 79 条修订：改为提交到 `refs/pi-flow/state`。**

28. **merge-fix 的挂起方式**：字面上"原任务保持 merging"会一直占着唯一的合并名额，merge-fix 永远进不了合并，形成死锁。改为原任务状态仍是 merging，但让出名额，记入合并队列的 `suspended`。"同一时间只有一个 merging"指正在执行的合并。
29. **merge-fix 合入即代表原任务合入**：merge-fix 的 worktree 由程序准备，基线是集成分支 HEAD 加上原任务的改动，冲突文件里保留冲突标记；它的 writes 就是冲突文件。merge-fix 合入后，原任务随之转 done（沿 `merge_fix_for` 链递归处理）。merge-fix 最终 blocked 时，原任务也转 blocked。merge-fix 由程序直接派发，不等 `/flow next`，仍受并发与互斥约束。
30. **合并步骤补充**：
    - rebase 前先 squash 成单个提交，避免逐个提交重复冲突。
    - 合并后检查文件是否残留冲突标记。
    - 用 `update-ref` 带旧值快进集成分支（CAS）；期间集成分支被移动时，任务放回队首。
    - rebase 成功后把 base_sha 更新为集成分支 HEAD，保证后续的 diff 检查正确。
31. **只要冲突文件在 `docs/contracts/**`（不论是否已锁定）或受保护路径下，就转 blocked。**
32. **受影响测试**：用 `codegraph affected -p <主工作区> -j <改动文件>`（codegraph 1.6.0 已核实）。结果为空、未索引或出错时，退回全量 `test`。注意：索引建在主工作区（main 分支），可能看不到集成分支上的新文件，这正是结果为空时退回全量的理由。每次合并后执行 `codegraph sync -q`。
33. **有 `flow_submit` 的角色隐式拥有 `flow_claim`**：第 8 节模板对 architect、researcher、scout 漏写了它，而角色提示要求先 claim。
34. **`<项目>.worktrees/.runs/<run>/` 中的提示文件目前不自动清理**，便于排查问题；M5 的 `/flow doctor` 负责清理。

35. **会话启动时不自动执行恢复**，只做只读检查并提示执行 `/flow resume`。原因：恢复会终止残留子进程，如果另一个 pi 会话正在运行同一流程，会误杀它的子进程。为此新增**引擎锁**（`<项目>.worktrees/.engine.lock`，记录 pid）：同一项目同一时间只允许一个会话运行引擎；持有者进程退出后可以接管。
36. **未过期但已中断的租约**（最常见：用户关掉了 pi）按 `run_failed` 处理：保留 worktree，计一次失败，重新派发后在原 worktree 继续。第 18 节只规定了过期租约的处理。过期租约按规格处理：worktree 干净 → 回到 ready（回收 worktree）；有改动 → 由用户选择继续或丢弃，无界面时挂起，列入摘要。
37. **调度模式（orchestrator 模式）显式进入**：执行 `/flow resume`（M6 起还包括 `/flow-build`、`/flow-fix`）后，本会话：
    - 只启用 orchestrator 的工具（write、edit、bash 被移除，Pi 直接返回 "Tool not found"）；
    - 所有工具调用都经过 guard（read 只能读 `docs/`、`.flow/`）；
    - 每轮在系统提示末尾追加 orchestrator 角色提示与"状态 + 唯一允许的下一步"。

    普通 pi 会话不受影响（逃生口）。注意：主会话中如果加载了其他扩展，pi-flow 的 tool_call 处理函数未必最后执行（见 M0 矩阵）；主要防线是工具移除。
38. **主工作区越权检测按"轮"比较**：before_agent_start 时记录 `.flow/` 之外的未提交改动，agent_end 时比较，新出现的改动记为 violation 并提示。用户在两轮之间自己的改动不计；用户在 agent 运行期间同时手改文件，可能被误报（提示中已说明可以忽略）。
39. **`/flow init` 不生成 `.pi/settings.json`、不同步 `.pi/rules/`**：pi-flow 以本地路径或 npm 包安装，来源由用户决定；规则由 prompt-assembler 注入（见第 16 条），不经 pi-rules。
40. **`/flow doctor --fix` 只做安全清理**：删除未被任何任务引用的 worktree、已结束 run 的提示文件、`git worktree prune`；不修改 `.flow/` 状态。状态问题由 `/flow resume` 或用户处理。
41. **`flow_wait` 等待的任务已是 done 或 blocked 时立即返回**，避免空等到超时。

42. **设计阶段任务由程序生成**（S0、S1、F0、F1 各一个，角色 architect）：orchestrator 没有写工具，subagent 不能和用户对话。
    - 用户的描述写进任务的 handoff。
    - "访谈式，一次只问一个问题"：architect 用 `flow_block` 提一个问题，用户用 `/flow unblock <任务> "<回答>"` 回答，回答写入 handoff 后任务重新派发。
    - 新增 `/flow reject "<意见>"`：设计阶段的闸门可以打回，打回后生成修订任务。阶段状态机原本就有 human reject。
43. **任务提案先保存，批准后才落为任务**：`flow_propose_tasks` 写入 `flows/<id>/proposal.json`，批准前可重复提交覆盖。用户批准 S1/F1 闸门时，程序把提案重新编号（接在已有任务之后，依赖一起改写）并创建任务，同时锁定契约。提案报告（任务数、关键路径、并行宽度、硬依赖占比、"硬依赖可能用多了"）在等待批准时显示于 `flow_status`。
44. **阶段闸门由程序执行**：本阶段任务全部 done 后提交闸门。
    - S1/F1 必须有提案。
    - auto 命令在集成分支 HEAD 的临时 worktree 中执行，evidence 存为 `evidence/stage-<阶段>/gate-<命令>.log`。
    - 通过后：需要人工 → awaiting_human；否则自动进入下一阶段。**最后一个阶段一律需要人工**（随后合入主分支）。
    - 失败时不自动重跑（避免死循环），直到本阶段有任务状态变化；用户可用 `/flow gate` 手动重跑。
45. **合并后验证改为"任务 verify 中有的才跑"**：typecheck 只在任务 verify 含 typecheck 时运行；测试只在含 test 或 test_affected 时运行。否则新项目在 S2 建好脚手架之前，文档任务永远无法合并。
46. **最终合入**：`/flow approve` 批准最后一个阶段时，先把集成分支以 `--no-ff` 合入主分支，成功后才批准。
    - 主工作区在主分支上：要求 `.flow/` 之外没有未提交改动，直接在主工作区合入；否则在临时 worktree 中合入。
    - 冲突时中止合并并报告，阶段保持待批准。
    - 无 UI 时需要 `/flow approve --yes` 确认。
47. **技能由程序注入**：子进程以 `--no-skills` 运行，按任务阶段注入 SKILL.md 正文（S0 write-prd；S1/F1 design-contract、decompose-dag；F0 write-feature-spec），所有实施角色注入 write-handoff。注入内容排在规则之后，属于稳定前缀。
48. **流程标题即用户描述**（FlowFile 没有单独的描述字段）。

49. **fix 流程**：编号 `X-NNN`，单一阶段 `X1`，集成分支就是主分支，**不占用活动流程指针**。因此 build/feature 流程处于等待审批时也能修复（需用户确认），同一时间只允许一个未结束的修复。任务由程序按步骤创建并派发，不建 DAG。
50. **新增转移 `report`**（`in_progress → done`，只用于 `analysis` 任务）：scout 只读，没有 diff，不走审查与合并。它用 `flow_submit` 提交结构化 `findings`（位置、根因、影响文件、建议角色、是否改契约、预计文件数），程序据此决定后续步骤。
51. **新增转移 `repro_confirmed`**（`verifying → done`，只用于 fix 中的复现测试）：审查通过后，程序在复现测试的 worktree 中运行 verify，**要求失败**；如果通过，说明测试没有复现问题，按 verify_fail 打回。复现测试不单独合入，避免主分支变红；修复任务从复现测试的分支末端开始，合入时一并带上。
52. **升级判断**：满足以下任一条件时，修复暂停并等待用户决定，提示"建议改用 /flow-build --feature"：
    - 需要改契约；
    - 预计改动文件数超过 `fix_max_files`；
    - 没有角色的可写范围覆盖影响文件。

    `/flow approve` 表示仍按修复处理（记录一条 approval 事件），新增的 `/flow abort` 表示中止。
53. **修复角色的选择**：采用 scout 建议的角色，前提是它的可写范围覆盖全部影响文件；否则选第一个覆盖得了的实施角色。修复任务的 writes 就是影响文件。
54. **fix 合入主分支**：主分支在主工作区检出时（状态提交也一直在推进它），在主工作区用 `cherry-pick` 应用；如果改动文件在主工作区有未提交修改，则转 blocked。主分支未检出时，用 update-ref 快进。提交信息为 `[X-NNN/T-xxx] fix: <描述>`。
55. **fix 日志** `.flow/fixes/<日期>-<序号>.md`：问题、根因、改动（`git show --stat`）、验证、成本（合计与按角色），由引擎写入并登记哈希。
56. **`/flow status --cost`**：按流程、阶段、角色、模型、任务汇总 token 与耗时，并列出返工最多的任务（审查打回、验证失败、合并失败、运行失败，数据来自事件日志）和修复日志。token 字段为 null 的运行不估算，单独计数。

57. **第三方插件在子进程中加载**（第 26 条已落实）：按角色用到的工具组（serena_read、serena_edit → pi-serena；codegraph → pi-codegraph；web → pi-web-access），先找项目级 `.pi/npm/node_modules`，再找用户级 `~/.pi/agent/npm/node_modules`，用 `-e <包根目录>` 加载，放在 guard 扩展之前。已实测：`-e` 可以指向包根目录；pi-web-access 的工具注册后默认不激活，`setActiveTools` 可以激活。
58. **插件产物写入仓库本地 `info/exclude`**（`.serena/`、`.codegraph/`）：真实模型冒烟中发现，pi-serena 在 worktree 根目录生成 `.serena/project.yml`，导致提交被判越界。info/exclude 不被跟踪，所有 worktree 共享，也不改用户的 `.gitignore`。
59. **并发重复派发的修复**：两个 run 同时结束时，两个 `pump` 可能同时给同一任务派审查，后一个租约会覆盖前一个。修复分两层：
    - 新增 `acquireLease`，在事务内检查租约为空才写入；
    - `pump` 按流程串行执行。
60. **`/flow approve` 与 `/flow unblock` 之后由程序直接派发 ready 任务**（等同于 `/flow next`），不必再输入一条命令。
61. **假模型脚本支持 variants**：按第一条用户消息中的关键字选择步骤，同一角色可以在不同阶段走不同脚本（演示用）。

62. **对外只呈现高层阶段**（用户需求，2026-10-01）：需求 → 规划 → 实施 → 验收 → 完成。
    - `workflow.yaml` 的阶段新增可选字段 `phase`（discovery、planning、execution、acceptance），缺省按阶段 id 推断；配置校验要求 phase 只能前进。
    - fix 流程按任务推进映射：定位 = 需求，复现测试 = 规划，修复 = 实施，审查验证合入 = 验收。
    - `/flow status` 默认是精简视图：需要你处理的事在最上面；之后是阶段条、阶段目标、本阶段进度、正在进行（状态翻成人话，`queued_merge` 与 `merging` 合并为"合入中"；重试显示第几次和上次失败的原因）、阻塞。原来的完整视图移到 `--detail`。
    - 最后一个阶段叫"验收"而不叫 Review，避免与代码审查混淆。"目标"只用流程描述与阶段说明，不编造模块分组。
    - orchestrator 的 `flow_status` 工具仍返回完整信息（模型需要细节来派发）。
    - 主动通知只在四种情况出现：进入新阶段、出现需要你处理的事、任务第一次未通过、流程结束。
    - 底层状态机、调度与合并不变。

63. **调度模式切换主会话模型**：进入调度（或访谈）模式时记住当前模型、思考级别与工具，切到 `/flow-config` 中 orchestrator 的设置（不可用或没有凭据时提示并保留）。新增 `/flow off`；没有进行中的流程与修复时自动退出并恢复。
64. **需求访谈（开流程之前）**：`/flow-build`、`--feature`、`/flow-fix` 默认先访谈。
    - 主会话换上 `agents/interviewer.md` 提示，一次一问并给出建议答案。
    - 可用工具只有 `read`（同 orchestrator，只能读 `docs/`、`.flow/`）和新增的 `flow_brief`。`flow_brief` 总是注册，但 `defaultActive: false`。
    - 摘要由程序保存在 `.flow/brief.json`（同一时间一份，登记哈希）。清单完整后，**用户**执行 `--confirm` 才开流程；摘要复制到 `flows/<id>/brief.md`，作为 S0/F0 设计任务与 fix 中 scout 的输入。
    - `--direct "<描述>"` 与 `--from <文件>` 跳过访谈；`--cancel` 放弃。
    - 删除提示模板 `/feature-kickoff`、`/fix-brief`，已被访谈取代。
65. **`/flow answer`**：阻塞任务的问题由用户在输入框中亲手作答（`ctx.ui.input`），不经模型转述，避免主会话模型自问自答绕过"只有人能解除阻塞"。无界面时提示用 `/flow unblock <任务> "<回答>"`。状态视图中阻塞项的建议命令改为 `/flow answer <任务>`。

66. **规则与命令草案**：S1/F1 的 architect 针对选定技术栈在 `docs/rules-draft/` 写草案。
    - `<名称>.md` 与 `rules/` 同名表示替换，新名字表示新增；`commands.yaml` 列出要改的命令。
    - 草案随文档合入集成分支。用户批准 S1/F1 时，若有草案就弹出选择（全部应用、逐个选择、暂不应用），也可以随时用 `/flow rules apply`；无界面时只提示，不自动应用。
    - 由**程序**写入主工作区的 `rules/` 与 `workflow.yaml` 并单独提交：`workflow.yaml` 用 yaml 文档 API 修改以保留注释，修改后整体校验，不通过则拒绝；运行中引擎的命令配置同步更新。
    - "规则只有用户能改"保持成立：agent 只能写草案，应用要用户选择。规则变化会让提示缓存失效一次，输出中会提醒。

67. **会话中断不计入失败预算**（修订第 36 条）：新增转移 `run_interrupted`（`in_progress → in_progress`、`review → review`），清空租约、保留 worktree，只增加任务的 `interruptions` 计数，不增加 attempts；连续中断达到 `MAX_INTERRUPTIONS = 5` 转 blocked。`resume` 处理"租约未过期但 run 已中断"以及审查中的任务时用它。租约真正过期仍按规格 attempts 加 1；同一会话内子进程自己异常退出（模型报错、连接失败）仍按 `run_failed` 计失败。
68. **重新派发时告知已有改动**：实施任务的 worktree 相对 base_sha 有改动、或有未提交文件时，提示中加一节"工作区已有的改动"（`git diff --stat <base_sha>` 与 `git status`），说明这是之前运行留下的工作，要先检查再决定继续还是重写。subagent 的对话不恢复（子进程以 `--no-session` 运行）；是否改为持久化会话并用 `--session` 续跑，留待实测后再定。

69. **先行验收测试必须先失败（build/feature，第二轮 A 项）**：
    - 范围：kind=test 且有非 test 任务硬依赖它（`dag.ts` 的 `isLeadingTest`）。没有下游实现任务的测试（S4 端到端、回归）照常 verify 通过后合并。
    - 审查通过后复用 fix 的 `repro_confirmed`：只运行 verify 中的测试类命令（test、test_affected、e2e；都没有时运行全部），**全部失败**才确认，确认后转 done、不进合并队列；有命令通过则按 verify_fail 打回，原因"验收测试没有失败"。typecheck、lint 不参与判断（实现之前它们未必失败）。fix 的复现测试 verify 只有 test，行为不变。
    - 承载者（`carrierOf`）：非 test 硬依赖方中不（传递）依赖其他依赖方、编号最小的那个。`flow_propose_tasks` 提交时规范化（`normalizeLeadingTests`）：其余硬依赖该测试的任务改为硬依赖承载者，并在返回中列出调整；一个任务承载多个先行测试、先行测试没有 verify 均报错。
    - 承载者的 worktree 从测试分支末端建立（`createTaskWorktree` 的 `from`），base_sha 即测试分支末端，测试文件不计入它的 diff；提示中说明"已在分支中的验收测试"，先行测试自己的提示说明"应当失败"。
    - 合并：基线之下有未合入提交（承载的测试、fix 的复现测试）时，squash 成**两个提交**（先测试、后实现），一起 rebase、合并后验证，再一次快进；rebase 后 base_sha 指向 rebase 后的测试提交。修正了一个原有隐患：此前合并后验证失败、重新提交时，diff 会把测试文件算进来而被判越界（fix 模式同样受影响）。fix 在主工作区 cherry-pick 改为区间 `integHead..sha`，fix 日志的改动统计改用合并前后区间（排除 `.flow/`）。
    - 承载者合入后回收测试任务的 worktree 与分支。
    - 已知局限：承载者最终 blocked 时，测试也不会进入集成分支；测试因自身写错（而非实现缺失）而失败也会被确认，靠审查把关。
70. **pump 循环以最新任务状态为准**：循环体中有 await，开头取得的任务列表可能过时；曾出现 verify 刚结束、标记已清除，又按旧状态对同一任务启动第二次 verify 的竞态（`merging -> queued_merge` 被拒）。现在每个任务处理前重新读取。

71. **上游 handoff 传给下游（第二轮 B）**：实施提示中新增"上游任务的 handoff"一节，放在任务说明之后、本任务 handoff 之前。来源是硬依赖与软依赖的任务，每个上游取最近 800 字（从完整的行开始），合计不超过 4000 字。没有上游或上游都没有 handoff 时不出现。审查提示不带这一节。
72. **项目级知识库（第二轮 C）**：
    - 存储 `.flow/knowledge.json`（schema `knowledge`，登记哈希与版本，经 StateStore 事务写入）。条目 `K-NNN`：类别（convention、pitfall、decision、environment、dependency）、内容（≤500 字）、适用 scopes 与路径 glob（都为空表示全局）、来源（agent、review、merge、human，含流程、任务、run、角色）、状态（candidate、active、retired、promoted）、提升后的草案文件。
    - 新工具 `flow_learn`：除 orchestrator 外的 subagent 角色隐式拥有（同 `flow_block`，第 10 条）。校验类别、长度、scope 存在、路径为仓库内相对路径且不指向 `.flow/`、`.git/`；与未废弃条目内容相同（忽略空白与标点）则拒绝；每个 run 最多 3 条。**提交即生效**（用户选择）。
    - 程序提炼候选（用户选择"提炼为候选，需确认"）：审查打回（`flow_approve` reject）与合并后验证失败时，截取原文生成 candidate（不调用模型）；"需要你处理"中提示；`/flow knowledge accept`（可改写）后生效。
    - 注入：派发时选出生效中且适用于任务的条目（全局、scope 相交、路径与 writes/inputs 重叠），放在系统提示末尾（技能之后），按编号排序；超过 40 条或 6000 字时保留最近的。声明"不是规则，与规则冲突时以规则为准"。
    - 管理：`/flow knowledge` 列出与搜索、`accept`、`retire`、`promote`。`promote` 把条目追加到 `docs/rules-draft/<规则名>.md`（默认取条目共同 scope 的第一个规则文件，否则 global；以现有规则内容为底稿）并在主工作区当前分支提交；`/flow rules` 现在同时读取主分支与当前流程集成分支上的草案（同名以集成分支为准），没有进行中的流程也能用。应用后引用该草案的条目标为 promoted。"规则只有用户能改"不变。
    - 展示：`/flow status --detail` 列出最近 5 条；访谈者提示中说明可读 `.flow/knowledge.json`。
    - 已知局限：每个 run 的条数检查在事务外读取，同一 run 并发提交时可能多出一条；知识与规则是否矛盾无法由程序判断，靠"以规则为准"的声明和用户废弃。

73. **租约心跳续租（第二轮 D）**：子进程每次工具调用经过 guard 前（`SubagentRuntime.heartbeat`），若租约剩余不足 `lease_minutes` 的一半，经 `StateStore.renewLease` 把到期时间延长到"现在 + lease_minutes"。续租在事务内校验 run 与 token 哈希、租约未过期、任务处于 in_progress/review，只延长不缩短，记一条 `note` 事件"续租"。一个 45 分钟的租约最多每 22.5 分钟产生一次状态提交。长时间没有任何工具调用（例如模型长时间思考或卡住）的 run 仍按时被租约看守终止。续租失败不影响本次工具调用的判定。
74. **子进程会话留档（第二轮 E）**：子进程不再以 `--no-session` 运行，改为 `--session-dir <项目>.worktrees/.sessions/<run>/`（Pi 0.99.2 `pi --help` 与 docs/sessions.md 核实；真实 pi 子进程测试已验证会话文件写入该目录）。
    - run 记录新增 `session_dir`（派发时）与 `session_file`（结束时在目录内递归找最新的 `.jsonl`）。
    - `/flow run [<run_id>]`：列出最近的运行，或显示一次运行的基本信息、工具调用摘要（参数截断，出错的工具结果标 ✗）与最后一条 assistant 文本，按 Pi 的会话格式（docs/session-format.md）解析，无法解析的行跳过。
    - `/flow doctor --fix` 按 `limits.session_retention_days`（新增可选配置，默认 14）清理：已结束且结束时间早于保留期的 run；没有 run 记录、修改时间早于保留期的目录。运行中的不清理。不加 `--fix` 时只提醒。
    - 会话文件含提示、模型回复、工具参数与输出，可能包含代码与命令输出；它在项目目录之外，不进 git。续跑原对话（第 68 条）本轮不做。

75. **集成分支在阶段边界同步主分支（第二轮 F）**：
    - 时机：引擎 pump 开头，build/feature 流程的当前阶段 active 且本阶段还没同步过（`flow.sync.stage` 不等于当前阶段）时执行；`/flow sync` 手动执行。审批后 `/flow approve` 先 pump 再派发，所以新阶段的任务在同步之后开工。
    - 串行：`MergeQueue.syncMain` 与合并共用进程内互斥，且要求合并队列没有 merging；忙时返回 null，下次 pump 再试。没有作为合并队列中的特殊条目（避免改动队列 schema 与转移表），效果相同。
    - 主分支相对分叉点只有 `.flow/` 的改动时视为已同步（主分支上始终有状态提交，否则每个阶段都会产生一个只含状态的合并提交）。真正合并时 `.flow/` 随之进入集成分支；它的冲突一律取主分支版本。集成分支上的 `.flow/` 拷贝不被任何逻辑读取。
    - 无冲突：在临时 worktree 中 `merge --no-ff` 主分支，CAS 快进集成分支。不做合并后验证（主分支与集成分支各自是绿的，语义冲突由下一个阶段闸门与后续合并的验证发现）。
    - 冲突分类：涉及 `docs/contracts/**` 或受保护路径，或没有角色的可写范围覆盖全部冲突文件 → `flow.sync.status = conflict`：暂停派发新任务（`next` 返回空、`dispatch` 拒绝非 merge-fix 的 ready 任务），在"需要你处理"中提示；用户在集成分支上手动合并后 `/flow sync` 校验并恢复。否则 → 提交含冲突标记的合并提交（保留两个父提交），生成 merge-fix 任务（新字段 `sync_main`，角色优先取写过这些文件的已完成任务的角色，verify 取这些任务 verify 的并集），`flow.sync.status = fixing`。
    - 同步 merge-fix 的合入（`mergeSyncFix`）：在合并提交之上 squash 修复为一个提交；集成分支期间有新提交时再 merge 进来（冲突则 blocked 交给用户）；检查冲突标记与合并后验证后 CAS 快进。不 rebase、不整体 squash，保留与主分支的合并关系，最终合入主分支时不再冲突。
    - 设计阶段生成任务时不把同步产生的 merge-fix 当作本阶段已有任务。
    - 新增 `flow.sync`（stage、status、main_sha、at、task、files、reason）与任务字段 `sync_main`。

76. **执行中修订计划（第二轮 G）**：
    - 发起：orchestrator 新工具 `flow_replan(reason)`（隐式拥有，转达用户原话，用户主要通过主 agent 沟通）或 `/flow replan "<原因>"`。只在 build/feature 的非设计阶段可用；设计阶段仍用 `/flow reject`。阶段等待审批时只有用户（`/flow replan`）能发起，程序把阶段经 `reject` 重新打开。同一时间只允许一个未结束的修订。
    - 修订任务：kind=analysis、角色 architect、writes 为空（guard 下不能写任何文件）、新字段 `replan`（原因），handoff 附现有任务一览与阻塞原因；注入技能 `revise-plan` 与 `decompose-dag`。它经 `report` 直接完成（`report` 的检查放宽为 findings 或 replan），没有审查与合并。
    - 新工具 `flow_revise_plan`（architect 独占；有 `flow_propose_tasks` 的角色隐式拥有）：`add`（临时编号 N-001 起，依赖可指向 T-xxx 或 N-xxx）、`rewire`（整体替换未开始任务的依赖，只能指向现有任务）、`cancel`（未开始的任务，写原因）。保存为 `flows/<id>/revision.json`（schema `revision`，登记哈希）。校验（`core/revision.ts` 的 `checkRevision`）：被改动的任务必须是 pending/ready 且不是程序生成的；新增任务的阶段不早于当前阶段且不是设计阶段；剩余任务不得依赖被取消的任务；合并后的 DAG 用 `validateDag` 校验，只报告修订引入的新错误；先行验收测试按第 69 条规范化（必要时把现有未开始任务的依赖调整并入 rewire）。
    - 闸门：修订待批准期间不提交阶段闸门；orchestrator 每轮注入"等待用户批准"；"需要你处理"列出修订。`/flow approve` 有待批准修订时先处理修订：按当前任务重新校验（批准前状态变化则拒绝并提示打回重做），重新编号，在一个事务内新增任务、改依赖、取消任务（`applyRevision`）。`/flow reject "<意见>"` 有待批准修订时打回修订并生成新的修订任务（原因附上意见与上一版）。
    - 修订待批准期间，被点名调整依赖或取消的任务暂停派发（`heldByRevision`：`next`、`dispatch`、orchestrator 下一步都跳过），批准或打回后恢复，避免批准时它们已经开始（用户选择）。起草期间开始的任务由 `flow_revise_plan` 的校验拦下，architect 当场修正。
    - **新增任务状态 `cancelled` 与转移 `cancel`（pending/ready → cancelled）**：只接受 actor=human（即用户批准的修订）。阶段完成、闸门、orchestrator 下一步的判断改为"done 或 cancelled 视为已结束"；进度不计已取消的任务。

77. **按风险审查（第二轮 H）**：`workflow.yaml` 新增可选 `review`（`max_parallel`、`low_risk.{enabled, mode, model, max_files, max_lines, paths, exclude}`），默认保守：启用、mode=cheap、model=cheap 档、3 个文件、100 行、路径限文档与测试。高风险条件：merge-fix、先行验收测试、之前失败过（attempts>0）、拿不到改动、超限、涉及契约/shared scope/exclude、有文档测试之外的改动（`cost-control.ts` 的 `assessRisk`，改动来自 `git diff --numstat base_sha HEAD`）。cheap 模式派审查时换便宜模型（`resolveModelRef`：档位或 provider/model，占位符视为取不到，回退审查者原模型），run 记 `review_mode`。skip 模式由引擎执行新增转移 **`review_skip`（review → verifying，只接受 actor=engine 且 low_risk、无审查 run）**，随后自动 verify。审查 run 的并发上限默认等于 `limits.max_parallel`，按本进程在跑的审查 run 计数，满时等下一次 pump。
78. **失败后升级模型与预算（第二轮 I）**：
    - 升级：`escalation.{enabled, after_failures}`（默认启用、2）。实施派发时 `attempts >= after_failures` 换成升级模型（`escalationModel`）：pi-flow.json 的 `escalate_model`（`/flow-config escalate` 或交互菜单）> `roles.<role>.escalate_model`（档位或 provider/model，配置校验档位存在）> 角色档位的上一档；取不到或与原模型相同则不升级。run 记 `escalated: true`。只作用于实施，不作用于审查。
    - 金额：`UsageAccumulator` 累加 `usage.cost.total`，run 新增 `cost`（拿不到为 null，不估算）。
    - 预算：`budget.{tokens, cost, warn_ratio}`，流程级覆盖 `flow.budget`（`/flow budget tokens|cost <数值>`，仅用户）。tokens 计输入 + 输出（不含缓存读写）。用到 warn_ratio（默认 0.8）时"需要你处理"提醒；超出后 `next` 返回空、`dispatch` 拒绝 ready 任务（merge-fix 除外），orchestrator 下一步改为向用户报告；返工、审查、verify 与合并照常，避免任务卡在半途。`/flow status --cost` 附预算用量。fix 流程同样受预算约束。

79. **状态存储的性能与提交位置（第二轮 J）**（用户要求连续完成，不再中途确认，方案由实现者决定并记录于此）：
    - 事务前的一致性校验只读事件日志最后一条（`readLastEvent`，从文件尾部反向读，校验该条的 schema 与内容哈希），与 state.json 的 head/version 比较；重放事务日志时取末尾序号、检查末行是否完整也只读尾部。完整的哈希链、序号、登记文件校验仍在 `verifyIntegrity`（resume、doctor）中做。
    - 读缓存：`readJsonRel` 按 inode + mtime + 大小缓存解析结果，返回深拷贝（写入都是临时文件 + rename，inode 必变）；`readEvents` 用 `EventCache` 增量解析（日志只追加，缓存字节偏移；inode 变化或文件变短时整体重读）。
    - 通知检测节流：引擎 onChange 后最多每 300 ms 做一次快照比较（尾随执行一次，变化不会漏掉）。
    - **状态提交移出分支历史**：`commitStateRef` 用独立索引文件（`<git-dir>/pi-flow-state.index`）read-tree 上一次状态提交 → `add -A -f .flow`（排除 `.lock`、`tx.json`、`*.tmp`）→ write-tree → commit-tree → `update-ref refs/pi-flow/state <新> <旧>`。仍满足"每次状态转移都 git commit"（原始需求第 2 节第 4 条），只是提交在专用引用上，不进入任何分支、默认不随 push 带出（需要时 `git push origin refs/pi-flow/state`）。并发安全依赖事务的文件锁（子进程的工具调用写状态也持有同一把锁）。
    - 每次状态提交的 git 进程数控制在 4 个（add、write-tree、commit-tree、update-ref）：公共 git 目录按根目录缓存；引用直接读松散引用文件（被 gc 打包后退回 rev-parse）；索引旁记一个标记文件写明它对应的状态提交，相同则跳过 read-tree。残留的索引锁与引用锁（来自被强杀的进程）在持有 `.flow/` 文件锁时直接清除。最初的实现每次约 9 个 git 进程，全量测试下与其他测试并发时，真实 pi 子进程首次启动被拖慢到 30–60 秒，崩溃恢复测试超时；优化后全量端到端从 534 秒降到 322 秒，全部通过。
    - 端到端测试中启动真实 pi 的进程设置 `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`（测试不需要联网；排查中发现网络不通时 `pi --list-models` 会卡约 60 秒）。生产环境的子进程未设置。
    - `.flow/` 写入仓库本地的 `info/exclude`（`/.flow/`），不改用户的 `.gitignore`，主工作区 `git status` 不再显示它，用户的 `git add -A` 也不会带上它。
    - 迁移：每个 StateStore 第一次提交前检查当前分支是否跟踪 `.flow/`；是则用临时索引从 HEAD 构造一个"删除 .flow/"的提交并 update-ref HEAD（不带上用户已暂存的其他改动；`git commit -- <路径>` 会重读工作区，不能用），再从真实索引中移除。之后新建的集成分支不再含 `.flow/`；迁移前建的集成分支仍含旧拷贝，合入主分支时随主分支的删除而删除，没有冲突。
    - 恢复与完整性校验不依赖 git 历史（依赖事件哈希链与登记哈希），不受影响。
    - 性能测试（`test/unit/state-store.test.ts`）：约 50 条事件与 2 万条事件时单次事务耗时相同（约 14 ms，不含 git）；改回整读日志后 2 万条时约 158 ms，测试失败。

80. **实时进度（第二轮 L）**：调度模式下用 `ctx.ui.setStatus('pi-flow', <一行>)` 显示（API 依据 Pi 0.99.2 `dist/core/extensions/types.d.ts` 的 `ExtensionUIContext.setStatus` 与 docs/tui.md，已在 `pi-api.d.ts` 补声明）。只在 `ctx.mode === 'tui'` 时设置；文字由 `status-view.ts` 的 `statusLine` 生成（流程、高层阶段、本阶段进度、最多 3 个进行中的任务、需要处理的事项数）。刷新挂在引擎 onChange 上，与通知检测共用 300 ms 节流；退出调度模式（含流程结束自动退出）时清除。没有用 `setWidget`：一行状态足够，不占编辑区。未在真实终端界面中自动化验证（测试环境没有 TUI），只有 `statusLine` 的单元测试。

81. **合并列车（第二轮 K）：测量后决定暂不实现**。测量脚本 `scripts/measure-merge.ts [任务数] [模拟验证秒数] [实施毫秒]`：20 个互不相关的小任务，fake-subagent（不调用模型），max_parallel=4，统计合并队列占用（merge_start → merge_done）与任务在队列中的等待（verify_pass → merge_start）。2026-10-01 本机结果：
    | 实施耗时 | 合并后验证 | 总耗时 | 合并队列占用 | 每次合并 | 队列平均等待 |
    |---|---|---|---|---|---|
    | 3 秒 | 约 0 秒 | 33.9 秒 | 15.3 秒（45%） | 0.77 秒 | 5.98 秒 |
    | 3 秒 | 2 秒 | 67.7 秒 | 49.1 秒（73%） | 2.45 秒 | 19.37 秒 |
    | 20 秒 | 约 0 秒 | 110.0 秒 | 8.3 秒（8%） | 0.41 秒 | 0.31 秒 |
    | 20 秒 | 10 秒 | 255.7 秒 | 207.6 秒（81%） | 10.38 秒 | 59.75 秒 |

    结论：合并本身（squash、rebase、快进）每次不到 1 秒；队列是否成为瓶颈只取决于"合并后验证耗时 × 任务数"与"实施耗时 ÷ 并发数"的大小关系：验证耗时超过 实施耗时 ÷ max_parallel 时队列开始积压。按真实模型冒烟的数据（实施 30 秒到数分钟、默认并发 2），只要合并后验证在半分钟左右以内就不是瓶颈；`test_affected`（codegraph 受影响测试）已在缩短这一项。合并列车（预先验证下一个任务、失败回退）会显著增加合并队列的状态与恢复路径的复杂度，在当前规模下收益不足，暂不实现。项目的测试集变慢（例如合并后验证超过 1 分钟且任务很多）时，先调大 `max_parallel` 不会缓解（瓶颈是串行验证），再考虑实现合并列车；届时可用上面的脚本复测。

82. **真实模型冒烟（2026-10-02）暴露的问题与修订**（高智力角色 architect、reviewer、orchestrator、scout 用 `openai-codex/gpt-6.1-sol`（high），实施角色用 `Workbuddy/glm-5.3-flash`（low），实施角色失败后升级到 gpt-6.1-sol）：
    - **临时目录**：glm 写测试时会建临时目录做实验（`cd /tmp`、在 worktree 里 `rm -rf .xxx`、`mv`），全部被 guard 拦下并计违规，三次即终止 run。新增每个 run 的临时目录 `<项目>.worktrees/.scratch/<run>/`（项目与 worktree 之外，run 结束后删除），提示中给出绝对路径；实施类角色可以 cd 进去、写入、rm、mv、cp。
    - **rm、mv、cp、rmdir 不再一律禁止**：作用于临时目录，或本任务 writes 内的文件时放行；worktree 中未被 git 跟踪的文件（之前运行留下的临时文件）可以 rm；其余（writes 之外被跟踪的文件、通配、变量、经 xargs 传参、没有文件参数）仍阻断。
    - **字面量变量代入**：同一条命令中先 `S=/abs/path` 再用 `$S/x`，guard 代入后校验（glm 常这样写）；含命令替换或未知变量的仍按无法校验阻断。
    - **只读角色试图运行 node**：scout 与 reviewer 都尝试跑测试被拦（计违规）。提示中写明不能运行 node、测试或构建命令，测试由程序在审查通过后运行；审查提示附上本任务验证输出（evidence）的绝对路径。
    - **scout 把测试文件列入影响文件**，修复任务因此往旧测试里加了重复用例。scout 提示改为只列业务代码。
    - **fix 合并的两个提交**中复现测试那个显示为"前置提交"：fix 的修复任务没有依赖，现在按"分支末端等于基线的 test 任务"找到复现测试，用它的编号与标题。
    - **验收标准不可测导致无休止打回**：architect 把"零第三方依赖"写进验收测试，glm 写了一个扫描源码的分词器，强模型审查连续三轮找出漏洞，任务失败三次转阻塞（第三次已升级为 gpt-6.1-sol，仍未通过）。修订：`decompose-dag` 技能写明约束类要求不写成验收测试；reviewer 提示要求只为不满足验收标准或明确缺陷打回，验收标准本身不合理时用 flow_block 交给用户改计划。
    - **阻塞的任务无法经计划修订处理**：只能取消 pending/ready 的任务，卡死的 blocked 任务会让阶段永远完不成。`cancel` 转移扩展为 pending/ready/blocked → cancelled（仍只接受用户批准的修订），批准后回收其 worktree；orchestrator 遇到阻塞时提示可以 flow_replan。
    - **调整依赖不能指向新增任务**：architect 只好把下游任务取消再新增替代任务。`rewire` 的依赖现在可以指向本次新增的 N-xxx，批准时改写为正式编号。
    - **审查者提问后被打回重新实施**：reviewer 按新提示用 flow_block 提出规则冲突（模板 `rules/backend.md` 要求 shared 错误类型，与架构师的契约冲突；冒烟脚本当时没有应用规则草案），用户回答后任务却回到 ready 重新实施。新增 `blocked_from` 字段与转移 `unblock`（blocked → review，只在审查中阻塞且 worktree 仍在时）：回答后回到审查。
    - **先行验收测试的范围过宽**：S4 的"package.json 无 dependencies"回归测试被 integration 任务硬依赖，被当成先行测试要求先失败，测试工程师只能 flow_block。先行验收测试改为只看 impl、infra 类任务的硬依赖；integration、doc 等依赖测试只表示先后顺序。
    - 冒烟结果：经一次计划修订（取消阻塞的 T-004 与两个下游、新增 5 个任务）后流程 S0→S5 完成并合入 main，13 个测试通过；39 次运行，输入 738k / 输出 80k / 缓存读 2.7M，约 59 分钟（含两次因上述问题阻塞后人工处理）。期间 S4 开始时把 main 上应用规则草案的提交同步进集成分支（F）。
    - 修订后复跑真实模型 fix：298 秒完成（第一次 397 秒），0 次违规；scout 只列业务代码，修复没有再改旧测试；main 上两个提交分别是 `[X-001/T-002] 复现测试：…` 与 `[X-001/T-003] fix: …`；5 次运行，输入 66k / 输出 2.8k。
    - 仍会触发违规的习惯：glm 仍偶尔 `cd /tmp`、`sed -i`；`max_violations_per_run` 默认 3，弱模型容易被终止。未改默认值。
    - 已确认工作正常：PRD 与架构质量（gpt）；先行验收测试先失败的检查；失败后升级模型（第三次实施的 run 标为 escalated、模型为 gpt-6.1-sol）；按风险审查（PRD 审查为 light）；计划修订由 architect 正确起草（取消、新增、依赖）；会话留档与 `summarizeSession` 用于排查；完整性校验通过。
    - 审查打回自动提炼的知识候选内容都是具体某次打回的细节（6 条），作为长期知识价值不高。用户决定改为默认不提炼：新增可选配置 `knowledge.auto_candidates`（默认 false），修订第 72 条的"程序提炼候选"。agent 主动的 flow_learn 不受影响。

83. **默认规则与违规上限（真实冒烟后，用户决定）**：
    - `limits.max_violations_per_run` 模板默认值 3 → 5（弱模型的无害误操作较多）。
    - 默认规则改为与技术栈无关，参考了用户提供的另一个项目的规则（`/Users/dade/Documents/Code/program/rules`），只取通用部分：不静默吞异常、外部调用处理失败并带上下文、只做需求范围内的功能、文件行数阈值（800 关注、1500 必拆）、文件按用途归位、不建空壳与总结文档、UTF-8 与乱码处理（global）；分层、参数绑定、避免 N+1、业务异常向上抛、不存在与无权限统一表现、REST 路径命名（backend）；迁移幂等与分批、布尔与时间列命名、避开保留字（database）；加载中/出错/空数据三态、不用 any（frontend）；新增 `rules/docs.md`（docs scope）。该项目特有的约定（多租户、雪花 ID、禁止外键、Python/FastAPI 等）没有照搬。
    - 冒烟中引起冲突的条目（"错误统一使用 shared 中定义的错误类型"、"显式声明外键约束"）改为"以契约与 ARCHITECTURE.md 为准"；global 新增"通用规则与已批准的契约冲突时 flow_block 请用户决定"。`design-contract` 技能要求架构师把错误类型、主键生成、外键策略、响应格式写进 ARCHITECTURE.md 与规则草案。
    - S1/F1 批准时的规则草案选项改为"全部应用（推荐）"，并说明不应用的后果。

84. **新增技能 `write-rules`**（S1、F1 注入给 architect）：规则草案的写法从 `design-contract` 中独立出来并展开——替换与新增的区别、F1 只改相关条目、覆盖清单（技术栈、目录分层、数据访问、错误处理、命名、数据模型、接口、测试、明确禁止）、每条可检查、关键条目给正确与错误写法对照、按重要性排列、文件末尾附审查清单、自检。参考了用户提供的外部项目规则的结构。草案应用时的行数上限 60 → 120（技能要求不超过 100 行，留出余量给代码对照）。

85. **启用 Pi 的 codemode（0.99）**：codemode 让模型写一段 JavaScript，在沙箱里并行调用其他工具并在脚本中过滤结果，适合配合 serena、codegraph 做多次查询。
    - 子进程以 `--no-extensions` 运行，内置扩展默认不加载；角色工具含 `codemode` 时由 `pluginExtensionsFor` 加入 `-e builtin:codemode`（在 guard 之前）。`config.ts` 把 `codemode` 登记为编排类工具（kind=other），它本身不读写文件。
    - 安全：已实测脚本中的每个工具调用都经过 `tool_call` 处理函数，guard 照常拦截与计违规（`test/e2e/pi-subprocess.test.ts` 用真实 pi 验证：审查者在脚本中并行读 diff 与文件成功，脚本里的越权写入被拦并记 1 次违规，集成分支上的文件未被改动）。脚本只能调用本角色已启用的工具，orchestrator 不允许启用。
    - 模板默认给 architect、reviewer、scout 启用（读多、查询多的角色）；实施角色未启用（glm 写脚本容易出错，用户可在 workflow.yaml 自行加上）。三个角色的提示加一句用法建议。
    - 真实模型对比（fix 演示，同一问题，各一次，样本小）：未启用时 298 秒、输入 66.1k（scout 22.1k、reviewer 31.1k）；启用后 226 秒、输入 45.1k（scout 10.8k、reviewer 21.1k），缓存读从 129k 升到 198k（codemode 的工具说明更长，但命中缓存）；scout 与 reviewer 实际都用了 codemode，0 次违规。

86. **升级到 Pi 1.0.0（2026-10-02）**：
    - 对比 0.99.2 与 1.0.0 的 `dist/**/*.d.ts`：`core/extensions/types.d.ts`、`modes/json-event.d.ts`、`core/session-manager.d.ts` 无变化，只新增界面组件的类型；pi-flow 用到的接口全部不变，代码无需修改。
    - 与本项目相关的变化：codemode 的提示约少 40%，错误提示会告诉模型怎么改（脚本里探测工具要用 `"name" in tools`，不能用 `typeof tools.name`；本项目没有这种写法）；终端界面默认全屏（`tuiMode: "regular"` 可恢复）；`--provider` 不带 `--model` 改为报错（本项目总是传 `--model provider/id`）。
    - 验证：升级前在临时目录安装 1.0.0，真实 pi 的端到端测试 7 个全部通过；真实模型 fix 演示两次 249 秒、232 秒（第二次缓存已热：提示 token 总量 209k，0.99.2 开 codemode 时为 243k）。升级后全量测试通过：单元 138、端到端 58，无跳过。
    - 同日发布的独立包 `@earendil-works/pi-durable`（持久化 agent 运行时：崩溃后从断点继续、任务与子任务、子 agent、工具调用钩子）评估后暂不引入：标注为实验性、API 随时变化；扩展与工具格式与 pi 命令行不同，serena、codegraph、web 插件无法加载；用户的交互依赖 pi 的终端界面。将来可作为 `SubagentLauncher` 的另一种实现，用于中断后从原对话续跑（第 68 条）与运行中插话。

87. **依赖检查与版本范围**（用户要求）：
    - 新增 `src/core/dependencies.ts`：验证过的版本集中登记（Pi 最低 0.99.0、验证 0.99.x – 1.x；pi-serena 0.9.x、pi-codegraph 0.1.x、pi-web-access 0.35.x；Serena 1.x；codegraph 命令行 1.x）。Pi 低于最低版本为错误；其余缺失或版本不在验证范围为提醒，附安装命令、npm 与 GitHub 链接、受影响的角色。插件只在 workflow.yaml 中有角色用到其工具组时才检查；Serena 按 pi-serena 的查找方式检测（`SERENA_PYTHON`、`uv tool dir` 下的 serena-agent）。
    - 接入：`/flow init`、`/flow doctor` 的前置条件；`/flow-build`、`/flow-fix` 开流程前（Pi 过低拒绝开始，其余列出提醒后继续）。Pi 版本取自 Pi 导出的 `VERSION`（已核实 `dist/index.d.ts` 导出），插件位置用已有的 `packageRoots`（项目级优先）。
    - 不在 package.json 中限定 Pi 版本：Pi 文档（docs/packages.md）要求宿主提供的包在 peerDependencies 中写 `"*"`，所以 Pi 版本只能在运行时检查。pi-flow 自己的运行时依赖仍是精确版本。
    - 插件不兼容时的安全性：子进程只启用配置里列出的工具名，guard 对取不到路径的写操作一律阻断，所以工具名或参数变化只会让工具失效，不会放宽安全检查；因此只提醒、不拒绝。子进程启动时若角色配置的工具没有注册，记一条"子进程缺少工具"事件，`/flow doctor` 汇总提示。
    - README 的安装一节重写为四步：基础环境 → pi-flow → 插件 → `/flow init` 自检。
    - 崩溃恢复测试的等待上限 90 → 180 秒：全量并发运行时真实 pi 子进程首次启动偶尔很慢，导致误报超时。

88. **模型服务不可用时暂停模型，不判任务失败（第三轮 A）**：
    - Pi 已核实（1.0.0 的 `pi-ai/dist/utils/retry.js` 与 `settings-manager.js`）：Pi 自己对限流、过载、5xx、网络错误自动重试（默认 3 次，间隔 2/4/8 秒），对额度用完类错误（`insufficient_quota`、`usage limit`、`quota exceeded`、`billing` 等）不重试；最终错误在最后一条 assistant 的 `errorMessage`（`stopReason: error`）中。所以传到 pi-flow 的已是"重试过还不行"或"不该重试"的错误。Codex 的额度错误带 "Try again in ~N min"。
    - 识别集中在 `src/core/model-pause.ts` 的 `classifyUnavailable`：`quota`（额度、余额、订阅用量）与 `unavailable`（限流、过载、服务或网络不可用；HTTP 状态码只在模型的错误信息里认，stderr 只在异常退出时参考）。判定不了的仍按 `run_failed`。
    - 新增触发 `run_paused`（in_progress→in_progress、review→review）：只清租约，不计 attempts、不计 interruptions、不覆盖 last_failure，所以不会因额度问题转 blocked，也碰不到 `MAX_INTERRUPTIONS`。run 的 outcome 新增 `unavailable`。
    - 暂停记录是项目级的 `.flow/model-pauses.json`（新 schema `model-pauses`，经 StateStore 写入、记 note 事件）：`{ model, kind, reason, since, retry_after?, strikes, roles, tasks }`。恢复时间：错误里读得出就用它（至少 1 分钟）；`unavailable` 读不出时 5 分钟起，自动恢复后又失败则加倍，最多 60 分钟；`quota` 读不出时等用户。模型下一次正常响应后删除记录（strikes 归零）。
    - 派发：`Engine.planModel` 把"这次派发用哪个模型"（审查分级 H、失败升级 I）抽出来，`pausedFor` 据此判断。`next`、pump（重新派发、审查、merge-fix）、fix 流程跳过模型被暂停的任务（并发名额让给其他任务）；显式 `dispatch`（`flow_dispatch`）报中文错误。
    - 恢复：引擎每 30 秒的租约检查同时检查暂停到期（`checkPauses`），到期后推进受影响的流程（pump，非 fix 流程再 `next`）；`/flow models resume <模型|all>` 立即恢复；`/flow-config` 改设置后调用 `retryPaused`，换了模型的任务立即继续。没有另设"备用模型"配置：角色模型每次派发都重新读取，用 `/flow-config` 换模型就是改用备用模型。
    - 提示："需要你处理"、主动通知（出现与恢复）、`flow_status`、orchestrator 每轮的"下一步"（只剩等暂停模型的任务时让它向用户说明并等待，不调用 flow_dispatch）。`scripts/real-build.ts` 在有暂停且两轮没有进展时停下，提示恢复后用 `--dir` 接着跑。
    - 验收：`test/e2e/model-pause.test.ts`（额度用完：attempts 不变、不转阻塞、模型不再派发、其他模型的任务完成、提示与 orchestrator 下一步、`/flow models resume` 后完成；限流：5 分钟后自动恢复、再失败退避加倍、成功后清除记录）；`test/e2e/pi-subprocess.test.ts` 用真实 pi 与假模型的 429 insufficient_quota 验证错误能被识别；`test/unit/model-pause.test.ts`、`state-machine.test.ts`。假模型 `test/fixtures/fake-llm/server.ts` 的步骤支持 `error: { status, message, code }`。

89. **第二轮起的审查只核对上次的问题（第三轮 B）**：
    - 审查打回时在 `review_reject` 事件的 data 中记下被审查的提交 `reviewed_head`（`TransitionRequest` 新增 `data`，原样写入事件）。
    - 派发审查时 `previousReviewOf` 查事件：该任务最近一次审查结论（review_reject、review_pass、review_skip）是打回时，取其原因（问题清单）、连续打回次数（本轮轮次 = 次数 + 1）、`git diff --stat <reviewed_head> HEAD`；审查提示以"第 N 轮审查：先核对上次打回的问题"一节代替"上次未通过的原因"，要求逐条写明是否已解决，只为没解决的问题或新改动引入的明确缺陷打回，新建议写进 pass 的 notes，验收标准有问题时 flow_block。审查通过后 verify 失败再回来的审查不算多轮（最近结论是 pass），按普通审查。
    - 可选 `review.max_rounds`（无默认）：到达时提示中加一条"只剩建议类问题就通过，建议写进 notes"。只改提示，不由程序强制通过：程序判断不了问题是不是"建议类"。
    - `agents/reviewer.md` 增加两行多轮审查说明（缓存提醒见下）。
    - 验收：`test/unit/prompt-assembler.test.ts`（提示内容与位置、轮次上限、实施提示不受影响）；`test/e2e/cost-control.test.ts`（被打回两次的任务，第 2、3 轮审查提示含上次的问题、上次审查的提交与"只核对"的要求）。真实效果待额度恢复后复跑返工多的任务对比。

90. **审查默认用中等模型，高风险用强模型（第三轮 C）**：
    - 模板 `templates/workflow.yaml` 中 reviewer 的档位 strong → medium（`agents/reviewer.md` 的 tier 同步）。已有项目的 `workflow.yaml` 与用户 `/flow-config` 的设置不受影响。
    - `assessRisk` 增加高风险判定（`high`、`highReasons`）：merge-fix、先行验收测试、改动契约或 shared、`review.high_risk.paths`、改动超过 `review.high_risk.max_lines`（默认 400 行）。`review.high_risk.enabled: false` 可关闭。审查分三档：light（低风险，便宜模型）、full（普通，审查者自己的模型；沿用旧值，不改名，旧 run 记录仍然有效）、strong（高风险）。
    - 高风险审查的模型 `strongReviewModel`：`/flow-config escalate reviewer`（reviewer 不做失败升级，这个设置复用为"高风险审查用的模型"，菜单与说明已改）> `review.high_risk.model` > `roles.reviewer.escalate_model` > reviewer 档位的上一档；取不到时用审查者的模型。
    - 偏离交接文档：没有做"阶段闸门前的最后审查用强模型"。阶段的最终检查是程序执行的闸门命令，不是某一次审查；用"本阶段最后一个任务"来判断太随意。
    - 用户现有的 `~/.pi/agent/pi-flow.json` 把 reviewer 显式设为 gpt-6.1-sol，普通审查仍会用它；要省成本需要用 `/flow-config` 把 reviewer 改成中等模型，再 `/flow-config escalate reviewer openai-codex/gpt-6.1-sol` 指定高风险审查用的模型。
    - 验收：`test/unit/cost-control.test.ts`（高风险各条件、可配置路径与行数、关闭、模型优先级、配置校验）；`test/e2e/cost-control.test.ts`（文档任务 light 用便宜模型、普通代码任务 full 用中等模型、450 行改动 strong 用强模型）。

91. **拆任务时尽早并行（第三轮 D）**：
    - `skills/decompose-dag/SKILL.md` 新增"尽早并行"一节：底座合并为一个 infra 任务（必要时加一个基础实现），不为底座拆"先行验收测试 → 实现"两层；切片之间默认软依赖 + integration；附记账服务的正反例。"先 test 后 impl"限定为功能切片。
    - `dagReport`（`flow_propose_tasks` 返回的报告）：新增 `serialHeads`，按阶段分组、只看本阶段内的硬依赖分层，开头连续 2 层（`SERIAL_HEAD_LAYERS`）宽度为 1 时提醒合并底座或改软依赖；任务少于 4 个的阶段不检查。关键路径占比的提醒阈值 0.6 → 0.5（`CRITICAL_PATH_RATIO`）。只是提醒，不拒绝提案。
    - 验收：`test/unit/dag.test.ts`。真实效果待额度恢复后用相同描述从零复跑中型项目，对比总耗时与并行度。

92. **先验证再审查（第三轮后续 1）**：
    - 状态顺序不变（review → verifying），在 review 状态内加一步程序验证：`reviewStep` 派审查前先 `runPrecheck`（`verify-runner.ts`），跑任务的 verify（要求先失败的测试只跑测试类命令，并要求失败），evidence 存为 `precheck-a<尝试次数>-<命令>.log`。
    - 失败：新增触发 `precheck_fail`（review → in_progress，failure，只允许 actor=verify-runner、无审查 run、有失败结果、已存 evidence），与 verify_fail 一样计一次失败、带上原因重新派发。返工统计计入"验证失败"，状态视图显示"审查前验证失败"。
    - 通过：记一条 note 事件 `data.precheck = { head, attempts, results }`（head 为 worktree 的 HEAD，有未提交改动时加 `+dirty` 且不复用）。审查通过进入 verifying 后，`runVerify` 发现同一 attempts、同一 HEAD 的验证结果就直接 verify_pass（或 repro_confirmed），不重跑。审查者没有写权限，审查期间代码不会变；审查被打回、重新提交后 attempts 变化，重新验证。
    - 没有 verify 命令的任务、低风险免审查（review_skip）的任务不做审查前验证。`review.verify_first: false` 关闭（默认开启）。
    - 审查提示与 `agents/reviewer.md` 改为"默认配置下派审查前已验证通过，输出见 precheck-*.log"（缓存提醒见下）。
    - 验收：`test/e2e/single-task.test.ts`（审查前验证失败不派审查、带原因重派；通过后审查后的 verify 沿用、evidence 只有 precheck；关闭后照旧）；`test/e2e/modes.test.ts`（"必然通过"的先行验收测试在审查前被退回）。

93. **返工接着上一次的对话（第三轮后续 2）**：
    - Pi 已核实（docs/cli.md 与实测 1.0.0）：`--session-dir <新目录> --fork <上次的会话文件>` 把上次的对话复制成新会话继续，原会话文件不变；系统提示按这次的 `--append-system-prompt` 重建（实测换成另一个文件后新请求里是新内容）；请求中带着上次的全部消息。
    - 条件（`Engine.forkSource`）：任务在 in_progress 且无租约（返工重新派发），角色不是 reviewer，同一任务、同一角色最近一次已结束的 run 正常提交（outcome submitted）、模型相同、会话文件存在且不超过 `MAX_FORK_BYTES`（1.5 MB）。失败升级换模型、任务回到 ready（unblock、租约过期重建 worktree）、上一次崩溃或额度暂停时从头开始。`limits.continue_session: false` 关闭。
    - 提示：系统提示照常组装（稳定前缀不变，能命中缓存）；用户消息换成 `continuationPrompt`：任务名、"接着上面的对话继续"、上次未通过的原因、新的临时目录、"先 flow_claim"。任务说明、上游、handoff 不再重复。run 记录新增 `forked_from`。
    - 风险：对话会越积越长，每轮重发的上下文变大；靠 1.5 MB 上限与 Pi 自己的压缩控制。复跑时对比返工运行的 token 与轮数再调上限。
    - 验收：`test/e2e/pi-subprocess.test.ts`（真实 pi + 假模型：第一次提交在审查前验证失败，第二次运行的第一个请求带着上次的 5 条回复、用户消息是续做说明，任务完成，`forked_from` 正确，新会话单独留档；`buildPiArgs` 含 `--fork`）；`test/unit/prompt-assembler.test.ts`。

94. **默认并发 2 → 3（第三轮后续 3）**：模板 `limits.max_parallel` 改为 3。核实调度代码：`selectDispatchable` 与转移表的并发只计 in_progress（实施）任务，审查另由 `review.max_parallel` 限制（模板为 2），两者本来就分开计数，不需要改代码。测试用配置（`test/helpers/config.ts` 的 `TEST_YAML`）保持 2，测试中的调度顺序不变。已有项目（包括冒烟的中型项目）的 `workflow.yaml` 不受影响。

95. **减少重复发送的上下文（第三轮后续 4）**：
    - 审查提示直接附 diff：`git diff <起点> HEAD` 不超过 `INLINE_DIFF_MAX`（2 万字符）时放进用户消息，起点是上次审查的提交（第二轮起）或 base_sha；写明"不必再运行 git diff"。超过时照旧只给 `--stat`。
    - run 记录新增 `turns`（assistant 消息数；fork 的 run 只计本次）；成本统计每行显示"平均 N 轮"（旧记录没有轮数，不计入平均）。冒烟脚本的成本输出随之带上。
    - 没做：按工具统计调用次数已在冒烟脚本里；其他减少轮数的办法等复跑数据（第 5、6 项暂缓，用户决定）。
    - 验收：`test/unit/prompt-assembler.test.ts`；`test/e2e/cost-control.test.ts`（第一轮附全部改动、第二轮附上次审查之后的改动，run 都有轮数，`/flow status --cost` 按角色显示平均轮数）。

96. **自动派发，orchestrator 只在值得汇报时醒来（第三轮后续 5，偏离第 15、20 节）**：
    - 起因：ready 任务原来要等 orchestrator 调用 `flow_dispatch`，可派发哪个任务又是程序算好的；`flow_wait` 在任何任务的状态或租约变化时都返回，一个任务从实施到合入要唤醒主会话 6～8 次，每次都重发整段对话。中型项目估计 100～150 次唤醒（未实测，冒烟脚本不走 orchestrator）。
    - 偏离：`limits.auto_dispatch`（默认 true；没写时也按 true）开启时，引擎在每次 pump 末尾对非 fix 流程调用 `next`（与 `/flow next`、`/flow budget` 提高预算后相同的调度规则：关键路径优先、并发与互斥、预算、修订冻结、模型暂停）。orchestrator 不再需要派发，只负责沟通与 `flow_replan`。第 15 节说 orchestrator"派发"，但第 20 节第 4 条"调度由 scheduler 决定，flow_dispatch 只收 task_id"——它本来就没有决策权，自动派发不放松任何约束。`flow_dispatch` 保留：`nextStep` 在程序空闲却仍有可派发任务（自动派发出错）时仍要求它，让 orchestrator 看到错误原因；关闭自动派发时照旧。
    - `flow_wait` 改为只在以下情况返回：任务完成、阻塞、取消或新增；关闭自动派发时出现 ready 任务；阶段、阶段状态、活动流程或修订状态变化；"需要你处理"出现新事项；引擎空闲（没有子进程、程序步骤、排队的 pump——`Engine.isIdle` 新增 pump 计数，避免 pump 进行中误判空闲）；超时（默认 300 → 1200 秒，上限 1800 → 3600）。给了 task_id 时只等该任务的状态变化。
    - 主会话用量：`pi.on('message_end')`（Pi 1.0.0 `types.d.ts` 的 `MessageEndEvent`，已在 `pi-api.d.ts` 补声明）在调度模式下把 assistant 消息的 usage 用 `UsageAccumulator` 累加，写成 role=orchestrator 的 run（每个流程、每个 pi 进程一条；创建即带 ended_at、outcome noted，恢复流程不会当成中断的子进程）。成本统计与预算随之计入主会话；"耗时"是会话跨度，不是运行时长。
    - `agents/orchestrator.md` 与 guard 的提示改为"任务由程序派发，用 flow_wait 等待"（缓存提醒见下）。测试用配置 `TEST_YAML` 关闭自动派发，测试中显式调用 `engine.next`，派发顺序可控。
    - 验收：`test/e2e/orchestrator-tools.test.ts`（不调用 flow_dispatch，一次 pump 后两个有依赖的任务依次自动派发、审查、合入；flow_wait 跳过中间步骤，第一次返回时报告 T-001 完成；空闲时立即返回；自动派发时忙碌中的下一步是 flow_wait，空闲且有可派发任务时退回 flow_dispatch，关闭时照旧）；`test/e2e/orchestrator-session.test.ts`（真实 pi 主会话的用量写入 orchestrator run）；全量端到端 64 个通过。

97. **第二次中型项目冒烟（2026-10-02，开 A–D 与后续 1–5）暴露的问题与修复**：
    - 运行：个人记账服务，15 个任务（S2 两个底座、S3 五对"验收测试 → 实现"、S4 联调）；跑了 10 小时只完成 9 个，用户同意停下修复。数据：41 次运行，输入 1164k、输出 202k、缓存读 28.7M；backend-engineer 10 次运行 230 分钟、平均 52 轮、缓存读 24.6M；审查 16 次共 15 分钟；审查打回 8 次、阻塞 6 次、违规 7 次、接续对话 6 次、升级 3 次、模型暂停 0 次。项目保留在 `/var/folders/87/538dtvdd6013gnp3w4qpz5jw0000gn/T/pi-flow-real-build-bbgjbZ`，日志 `~/pi-flow-runs/real-build-20261002-0853.log`。
    - 有效的：拆任务后 S3 五个验收测试同时开工；审查每次约 1 分钟，第二轮先核对上次的问题；没有空转。
    - 修复（各自单独提交）：
      1. **租约检查只在 /flow resume 时启动**（bug）：冒烟用 `/flow approve`、`/flow next` 启动引擎，挂起的子进程永远不会被结束（一次 `node --test` 挂了 6 小时）。改为 `engineFor` 创建引擎后总是 `startLeaseWatch`。
      2. **bash 没有超时**：子进程扩展在 guard 放行后把 bash 的 `timeout`（秒，Pi 1.0.0 `tools/bash.d.ts`）改成不超过 `limits.bash_timeout_s`（默认 300）；Pi 文档：`tool_call` 的 `event.input` 可原地修改。真实 pi 端到端测试验证。冒烟脚本的测试命令加 `--test-timeout=60000`。
      3. **测试产物卡住提交**：测试运行在工作区根部生成 `data/ledger.json`（未跟踪、不在 writes 内），实施者无权删除，提交又因越界被拒，只能阻塞求助。改为 `flow_submit` 先 `cleanStrayUntracked`：删除未被 git 跟踪（且未被忽略）、不在 writes 内的文件，记入 handoff 与提交结果。已跟踪文件的越界改动仍被拒。
      4. **Serena 严格模式拖慢弱模型**：模板中实施角色的 `PI_SERENA_STRICT=1` 让 pi-serena 拦下直接读代码（T-004 第一次运行 32 次失败里 24 次是它）。模板去掉，需要时仍可按角色在 `env` 中开启。
      5. **底座测试锁死后续任务**：T-004 写了"src/server 下没有任何功能路由"的断言，三个功能实现都因改不了它而阻塞。`rules/testing.md` 补四条：关闭测试中启动的服务器、数据写临时目录、不断言后续任务一定会改变的全局状态、上游测试有误时 flow_block 并写"建议修订计划"；冒烟脚本遇到"修订计划"时代为 `/flow replan`。（缓存提醒见下）
      6. **高风险审查过宽**：16 次审查 14 次用了强模型，其中 10 次是先行验收测试。先行验收测试不再算高风险（"先失败"已由程序在审查前验证）。注：用户的 reviewer 显式设为 gpt，这次两档模型相同。
      7. **接续对话的上下文过长**：接续 T-004 的两次运行缓存读上千万 token。`MAX_FORK_BYTES` 1.5 MB → 400 KB。
      8. **底座任务对弱模型太大**：T-004 第一次 44 分钟、175 轮，后面 11 个任务都在等它。新增 `escalation.critical_fanout`（默认 3）：被至少这么多任务直接硬依赖的非测试任务第一次派发就用升级模型。
    - 验收：单元 151、端到端 67 全部通过（含新增：bash 超时（真实 pi）、提交前清理、关键底座升级）。
    - **修复后重跑（同一描述，2026-10-02 19:30 起）**：64.5 分钟走完 S0→S5 并合入主分支，15 个任务全部完成，项目测试 65 个全部通过，完整性校验通过。59 次运行合计 107.6 分钟，输入 1588k、输出 178k、缓存读 10.8M；backend-engineer 10 次运行 18 分钟、平均 11.5 轮；审查 29 次 25.6 分钟；审查打回 14 次（多数是先行验收测试写错：断言自相矛盾、测试因端口或环境而非行为缺失失败、断言无效，均为真实问题），阻塞 1 次（需求阶段的正常提问），违规 1 次，卡死 0 次；接续对话 10 次，升级模型 6 次（T-004 底座 2 次，其余是失败两次后的升级）。项目在 `/var/folders/87/538dtvdd6013gnp3w4qpz5jw0000gn/T/pi-flow-real-build-s9P6Bf`，日志 `~/pi-flow-runs/real-build-20261002-1930.log`。
    - 待处理：Pi 的 bash 超时只结束 shell，不结束它启动的进程组，挂住的 `node --test` 会成为孤儿进程（上次运行留下两个，已手动清理）；停掉冒烟脚本也不会结束正在运行的子进程。都不影响流程推进。

## 第三轮优化设计要点

- **A 模型暂停**（第 88 条）。验收见该条。
- **B 多轮审查只核对上次的问题**（第 89 条）。
- **C 审查模型分级**（第 90 条）。
- **D 拆任务时尽早并行**（第 91 条）。

## 第二轮优化设计要点

- **A 先行验收测试先失败**（第 69、70 条）。验收：
  - `test/e2e/modes.test.ts` build 全流程：验收测试第一次"必然通过"被打回（原因"验收测试没有失败"），第二次确认失败；不单独合入；集成分支每次前进后的 HEAD 都不出现"有验收测试没有实现"；测试提交紧接着实现提交。
  - `test/e2e/merge-queue.test.ts`：承载者从测试分支开工，合并后验证失败后重新提交不被判越界，最终测试与实现一次快进，测试的 worktree 被回收。
  - `scripts/demo.ts` 的演示脚本改为实现前会失败的验收测试（原脚本正是"实现缺失时跳过"的必然通过测试），并改用 `/flow-build --direct`（访谈模式上线后演示已无法直接开流程）。
- **B + C 上游经验与项目级知识库**（第 71、72 条）。验收：
  - `test/e2e/knowledge.test.ts`：agent 提交的知识出现在后续同 scope 任务的系统提示中，其他 scope 的不出现；下游提示含上游 handoff；重复与非法 scope 被拒；agent 写 `.flow/knowledge.json` 被拦；审查打回生成候选，确认前不注入；废弃；提升为规则草案并应用；跨流程保留；篡改知识库被完整性校验发现。
  - `test/unit/knowledge.test.ts`：校验、去重、选择与上限、提示位置、上游长度限制、提升目标。
- **F 集成分支同步主分支**（第 75 条）。验收（`test/e2e/sync.test.ts`）：两阶段流程中，用户在实施期间向主分支提交一处无关改动与一处与任务冲突的改动；进入 S4 时主分支改动已进入集成分支（S4 任务的 worktree 可见），冲突生成 merge-fix（看到冲突标记）并合入，集成分支以主分支为祖先，最终合入主分支无冲突。契约冲突时暂停派发、提示用户，手动合并后 `/flow sync` 恢复派发。
- **G 执行中修订计划**（第 76 条）。验收（`test/e2e/replan.test.ts`）：主 agent 经 `flow_replan` 发起，architect 收到原话与任务一览；取消进行中任务、取消仍被依赖的任务被拒；architect 不能写文件；待批准时阶段闸门不运行、主 agent 只能等待、agent 不能取消任务；用户批准后新增任务重新编号、依赖调整、任务取消，进行中任务的租约不变；第二次修订被打回后按意见重做再批准；最终含已取消任务的阶段照常通过闸门。`test/unit/revision.test.ts`：阶段、环、不存在的依赖、先行验收测试规范化与编号映射。
- **H + I 按风险审查、升级模型与预算**（第 77、78 条）。验收（`test/e2e/cost-control.test.ts`）：文档任务的审查 run 用便宜模型（review_mode light），代码任务用强模型；审查并发上限 1 时从未同时有两个审查；skip 模式下文档任务不派审查、由引擎 `review_skip` 后完成，agent 不能免审查；被打回两次后第三次实施使用升级模型并标记；超预算后不派发新任务、提示用户、orchestrator 只能报告，`/flow status --cost` 显示用量，`/flow budget` 提高后继续派发。`test/unit/cost-control.test.ts`：风险判定各条件、模型引用与升级优先级、配置校验。
- **J 状态存储**（第 79 条）。验收：性能测试（事件数 2 万时单次事务耗时不变）；`git log HEAD` 中不再有 `flow-state:` 提交，状态提交在 `refs/pi-flow/state`；早期版本跟踪在分支上的 `.flow/` 自动迁移；完整性校验与全部恢复测试照常通过。
- **L 实时进度**（第 80 条）。验收：`test/unit/status-view.test.ts` 中状态栏文字随任务开始、阻塞、流程结束变化，没有流程时清除。
- **K 合并列车**（第 81 条）：只做测量（`scripts/measure-merge.ts`），按数据暂不实现。
- **D + E 租约续期与会话留档**（第 73、74 条）。验收（`test/e2e/lease-session.test.ts`）：持续调用工具时剩余不足一半才续租、超过最初 45 分钟不被杀、停止调用后按时过期、伪造 token 不能续租；run 记录会话目录，`/flow run` 显示工具调用与失败、最后的回复；doctor 按保留期提醒与清理。`test/e2e/pi-subprocess.test.ts` 用真实 pi 验证会话文件写入留档目录并能摘要出 flow_* 调用与被 guard 拦下的调用。

## M8 设计要点

- 交付物：
  - 角色提示 11 个：scout、researcher、architect 按各自工作方式定稿，其余按统一骨架；
  - 规则 7 个；技能 5 个；提示模板 3 个（`/stage-kickoff`、`/feature-kickoff`、`/fix-brief`）；
  - 文档模板；中文 README；`scripts/demo.ts`。
- `scripts/demo.ts`：
  - 默认用真实 pi 进程加假模型，从空仓库跑完 build 流程 S0→S5 并合入 main（10 次运行，约 11 秒）。
  - `--real-fix` 用 `/flow-config` 中设置的真实模型跑一次 `/flow-fix`。
- 真实模型冒烟（Workbuddy/glm-5.3-flash，2026-10-01，子进程加载 pi-serena 与 pi-codegraph）：
  - 第一次：scout 与复现测试完成，修复因 `.serena/` 产物被判越界；模型按要求 `flow_block` 并准确说明原因。据此新增第 58 条。
  - 第二次：全流程 185 秒完成，修复合入 main，fix 日志含根因与成本（5 次运行，输入 31.0k / 输出 2385 / 缓存读 109.0k），完整性校验通过。
- 安装验证：`pi install -l <pi-flow 目录>` 后不带 `-e`，`/flow-config`、`/flow init` 正常。
- **缓存提醒**：M8 修改了角色提示（scout、researcher、architect），新增了技能注入。这些属于子进程系统提示的稳定前缀，已有项目在升级后第一次派发时，提供商的提示缓存会失效一次。

## M7 设计要点

- `src/modes/fix.ts` 的 `fixStep` 由引擎的 `pump` 调用，代替 fix 流程的阶段推进。顺序：scout → 升级判断 → 复现测试 → 修复 → 写日志并结束。
- 验收（`test/e2e/fix.test.ts`）：
  - 一次小修复全流程：复现测试第一次没有复现被打回，第二次确认；修复 cherry-pick 进主工作区；日志含成本。
  - 超出规模时的升级提示，以及继续、中止两种选择。
  - 与 build 流程并存的规则。
  - 成本合计、按角色、按任务的汇总都与 runs 记录逐项相等。

## M6 设计要点

- 引擎的 `pump` 增加阶段推进：设计阶段生成任务；本阶段任务全部完成时提交闸门；无需人工的闸门通过后进入下一阶段。
- `/flow-build "<描述>"`、`/flow-build --feature "<描述>"`：
  1. 未初始化时先执行 `/flow init`；
  2. 已有进行中的流程时拒绝，并提示 `/flow resume`；
  3. 建流程与集成分支，进入调度模式，生成并派发设计阶段任务。
- 验收（`test/e2e/modes.test.ts`）：
  - build 全流程 S0→S5：S0 打回一次；agent 无法批准；批准前提案不落为任务；互斥任务从未同时在途；最终合入 main。
  - feature 流程：跳过 S2；S4 闸门执行 test 与 e2e；闸门失败时不能 approve；修复后 `/flow gate` 通过。
  - 同一时间只允许一个流程。
- 真实 pi：在空仓库执行 `/flow-build` 一条命令完成初始化、建流程、S0 任务的实施、审查与合入，停在等待批准（`test/e2e/orchestrator-session.test.ts`）。

## M5 设计要点

- `resume()` 的步骤：
  1. 重放事务日志；
  2. 完整性校验，不一致时直接在事件日志末尾追加 `integrity_error` 后停止（不更新 state.json，后续写入继续被拒绝）；
  3. 终止残留子进程（run 记录中的 pid，按进程组终止），把 run 标记为 killed；
  4. 处理租约（见第 36 条）；
  5. 恢复中断的合并：先 `rebase --abort`；集成分支已包含任务 HEAD 时补完为 done，否则放回队首；worktree 丢失时转 blocked；
  6. 生成 resume brief：状态、恢复操作、需要用户决定的事项、进行中任务的 handoff、最近 10 条事件。
- 引擎租约看守：`startLeaseWatch()` 每 30 秒检查一次，租约到期的 run 被终止，按 run_failed 计一次失败。
- 强杀验收（`test/e2e/crash-recovery.test.ts`）：引擎在独立 node 进程中运行（真实 pi 子进程 + 假 LLM），分别在任务进行中、合并进行中 `SIGKILL`。任务进行中：残留的 pi 子进程被清理，任务在原 worktree 上完成。合并进行中：合并回滚到队首，最终只合入一次。
- 调度模式端到端（`test/e2e/orchestrator-session.test.ts`）：在真实 pi 主会话中执行 `/flow resume` 后发出调度指令。验证：
  - 写工具不可用；
  - 读 `src/` 被拦下并记录违规；
  - 注入的下一步是 `flow_dispatch(T-001)`；
  - 派发、等待、实施、审查、verify、合并全部跑通。

## M4 设计要点

- `MergeQueue.processNext` 由引擎的 `pump` 驱动：合并名额空闲、且队首属于当前流程时处理它。进程内有互斥标志，存储层只有一个 `merging` 名额，双重保证同一时间只合并一个。
- 结果分四类：`merged`（快进、清理、处理挂起链），`verify_failed`（`merging → in_progress`，attempts 加 1，worktree 已 rebase 到最新集成分支），`merge_fix`（挂起原任务、生成 merge-fix），`blocked`。
- evidence：合并后验证的输出保存为 `merge-a<次数>-<命令>.log`。
- 真实模型冒烟（2026-10-01）：两个任务并行实施，串行合并，集成分支上得到两个 squash 提交，worktree 已清理，总耗时 75 秒。

## M3 设计要点

- **进程拓扑**：引擎运行在 orchestrator 所在的 pi 进程内；每个 run 是一个 `pi --mode json -p` 子进程（`PiLauncher`），工作目录为任务 worktree。子进程中的 `subagent.ts` 扩展直接读写主工作区 `.flow/`（`PI_FLOW_ROOT`），靠文件锁与 git 重试并发安全。
- **run token**：24 字节随机数，只经环境变量 `PI_FLOW_RUN_TOKEN` 传入；`.flow/` 只存其 sha256。已验证模型请求中不出现 token。
- **提示文件**：`<项目>.worktrees/.runs/<run>/system.md`（不放在 `.flow/`，避免成为未登记文件）。
- **提交快照**：`flow_submit` 先把 worktree 改动提交为快照（作者 pi-flow），再以 `base_sha..HEAD` 计算 diff 交给状态机校验。
- **verify**：`sh -c` 在 worktree 中执行，去掉 `PI_FLOW_*` 环境变量，默认超时 15 分钟，按进程组终止；每次尝试的输出保存为 `evidence/<task>/verify-a<次数>-<命令>.log`。
- **测试分层**：`test/fixtures/fake-subagent`（进程内脚本，走真实 guard 与工具，快）；`test/e2e/pi-subprocess.test.ts`（真实 pi 子进程 + 假 LLM，验证适配层）；`playground/make-smoke.ts`（真实模型冒烟，不进自动化测试）。
- **真实模型冒烟结果**（Workbuddy/glm-5.3-flash，2026-10-01）：实施 33 秒（input 4042 / output 185 / cacheRead 7936），审查 22 秒（1916 / 210 / 5056），verify 通过，0 违规，完整性校验通过。

## M2 设计要点

- `config.ts`：先用 schema 校验结构，再校验引用（scope、工具组、命令、模型档位、阶段 id），错误格式为 `roles.x.scopes[1]（第 N 行）: ...`。占位符模型给警告。工具分类：内置读、内置写、`serena_edit` 组为写，`web` 组为联网，其他组按只读扩展工具处理；同一工具同时在读组和编辑组时按写处理。`activeTools(role)` 给出子进程应启用的工具，`bash_readonly` 映射为 `bash`。
- `shell.ts`：极简 shell 解析器。支持引号、转义、`$()`、反引号、`<()`、`$(())`、`${}`、heredoc（未加引号时扫描其中的命令替换）、重定向、fd 复制、子 shell 与分组。解析失败返回错误。
- `guard.ts`：`checkToolCall` 是纯判定函数，`enforceToolCall` 在阻断时调用 `StateStore.recordViolation`。违规按 run 计数（以事件日志为准）；达到 `max_violations_per_run` 时，run 标记为 `killed`，任务经转移表转 `blocked`，返回 `terminate=true` 由调用方终止子进程。
- **guard 已知局限**（第 24 节第 1 条，兜底是 `flow_submit` 的 diff 检查）：
  - 脚本文件（`bash x.sh`、`node script.js`、`pnpm <script>`）内部的行为无法检查。
  - `grep -r` 等递归读取可能读到 `.env` 内容。
  - glob 敏感判断是启发式的。

## M1 设计要点

- **唯一写入口**：所有 `.flow/` 写入都经 `StateStore.transaction`。流程：取文件锁 → 重放未完成事务 → 校验 state.json 与事件日志头一致 → 执行回调暂存写入 → schema 校验 → 写事务日志 `tx.json` → 应用（临时文件 + rename）→ 追加事件 → 写 state.json → 删除事务日志 → `git commit`（前缀 `flow-state:`，只提交 `.flow/`，不影响用户已暂存的其他文件；第 79 条起提交到专用引用 `refs/pi-flow/state`）。
- **事务必须附带事件**；无事件的写入被拒。
- **完整性**：事件带哈希链（键排序的规范 JSON + sha256）；每个事务的最后一条事件记录本事务写入的所有文件哈希（`entities`），以及 `active_flow` 的变化。`verifyIntegrity` 校验：哈希链、序号连续、state.json 的 head/version/active_flow、每个登记文件的哈希与 schema、`.flow/` 下是否存在未登记文件、是否存在未重放的事务日志。
- **facts 不采信调用方**：stage 是否 active、依赖状态、并发数、互斥、合并队列状态、handoff 与 evidence 是否存在、契约是否锁定，均由 StateStore 计算并覆盖调用方传入的同名字段。token、diff、verify 结果、rebase 结果等由程序内模块（M3/M4）提供。
- **乐观版本**：每个带 version 的文件写入时必须基于当前版本，自动加 1。
- **状态字段不可旁路**：`updateTask` 只能改 `lease`、`worktree`、`branch`、`base_sha`；status、attempts 等只能经转移表改变。
- **glob 关系判断**（`paths.ts`）：`globWithin` 保守（不确定判"不在内"），`globsOverlap` 保守（不确定判"重叠"）。

## 缓存提醒

- 2026-10-02（第 97 条）：`rules/testing.md` 增加四条（新项目 `/flow init` 时复制，已有项目不受影响）；用到 testing 规则的子进程提示缓存失效一次。
- 2026-10-02（第三轮后续 5）：`agents/orchestrator.md` 改为"任务由程序派发，用 flow_wait 等待"；主会话进入调度模式后的提示缓存失效一次。
- 2026-10-02（第三轮后续 1）：`agents/reviewer.md` 改为"派审查前已验证"；reviewer 子进程提示缓存失效一次。
- 2026-10-02（第三轮 D）：`skills/decompose-dag` 增加"尽早并行"；architect 在 S1/F1 与计划修订时的子进程提示缓存失效一次。
- 2026-10-02（第三轮 B、C）：`agents/reviewer.md` 增加多轮审查的说明、tier 改为 medium；reviewer 子进程的提示缓存失效一次。审查默认改用中等模型后，缓存按新模型重新建立。

- 2026-10-01（M8）：角色提示（scout、researcher、architect）变更，新增技能注入；升级后首次派发时提示缓存失效一次。
- 2026-10-01：新增 `agents/interviewer.md`（只用于主会话）；`agents/architect.md` 与 `skills/design-contract` 增加规则草案说明，architect 子进程的提示缓存失效一次。
- 2026-10-01（第二轮 A）：`agents/test-engineer.md`、`skills/decompose-dag`、`rules/testing.md` 增加"先行验收测试必须先失败"的说明；test-engineer 与 architect（S1/F1）子进程提示缓存失效一次。新项目 `/flow init` 时复制的 `rules/testing.md` 随之变化，已有项目的 `rules/` 不受影响。
- 2026-10-01（第二轮 B + C）：`skills/write-handoff`（所有实施角色）、`agents/reviewer.md`、`agents/scout.md` 增加 flow_learn 说明，`agents/interviewer.md`（主会话）增加读知识库的说明；所有子进程角色的工具声明多了 flow_learn。以上都会让提示缓存失效一次。此外项目知识新增条目时，系统提示末尾的知识部分变化，只影响其后的缓存。
- 2026-10-01（第二轮 G）：新增技能 `skills/revise-plan`（只注入修订任务）；`agents/orchestrator.md`（主会话）增加 flow_replan 说明，orchestrator 的工具多了 flow_replan；architect 的工具声明多了 flow_revise_plan，architect 子进程提示缓存失效一次。
- 2026-10-02（真实模型冒烟后）：`agents/reviewer.md`、`agents/scout.md`、`skills/decompose-dag`、`skills/revise-plan` 修改；审查与实施提示新增临时目录、evidence 路径两节（在动态部分）。reviewer、scout、architect 子进程提示缓存失效一次。
- 2026-10-02（默认规则更新）：`rules/` 全部重写并新增 `rules/docs.md`，`skills/design-contract` 修改。只影响之后 `/flow init` 的新项目（已有项目的 rules/ 不变）；architect 子进程提示缓存失效一次。
- 2026-10-02（write-rules）：新增技能 `skills/write-rules`，`skills/design-contract` 与 `agents/architect.md` 修改；architect 子进程提示缓存失效一次。
- 2026-10-02（codemode）：`agents/architect.md`、`agents/reviewer.md`、`agents/scout.md` 增加 codemode 用法；三个角色的工具声明多了 codemode，提示缓存失效一次。
- 以后修改 `agents/`、`rules/`、`skills/` 时，在此追加一条。
