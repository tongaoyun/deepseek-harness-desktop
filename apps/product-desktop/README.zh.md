# 产品桌面构建

[English](README.md) | 中文

## 概要

产品 assembly 通过官方 Electron 管线打包企业桌面。内网 Gitea 负责开发和审核；GitHub 私有仓库接收选定的已提交源码及其固定 Harness 基线，使用托管 runner 构建 Windows x64、macOS ARM64 和 macOS Intel 安装包。

## GitHub 打包

通过 `gh auth login --hostname github.com --git-protocol https --scopes workflow` 登录。账号需要仓库管理、源码上传、工作流更新和 Actions 触发权限。同步前提交并验证源码。以下命令创建空的私有仓库，并触发首次验收构建：

```sh
node apps/product-desktop/scripts/sync-github.mjs --repository OWNER/deepseek-harness-desktop --create
```

已有构建仓库时省略 `--create`。同步拒绝公开仓库、fork、归档仓库、未提交源码、浅克隆历史和不一致的基线。浅克隆先通过 `git fetch --unshallow origin` 从现有桌面仓库补齐历史，再进行同步。脚本只原子推送 `main` 和固定基线 tag；引用分叉时直接失败，不强推、不删除引用、不修改 remote。上传期间 Actions 保持禁用。适配层禁用复制过来的上游工作流，仅启用产品打包工作流，限制允许使用的 Actions，再触发上传的精确提交。工作流尚未被索引或推送失败时 Actions 保持禁用；解决报错后省略 `--create` 重试。

内网手动工作流 **Sync desktop packages to GitHub** 读取仓库变量 `DESKTOP_GITHUB_REPOSITORY` 和 secret `DESKTOP_GITHUB_TOKEN`；Gitea 保留以 `GITHUB_` 开头的名称。变量只保存 owner/name；secret 需要 Contents、Workflows、Actions 和 Administration 写权限，优先使用限定该构建仓库的凭据。任务获取 Gitea 的 `main` 及其固定基线，验证登记补丁后同步该源码。GitHub runner 不访问内网 Gitea 或生产凭据。桌面私有 Git 历史会上传至 GitHub；服务端和控制中心仓库仍在内网。

每个平台使用原生托管 runner 安装锁定依赖、验证基线、测试产品 sidecar，并调用产品打包入口。Windows 使用原生 PowerShell，验证未签名安装包、应用、sidecar 及安装卸载流程。打包过程包含官方打包运行时 smoke。每次构建产出未签名安装包、配套 blockmap 和 `build-manifest.json`，记录版本、源码提交、目标平台、大小及 SHA-256。可在运行记录的 Artifacts 区域下载，保留十四天。任务失败时不上传不完整安装包。

验收构建不创建 Release、不发布更新源、不使用签名证书，也不进行 macOS 公证。两个 macOS 目标沿用官方未签名本地构建的应用标识；Windows 使用配置的产品应用标识。未签名安装包可能需要正常的操作系统确认。正式签名分发使用现有内网发布流程。

## 本地检查

上游回归在所有托管平台运行。执行权限位变化在文件系统支持该权限的 macOS 和 Linux 上验证；失效符号链接检查也在 Windows 上运行。

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm run verify:upstream
```
