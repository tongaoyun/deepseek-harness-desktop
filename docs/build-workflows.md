# 构建工作流

Gitea 提供四个入口：

| 入口 | 触发方式 | 用途 |
|---|---|---|
| 代码检查 | main 提交、合并请求、手动 | 前端与 Harness 检查，以及 Windows Rust 检查 |
| macOS 安装包 | 版本标签、手动 | 手动默认 ARM，可选 Intel 或全部；标签固定构建双架构 |
| Windows 安装包 | 版本标签、手动 | 默认 release；手动可选 quick 生成开发验证用 Debug NSIS |
| 版本回退 | 手动 | 将 Windows 更新索引切回已有签名版本，不重新构建 |

macOS 的公共质量检查每轮只执行一次，通过后按目标架构顺序编译、签名和验收。每个目标都独立验证内置 Node、原生模块、Harness 和最终安装包。两种架构不同时修改暂存资源。

macOS 复用 `/tmp/xiaoyin-desktop-builder/target`，Windows 检查与安装包复用 `C:\xiaoyin-desktop-builder\target`；Debug、Release 和跨架构产物由 Cargo 分目录管理。工具链、系统目标或依赖变化仍可能触发重新编译，缓存不保证固定构建时间。不要在构建前清空 Cargo 缓存。

Windows quick 只用于人工验证界面与基本运行，不运行完整质量门禁及安装卸载验收，不发布更新源；产物名称含 quick。release 执行完整检查，产出 MSI、NSIS 及更新签名。版本标签不会进入 quick 模式，且强制安装验收。当前 Windows 代码检查受 Runner DLL 环境限制，只编译和链接 Rust 测试；正式安装包工作流仍要求实际测试通过。

每个平台的新手动构建取代旧手动构建，避免重复排队；正式标签发布使用独立并发组，不自动取消。先完成本地检查、一次提交全部构建修正，再触发一次需要的目标。修改工作流不会改变已经开始的运行；停掉过时任务后再验证新配置。

删除工作流文件不会删除已有运行记录和安装包。Gitea 默认分支上的工作流文件决定常用入口；构建分支上的变更需要合入默认分支后才对日常操作生效。

工作流结构回归：`node --test scripts/workflows.test.mjs`。
