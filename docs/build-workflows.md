# 构建工作流

Gitea 提供三个入口：

| 入口 | 触发方式 | 用途 |
|---|---|---|
| 代码检查 | main 提交、合并请求、手动 | 前端与 Harness 检查，以及 Windows Rust 检查 |
| macOS 安装包 | 版本标签、手动 | 手动默认 ARM，可选 Intel 或全部；标签固定构建双架构 |
| Windows 安装包 | 版本标签、手动 | 默认 release；手动可选 quick 生成开发验证用 Debug NSIS |

代码检查在合并请求和 `main` 提交时运行：Web/Host Job 执行 `pnpm check:web`，Windows Job 检查 PowerShell 和 Rust。安装包工作流核对发布身份、打包和烟测，不重复整套质量检查。macOS 标签并行构建两个架构（Runner 不足时自动排队），分别验收内置 Node、原生模块、Harness 和最终安装包。

macOS 的两个架构使用矩阵并行构建，分别复用 `/tmp/xiaoyin-desktop-builder/target/arm64` 和 `/tmp/xiaoyin-desktop-builder/target/x64`；可用 Runner 不足时由 Gitea 自动排队。Windows 检查与安装包复用 `C:\xiaoyin-desktop-builder\target`。工具链、系统目标或依赖变化仍可能触发重新编译，缓存不保证固定构建时间。不要在构建前清空 Cargo 缓存。

macOS 内置 Node 使用仓库锁定的版本和 SHA-256，首次下载并校验后复用 Runner 的 `~/Library/Caches/xiaoyin-desktop-builder`。版本或哈希变化时自动建立新缓存。

Harness Primary Runtime 使用固定版本 `0.1.7-rc.2` 的内部 generic package 制品。Windows 和 macOS 构建按目标平台下载 `win-x64.tar.gz`、`mac-x64.tar.gz` 或 `mac-arm64.tar.gz`，随后校验清单中的 SHA-256 并检查 `primary-runtime/runtime.json` 与官方 Office Skill 检查器。下载器支持 Runner 缓存，但缓存命中也必须重新计算摘要；网络下载、摘要不匹配或归档内容不完整都会使构建失败。构建不访问上游源码、不应用本地 patch，也不复制上游源码到仓库。

Windows 正式发布会将 Release 资产和版本包按最多 3 个请求并行上传，更新索引始终最后发布；每个文件都会记录上传耗时，并在发布前后校验版本、签名、大小和哈希。上传失败会清理同批请求并停止发布，不会提前公开不完整的更新索引。

Windows quick 只允许从普通分支手动运行，用于验证界面与基本启动；它生成 Debug NSIS，不执行安装卸载验收，也不发布更新源。release 生成 MSI、NSIS 和更新签名，并固定执行 NSIS 安装、内置 Harness、应用启动和卸载验收。从标签手动运行时，Windows 强制使用 release，macOS 强制构建双架构。

正式发布先通过 `main` CI，再确认版本同步、Runner 和所需 Secrets；控制中心默认使用仓库固定的公司内网地址，不要求配置工作流变量。随后在当前 `main` 提交创建与项目版本一致的 `v*` 标签并推送。标签触发 Windows release 与 macOS 双架构构建；检查两个流水线的安装包、签名、哈希和更新索引实际发布结果。推送 `main` 本身不会发布安装包。

同一平台只保留一个普通手动构建运行，新的运行取消仍在执行的同类运行。正式标签发布使用独立并发组，不自动取消。发布失败时保留标签和失败制品供诊断，不移动或复用已经发布的版本标签。

工作流结构回归：`node --test scripts/workflows.test.mjs`。
