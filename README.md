# xiaoyin-desktop

小胤企业桌面端。Tauri + React 提供工作台、本地授权与 ERP 扫码登录，`harness-host` 隔离 DeepSeek Harness Runtime，并与桌面安装包共同发布。

## 目录

```text
src/              React 工作台与企业登录界面
src-tauri/        Tauri 原生壳、扫码登录与本地能力边界
harness-host/     DeepSeek Harness JSON-RPC Sidecar
```

## 专家套件

桌面端从控制中心读取专家套件目录和一次性下载地址，由 Tauri 原生层完成下载、SHA-256 校验、安全解包和 Manifest 校验。套件安装到操作系统应用数据目录下的 `expert-kits/<kit-id>/<version>`，不会写入用户当前工作目录。

扩展中心分别读取控制中心下发的 `/api/v1/expert-kits`、`/api/v1/skills` 和 `/api/v1/connectors`。专家套件只声明连接器 ID 和所需工具，不携带地址、账号或令牌；桌面会将声明与企业连接器目录匹配，并显示“已就绪”或具体缺失项。公司托管连接器不向员工提供修改凭据的入口。

安装器只接受 HTTP(S) 下载地址、普通文件和目录，并限制压缩包大小、解压大小及文件数量；路径穿越、符号链接、摘要不一致、Manifest 引用缺失或桌面版本不兼容都会终止安装。前端不会接触 MinIO 凭据。

已安装套件的 Skill 根目录会由 Tauri 注入 Harness。选择专家套件后，桌面同时注入其命令说明、限制本次 Agent 可见的 ERP 工具，并复用同一个 Harness 会话执行后续消息。

ERP MCP Bridge 使用官方 TypeScript MCP Client 做工具发现与调用，只将服务端明确标注 `readOnlyHint: true` 的工具注册到 Harness。写工具在桌面审批通道完成前默认不可见；本地 Office/File Tool Bridge 也尚未启用。

桌面由 Tauri 持有一个长期运行的 Harness Host 进程，模型请求走控制中心下发的 LiteLLM 地址，运行状态和工具事件通过 Tauri Event 返回聊天界面。界面只展示阶段与工具调用，不展示模型的隐藏推理原文。

## 开发验证

需要 Node.js 24.19.0、pnpm 10.33.0 和 Rust 1.97+：

```bash
pnpm install
pnpm check
pnpm tauri:dev
```

浏览器开发模式使用本地预览身份；真实钉钉二维码、ERP Cookie 和系统权限只能在 Tauri 原生窗口验证。

## 发布边界

本仓库不部署到 K3s，也不调用 `node-k3s.yml`。Windows 安装包把 Node 24、`harness-host` 及其生产依赖作为 Tauri Resource 一并安装，员工电脑不依赖全局 Node；嵌入式 Node 继续作为 Harness 子进程的运行时。

`.gitea/workflows/windows-installer.yml` 使用公司 `windows-x64` Runner 构建 MSI 与 NSIS。构建前会生成并健康检查可移植 Harness Runtime，手动运行默认还会在隔离目录完成安装、调用安装目录内的 Harness、启动桌面端和卸载烟测。构建产物附带 `SHA256SUMS.txt`，当前尚未配置企业代码签名证书。

在 Windows 构建机本地可执行：

```powershell
pnpm install --frozen-lockfile
.\scripts\prepare-harness-runtime.ps1
pnpm tauri build
```

生产密钥不得写入 `.env`、前端产物或安装包；员工 LiteLLM 虚拟 Key 使用系统 Keychain 保存。
