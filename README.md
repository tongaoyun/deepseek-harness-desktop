# 小胤桌面端

面向员工的桌面工作助手。小胤管理专家套件、技能、连接器、知识库、定时任务和 IM 频道；DeepSeek Harness 执行会话、工具调用、权限审批和任务恢复。

## 仓库职责

| 仓库 | 负责什么 |
| --- | --- |
| `xiaoyin-desktop` | 桌面、任务执行、本地文件、Office、定时任务和钉钉 |
| `xiaoyin-server` | 企业控制台；Skill、专家套件的审核与分发；连接器目录；知识库存储、索引与检索；审计和记忆同步 |
| `xiaoyin-extensions` | 官方 Skill、专家套件的源码、规范和发布工具 |
| `erp-mcp-gateway` | ERP 业务工具与 Nacos MCP 注册 |

## 开发

环境：Node.js 24.19.0、pnpm 10.33.0、Rust 1.97+。Windows 需要 Visual C++ Build Tools；macOS 需要 Xcode Command Line Tools。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm tauri:dev
```

服务端 API 默认使用公司内网地址 `http://192.168.2.67:30081`，开发和正式安装包都无需额外配置。需要切换环境时可通过 `VITE_XIAOYIN_SERVER_URL` 覆盖；正式构建仅允许 HTTPS、回环地址或 RFC1918 私网 IP。`pnpm tauri dev/build` 会把实际地址的 origin 同步加入桌面 CSP；不要绕过仓库脚本直接调用 Tauri CLI。

浏览器预览使用本地开发身份。桌面开发可在未提交的 `.env.local` 中设置 `VITE_SKIP_DINGTALK_LOGIN=true`；正式构建始终使用钉钉登录。模型调用与企业目录需要对应服务可达。本机权限、凭据、文件、Harness 和 IM 在 Tauri 中验证。

## 代码目录

| 目录 | 内容 |
| --- | --- |
| `src/` | React 工作台、交互与任务状态 |
| `src-tauri/` | 原生权限、凭据、SQLite、扩展安装和进程管理 |
| `harness-host/` | Agent 运行时、Skills、MCP、本地工具和钉钉 |
| `scripts/` | 构建、运行时准备、安装包和验收脚本 |
| `.gitea/workflows/` | CI、安装包与更新发布 |

## 构建发布

`pnpm check:web` 是 CI 与本地共用的前端/Harness 门禁；`pnpm check` 还执行 Rust 格式、Clippy 和测试。发布条件与签名配置见[构建流程](docs/build-workflows.md)和[发布验收](docs/system-readiness.md)。

安装包内置 DeepSeek Harness `0.1.7-rc.2` 官方运行时。构建阶段只下载固定平台制品并校验 SHA-256，不复制或修改 Harness 源码；Office 能力由随包的官方 Office Skills 和 LibreOffice Kit 提供。

| 工作流 | 参数 | 产物 |
| --- | --- | --- |
| Windows 安装包 | `release` | MSI、NSIS、更新签名与 SHA-256 |
| Windows 安装包 | `quick` | 开发验证用 Debug NSIS |
| macOS 安装包 | `arm64`、`x64` 或 `all` | DMG、应用归档、更新签名与 SHA-256 |

手动构建保存流水线制品；与项目版本一致、指向当前 `main` 的 `v*` 标签触发正式安装包发布。推送 `main` 只触发代码检查，不发布安装包。Tauri 更新签名和系统信任签名分别配置，不能互相替代。

## 文档

| 需要了解 | 文档 |
| --- | --- |
| 产品能力与边界 | [产品能力](docs/desktop-alignment.md) |
| Harness 能力审计 | [DeepSeek Harness 能力矩阵](docs/deepseek-harness-capability-matrix.md) |
| 组件和数据如何协作 | [架构](docs/architecture.md) |
| 任务、恢复、队列与交付 | [任务执行](docs/task-execution.md) |
| 登录、会话与诊断 | [登录与会话](docs/login.md) |
| Skill、专家套件、连接器 | [扩展](docs/extensions.md) |
| 文档生成、重算与检查 | [Office 文档能力](docs/office.md) |
| 质量与发布门槛 | [发布验收](docs/system-readiness.md)、[真实任务评测](docs/task-evaluation.md) |
| 安装包与更新 | [构建流程](docs/build-workflows.md)、[macOS](docs/macos-updates.md)、[Windows](docs/windows-release-acceptance.md) |
