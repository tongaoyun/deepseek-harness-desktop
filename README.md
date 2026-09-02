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

- ERP 扫码登录、LiteLLM 模型选择和跨设备记忆同步；个人记忆位于桌面设置，支持确认、版本恢复和导入导出。
- Windows 以纯桌面模式启动；扫码授权窗口完成后自动收起并切回小胤工作台。
- 专家套件、独立 Skills、连接器和企业知识库。
- 专家套件与 Skills 支持按名称、说明、ID 和安装状态检索；连接器支持按状态、工具检索和实时 MCP 握手诊断。
- 本地文件、DOCX/XLSX/PDF、受审批 Shell 和 Windows Computer Use。
- Agent 异常进入通知中心并支持重新检测；任务可取消，失败后可重新执行；会话由本机 SQLite 保存并支持搜索、分页和归档。
- MCP 实时握手、工具清单漂移诊断和设备能力上报；企业能力同步失败时保留上次成功数据并展示分项原因。
- Temporal 定时任务、任务中心、本地钉钉频道、中央审计和签名自动更新；钉钉私聊与群聊各自使用隔离会话。
- 回复支持 Markdown、表格、代码块及 Office/PDF 产物卡片，可打开文件或在文件夹中定位。
- 左下角头像统一提供桌面设置、正式版更新、反馈与帮助和退出登录；桌面设置包含个人记忆和设备能力，反馈进入控制中心审计链路。
- 启动时只做轻量 Harness Host 健康探测；Office、Shell 和 Computer Use 完整自检由“设备能力”页按需执行，避免拖慢工作台。
- 安装包图标与工作台共用同一套小胤形象；任务搜索支持 `Ctrl/Cmd + K`，弹层支持 `Esc` 和点击遮罩关闭，并兼容系统“减少动态效果”设置。
- 顶层异常会进入可恢复页面，不显示可能包含本地路径或业务上下文的异常详情。
- 文件和文件夹可直接拖入工作台，自动授权所在目录并加入当前任务；设置页集中展示快捷键。

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

- `main`：只执行前端与 Harness 的类型检查、测试和构建，不生成 Windows 安装包；连续提交时自动取消旧任务。
- 手动构建：按需运行 `Windows installer`，可选择是否执行安装烟测，不创建正式 Release。
- `v*` 标签：实际验收文件、Office 和 Shell；交互会话实际验收 Computer Use，服务型 Runner 验证桥接依赖，再执行安装/启动/卸载并发布正式 Gitea Release。
- 发布失败保留草稿时可直接重跑同一标签；流水线会清理未完成资产，并在公开 Release 后回读校验资产和发布清单。
- 自动更新：只使用正式单通道和 Tauri 签名，不设置 `stable`/`beta` 通道；启动、重新激活和每 6 小时自动检查。
- 回滚：运行 `Roll back desktop release`，目标必须是已发布的不可变版本。

发布前同步更新 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本。本仓库不部署到 K3s；Windows 安装包内置 Node 与 Harness Runtime，员工电脑无需安装开发环境。

签名私钥只保存在 Actions Secret 和受保护备份中，不得提交到仓库、`.env` 或安装包。
