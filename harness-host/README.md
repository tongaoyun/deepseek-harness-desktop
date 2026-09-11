# Xiaoyin Harness Host

## 协议

Harness Host 通过 stdin/stdout 提供逐行 JSON-RPC 2.0。stdout 只输出协议消息，运行日志写入 stderr。

| 方法 | 用途 |
|---|---|
| `host.initialize` | 启动 Runtime 并完成初始化握手 |
| `host.health` | 返回 Runtime 和本地能力状态 |
| `session.run` | 执行 `{ "prompt": "...", "sessionId": "..." }` |
| `approval.respond` | 返回高风险工具调用的允许或拒绝结果 |
| `question.respond` | 返回普通问题、多选问题或计划审阅的结构化答案 |
| `host.shutdown` | 关闭 Host 和受管子进程 |

## 运行配置

| 环境变量 | 内容 |
|---|---|
| `DSH_CORDIS_CONFIG` | 完整 `sdk` Profile 的小胤覆盖配置路径 |
| `DSH_CUSTOM_SKILL_DIRS` | 通过桌面校验的 Skill 根目录 |
| `XIAOYIN_MCP_CONNECTORS` | 控制中心下发并由桌面筛选的 MCP 连接器 |
| `XIAOYIN_LOCAL_FILE_ROOTS` | 任务授权目录 ID 和路径映射 |
| `XIAOYIN_ALLOW_SHELL` | Shell 能力开关 |
| `XIAOYIN_APPROVE_SHELL` | Shell 审批策略开关 |
| `XIAOYIN_EXECUTION_MODE` | `agent` 或官方持久化 `plan` 模式 |
| `DSH_PERMISSION_MODE` | `read-only`、`workspace-write` 或 `danger-full-access`，默认 `workspace-write` |
| `XIAOYIN_TOOLS_MODE` | `native`、`ptc` 或 `both`，PTC 默认不启用 |
| `XIAOYIN_LSP_SERVERS` | LSP stdio server JSON 映射；未配置时不挂载 LSP |
| `XIAOYIN_CODEX_HOOKS_CONFIG` | Codex Hooks 配置路径；未配置时不挂载 |
| `XIAOYIN_CLAUDE_HOOKS_CONFIG` | Claude Code Hooks 配置路径；未配置时不挂载 |
| `XIAOYIN_ENABLE_CODEX_SUBAGENT` | 显式启用 Codex 外部子 Agent |
| `XIAOYIN_ENABLE_CLAUDE_SUBAGENT` | 显式启用 Claude Code 外部子 Agent |
| `XIAOYIN_ACP_COMMAND` | 显式配置 ACP 子 Agent 命令 |
| `XIAOYIN_ENABLE_DSH_SUBAGENT` | 显式启用独立 DSH SDK 子 Agent |
| `XIAOYIN_ENABLE_SESSION_QUERY_TOOLS` | 实验性启用 Session Query 模型工具；rc.2 生命周期问题修复前保持关闭 |

## 执行边界

- 审批和结构化问题桥只监听 `127.0.0.1`，每次启动使用随机 Bearer Token。
- 缺少桌面响应、用户拒绝、取消或超时都会停止对应的交互等待。
- MCP 工具使用显式白名单；专家套件声明的依赖用于路由和诊断，不会隐藏同一已授权连接器的其他工具。
- 本地文件工具只访问 `XIAOYIN_LOCAL_FILE_ROOTS` 指定的目录。
- 默认沙箱为 `workspace-write` 且高风险调用需要确认；Plan 模式在官方 projection 中持久化，并动态拒绝修改型及未知工具。
- Shell 使用 Harness 完整 `sdk` 的持久 Terminal 和 Subprocess Runtime；macOS/Linux 使用 `bash`，Windows 使用 `pwsh`。
- Skill 先注入有预算的目录，完整 `SKILL.md` 按需加载，不随选择数量完整塞入上下文。
- 子 Agent 使用独立持久 Session，支持后台继续、消息、停止和状态查询；子 Agent 不递归委派。
- Goal、Todo、Jobs、自动压缩、Tool Result Pruner、Spill、Workflow、Ralph、Web Search/Fetch 和 AGENTS.md 指令由完整 `sdk` Profile 提供。
- PTC、LSP、Hooks 和外部 Agent 具有本机代码或进程权限，只在配置完整时挂载，不暴露不可用的伪能力。
- 遥测默认通过 `DSH_TELEMETRY_DISABLED=1` 关闭，避免企业会话被 Harness exporter 收集。
