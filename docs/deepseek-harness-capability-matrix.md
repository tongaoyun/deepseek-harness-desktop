# DeepSeek Harness 能力审计

审计对象是 `@deepseek-ai/dsh` / `sdk` profile `0.1.7-rc.2`，以实际安装依赖、
profile 合成结果和小胤覆盖层共同判断，不以 `package.json` 中的版本号代替运行时验收。

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
| Session Projection 与 Projection Cache | `session-projection`、`session-projection-cache` | Host 转发官方投影，小胤注册 `xiaoyin.product` 产品投影 |
| SQLite Session Query 索引 | `session-query-sqlite` | 配置为首次搜索时打开；模型查询工具另有开关，见下表 |
| 跨会话引用快照 | `dsh-session-reference` | 使用规范 `dsh-session:` 引用，由 Harness 读取有界、不可变且标记为不可信的来源快照；不改变小胤任务历史事实源 |
| 权限、沙箱、审批 | `sandbox`、`sandbox-policy`、`permission`、`approval` | 小胤桌面审批桥承接用户确认；依赖 `ctx.shell` 的 `permission` 预设服务在 Shell 关闭时不挂载 |
| 文件读取、编辑、搜索 | `fs-sandbox`、`tool-fs`、`tool-fs-search` | 首个授权目录是官方 Session cwd；小胤目录桥只处理第二个及后续授权目录 |
| Skill Registry 与按需加载 | `skill`、`skill-filesystem`、`tool-skill` | 小胤技能目录、安装、版本和能力快照保留为产品层 |
| Harness 命令与反馈 | `commands`、`command-feedback` | Harness 负责运行时命令注册和结果反馈；专家套件的 `Command` 仍由小胤目录与版本清单管理 |
| 子 Agent（进程内 spawn/fork） | `subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`tool-subagent*` | 子 Agent 使用独立 Session，默认禁止递归委派 |
| Todo、Goal | `tool-todo`、`goal`、`tool-goal` | 任务进度和目标通过 Harness 工具产生事件 |
| Workflow | `workflow-worker-thread`、`tool-workflow` | 模型可调用工作流；小胤不另建 DAG 引擎 |
| 自动压缩与工具结果裁剪 | `compaction-basic`、`tool-result-pruner`、`command-compact` | 长会话上下文由 Harness 管理，桌面回放仅负责恢复展示 |
| Token Meter | `token-meter` | 官方投影写入任务 Projection，桌面任务状态可显示用量摘要 |
| Jobs、后台工具 | `jobs`、`tool-jobs` | Harness 后台工具可用；小胤 Cron 产品仍使用自己的调度层 |
| 官方 Present 交付声明 | `dsh-tool-present`、`deliverables/presented` | 模型通过官方 Session filesystem 声明首个工作目录中的最终文件；投影转成员工可打开的 artifact |
| 官方附件 | `dsh-attachment-local` | 使用官方内容寻址存储、图片规范化、通用文件和完整性校验；`DSH_HOME` 按员工隔离 |
| MCP Resources | `dsh-mcp-resources` | 已配置 MCP 服务器时按需提供资源列表、模板列表和资源读取；无服务器时不增加工具 Token |
| Web Search / Fetch | `web`、`web-search-deepseek`、`web-fetch-http`、`tool-web` | `web_search`、`web_fetch` 已可用；不是浏览器自动化 |
| Spill、超时、重复调用提醒 | `spill-local`、`spill-policy`、`timeout-policy`、`repeat-tool-reminder` | 保护长输出和工具链异常 |
| 用户提问与计划模式 | `user-questions`、`tool-ask-user`、`plan-mode` | 小胤桌面桥接结构化问题和计划审阅 |
| Settings / Credentials | `settings`、`credentials`、`llm-retry` | Harness 负责运行时读取，并将文件固定在员工隔离的 `DSH_HOME`；账号、模型目录和企业权限仍由小胤服务端维护 |
| 遥测管线 | `session-telemetry-otel` | 运行时通过 `DSH_TELEMETRY_DISABLED=1` 明确关闭，企业会话不会默认外发 |

## 已接入但默认受控

| 能力 | 开关 | 当前默认 | 说明 |
| --- | --- | --- | --- |
| MCP 标准 Client | 当前任务选中的连接器快照 | 普通桌面任务不注册 MCP 服务器 | 所有 MCP 连接统一由官方 `dsh-mcp-client` 建立；小胤只负责快照白名单、员工授权和写操作策略，不维护第二套传输或发现协议。模型侧名称固定为 `mcp__<server>__<tool>` |
| Session Query 模型工具与桌面历史搜索 | `XIAOYIN_ENABLE_SESSION_QUERY_TOOLS=false` | 默认开启 | `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read` 直接使用官方工具；桌面 `session.search` 英文复用官方 SQLite FTS5，中文复用官方 `filterEvents` 字面量扫描；关闭模型工具不关闭桌面检索 |
| Ralph 循环 | `XIAOYIN_ENABLE_RALPH=true` | 关闭 | 直接使用官方 `tool-ralph`；只为明确的持续目标开启，避免普通办公任务进入无边界循环 |
| Codex / Claude Code Hooks | 小胤设置“Hooks” + `XIAOYIN_CODEX_HOOKS_CONFIG`、`XIAOYIN_CLAUDE_HOOKS_CONFIG` | 关闭 | 配置可执行本机命令，必须同时打开桌面总开关，默认不加载 |
| Shell / Persistent Terminal | 小胤设置“本地 Shell 与持久终端” -> `XIAOYIN_ALLOW_SHELL` | 默认开启，可在桌面设置关闭 | rc.2 由 `dsh-terminal` 管理持久 PTY，模型侧仅暴露对应平台的 `bash` 或 `pwsh`；不再暴露旧 `terminal_open/send/read/...` 工具 |
| Browser | `XIAOYIN_ALLOW_BROWSER=true` | 关闭 | 这是小胤自己的 browser plugin，不是 Harness Web Search |

## 小胤产品层，不应被 Harness 替代

| 产品能力 | Harness 复用部分 | 必须保留的小胤事实源 |
| --- | --- | --- |
| 专家套件 | Agent、Skill、Tool Filter、Session 能力装配 | 市场、版本、签名、安装、依赖闭包、组合规则和 `CapabilitySnapshot` |
| 技能 | Skill Registry、filesystem、按需注入 | 企业目录、审核、发布、安装、更新和启停 |
| 连接器 | Harness Tool Registry 和官方 MCP Resources 接收工具、资源调用 | MCP 目录、OAuth、员工权限、审计、重连和写操作核对；当前使用 `managed-mcp-plugin` + MCP SDK |
| 知识库 | `knowledge_list` / `knowledge_search` 作为 Harness tools | 小胤负责权限与统一 API，WeKnora 负责文档、索引、检索和引用来源 |
| 定时任务 | Harness Session、Turn、Checkpoint、Jobs 工具 | Cron、唤醒策略、执行历史、通知和本机生命周期 |
| IM 频道 | 复用 Session 执行和 Projection | 钉钉身份映射、去重、队列、结果回传和频道权限 |
| 附件展示 | `dsh-attachment-local` 产生不可变引用 | 桌面只按当前员工的 `DSH_HOME` 读取官方对象并展示，不再实现附件存储后端 |
| 浏览器/Computer Use | 无等价的完整 Harness 产品层 | `local-browser-plugin`、`local-computer-use-plugin` 和系统权限 |

## 尚未形成产品链路

以下包虽然在 `harness-host/package.json` 或 `dsh` 依赖闭包中可解析，但当前没有小胤产品入口，不能宣称“已接入”：

- `dsh-output-retention`：IM 文本附件预览复用官方 `TextRetainer`；Office 文件不再由小胤提前解析。通用 Harness 工具仍由 `tool-result-pruner` 和 spill 策略负责，裁剪数量与省略 Token 已由事件投影到任务摘要。
- `dsh-settings` 抽象层：运行时使用员工隔离的 `dsh-settings-file`；小胤设置页暂不直接编辑 Harness settings 文档，模型和账号配置仍走小胤服务端。
- 官方 Web Client (`dsh-web-app`)：提供浏览器 GUI、模型/设置页和会话历史，但小胤是 Tauri 桌面产品，不能直接把 Web Client 当成桌面能力。
- 可选 `str_replace_editor`、`tool-cordis`、实验性 Agent Team、Python Code Runtime、Webhook/GitHub 等：不在当前 `sdk` 合成层中，需明确产品场景和权限后再单独评估。

`dsh-tool-present` 始终挂载，负责首个工作目录的官方交付；`local_files_publish` 只负责第二个及后续授权目录。两者的目录归属互斥，不会对同一路径提供两套写入接口。

版本升级时用 `dsh --profile sdk --dump-config` 核对官方合成配置与小胤覆盖层，并运行 `pnpm check`。运行时能力以实际 Profile 启动结果为准，依赖存在不代表已授权或已启用。

## 桌面可见性

设置 → 本地能力只展示任务执行权限和按需启动状态，不展示 Harness 插件名称。登录、进入设置和切换权限都不会启动 Host；只有真实任务或用户在“高级设置与诊断”中主动检查时才启动。检查会执行与真实任务相同的 `host.initialize` 握手并读取 `host.health`，插件装载失败会在这里暴露。检查完成后，页面只显示当前 profile 真实挂载且允许员工配置的能力；原始能力状态仅写入不含会话、文件内容和凭据的诊断文件。

运行时页面提供“检查模型服务”操作，显式调用配置地址的标准 `/models` 元数据接口；请求不携带聊天内容，结果只返回可用、未授权或不可达及耗时，不保存响应正文。

设备心跳会在保留 `harness` 总体状态的同时，上报脱敏的 `harness.<capability>` 明细及 `READY / DEGRADED / UNSUPPORTED` 状态，供服务端做版本和能力差异诊断；不会上报 Prompt、会话内容、凭据或本机路径。
