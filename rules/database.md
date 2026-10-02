# 数据库规则

## 迁移
1. 结构变更只经迁移；业务代码中不执行建表、改表语句。
2. 迁移只增不改：已合入的迁移文件不得修改或删除。
3. 迁移文件名使用时间戳：YYYYMMDDHHMMSS_<动作>_<对象>（或框架等价形式）。
4. 每个迁移都提供可执行的回滚；无法回滚的变更须在 handoff 中说明并 flow_block 请用户确认。
5. SQL 尽量幂等（IF NOT EXISTS / IF EXISTS）；大表数据迁移分批执行。
6. 大表变更（加非空列、改类型）分多步：加可空列 → 回填 → 加约束。

## 命名与字段
7. 表名用复数蛇形（order_items），列名用蛇形，主键统一为 id。
8. 关联列命名为 <被引用表单数>_id；是否使用外键约束、主键生成方式以 ARCHITECTURE.md 为准。
9. 布尔列用 is_ / has_ 前缀，时间列用 _at 后缀并带时区；统一有 created_at、updated_at。
10. 列名避开 SQL 保留字与易混淆的词（type、order、key、value、index、data、metadata 等），改用具体名称（order_type、sort_order）。
11. 用于过滤、连接的列都要有索引；唯一约束用唯一索引表达。
