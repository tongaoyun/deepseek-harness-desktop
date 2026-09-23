# DeepSeek Harness 能力审计

审计对象是 `@deepseek-ai/dsh` / `sdk` profile `0.1.5-rc.2`，不是只看
`harness-host/package.json` 的直接依赖。`sdk` 实际由 `dsh-base` + `dsh-sdk-app`
组合而成，因此必须以官方 profile patch 合成结果和小胤自己的覆盖层共同判断。

## 结论

| 状态 | 含义 |
| --- | --- |
| 已接入并启用 | 官方运行时行会被挂载，当前小胤任务可以使用 |
| 已接入但受开关控制 | 代码和配置链路存在，默认不暴露或依赖运行环境 |
| 小胤产品层 | 执行通过 Harness 工具完成，但目录、权限、OAuth、业务规则由小胤维护 |
| 已安装但未挂载 | 包在依赖闭包中，但当前 profile 没有对应运行时行 |

## 已接入并启用

| 能力 | 证据/运行时行 | 小胤使用方式 |
| --- | --- | --- |
| DeepSeek LLM、Agent Loop、SDK JSON-RPC | `llm-deepseek`、`agent-loop`、`sdk-jsonrpc-server` | `harness-host/src/runtime.ts` 驱动 Session Turn |
| Session 持久化与恢复 | `session-persistence-jsonl`、`session-checkpoint-policy` | 会话以 Harness `sessionId` 为事实源；桌面恢复通过官方 Persistence `stat/open/read` 查询 |
| Session Projection 与 Projection Cache | `session-projection`、`session-projection-cache` | Host 转发官方投影，小胤注册 `xiaoyin.task` 产品投影 |
| SQLite Session Query 索引 | `session-query-sqlite` | 配置为首次搜索时打开；模型查询工具另有开关，见下表 |
| 跨会话引用快照 | `dsh-session-reference` | 使用规范 `dsh-session:` 引用，由 Harness 读取有界、不可变且标记为不可信的来源快照；不改变小胤任务历史事实源 |
| 权限、沙箱、审批 | `sandbox`、`sandbox-policy`、`permission`、`approval` | 小胤桌面审批桥承接用户确认；依赖 `ctx.shell` 的 `permission` 预设服务在 Shell 关闭时不挂载 |
| 文件读取、编辑、搜索 | `fs-sandbox`、`tool-fs`、`tool-fs-search` | 无授权目录的任务使用 Harness；有多目录授权时隐藏官方工具，仅暴露小胤策略适配，避免两套 API 同时出现 |
| Skill Registry 与按需加载 | `skill`、`skill-filesystem`、`tool-skill` | 小胤技能目录、安装、版本和能力快照保留为产品层 |
| Harness 命令与反馈 | `commands`、`command-feedback` | Harness 负责运行时命令注册和结果反馈；专家套件的 `Command` 仍由小胤目录与版本清单管理 |
| 子 Agent（进程内 spawn/fork） | `subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`tool-subagent*` | 子 Agent 使用独立 Session，默认禁止递归委派 |
| Todo、Goal、Ralph | `tool-todo`、`goal`、`tool-goal`、`tool-ralph` | 任务进度和目标通过 Harness 工具产生事件 |
| Workflow | `workflow-worker-thread`、`tool-workflow` | 模型可调用工作流；小胤不另建 DAG 引擎 |
| 自动压缩与工具结果裁剪 | `compaction-basic`、`tool-result-pruner`、`command-compact` | 长会话上下文由 Harness 管理，桌面回放仅负责恢复展示 |
| Token Meter | `token-meter` | 官方投影写入任务 Projection，桌面任务状态可显示用量摘要 |
| Jobs、后台工具 | `jobs`、`tool-jobs` | Harness 后台工具可用；小胤 Cron 产品仍使用自己的调度层 |
| Session-local Reminders | `dsh-schedule`、`schedule_create/list/delete` | 同一 Session 内的提醒交给 Harness 持久化和 follow-up；不承担 Cron、冷 Session 唤醒或 IM/推送 |
| 官方 Present 交付声明 | `dsh-tool-present`、`deliverables/presented` | 无小胤显式授权目录时，模型通过官方 Session filesystem 声明最终文件；投影转成员工哈希命名的 `harness-workspace-*` artifact。 |
| Web Search / Fetch | `web`、`web-search-deepseek`、`web-fetch-http`、`tool-web` | `web_search`、`web_fetch` 已可用；不是浏览器自动化 |
| Spill、超时、重复调用提醒 | `spill-local`、`spill-policy`、`timeout-policy`、`repeat-tool-reminder` | 保护长输出和工具链异常 |
| 用户提问与计划模式 | `user-questions`、`tool-ask-user`、`plan-mode` | 小胤桌面桥接结构化问题和计划审阅 |
| Settings / Credentials | `settings`、`credentials`、`llm-retry` | Harness 负责运行时读取，并将文件固定在员工隔离的 `DSH_HOME`；账号、模型目录和企业权限仍由小胤服务端维护 |
| 遥测管线 | `session-telemetry-otel` | 运行时通过 `DSH_TELEMETRY_DISABLED=1` 明确关闭，企业会话不会默认外发 |

## 已接入但默认受控

| 能力 | 开关 | 当前默认 | 说明 |
| --- | --- | --- | --- |
| MCP 标准 Client | `XIAOYIN_MCP_IMPLEMENTATION=harness` 且连接器无白名单、无需写审批或审计 | 普通桌面任务不使用 | 官方 `dsh-mcp-client` 代码路径已接入，但当前任务连接器都带白名单和写审批，仍走小胤适配；不能为了复用绕过产品权限 |
| Session Query 模型工具与桌面历史搜索 | `XIAOYIN_ENABLE_SESSION_QUERY_TOOLS=false` | 默认开启 | `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read` 通过小胤兼容层注册；桌面 `session.search` 英文复用官方 SQLite FTS5，中文复用官方 `filterEvents` 字面量扫描；关闭模型工具不关闭桌面检索 |
| Code Runtime / PTC | `XIAOYIN_TOOLS_MODE=ptc\|both` | `native` | Worker Thread 执行模型生成的 TypeScript，权限接近 Bash，须单独选择 PTC；关闭 Shell 不会自动关闭 PTC，两个设置是独立授权边界 |
| LSP | 小胤设置“LSP 语言服务” + `XIAOYIN_LSP_SERVERS` | 未配置 | 开关开启且提供包含 `command` 与 `extensionToLanguage` 的明确 server map 才挂载 `dsh-lsp`、stdio transport 和 `tool-lsp`；桌面不猜测可执行文件 |
| Codex / Claude Code Hooks | 小胤设置“Hooks” + `XIAOYIN_CODEX_HOOKS_CONFIG`、`XIAOYIN_CLAUDE_HOOKS_CONFIG` | 关闭 | 配置可执行本机命令，必须同时打开桌面总开关，默认不加载 |
| 外部 Codex / Claude / ACP / DSH 子 Agent | 小胤设置“外部 Agent” + 对应 `XIAOYIN_ENABLE_*` 或 `XIAOYIN_ACP_COMMAND` | 关闭 | 必须同时通过桌面总开关和外部进程配置，才向模型暴露静态工具；默认不启动本机进程 |
| Shell / Persistent Terminal | 小胤设置“本地 Shell 与持久终端” -> `XIAOYIN_ALLOW_SHELL` | 默认开启，可在桌面设置关闭 | Bash/PowerShell 一次性工具与持久 PTY 分开；共享同一显式授权边界，均受小胤审批和目录策略约束；运行时分别报告 `shell` 与 `persistentTerminal` |
| Browser | `XIAOYIN_ALLOW_BROWSER=true` | 关闭 | 这是小胤自己的 browser plugin，不是 Harness Web Search |

## 小胤产品层，不应被 Harness 替代

| 产品能力 | Harness 复用部分 | 必须保留的小胤事实源 |
| --- | --- | --- |
| 专家套件 | Agent、Skill、Tool Filter、Session 能力装配 | 市场、版本、签名、安装、依赖闭包、组合规则和 `CapabilitySnapshot` |
| 技能 | Skill Registry、filesystem、按需注入 | 企业目录、审核、发布、安装、更新和启停 |
| 连接器 | Harness Tool Registry 接收工具调用事件 | MCP 目录、OAuth、员工权限、审计、重连和写操作核对；当前使用 `managed-mcp-plugin` + MCP SDK |
| 知识库 | `knowledge_list` / `knowledge_search` 作为 Harness tools | 小胤负责权限与统一 API，WeKnora 负责文档、索引、检索和引用来源 |
| 定时任务 | Harness Session、Turn、Checkpoint、Jobs 工具 | Cron、唤醒策略、执行历史、通知和本机生命周期 |
| IM 频道 | 复用 Session 执行和 Projection | 钉钉身份映射、去重、队列、结果回传和频道权限 |
| 附件 | Harness Session 可保存引用 | 小胤 content-addressed backend 实现 Harness `AttachmentStore` 抽象，按员工隔离二进制缓存；官方 `attachment-local` 被显式禁用，避免双存储 |
| 浏览器/Computer Use | 无等价的完整 Harness 产品层 | `local-browser-plugin`、`local-computer-use-plugin` 和系统权限 |

## 尚未形成产品链路

以下包虽然在 `harness-host/package.json` 或 `dsh` 依赖闭包中可解析，但当前没有小胤产品入口，不能宣称“已接入”：

- `dsh-output-retention`：Office 文档解析等小胤工具直接复用官方 `TextRetainer`；通用 Harness 工具仍由 `tool-result-pruner` 和 spill 策略负责，裁剪数量与省略 Token 已由事件投影到任务摘要。
- `dsh-settings` 抽象层：运行时使用员工隔离的 `dsh-settings-file`；小胤设置页暂不直接编辑 Harness settings 文档，模型和账号配置仍走小胤服务端。
- `dsh-attachment` 官方抽象和 `dsh-fs` 普通文件后端：被小胤自己的附件/目录授权实现覆盖，不能与现有 provider 并挂。
- 官方 Web Client (`dsh-web-app`)：提供浏览器 GUI、模型/设置页和会话历史，但小胤是 Tauri 桌面产品，不能直接把 Web Client 当成桌面能力。
- 可选 `str_replace_editor`、`tool-cordis`、实验性 Agent Team、Python Code Runtime、Webhook/GitHub 等：不在当前 `sdk` 合成层中，需明确产品场景和权限后再单独评估。

`dsh-tool-present` 已挂载，但受文件系统策略控制：存在 `XIAOYIN_LOCAL_FILE_ROOTS` 时关闭，由 `local_files_publish` 负责产品目录授权和交付；没有显式授权目录时才使用官方 Session filesystem。

版本升级时用 `dsh --profile sdk --dump-config` 核对官方合成配置与小胤覆盖层，并运行 `pnpm check`。运行时能力以实际 Profile 启动结果为准，依赖存在不代表已授权或已启用。

## 桌面可见性

设置 → 本地能力只展示任务执行权限和按需启动状态，不展示 Harness 插件名称。登录、进入设置和切换权限都不会启动 Host；只有真实任务或用户在“高级设置与诊断”中主动检查时才启动。检查会执行与真实任务相同的 `host.initialize` 握手并读取 `host.health`，插件装载失败会在这里暴露。检查完成后，页面只按实际配置显示语言服务、Hooks 和外部协作 Agent 等产品化开关；原始能力状态仅写入不含会话、文件内容和凭据的诊断文件。

运行时页面提供“检查模型服务”操作，显式调用配置地址的标准 `/models` 元数据接口；请求不携带聊天内容，结果只返回可用、未授权或不可达及耗时，不保存响应正文。

设备心跳会在保留 `harness` 总体状态的同时，上报脱敏的 `harness.<capability>` 明细及 `READY / DEGRADED / UNSUPPORTED` 状态，供服务端做版本和能力差异诊断；不会上报 Prompt、会话内容、凭据或本机路径。
