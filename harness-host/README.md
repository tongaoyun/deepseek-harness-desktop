# Xiaoyin Harness Host

桌面进程与 DeepSeek Harness 之间的隔离层。它自己通过 SDK 管理 Harness 子进程，对桌面暴露一行一个消息的 JSON-RPC 2.0 协议。

支持的方法：

- `host.health`
- `host.initialize`，启动 Runtime 并完成初始化握手，但不请求模型
- `session.run`，参数 `{ "prompt": "...", "sessionId": "..." }`
- `host.shutdown`

所有运行日志写入 stderr，stdout 只允许 JSON-RPC。当前安全基线不加载 Shell 或本地写文件工具；这些能力必须通过桌面授权代理接入。

运行时通过 `DSH_CUSTOM_SKILL_DIRS` 接收桌面端校验过的专家套件 Skill 根目录。`ERP_MCP_URL` 启用 ERP MCP Bridge；Bridge 只注册服务端明确声明 `readOnlyHint: true` 的工具，写工具在桌面审批桥完成前一律不进入 Harness。
