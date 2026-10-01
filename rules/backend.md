# 后端规则

1. 分层与依赖方向：handler → service → repository；下层不得 import 上层。
2. handler 只做参数解析、调用 service、映射响应；业务逻辑一律放在 service。
3. 输入校验在 handler 入口用 shared 中的 schema 完成；service 假定输入已校验。
4. 错误统一使用 shared 中定义的错误类型；不得抛出裸字符串或通用 Error。
5. 对外错误响应只包含错误码与可读信息，不包含堆栈与内部细节。
6. 日志字段固定：level、msg、request_id、module；不得记录密钥、令牌与完整请求体。
7. 模块按目录自动发现（如 src/server/<模块>/routes.ts），不修改集中路由表或集中导出文件。
8. 数据库访问只经 repository；service 中不得出现 SQL 字符串。
9. 新增公共接口必须先在契约中存在；契约外的接口不得暴露。
