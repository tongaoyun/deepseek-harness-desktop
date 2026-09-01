# xiaoyin-desktop

小胤 Windows 企业桌面端。React 提供工作台，Tauri 管理本地权限和进程，`harness-host` 运行 DeepSeek Harness、Skills、MCP 与本地工具。

## 目录

| 目录 | 职责 |
|---|---|
| `src/` | 工作台、扩展中心、任务与管理页面 |
| `src-tauri/` | 原生登录、权限、审批、安装器和自动更新 |
| `harness-host/` | Agent Runtime、MCP Client、本地工具和钉钉频道 |
| `scripts/` | Windows Runtime、构建、烟测与发布脚本 |

架构、请求链路、能力和边界见 [架构与能力](docs/architecture.md)。

## 当前能力

- ERP 扫码登录、LiteLLM 模型选择和跨设备意识同步。
- 专家套件、独立 Skills、连接器和企业知识库。
- 本地文件、DOCX/XLSX/PDF、受审批 Shell 和 Windows Computer Use。
- MCP 实时握手、工具清单漂移诊断和设备能力上报。
- Temporal 定时任务、任务中心、本地钉钉频道、中央审计和签名自动更新。

## 安全边界

- 桌面只使用控制中心下发的地址和短期制品 URL，不直连 Nacos、Temporal、PostgreSQL 或 MinIO 管理接口。
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

- `main`：执行完整质量门禁并生成 MSI、NSIS 和 SHA-256 制品。
- `v*` 标签：实际验收文件、Office、Shell、Computer Use，再执行安装/启动/卸载并发布正式 Gitea Release。
- 自动更新：只使用正式单通道和 Tauri 签名，不设置 `stable`/`beta` 通道。
- 回滚：运行 `Roll back desktop release`，目标必须是已发布的不可变版本。

发布前同步更新 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本。本仓库不部署到 K3s；Windows 安装包内置 Node 与 Harness Runtime，员工电脑无需安装开发环境。

签名私钥只保存在 Actions Secret 和受保护备份中，不得提交到仓库、`.env` 或安装包。
