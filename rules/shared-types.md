# 共享类型规则（schema-first）

1. 核心数据结构只在 src/shared 中定义一次（schema），类型、校验与文档都由 schema 派生。
2. 新增字段先改 schema，再改使用方；不得在各处临时定义同名结构。
3. 写新函数前先搜索现有实现（serena 或 codegraph）；同样逻辑出现超过两处必须抽取到共享位置。
4. 避免集中注册与集中导出文件（如 index.ts 汇总导出）；按路径直接引用。
5. 跨模块传递的数据只用 schema 派生的类型，不传递 any 或宽泛的 Record。
