# xiaoyin-desktop

小胤企业桌面端。当前发布 Windows x64 安装包。React 提供工作台，Tauri 管理本地权限和进程，`harness-host` 运行 DeepSeek Harness、Skills、MCP 与本地工具。

## 目录

| 目录 | 职责 |
|---|---|
| `src/` | 工作台、扩展中心、任务与管理页面 |
| `src-tauri/` | 原生登录、权限、审批、安装器和自动更新 |
| `harness-host/` | Agent Runtime、MCP Client、本地工具和钉钉频道 |
| `scripts/` | Windows Runtime、构建、烟测与发布脚本 |

架构、请求链路、能力和边界见 [架构与能力](docs/architecture.md)。

## 能力

- ERP 扫码登录、LiteLLM 模型选择、个人记忆和本机 SQLite 会话。
- 专家套件、独立 Skill、Nacos MCP 连接器和个人、团队、公司知识库。
- `/` 调用命令或 Skill，`@` 挂载知识库；任务启动时固化能力快照。
- 结构化 Task Monitor，实时展示执行计划、工具状态、能力快照和由工具结果确认的产物。
- 本地文件、DOCX/XLSX/PPTX/PDF、Harness 原生 Bash/PowerShell、后台 Jobs、持久 Goal、工作区指令、自动多 Agent 并行委派、Computer Use，以及支持持久登录、多标签、下载和人工接管的语义浏览器。
- 自然语言创建 Temporal 定时任务、执行记录、失败通知和产物下载；桌面关闭后任务继续运行。
- 本地钉钉 Stream、`/bind` 桌面任务接管、完整会话/步骤/产物同步、图片与文档附件理解、生成文件回传和定时任务精准推送。
- MCP 握手、Tool 清单诊断、设备能力检测、反馈、后台去敏审计上报和正式版自动更新。

## 安全边界

- 桌面只使用控制中心下发的地址和制品 URL，不自行查询 Nacos、Temporal、PostgreSQL 或 MinIO 管理接口。
- 套件和 Skill 必须通过版本、SHA-256、Manifest、权限和路径校验。
- 写文件、生成文档、Shell、Computer Use 和业务写工具严格执行专家套件声明的 `deny`、`approval`、`allow`。
- 模型凭据、员工令牌和钉钉 Secret 不进入前端日志或业务制品。
- UI 只展示安全执行阶段，不展示隐藏推理、工具参数或业务返回原文。

## 本地开发

要求 Node.js 24.19.0、pnpm 10.33.0、Rust 1.97+。

```bash
pnpm install
pnpm check
pnpm tauri:dev
```

默认控制中心为 `http://192.168.2.67:30081`。开发环境可通过 `VITE_CONTROL_PLANE_BASE_URL` 覆盖。浏览器模式仅用于界面开发；ERP Cookie、系统权限和本地 IM 必须在 Tauri 中验证。

## 构建与验收

Gitea 统一为「代码检查」「macOS 安装包」「Windows 安装包」「版本回退」四个入口。参数、缓存及并发规则见 [构建工作流](docs/build-workflows.md)。

| 平台 | 命令或工作流 | 输出 |
|---|---|---|
| Windows x64 调试 | `pnpm tauri:dev` | 本地应用 |
| Windows x64 快速安装验证 | `Windows 安装包`，选择 `quick` | Debug NSIS，仅开发验证 |
| Windows x64 完整安装验证 | `Windows 安装包`，选择 `release` | MSI、NSIS、Updater 文件 |
| macOS Apple Silicon / Intel | `macOS 安装包`，选择 `arm64` / `x64` / `all` | `.app`、`.dmg`、Updater 文件、SHA-256 |

macOS 构建按目标架构准备固定版本的 Node.js 和 Harness Runtime，并验证最终 DMG、原生依赖、Harness 与更新包签名。公共质量检查只跑一次，正式标签顺序构建双架构，通过后发布独立 Mac 更新索引。安装包最低要求 macOS 14，使用内部分发临时签名，尚无 Apple 公证；完整安装和升级仍需验收。详见 [macOS 更新](docs/macos-updates.md)。

## 发布

发布前同步更新以下版本：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

推送 `v*` 标签会运行 Windows 和 macOS 安装包工作流。Windows Updater 需要以下 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Updater 私钥只保存在 Actions Secrets 和受保护备份中，不提交到仓库、`.env` 或安装包。Windows 更新索引回退使用「版本回退」工作流。
