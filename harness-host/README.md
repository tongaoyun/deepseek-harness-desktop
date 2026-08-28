# Xiaoyin Harness Host

桌面进程与 DeepSeek Harness 之间的隔离层。它自己通过 SDK 管理 Harness 子进程，对桌面暴露一行一个消息的 JSON-RPC 2.0 协议。

支持的方法：

- `host.health`
- `host.initialize`，启动 Runtime 并完成初始化握手，但不请求模型
- `session.run`，参数 `{ "prompt": "...", "sessionId": "..." }`
- `approval.respond`，桌面对一次高风险工具调用返回允许或拒绝
- `host.shutdown`

所有运行日志写入 stderr，stdout 只允许 JSON-RPC。Host 在 `127.0.0.1` 建立带随机 Bearer Token 的临时审批桥，将 Harness 标准审批请求转交 Tauri 原生确认；缺少桌面响应、拒绝、取消或超时均失败关闭。

运行时通过 `DSH_CUSTOM_SKILL_DIRS` 接收桌面端校验过的专家套件 Skill 根目录。`ERP_MCP_URL` 启用 ERP MCP Bridge；读工具直接使用，专家套件允许的写工具逐次审批。

`XIAOYIN_LOCAL_FILE_ROOTS` 只由 Tauri 注入本次任务已授权的目录。Local File Bridge 提供目录浏览、文本读写、建目录、复制、移动和删除；Document Bridge 解析和生成 DOCX/XLSX/PDF；Shell Bridge 仅在套件授权时运行受控前台命令。所有 Bridge 都重新校验真实路径边界和输入上限。
