# 小胤桌面端

## 项目结构

| 路径 | 内容 |
|---|---|
| `src/` | React 工作台、任务、扩展、知识库和 IM 页面 |
| `src-tauri/` | Tauri 命令、权限、凭据、文件访问、进程管理和安装配置 |
| `harness-host/` | DeepSeek Harness、Skills、MCP、本地工具和钉钉 Runtime |
| `scripts/` | Runtime 准备、安装包构建、烟测和发布验收 |
| `.gitea/workflows/` | CI、Windows/macOS 安装包和版本回滚 |

详细组件边界见 [架构与能力](docs/architecture.md)，对话、排队和文件交付见 [任务执行与结果展示](docs/task-execution.md)，页面功能与参考产品差异见 [桌面能力对照](docs/desktop-alignment.md)，Windows 人工验收见 [Windows 正式版验收](docs/windows-release-acceptance.md)。

## 开发

环境要求：Node.js 24.19.0、pnpm 10.33.0、Rust 1.97+。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm tauri:dev
```

`pnpm check` 执行版本一致性、lint、TypeScript、前端测试、Harness 测试、生产构建、Rust 格式、Clippy 和 Rust 测试。

控制中心默认地址为 `http://192.168.2.67:30081`，可通过 `VITE_CONTROL_PLANE_BASE_URL` 覆盖。浏览器模式用于界面开发；ERP Cookie、系统凭据、本地文件权限、Harness 和本地 IM 必须在 Tauri 中验证。

网页预览默认使用 `local-development` 本地员工，不需要扫码。桌面本地测试可在不提交的 `.env.local` 中设置 `VITE_SKIP_ERP_LOGIN=true`，运行 `pnpm tauri:dev` 自动进入工作台；正式桌面构建忽略此开关，仍使用 ERP 登录。恢复扫码测试时将开关设为 `false` 并重启开发服务。本地身份不读取或清除已有 ERP 凭据，退出后会重新进入本地会话。

免扫码只跳过身份登录，不模拟控制中心或模型服务。服务离线时可以进入工作台，但企业目录同步和模型调用仍需对应服务可达。

## 连接器

技能和专家套件的创建、导入、调用、启停、原文查看、定制与分享见 [扩展使用](docs/extensions.md)。

在「扩展 → 连接器」中添加企业或个人 MCP 服务，支持 Streamable HTTP、SSE 和 STDIO。

- JSON 导入支持单个连接器对象和包含多个服务的 `mcpServers`；兼容 `type` / `transport`、`args` / `arguments`、`env` / `environment`。
- 中文和其他显示名称会保留，内部 ID 自动生成。手动配置时可以只填写名称，留空 ID。
- 导入前逐项检查配置；已有 ID 不会被覆盖。导入后显示各项保存结果，失败项可以重试。
- 「已添加」保留关闭的个人服务；可以直接编辑完整配置或删除个人连接器。关闭开关保留配置，删除同时移除本机凭据。
- 已启用的 MCP 服务在打开连接器页面或配置变化时自动检测，展示连接中、待配置、正常、异常或未检测状态。展开「工具与配置」可查看声明工具、实际发现的工具及差异。

检测结果是一次连接测试，不是持续在线承诺。浏览器开发模式无法执行本机 MCP 检测，显示未检测；桌面内置能力在使用时检查。配置变化用于新任务，既有任务保留自己的能力快照。

## 构建与验收

Gitea 统一为「代码检查」「macOS 安装包」「Windows 安装包」「版本回退」四个入口。参数、缓存及并发规则见 [构建工作流](docs/build-workflows.md)。

| 平台 | 命令或工作流 | 输出 |
|---|---|---|
| Windows x64 调试 | `pnpm tauri:dev` | 本地应用 |
| Windows x64 快速安装验证 | `Windows 安装包`，选择 `quick` | Debug NSIS，仅开发验证 |
| Windows x64 完整安装验证 | `Windows 安装包`，选择 `release` | MSI、NSIS、Updater 文件 |
| Windows x64 人工验收 | `pnpm acceptance:windows` | `acceptance-report.json` |
| macOS Apple Silicon | `macOS 安装包`，默认选择 `arm64` | `.app`、`.dmg`、Updater 文件、SHA-256 |
| macOS Intel | 在 `macOS 安装包` 手动选择 `x64`，由 `macos-arm64` Runner 交叉构建并用 Rosetta 验证 | `.app`、`.dmg`、Updater 文件、SHA-256 |

macOS 构建按目标准备固定版本的 Node.js、原生依赖和 Harness Runtime，并对最终 DMG 执行完整性、签名、架构和 Harness 健康检查，核对更新归档与 DMG 包含同一应用。发布标签触发同一 Apple Silicon Runner 顺序构建两种架构；全部通过后发布独立 macOS 更新索引，不受 Windows 发布覆盖。产物使用临时签名、尚无 Apple 公证；真实发布需要现有签名密钥与发布凭据，Intel 实机安装升级仍需单独验收。详见 [macOS 更新](docs/macos-updates.md)。

## 发布

发布前同步更新以下版本：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

推送 `v*` 标签会运行 Windows 和 macOS 安装包工作流。Windows 和 macOS Updater 产物需要以下 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Updater 私钥只保存在 Actions Secrets 和受保护备份中，不提交到仓库、`.env` 或安装包。Windows 更新索引回退使用「版本回退」工作流。
