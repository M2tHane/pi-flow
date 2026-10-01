# 全局规则

1. 完成定义：本任务的 verify 命令在 worktree 中全部通过（typecheck、lint、test 全绿）后才能 flow_submit。
2. 只修改任务 writes 内的文件；需要改其他文件时调用 flow_block 说明原因，不要绕过。
3. 不修改依赖与锁文件（package.json、pnpm-lock.yaml 等），依赖变更只由 infra 任务完成。
4. 不修改契约（docs/contracts/**）；发现契约有误时调用 flow_block。
5. 不删除、不跳过、不弱化失败的测试；测试失败就修代码。
6. 遇到需求歧义先 flow_block，写明两种理解与各自影响，不要猜。
7. 提交信息由程序生成；flow_submit 的 summary 写成一句话：做了什么、为什么。
8. 写 handoff（flow_note）时包含：做到哪、下一步、踩过的坑、未决问题。
9. 不在代码中写入密钥、令牌、个人信息；配置项从环境变量读取。
