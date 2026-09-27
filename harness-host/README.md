# Xiaoyin Harness Host

## 协议

Harness Host 通过 stdin/stdout 提供逐行 JSON-RPC 2.0。stdout 只输出协议消息，运行日志写入 stderr。

| 方法 | 用途 |
|---|---|
| `host.initialize` | 启动 Runtime 并完成初始化握手 |
| `host.health` | 返回 Runtime、版本和可选能力门控状态；未完成初始化时为 `uninitialized`，桌面健康探针会先完成 `host.initialize`，再读取该结果 |
| `session.run` | 执行 `{ "prompt": "...", "sessionId": "..." }` |
| `session.inspect` | 通过官方 Session Persistence 读取单个会话摘要和小胤投影 |
| `session.search` | 英文通过官方 Session Query SQLite FTS5 搜索；中文使用官方 `filterEvents` 进行字面量扫描，均支持不透明 `nextCursor` |
| `session.projection` | Harness 官方 Session Projection 的实时变更通知（Host -> 桌面） |
| `approval.respond` | 返回高风险工具调用的允许或拒绝结果 |
| `question.respond` | 返回普通问题、多选问题或计划审阅的结构化答案 |
| `host.shutdown` | 关闭 Host 和受管子进程 |

## 运行配置

| 环境变量 | 内容 |
|---|---|
| `DSH_CORDIS_CONFIG` | 完整 `sdk` Profile 的小胤覆盖配置路径 |
| `DSH_CUSTOM_SKILL_DIRS` | 通过桌面校验的 Skill 根目录 |
| `XIAOYIN_MCP_CONNECTORS` | 控制中心下发并由桌面筛选的 MCP 连接器；每项可配置 `reconnect.enabled`、`initialDelayMs`、`maxDelayMs` 和 `maxAttempts`，连接断开时保留上一组工具并指数退避重连 |
| `XIAOYIN_LOCAL_FILE_ROOTS` | 任务授权目录 ID 和路径映射 |
| `XIAOYIN_ALLOW_SHELL` | 小胤“本地 Shell 与持久终端”设置下发的能力开关；关闭时同时禁用 Bash、PowerShell、PTY 和工具终端 |
| `XIAOYIN_APPROVE_SHELL` | Shell 审批策略开关 |
| `XIAOYIN_EXECUTION_MODE` | `agent` 或官方持久化 `plan` 模式 |
| `DSH_PERMISSION_MODE` | `read-only`、`workspace-write` 或 `danger-full-access`，默认 `workspace-write` |
| `XIAOYIN_LSP_SERVERS` | LSP stdio server JSON 映射；未配置时不挂载 LSP |
| `XIAOYIN_ALLOW_LSP` | 小胤运行时设置下发的 LSP 总开关；设为 `false` 时即使存在 Server map 也不挂载 |
| `XIAOYIN_CODEX_HOOKS_CONFIG` | Codex Hooks 配置路径；未配置时不挂载 |
| `XIAOYIN_CLAUDE_HOOKS_CONFIG` | Claude Code Hooks 配置路径；未配置时不挂载 |
| `XIAOYIN_ALLOW_HOOKS` | 小胤运行时设置下发的 Hooks 总开关；默认关闭，设为 `false` 时强制禁用已配置 Hooks |
| `XIAOYIN_ENABLE_CODEX_SUBAGENT` | 显式启用 Codex 外部子 Agent |
| `XIAOYIN_ENABLE_CLAUDE_SUBAGENT` | 显式启用 Claude Code 外部子 Agent |
| `XIAOYIN_ACP_COMMAND` | 显式配置 ACP 子 Agent 命令 |
| `XIAOYIN_ENABLE_DSH_SUBAGENT` | 显式启用独立 DSH SDK 子 Agent |
| `XIAOYIN_ALLOW_EXTERNAL_AGENTS` | 小胤运行时设置下发的外部 Agent 总开关；默认关闭，设为 `false` 时强制禁用所有外部 Agent |
| `XIAOYIN_ENABLE_SESSION_QUERY_TOOLS` | Session Query 模型工具开关；默认开启，显式设置为 `false` 可用于故障隔离 |
| `XIAOYIN_ENABLE_SESSION_REFERENCES` | 官方跨会话 `dsh-session:` 引用开关；默认开启，显式设置为 `false` 可用于故障隔离 |

## 执行边界

- 审批和结构化问题桥只监听 `127.0.0.1`，每次启动使用随机 Bearer Token。
- 缺少桌面响应、用户拒绝、取消或超时都会停止对应的交互等待。
- MCP 工具使用显式白名单；专家套件声明的依赖用于路由和诊断，不会隐藏同一已授权连接器的其他工具。
- MCP 连接器统一由官方 `dsh-mcp-client` 管理 Client、Transport、工具发现和重连；小胤只在客户端启动前提供不可变能力快照与凭据，官方工具名使用 `mcp__<server>__<tool>`。
- 本地文件工具只访问 `XIAOYIN_LOCAL_FILE_ROOTS` 指定的目录。
- 没有显式授权目录时，模型可使用官方 `present` 在 Session filesystem 中声明交付文件；投影中的工作区 root ID 使用员工哈希命名以保持隔离。存在小胤授权目录时关闭该工具，交付统一走 `local_files_publish`，避免出现两套路径和授权模型。
- 默认沙箱为 `workspace-write` 且高风险调用需要确认；Plan 模式在官方 projection 中持久化，并动态拒绝修改型及未知工具。
- Shell 使用 Harness 的一次性 Bash/PowerShell 工具；需要跨调用保留状态或交互输入时，使用独立的持久 `terminal_*` 工具。macOS/Linux 使用 `bash`，Windows 使用 `pwsh`，后台发送复用 Jobs。
- Skill 先注入有预算的目录，完整 `SKILL.md` 按需加载，不随选择数量完整塞入上下文。
- 子 Agent 使用独立持久 Session，支持后台继续、消息、停止和状态查询；子 Agent 不递归委派。
- Goal、Todo、Jobs、自动压缩、Tool Result Pruner、Spill、Workflow、Ralph、Web Search/Fetch 和 AGENTS.md 指令由完整 `sdk` Profile 提供。
- LSP、Hooks 和外部 Agent 具有本机代码或进程权限，只在配置完整时挂载，不暴露不可用的伪能力。
- 遥测默认通过 `DSH_TELEMETRY_DISABLED=1` 关闭，避免企业会话被 Harness exporter 收集。
- Session Projection 由 Harness 的 `ctx.sessionProjections` 驱动；Host 仅转发经过本机随机 Bearer Token 验证的变更，桌面端不维护第二份持久会话事实源。
- 跨会话引用由 Harness `dsh-session-reference` 生成有界、不可变且标记为不可信的快照；它不会把小胤本地任务索引变成第二个 Session 事实源。
