---
name: revise-plan
description: 执行中修订计划：分析影响 → 改 API 文档 → 取消受影响的未开始任务 → 新增任务
---

# 修订计划

你在处理执行中的修订（见 handoff 中"用户提出的修订"与现有任务一览）：可能是用户改了需求，也可能是实施者发现
API 文档有缺口、或上游的测试写错而阻塞。你只提交修订，不写任何文件；修订需要用户批准才生效。

## 步骤

1. **分析影响**。读修订要求、docs/PRD.md、docs/ARCHITECTURE.md、docs/contracts/ 与相关代码
   （可用 codegraph 查调用关系、serena 查符号引用），写清楚：
   - 要改哪些 API 接口、数据格式、错误码；
   - 影响哪些模块；
   - 受影响的任务分三类：已完成的、进行中的、未开始（pending、ready、blocked）的。
   这段分析写进 flow_revise_plan 的 impact，用户批准时会看到。

2. **先改 API 文档**。需要改 docs/contracts/ 时，新增一个改文档的任务：
   kind 为 doc，角色 architect，contract_change 为 true，writes 只写 docs/ 下要改的文件，
   验收标准逐条写明接口怎么改。契约已锁定，只有这种任务能改它。需要改 PRD、ARCHITECTURE 时也放在这个任务里。

3. **处理受影响的任务**（越少越好）：
   - 未开始的：取消（cancel，写明原因），改为新增按新文档实现的任务；或只调整依赖（rewire）。
   - 进行中的：不能取消。让它做完，再新增一个修改任务硬依赖它。
   - 已完成的：新增修改任务（例如"按新接口修改账户模块"）。
   - 所有按新文档实现的任务，都硬依赖第 2 步的改文档任务；依赖被取消任务的任务要一并调整或取消。

4. **新增任务**的规则与任务 DAG 相同（见 decompose-dag）：id 用 N-001 起；stage 不早于当前阶段；
   垂直切片、实施者边写边测、writes 尽量不与他人重叠；依赖可以指向现有任务 T-xxx 或本次新增的 N-xxx。

5. 调用 flow_revise_plan（summary 一句话，impact 写第 1 步的分析）。校验失败会返回具体错误，修正后重新提交。

6. flow_note 写明理由与取舍，然后 flow_submit。

修订要求本身不清楚时，用 flow_block 提一个问题，不要猜。
