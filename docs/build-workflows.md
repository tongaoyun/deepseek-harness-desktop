# 构建工作流

Gitea 提供四个入口：

| 入口 | 触发方式 | 用途 |
|---|---|---|
| 代码检查 | main 提交、合并请求、手动 | 前端与 Harness 检查，以及 Windows Rust 检查 |
| macOS 安装包 | 版本标签、手动 | 手动默认 ARM，可选 Intel 或全部；标签固定构建双架构 |
| Windows 安装包 | 版本标签、手动 | 默认 release；手动可选 quick 生成开发验证用 Debug NSIS |
| 版本回退 | 手动 | 将 Windows 更新索引切回已有签名版本，不重新构建 |

代码检查在合并请求和 `main` 提交时完成。macOS 安装包工作流复用该结果，核对版本后并行编译两个架构；每个目标仍独立验证内置 Node、原生模块、Harness 和最终安装包。8 核构建机为每个 Cargo 进程分配 3 个并行任务，给安装包验收和系统进程保留资源。

macOS 的两个架构分别复用 `/tmp/xiaoyin-desktop-builder/target/arm64` 和 `/tmp/xiaoyin-desktop-builder/target/x64`，避免并发编译争用 Cargo 目录锁。Windows 检查与安装包复用 `C:\xiaoyin-desktop-builder\target`。工具链、系统目标或依赖变化仍可能触发重新编译，缓存不保证固定构建时间。不要在构建前清空 Cargo 缓存。

macOS 内置 Node 使用仓库锁定的版本和 SHA-256，首次下载并校验后复用 Runner 的 `~/Library/Caches/xiaoyin-desktop-builder`。版本或哈希变化时自动建立新缓存。

Windows quick 只用于人工验证界面与基本运行，不运行完整质量门禁及安装卸载验收，不发布更新源；产物名称含 quick。release 执行完整检查，产出 MSI、NSIS 及更新签名。版本标签不会进入 quick 模式，且强制安装验收。Windows 代码检查和正式安装包工作流均实际执行 Rust 测试。

同一平台只保留一个手动构建运行，新的手动触发会取消仍在执行的同类运行；正式标签发布使用独立并发组，不自动取消。构建必须使用默认分支已经合入的工作流和代码。

工作流结构回归：`node --test scripts/workflows.test.mjs`。
