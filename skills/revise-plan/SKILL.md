---
name: revise-plan
description: 实施中修订模块计划：分析影响 → 新增模块或修改任务 → 调整或取消未开始的模块
---

# 修订计划

你在处理实施阶段的修订（见 handoff 中"用户提出的修订"与现有任务一览）：可能是用户追加或改了需求，也可能是实现者发现模块划分不对而阻塞。
你只提交修订（flow_revise_plan），修订需要用户批准才生效。

## 步骤
1. **分析影响**：读修订要求、需求说明、docs/modules.md、docs/interfaces/ 与相关代码（codegraph 查调用关系），写清楚要改什么、影响哪些模块，
   受影响的任务分三类：已完成的、进行中的、未开始（pending、ready、blocked）的。写进 impact。
2. **处理受影响的任务**（越少越好）：
   - 未开始的：调整依赖（rewire），或取消（cancel，写明原因）后新增一个按新要求实现的模块。
   - 进行中的：不能取消。让它做完，再新增一个修改任务硬依赖它；也可以请用户用 /flow-add --task 直接把要求送给它。
   - 已完成的：新增修改任务（例如"知识库：检索结果加上高亮"）。
3. **新增任务**：id 用 N-001 起；stage 为实施阶段；kind 为 impl，角色 implementer，scopes [code]；
   writes 写具体目录，几个模块都会改的文件放进 shared；acceptance 只写能用代码测试或命令验证的（独立验收者会逐条确认）；界面与软件层面的测试和验收写进 manual_checks，由用户做（agent 不打开桌面应用与浏览器）；按大小填 size（S、M、L）；
   verify 用 [test]；依赖写 reason。
4. 需要改模块之间的接口时，在新增任务的验收标准里写明，并把 docs/interfaces/ 下的文件放进它的 writes。
