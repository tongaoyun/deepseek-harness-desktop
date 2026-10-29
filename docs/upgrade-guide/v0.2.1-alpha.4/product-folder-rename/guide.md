---
kind: upgrade-guide
description: "产品连接器固定版本、资料写入回执与开发热更新的处理约定。"
---

# 产品执行与资料写入

## Change

连接器执行快照必须包含 `version`。旧产品快照缺少该字段时明确阻止执行；当前配置版本变化也阻止旧任务使用新端点。托管 MCP 请求必须携带 `X-Harness-Connector-Version`，服务端返回 409 `EXTENSION_VERSION_CONFLICT` 拒绝缺失或变化的版本。目录浏览不连接 MCP；运行时按依赖 ID 查询。

全部命令幂等键及回执永久保留，不按时间回收。知识引擎写入在调用远端前独立提交领取记录，成功与未知结果也独立提交；外层事务回滚或进程中断不再使原键重复执行。纯数据库文件夹创建和改名与其不可变回执共同提交，不受之后改名、删除影响。`IN_PROGRESS` 与 `UNKNOWN_EXTERNAL` 均阻止自动重发，应先核对远端结果。知识库保存结果未确认时可保留并关闭；本窗口按员工隔离保存草稿及原请求编号，相同入口重新打开时先恢复原操作。目录暂时失败保留原编辑器及在途保存，关闭窗口后不保证恢复，不应据此另行重复创建。

`knowledge.folders.rename` 必须提交 `expectedUpdatedAt` 和 `operationId`。文件夹响应必须含有 `updatedAt`。服务端 `PUT /api/v1/knowledge-bases/{baseId}/folders/{folderId}` 必须带 `Idempotency-Key`，正文包含 `name` 和 `expectedUpdatedAt`。缺少版本的旧请求不再接受，不提供兼容路径。

`knowledge.documents.move` 必须提交固定的 `operationId`、`expectedUpdatedAt` 和原目录 `expectedFolderId`，根目录为 `null`。服务端文档位置 PUT 使用同一 `Idempotency-Key`，移动目标、原目录和版本共同确定请求身份。过期页面返回 `KNOWLEDGE_DOCUMENT_CONFLICT`；已成功的重试仅重放回执，远端结果不明返回 `IDEMPOTENCY_OPERATION_UNKNOWN`，不会再次调用移动接口。应先刷新核对位置，再开始另一操作。产品文档写入共用数据库文档锁；WeKnora 后台直接写入没有远端条件更新，不在原子并发保证范围内。

开发环境在客户端插件替换前卸载 React 根，期间显示现有启动页面，所有插件激活后重新挂载。加载失败保留具体插件诊断，重试成功后恢复页面。此处理不改变官方 Session 数据格式。

## Migration

1. 先更新产品服务端，再更新桌面和控制中心。现有知识库、文档和 Session 无需迁移。
2. 从文件夹响应捕获 `updatedAt`，同次改名的重试保留版本、名称和操作编号。
3. 验证过期版本返回 `KNOWLEDGE_FOLDER_CHANGED`；已成功的原请求重试不会覆盖后续改名。
4. 文档移动从读取响应固定版本及原目录，同一操作的重试不得修改目标或编号；桌面与控制中心在首次提交后锁定目标选择，取消后可刷新目录再选择。
5. 执行服务端 `V60__retain_unresolved_command_receipts.sql` 和 `V61__retain_all_command_receipts.sql` 迁移，保留所有命令回执并删除过期字段。已被旧版本清理的回执无法重建，须先核对真实资源，不自动补发。更新桌面后，为缺少连接器版本或版本变化的任务创建新对话；原历史保留，不提供旧产品快照兼容逻辑。
