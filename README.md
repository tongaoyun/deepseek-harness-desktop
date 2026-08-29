# xiaoyin-desktop

小胤企业桌面端。Tauri + React 提供工作台、本地授权与 ERP 扫码登录，`harness-host` 隔离 DeepSeek Harness Runtime，并与桌面安装包共同发布。

## 目录

```text
src/              React 工作台与企业登录界面
src-tauri/        Tauri 原生壳、扫码登录与本地能力边界
harness-host/     DeepSeek Harness JSON-RPC Sidecar
```

完整的当前架构、请求链路、能力清单和系统边界见 [架构与能力](docs/architecture.md)。

知识库页面支持上传 PDF、DOCX、XLSX、TXT 和 Markdown。解析由 Temporal 后台工作流完成；
桌面与钉钉 Harness 通过只读工具检索，并保留文件名、页码或工作表引用。

## 专家套件

桌面端从控制中心读取专家套件目录和一次性下载地址，由 Tauri 原生层完成下载、SHA-256 校验、安全解包和 Manifest 校验。套件安装到操作系统应用数据目录下的 `expert-kits/<kit-id>/<version>`，不会写入用户当前工作目录。

扩展中心分别读取控制中心下发的 `/api/v1/expert-kits`、`/api/v1/skills` 和 `/api/v1/connectors`。专家套件只声明连接器 ID 和所需工具，不携带地址、账号或令牌；桌面会将声明与企业连接器目录匹配，并显示“已就绪”或具体缺失项。公司托管连接器不向员工提供修改凭据的入口。

安装器只接受 HTTP(S) 下载地址、普通文件和目录，并限制压缩包大小、解压大小及文件数量；路径穿越、符号链接、摘要不一致、Manifest 引用缺失或桌面版本不兼容都会终止安装。前端不会接触 MinIO 凭据。

已安装套件的 Skill 根目录会由 Tauri 注入 Harness。选择专家套件后，桌面同时注入其命令说明，只挂载套件引用的连接器并限制本次 Agent 可见的工具，然后复用同一个 Harness 会话执行后续消息。

聊天消息会记录“分析、加载 Skill、调用业务工具、生成回复”的结构化执行步骤，可在本机任务历史中回看；只展示阶段、工具名和成功/失败状态，不展示隐藏推理、工具参数或业务返回原文。

聊天输入 `/` 会列出已安装专家套件的快捷命令与 Skill；选择后自动绑定所属套件及权限上下文。当前每个会话只激活一个专家套件，避免不同套件的写权限和工具白名单相互扩大。

模型选择器只展示控制中心下发且 LiteLLM 已开放的模型。员工选择按账号保存在本机，切换模型只影响后续消息，不清空当前会话；当前生产环境只发布 `deepseek-v4-flash`，增加模型时无需升级桌面端。

“意识”在本机保存协作风格和长期工作手册，启用后同时注入桌面对话与本机 IM。该内容不会上传控制中心，也不能覆盖公司权限、安全策略或专家套件规则；保存后桌面会重启对应 Harness 进程使新设置立即生效。

通用 MCP Runtime 使用官方 TypeScript MCP Client，支持 `streamable-http` 和 SSE。控制中心从 Nacos 动态下发连接器地址、认证模式和工具白名单，新增 MCP 不需要修改桌面代码；普通会话隔离不可用连接器，专家套件要求的连接器不可用时则终止执行。通用模式只开放 `readOnlyHint: true` 的工具；套件声明写权限后才注册写工具，并且每次调用都由桌面原生确认。

本地能力仅作用于员工通过系统选择器授权的任务目录，绝对路径不会进入模型上下文。平台提供目录浏览、UTF-8 文本读写、建目录、复制、移动和删除，以及 `office.document.read`、`office.docx.create`、`office.xlsx.create`、`office.pdf.create` 四个稳定的文档工具。目录穿越、越界符号链接、凭据文件、超限内容和未授权目录会被拒绝；新建任务或退出登录会清空授权。

专家套件声明 Shell 权限后，可从授权目录启动 PowerShell/Bash 命令。Shell 使用去敏环境变量、两分钟超时和输出上限，不继承 ERP、模型或审批令牌；它仍以员工操作系统账号运行，因此确认框会完整展示用途、工作目录和命令。文件修改、文档生成、Shell 与 ERP 写调用统一进入 DeepSeek Harness 标准审批服务，由 Tauri 弹出原生“一次允许/拒绝”确认，并在 Harness 会话中记录审批审计事件。

桌面由 Tauri 持有一个长期运行的 Harness Host 进程，模型请求走控制中心下发的 LiteLLM 地址。模型网关凭据只在当前进程内使用，不写入本地配置或日志。运行状态和工具事件通过 Tauri Event 返回聊天界面；界面只展示阶段与工具调用，不展示模型的隐藏推理原文。

定时任务页根据专家套件的 `serverWorkflows` 动态生成输入表单，通过控制中心管理 Temporal Schedule，支持创建、暂停、恢复、立即运行、删除和查看最近执行记录。任务在云端 Worker 执行，桌面关闭不影响运行。

任务中心在员工电脑本地保存桌面 Agent 的对话和执行状态，并与控制中心返回的 Temporal 执行记录合并展示。本机任务可继续打开对话；云端任务完成后以 runId 请求短期 MinIO 下载地址，桌面端不能自行指定对象键。

IM 频道是桌面本地能力。钉钉 Client ID 保存在应用数据目录，Client Secret 保存在 Windows Credential Manager 或 macOS Keychain，不上传控制中心。桌面内置 Harness Host 使用钉钉官方 Stream SDK 接收消息，按群聊或私聊隔离会话，并通过同一个本地 DeepSeek Harness 调用 Skills 与企业只读连接器后回复原会话。

钉钉支持开放模式和配对模式；配对请求由 IM 频道页本机审批。主窗口关闭后小胤驻留系统托盘，频道继续运行；显式退出小胤或电脑关机后停止。当前提供 Client ID/Secret 手动配置，扫码自动注册需要后续接入公司授权服务。飞书、Lark、微信和企业微信已预留频道入口，尚未启用运行时。

## 开发验证

需要 Node.js 24.19.0、pnpm 10.33.0 和 Rust 1.97+：

```bash
pnpm install
pnpm check
pnpm tauri:dev
```

浏览器开发模式使用本地预览身份；真实钉钉二维码、ERP Cookie 和系统权限只能在 Tauri 原生窗口验证。

正式安装包默认连接公司内网控制中心 `http://192.168.2.67:30081`。本地开发需要连接其他环境时，可在构建前设置 `VITE_CONTROL_PLANE_BASE_URL` 覆盖。

## 发布边界

本仓库不部署到 K3s，也不调用 `node-k3s.yml`。Windows 安装包把 Node 24、`harness-host` 及其生产依赖作为 Tauri Resource 一并安装，员工电脑不依赖全局 Node；嵌入式 Node 继续作为 Harness 子进程的运行时。

Node.js v24.19.0 的官方许可证及第三方声明固定保存在 `third-party/node-v24.19.0/LICENSE`，构建时会校验 SHA-256 后随 Runtime 一并发布，Windows Runner 不依赖 GitHub 下载。

`.gitea/workflows/windows-installer.yml` 使用公司 `windows-x64` Runner 构建 MSI 与 NSIS。构建前会生成并健康检查可移植 Harness Runtime，手动运行默认还会在隔离目录完成安装、调用安装目录内的 Harness、启动桌面端和卸载烟测。构建产物附带 `SHA256SUMS.txt`，当前尚未配置企业代码签名证书。

WiX 3.14、NSIS 3.11 与 Tauri NSIS 插件镜像在公司 Gitea Generic Package Registry。`prepare-tauri-windows-tools.ps1` 只从内网下载，并使用 Tauri 2.11.4 固定的官方 SHA-256/SHA-1 校验后写入 `CARGO_TARGET_DIR\.tauri`；Runner 无需访问 GitHub，且后续构建复用已校验缓存。

## 正式发布与自动更新

推送与 `package.json` 版本一致的 `v*` 标签会触发唯一的正式发布流程。Windows Runner 会执行质量门禁、生成带 Tauri 更新签名的 MSI/NSIS、完成安装与卸载烟测，并将安装包、签名、SHA-256 清单、`release-manifest.json` 和 `latest.json` 写入永久 Gitea Release。

员工客户端从公司 Gitea Generic Package Registry 匿名读取 `xiaoyin-desktop-updater/latest/latest.json`，下载安装包后必须通过内置公钥验签才能安装。版本安装包同时保存到不可覆盖的 `xiaoyin-desktop/<version>` 包版本；`latest` 只负责指向当前正式版，不设置测试或灰度通道。

需要回滚时，手动运行 `Roll back desktop release` 工作流并输入已经正式发布的版本号。工作流只接受该版本不可变包中的签名元数据，验证安装包仍可匿名读取后才会切换 `latest`；客户端允许安装公司明确指向的旧版签名包。Gitea 工作流运行记录就是回滚审计记录。

更新签名私钥和密码保存在仓库 Actions Secret 中，不得写入代码、日志或安装包。本机加密私钥备份位于 `~/.config/xiaoyin/release/tauri-updater.key`，密码保存在 macOS Keychain 的 `com.instudio.xiaoyin.tauri-updater.password` 项。丢失签名私钥后，已经安装的客户端将无法信任后续更新。

发布前同时更新 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的版本，再创建并推送标签：

```bash
git tag -a v0.1.6 -m "小胤 0.1.6"
git push origin v0.1.6
```

在 Windows 构建机本地可执行：

```powershell
pnpm install --frozen-lockfile
.\scripts\prepare-harness-runtime.ps1
.\scripts\prepare-tauri-windows-tools.ps1
pnpm tauri build
```

生产密钥不得写入 `.env`、前端产物或安装包；员工 LiteLLM 虚拟 Key 只在当前桌面进程内使用，不持久化到本机。
