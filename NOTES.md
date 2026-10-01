# pi-flow 开发笔记

## 已验证版本号

| 组件 | 版本 | 来源 / 说明 |
|---|---|---|
| Node | 24.18.0 | 本机；package.json 要求 >=22。测试直接用 Node 原生 TS 类型剥离运行（要求 erasable syntax，不用参数属性、enum、namespace） |
| Pi | `@earendil-works/pi-coding-agent` **0.99.2**（用户已升级，以此为准） | 旧包名 `@mariozechner/pi-coding-agent` 停在 0.73.1 |
| typebox | 1.3.27（devDependency，与 Pi 0.99.2 内置版本一致） | Pi `docs/packages.md`：typebox 属于 Pi 内置核心包，作为 `peerDependencies: "*"` 声明，不打包 |
| proper-lockfile | 4.1.2 | 与 Pi 自身依赖同版本；npm 官方包，作者 moxystudio；用途：`.flow/` 跨进程文件锁 |
| minimatch | 10.2.6 | 与 Pi 自身依赖同版本；isaacs 维护；用途：glob 匹配 |
| yaml | 2.9.0 | 与 Pi 自身依赖同版本；eemeli 维护；用途：解析 workflow.yaml 并定位行号 |
| typescript | 5.9.3 | devDependency，仅 typecheck |

依赖选择理由：上述运行时依赖均是 Pi 本身已使用的库，版本对齐，装 pi-flow 不会引入新的供应链来源。测试框架用 Node 内置 `node:test`，不另装。

## M0：Pi API 矩阵（Pi 0.99.2）

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
| 子进程 | `pi --mode json -p --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files -e <ext>... --model provider/id --thinking <level> --tools a,b --append-system-prompt <file> "<prompt>"`；**stdin 必须关闭**（否则 -p 等待输入）；工作目录 = spawn 的 cwd；环境变量直接继承到工具执行 | 实测；官方 subagent 示例同此用法 |
| token 用量 | 每条 assistant `message_end.message.usage = {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`；`input` 不含缓存命中；同时给出 `provider`、`model`、`thinkingLevel`、`stopReason`、`errorMessage` | 实测（假模型；真实模型 Workbuddy/glm-5.3-flash：单轮 input 523/output 3；含工具调用的 3 轮合计 input 1736、output 67、cacheRead 768，缓存命中可计入） |
| 模型与思考级别 | 思考级别 `off/minimal/low/medium/high/xhigh/max`；`getSupportedThinkingLevels(model)`（pi-ai）给出每个模型支持的级别，例如 Workbuddy/glm-5.3-flash 只支持 `low/high/xhigh` | 实测 |
| 用户配置目录 | `getAgentDir()` = `~/.pi/agent`（`PI_CODING_AGENT_DIR` 可覆盖）；官方 preset 示例把全局配置放在这里，项目配置放在 `<cwd>/.pi/` | 实测；源码 |
| 内置工具参数 | `read{path}`、`write{path,content}`、`edit{path,edits[]}`、`bash{command}`、`grep{pattern,path?,glob?}`、`find{pattern,path?}`、`ls{path?}`；另有 `powershell` | 源码 |
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
27. **状态提交落在主工作区当前分支**（通常是 main），前缀 `flow-state:`。单个任务走完一轮约 13 个状态提交；如嫌多，后续可改为按阶段合并提交（需同时调整完整性校验）。

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

- **唯一写入口**：所有 `.flow/` 写入都经 `StateStore.transaction`。流程：取文件锁 → 重放未完成事务 → 校验 state.json 与事件日志头一致 → 执行回调暂存写入 → schema 校验 → 写事务日志 `tx.json` → 应用（临时文件 + rename）→ 追加事件 → 写 state.json → 删除事务日志 → `git commit`（前缀 `flow-state:`，只提交 `.flow/`，不影响用户已暂存的其他文件）。
- **事务必须附带事件**；无事件的写入被拒。
- **完整性**：事件带哈希链（键排序的规范 JSON + sha256）；每个事务的最后一条事件记录本事务写入的所有文件哈希（`entities`），以及 `active_flow` 的变化。`verifyIntegrity` 校验：哈希链、序号连续、state.json 的 head/version/active_flow、每个登记文件的哈希与 schema、`.flow/` 下是否存在未登记文件、是否存在未重放的事务日志。
- **facts 不采信调用方**：stage 是否 active、依赖状态、并发数、互斥、合并队列状态、handoff 与 evidence 是否存在、契约是否锁定，均由 StateStore 计算并覆盖调用方传入的同名字段。token、diff、verify 结果、rebase 结果等由程序内模块（M3/M4）提供。
- **乐观版本**：每个带 version 的文件写入时必须基于当前版本，自动加 1。
- **状态字段不可旁路**：`updateTask` 只能改 `lease`、`worktree`、`branch`、`base_sha`；status、attempts 等只能经转移表改变。
- **glob 关系判断**（`paths.ts`）：`globWithin` 保守（不确定判"不在内"），`globsOverlap` 保守（不确定判"重叠"）。

## 缓存提醒

- 2026-10-01（M8）：角色提示（scout、researcher、architect）变更，新增技能注入；升级后首次派发时提示缓存失效一次。
- 2026-10-01：新增 `agents/interviewer.md`（只用于主会话）；`agents/architect.md` 与 `skills/design-contract` 增加规则草案说明，architect 子进程的提示缓存失效一次。
- 以后修改 `agents/`、`rules/`、`skills/` 时，在此追加一条。
