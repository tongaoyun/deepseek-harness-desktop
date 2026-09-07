# Xiaoyin Harness Host

## 协议

Harness Host 通过 stdin/stdout 提供逐行 JSON-RPC 2.0。stdout 只输出协议消息，运行日志写入 stderr。

| 方法 | 用途 |
|---|---|
| `host.initialize` | 启动 Runtime 并完成初始化握手 |
| `host.health` | 返回 Runtime 和本地能力状态 |
| `session.run` | 执行 `{ "prompt": "...", "sessionId": "..." }` |
| `approval.respond` | 返回高风险工具调用的允许或拒绝结果 |
| `host.shutdown` | 关闭 Host 和受管子进程 |

## 运行配置

| 环境变量 | 内容 |
|---|---|
| `DSH_CORDIS_CONFIG` | Cordis 配置文件路径 |
| `DSH_CUSTOM_SKILL_DIRS` | 通过桌面校验的 Skill 根目录 |
| `XIAOYIN_MCP_CONNECTORS` | 控制中心下发并由桌面筛选的 MCP 连接器 |
| `XIAOYIN_LOCAL_FILE_ROOTS` | 任务授权目录 ID 和路径映射 |
| `XIAOYIN_ALLOW_SHELL` | Shell 能力开关 |
| `XIAOYIN_APPROVE_SHELL` | Shell 审批策略开关 |

## 执行边界

- 审批桥只监听 `127.0.0.1`，每次启动使用随机 Bearer Token。
- 缺少桌面响应、用户拒绝、取消或审批超时都会拒绝工具调用。
- MCP 工具使用显式白名单；专家套件要求的连接器不可用时终止任务。
- 本地文件工具只访问 `XIAOYIN_LOCAL_FILE_ROOTS` 指定的目录。
- Shell 使用 Harness 原生 Executor 和 Subprocess Runtime；macOS/Linux 使用 `bash`，Windows 使用 `pwsh`。
- Agent 支持 Workspace Context、Jobs、Goal 和最多 3 个并行子 Agent；子 Agent 不递归委派。
