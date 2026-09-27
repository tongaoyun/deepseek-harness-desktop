# macOS 构建与更新

桌面支持 Windows 与 macOS 更新入口。开发模式不后台检查，缺少当前架构的发布包时显示「暂未发布此平台更新」，允许稍后重试。下载与安装期间不并发检查新版本。

Apple Silicon 与 Intel 安装包均要求 macOS 14 或更新系统，与内置桌面操作组件的最低系统版本一致；Intel 架构支持不代表支持旧版 macOS。

钉钉登录通过系统浏览器打开官方 OAuth 页面，不在桌面端嵌入二维码页面；控制中心使用构建时固定的私网 IP，桌面 CSP 仅放行该来源。应用不启用全局 HTTP 例外。安装包烟测检查这些限制。

## 发布流程

- `macos-installer.yml` 的版本标签构建 Apple Silicon 和 Intel；手动默认 `arm64`，可选择 `all` 或 `x64`，手动构建只留流水线制品。前端、Harness 和 Rust 质量门禁由合并请求与 `main` 的代码检查完成；安装包工作流核对版本后直接构建并验收。工作流入口及触发规则见 [构建工作流](build-workflows.md)。
- 两个架构由 `macos-arm64` Runner 串行构建，使用独立工作区和 Cargo 根目录。每个 Cargo 进程最多使用 2 个并行任务，避免 16 GB Runner 发生内存交换。Apple Silicon 主机构建 Intel 包需安装 `x86_64-apple-darwin` Rust 标准库，并用 Rosetta 2 运行 Intel 内置 Node 和原生依赖的验收；不要求另设 Intel Runner。
- `XIAOYIN_MACOS_ARCH=arm64|x64` 明确指定目标，Rust 主程序、内置 Node、node-pty 和 Swift 桌面助手保持一致。原生可选依赖安装两种 CPU 版本；实际验收使用目标 Node 加载 FFI、PDF/图片模块并运行终端子进程，不能只检查主程序架构。
- 内置 Node 的版本与官方 SHA-256 固定在构建脚本中。校验成功的下载包保存在 Runner 缓存，后续构建再次验哈希后复用。
- 显式目标的产物目录为 `$CARGO_TARGET_DIR/<Rust target>/release/bundle`，未指定 `CARGO_TARGET_DIR` 时使用 `src-tauri/target/<Rust target>/release/bundle`。更新平台仍分别使用 `darwin-aarch64` 和 `darwin-x86_64`，不将单架构包标记为 Universal。
- 最终深度签名后重新打包并签署更新压缩包，确保更新安装与 DMG 包含同一应用，而不是发布签名前的旧压缩包。
- 标签构建将 DMG、Tauri `.app.tar.gz`、更新签名与 SHA-256 元数据存入 Gitea `xiaoyin-desktop-macos/<版本>` 通用包。已存在且内容不同的文件不能被覆盖。
- 两个架构都成功后，发布步骤并行核对版本、提交与全部文件的 SHA-256，生成 `darwin-aarch64`、`darwin-x86_64` 两个更新目标，最后更新 `xiaoyin-desktop-updater-macos/latest/latest.json` 并匿名回读确认。
- macOS 配置使用独立索引，Windows 发布不会覆盖 Mac 平台信息。禁止以旧版本覆盖较新的 Mac 更新索引；发布凭据使用 Gitea Secrets，不写入仓库。

## 验收条件

必须具备可连接 Gitea 的 `macos-arm64` Runner、Node 24.19.0、pnpm 10.33.0、Rust 两个 macOS 目标、Xcode Command Line Tools 和 Rosetta 2，以及 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`RELEASE_USERNAME`、`RELEASE_CREDENTIAL`。缺少任一架构时不发布不完整索引。私钥须与已安装版本内置公钥对应，不能临时生成新密钥替代后直接发布给现有客户端。

本地构建入口（先设置现有更新签名私钥，不将私钥写入命令或仓库）：

```bash
pnpm tauri:build:macos arm64
pnpm tauri:build:macos x64
```

构建脚本在缺少签名密钥或无法执行目标架构时提前失败。最终验收挂载只读 DMG，核对版本、签名和目标架构，运行内置 Harness 与原生模块，并解压更新归档确认它与 DMG 包含逐文件相同的应用。并发构建时 Harness 启动检查最多等待 5 分钟。更新归档须通过应用内置公钥的 Ed25519 验签，同时校验 Minisign 的可信备注签名；私钥不匹配或内容损坏时不上传产物。不会覆盖 `/Applications` 或修改员工任务数据。

本地正式构建默认使用公司内网控制中心，无需设置服务地址。覆盖地址时，正式构建仅接受 HTTPS、回环地址或 RFC1918 私网 IP。Host 验收逐条等待初始化、健康与关闭响应，最后再结束 stdin。

脚本回归：`node --test scripts/macos-build-env.test.mjs scripts/check-harness-runtime.test.mjs scripts/publish-macos-update.test.mjs`。覆盖架构与目录映射、无效目标拒绝、顺序协议、初始化失败/超时、更新平台映射与双架构提交一致性。

## 发布与实际升级验收

- 确认 Gitea 的两种架构构建都成功，制品与更新索引来自同一提交和版本；不能以 Runner 在线代替流水线成功。
- 在独立测试账户安装 DMG，确认无需系统 Node、Python 或 LibreOffice 即可启动、执行任务并通过 Office Runtime 自检。
- 使用已发布的旧版本创建合成任务、附件、计划与记忆，记录文件哈希和数据数量；在无运行中任务时检查更新、下载安装并重启，确认版本变化、记录恢复和续聊可用。
- 在网络中断、下载失败、签名不匹配时确认当前版本仍可打开，并可重新检查；不修改真实用户数据制造故障。
- Apple Silicon 上的 Intel 运行依赖 Rosetta，只能作为交叉构建验收；正式支持 Intel 仍需 Intel 实机完成首次安装、权限、Office 调用与升级验收。

内部分发的临时签名不等于 Apple Developer ID 公证；对外分发前还须完成签名、公证及 Intel 实机验收。
