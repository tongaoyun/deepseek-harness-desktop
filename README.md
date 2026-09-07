# 小胤桌面端

面向员工的桌面工作助手。以 Qoder Work 为产品主线，以 Claude、Codex 的任务执行能力为目标，完成需求理解、工具执行、结果检查和文件交付。

## 仓库职责

| 仓库 | 负责什么 |
| --- | --- |
| `xiaoyin-desktop` | 桌面、任务执行、本地文件、Office、定时任务和钉钉 |
| `xiaoyin-server` | 企业控制台、模型与扩展目录、知识索引、审计和记忆同步 |
| `xiaoyin-extensions` | 官方 Skills、专家套件、内容模板和发布工具 |
| `erp-mcp-gateway` | ERP 业务工具与 Nacos MCP 注册 |

## 开发

环境：Node.js 24.19.0、pnpm 10.33.0、Rust 1.97+。Windows 需要 Visual C++ Build Tools；macOS 需要 Xcode Command Line Tools。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm tauri:dev
```

控制中心默认地址为 `http://192.168.2.67:30081`，通过 `VITE_XIAOYIN_SERVER_URL` 指定其他环境。

浏览器预览使用本地开发身份。桌面开发可在未提交的 `.env.local` 中设置 `VITE_SKIP_ERP_LOGIN=true`；正式构建始终使用 ERP 登录。模型调用与企业目录需要对应服务可达。本机权限、凭据、文件、Harness 和 IM 在 Tauri 中验证。

## 代码目录

| 目录 | 内容 |
| --- | --- |
| `src/` | React 工作台、交互与任务状态 |
| `src-tauri/` | 原生权限、凭据、SQLite、扩展安装和进程管理 |
| `harness-host/` | Agent 运行时、Skills、MCP、本地工具和钉钉 |
| `scripts/` | 构建、运行时准备、安装包和验收脚本 |
| `.gitea/workflows/` | CI、安装包与更新发布 |

## 构建发布

`pnpm check` 执行版本、lint、类型、前端与 Harness 测试、生产构建，以及 Rust 格式、Clippy 和测试。

| 工作流 | 参数 | 产物 |
| --- | --- | --- |
| Windows 安装包 | `release` | MSI、NSIS、更新签名与 SHA-256 |
| Windows 安装包 | `quick` | 开发验证用 Debug NSIS |
| macOS 安装包 | `arm64`、`x64` 或 `all` | DMG、应用归档、更新签名与 SHA-256 |

手动构建保存流水线制品。推送版本标签会发布更新，发布前同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`，执行 `pnpm verify:version`。

Tauri 更新签名使用 Actions Secrets 中的 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。Windows Authenticode 与 Apple Developer ID 公证属于操作系统信任签名，需要分别配置。

## 文档

| 需要了解 | 文档 |
| --- | --- |
| 产品能力与边界 | [产品能力](docs/desktop-alignment.md) |
| 组件和数据如何协作 | [架构](docs/architecture.md) |
| 任务、恢复、队列与交付 | [任务执行](docs/task-execution.md) |
| Skills、套件、连接器 | [扩展](docs/extensions.md) |
| 文档生成、重算与 PDF | [Office 工具](docs/office.md) |
| 质量与发布门槛 | [发布验收](docs/system-readiness.md)、[真实任务评测](docs/task-evaluation.md) |
| 安装包与更新 | [构建流程](docs/build-workflows.md)、[macOS](docs/macos-updates.md)、[Windows](docs/windows-release-acceptance.md) |
| 下一步完善内容 | [完善计划](docs/roadmap.md) |
