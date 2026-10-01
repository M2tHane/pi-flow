---
name: write-feature-spec
description: 撰写功能说明：目标、非目标、验收标准、受影响模块、是否需要改契约
---

# 撰写功能说明

1. 读 docs/PRD.md、docs/ARCHITECTURE.md 与相关契约，确认功能落在哪些模块。
2. 用 docs/features/_template.md 的结构写 docs/features/<名称>.md：
   - 目标与非目标各至少两条。
   - 验收标准：每条可被自动化测试验证。
   - 受影响模块：先写初步判断，F1 阶段由影响面分析补全。
   - 是否需要改契约：是/否；是则列出变更点。
3. 在 docs/PRD.md 的功能范围中追加一条，链接到功能说明。
4. 关键信息缺失时用 flow_block 一次问一个问题。
