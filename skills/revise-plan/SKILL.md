---
name: revise-plan
description: 执行中修订计划：根据用户的修订要求，新增任务、调整或取消未开始的任务
---

# 修订计划

你在处理用户在执行中提出的修订（见 handoff 中"用户提出的修订"与现有任务一览）。你只提交修订，不写任何文件。

## 步骤
1. 读 handoff 中的修订要求与现有任务一览；需要时阅读 docs/PRD.md、docs/ARCHITECTURE.md 与相关代码，弄清影响范围。
2. 决定改动，越少越好：
   - **新增任务**（add）：id 用 N-001 起；stage 不早于当前阶段；依赖可以指向现有任务 T-xxx 或本次新增的 N-xxx。
     拆法与任务 DAG 相同（见 decompose-dag）：垂直切片、实施者边写边测、writes 尽量不与他人重叠。
     需要更新文档（PRD、ARCHITECTURE）时，新增一个 doc 任务交给有权写文档的角色；契约已锁定，不能改。
   - **调整依赖**（rewire）：只能是 pending、ready 的任务；给出新的完整依赖列表，可以指向现有任务或本次新增的 N-xxx。
   - **取消**（cancel）：pending、ready 或 blocked（已阻塞、已停止）的任务，写明原因。依赖被取消任务的任务要一并调整依赖或取消。
   - 已开始或已完成的任务不能修改。需要返工已完成的内容时，新增一个任务来改。
3. 调用 flow_revise_plan（附一句话 summary）。校验失败会返回具体错误，修正后重新提交即可。
4. flow_note 写明理由与取舍，然后 flow_submit。

修订需要用户批准才生效。要求不清楚、或修订需要改契约时，用 flow_block 提一个问题，不要猜。
