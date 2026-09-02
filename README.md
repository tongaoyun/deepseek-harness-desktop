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
- 本地文件、DOCX/XLSX/PDF、受审批 Shell、语义浏览器连接器和 Windows Computer Use。
- 自然语言创建 Temporal 定时任务、执行记录、失败通知和产物下载；桌面关闭后任务继续运行。
- 本地钉钉 Stream、会话隔离、桌面任务接管、持久队列、附件解析和任务结果推送。
- MCP 握手、Tool 清单诊断、设备能力检测、反馈、审计和正式版自动更新。

## 安全边界

- 桌面只使用控制中心下发的地址和制品 URL，不自行查询 Nacos、Temporal、PostgreSQL 或 MinIO 管理接口。
- 套件和 Skill 必须通过版本、SHA-256、Manifest、权限和路径校验。
- 写文件、生成文档、Shell、Computer Use 和业务写工具均需原生单次确认。
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

## Windows 发布

| 场景 | 工作流 |
|---|---|
| 日常调试 | Windows 工作机运行 `pnpm tauri:dev` |
| 快速安装验证 | `Windows quick installer`，生成 Debug NSIS，制品保留 7 天 |
| 完整安装验证 | `Windows installer`，生成 MSI 与 NSIS，并按配置执行烟测 |
| 正式发布 | 推送 `v*` 标签，执行门禁、烟测、签名和 Gitea Release |
| 回滚 | `Roll back desktop release`，选择已发布版本 |

`main` 执行 lint、类型、测试与构建门禁。Windows Rust CI 在 `main`、Pull Request 或手动触发时执行。自动更新使用正式单通道和 Tauri 签名。

发布前同步更新 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本。本仓库不部署到 K3s；Windows 安装包内置 Node 与 Harness Runtime，员工电脑无需安装开发环境。

正式和快速 Windows 安装包都强制执行 Authenticode 与 Tauri Updater 双签名。Actions 需要配置：

- `WINDOWS_AUTHENTICODE_PFX_BASE64`：代码签名 PFX 的 Base64 内容。
- `WINDOWS_AUTHENTICODE_PFX_PASSWORD`：PFX 密码。
- `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：Updater 签名密钥。

签名私钥只保存在 Actions Secret 和受保护备份中，不得提交到仓库、`.env` 或安装包。
