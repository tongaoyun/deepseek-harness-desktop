# 小胤桌面端

## 项目结构

| 路径 | 内容 |
|---|---|
| `src/` | React 工作台、任务、扩展、知识库和 IM 页面 |
| `src-tauri/` | Tauri 命令、权限、凭据、文件访问、进程管理和安装配置 |
| `harness-host/` | DeepSeek Harness、Skills、MCP、本地工具和钉钉 Runtime |
| `scripts/` | Runtime 准备、安装包构建、烟测和发布验收 |
| `.gitea/workflows/` | CI、Windows/macOS 安装包和版本回滚 |

详细组件边界见 [架构与能力](docs/architecture.md)，Windows 人工验收见 [Windows 正式版验收](docs/windows-release-acceptance.md)。

## 开发

环境要求：Node.js 24.19.0、pnpm 10.33.0、Rust 1.97+。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm tauri:dev
```

`pnpm check` 执行版本一致性、lint、TypeScript、前端测试、Harness 测试、生产构建、Rust 格式、Clippy 和 Rust 测试。

控制中心默认地址为 `http://192.168.2.67:30081`，可通过 `VITE_CONTROL_PLANE_BASE_URL` 覆盖。浏览器模式用于界面开发；ERP Cookie、系统凭据、本地文件权限、Harness 和本地 IM 必须在 Tauri 中验证。

## 构建与验收

| 平台 | 命令或工作流 | 输出 |
|---|---|---|
| Windows x64 调试 | `pnpm tauri:dev` | 本地应用 |
| Windows x64 快速安装验证 | `Windows quick installer` | Debug NSIS |
| Windows x64 完整安装验证 | `Windows installer` | MSI、NSIS、Updater 文件 |
| Windows x64 人工验收 | `pnpm acceptance:windows` | `acceptance-report.json` |
| macOS Apple Silicon | `pnpm tauri:build:macos` 或 `macOS installer` | `.app`、`.dmg`、SHA-256 |

macOS 构建会准备固定版本的 Node.js 和 Harness Runtime，并对最终 DMG 执行完整性、签名、架构和 Harness 健康检查。产物使用临时签名，用于公司内部分发；Apple 公证和 macOS 自动更新不在该流程内。

## 发布

发布前同步更新以下版本：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

推送 `v*` 标签会运行 Windows 和 macOS 安装包工作流。Windows Updater 需要以下 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Updater 私钥只保存在 Actions Secrets 和受保护备份中，不提交到仓库、`.env` 或安装包。版本回滚使用 `Roll back desktop release` 工作流。
