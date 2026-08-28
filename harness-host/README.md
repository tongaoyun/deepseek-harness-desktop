# Xiaoyin Harness Host

桌面进程与 DeepSeek Harness 之间的隔离层。它自己通过 SDK 管理 Harness 子进程，对桌面暴露一行一个消息的 JSON-RPC 2.0 协议。

支持的方法：

- `host.health`
- `host.initialize`，启动 Runtime 并完成初始化握手，但不请求模型
- `session.run`，参数 `{ "prompt": "...", "sessionId": "..." }`
- `host.shutdown`

所有运行日志写入 stderr，stdout 只允许 JSON-RPC。当前安全基线不加载 Shell 或本地写文件工具。

运行时通过 `DSH_CUSTOM_SKILL_DIRS` 接收桌面端校验过的专家套件 Skill 根目录。`ERP_MCP_URL` 启用 ERP MCP Bridge；Bridge 只注册服务端明确声明 `readOnlyHint: true` 的工具，写工具在桌面审批桥完成前一律不进入 Harness。

`XIAOYIN_LOCAL_FILE_ROOTS` 只由 Tauri 注入本次任务已授权的目录。Local File Bridge 提供 `local_files_roots`、`local_files_list` 和 `local_files_read_text` 三个只读工具，并再次执行真实路径边界、类型和大小校验。
