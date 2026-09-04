# 小胤桌面架构

## 组件

```text
React 工作台
  │ Tauri Command / Event
Tauri 原生层
  ├─ ERP 登录、系统凭据和权限审批
  ├─ 本地文件、扩展安装、SQLite 和自动更新
  └─ Harness Host 与本地 IM 进程管理
  │ JSON-RPC 2.0 / stdio
DeepSeek Harness Host
  ├─ Skills、MCP、知识库和会话
  ├─ 文件、Office、Shell、Jobs、Goal 和 Computer Use
  └─ 钉钉 Stream、消息队列和任务接管
  │ HTTP(S)
控制中心
  ├─ Bootstrap、模型、扩展、知识库、记忆和审计
  ├─ Temporal 定时任务和 MinIO 制品授权
  └─ LiteLLM、ERP MCP 与 Nacos MCP Registry
```

桌面只访问 Bootstrap 下发的业务端点和制品 URL，不访问 Nacos、Temporal、PostgreSQL 或 MinIO 管理接口。

## 运行链路

| 场景 | 链路 |
|---|---|
| 登录 | 钉钉扫码 → ERP WebView Cookie → 公司身份校验 → 桌面会话 |
| 对话 | 命令、Skill、连接器和知识库选择 → 能力快照 → Tauri 校验 → Harness → 模型/MCP/本地工具 → 任务时间线 |
| 任务恢复 | Host 健康探测 → 失败分类 → 进程清理 → 新会话重试 |
| 本地文件 | 原生授权 → 任务目录 ID → Harness 文件或 Office 工具 → 本地预览和变更卡片 |
| 扩展安装 | 控制中心目录 → 制品下载 → SHA-256、Manifest 和路径校验 → 版本目录 |
| 连接器 | 员工启用 → MCP 握手和工具清单诊断 → 新任务能力快照 |
| 定时任务 | 桌面 → 控制中心 → Temporal → Workflow Worker → 运行记录和制品 |
| 钉钉 | DingTalk Stream → 本地队列和会话 → Harness；`/bind` 将会话绑定到桌面任务 |
| 审计 | 桌面或服务端 → 去敏事件 API → PostgreSQL |

## 能力矩阵

| 领域 | 能力 |
|---|---|
| 身份与模型 | ERP 扫码登录、控制中心模型目录、LiteLLM |
| 任务 | SQLite 会话、搜索、归档、流式回复、取消、失败重试、产物和执行时间线 |
| Agent | Workspace Context、后台 Jobs、持久 Goal、最多 3 个并行子 Agent |
| 扩展 | 专家套件、独立 Skill、ZIP/tar.gz 导入、定制副本、ZIP 导出 |
| 连接器 | Streamable HTTP/SSE、员工级启停、工具白名单、诊断和能力快照 |
| 本地工具 | 文件、DOCX、XLSX、PPTX、PDF、Bash/PowerShell、浏览器和 Computer Use |
| 知识与记忆 | 个人/团队/公司知识库、来源引用、记忆确认、导入和导出 |
| 云端任务 | Temporal 定时任务、执行预览、失败通知、运行记录和制品下载 |
| IM | 钉钉 Stream、开放/配对模式、持久队列、任务接管、附件和产物回传 |

## 平台支持

| 平台 | 构建 | 发布方式 | 限制 |
|---|---|---|---|
| Windows x64 | Windows Runner | MSI、NSIS、Tauri Updater | 安装包不含 Authenticode 签名 |
| macOS arm64 | `macos-arm64` Runner | 临时签名 DMG、流水线制品 | 不含 Apple 公证和自动更新 |
| macOS x64 | 构建脚本按 `x86_64` 选择 Node 和产物架构 | 需要 Intel Runner | Gitea 未配置 Intel Runner |

Computer Use 依赖可交互桌面，不在锁屏会话或 Windows Session 0 中运行。ERP MCP 工具为只读工具。IM 支持钉钉；飞书、Lark、微信和企业微信不在桌面连接器列表中。

## 安全规则

- 专家套件和 Skill 只声明连接器 ID、工具和知识库引用，不携带地址或凭据。
- 任务只使用员工启用且诊断就绪的连接器；能力快照在任务创建时固定。
- 本地工具只访问任务授权目录，并拒绝目录穿越、越界符号链接和敏感文件。
- 删除、高危 Shell 和破坏性 MCP 调用必须经过原生确认。
- 模型凭据、员工令牌和 IM Secret 只进入受控进程或系统凭据库。
- UI、设备报告和审计不保存隐藏推理、工具参数、业务原文、令牌或绝对路径。
- 云端无人值守任务不执行声明为破坏性的 MCP 工具。
- ERP Cookie 只保存在系统 WebView 中，不进入 Harness 或控制中心。

## 相关仓库

| 仓库 | 职责 |
|---|---|
| `xiaoyin-desktop` | 桌面应用、Harness、本地工具和本地 IM |
| `xiaoyin-server` | 控制中心和 Workflow Worker |
| `xiaoyin-extensions` | SDK、专家套件、Skills 和模板 |
| `erp-mcp-gateway` | ERP MCP 工具开发与运行入口 |
