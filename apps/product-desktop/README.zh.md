# 产品桌面构建

[English](README.md) | 中文

## 概要

产品 assembly 通过官方 Electron 管线启动和打包企业桌面。内网 Gitea 负责开发和审核；GitHub 源码仓库接收选定的已提交源码及其固定 Harness 基线，使用托管 runner 构建 Windows x64、macOS ARM64 和 macOS Intel 安装包。产品流程和架构从[项目总览](docs/README.zh.md)开始阅读。

<a id="local-development"></a>
## 本地开发

完成仓库构建和原生运行时准备后，在仓库根目录执行 `pnpm run start:product-desktop` 打开当前产品装配；`pnpm run dev:product-desktop` 会先构建再启动。钉钉登录和企业目录使用这些入口，官方 `dev:desktop` 和 `start:desktop` 不选择产品扩展。

产品启动器在 `apps/desktop/.desktop-build/product-development/` 下使用独立 home 和 Electron 用户数据目录，可通过 `DSH_PRODUCT_HOME` 和 `DSH_PRODUCT_USER_DATA` 显式覆盖。继承的官方 `DSH_HOME` 和 `DSH_DESKTOP_USER_DATA_DIR` 不决定产品状态目录。开发时可用 `DEEPSEEK_HARNESS_SERVER_URL` 覆盖服务端 origin，安装版读取打包资源。已保存的员工会话过期时需正常钉钉登录，不在 profile 之间复制令牌。

## GitHub 打包

通过 `gh auth login --hostname github.com --git-protocol https --scopes workflow` 登录。账号需要仓库管理、源码上传、工作流更新和 Actions 触发权限。同步前提交并验证源码。以下命令创建空的私有仓库，并触发首次验收构建：

```sh
node apps/product-desktop/scripts/sync-github.mjs --repository OWNER/deepseek-harness-desktop --create
```

已有构建仓库时省略 `--create`。同步支持公开或私有源码仓库，不改变仓库可见性。公开仓库的源码和 Git 历史任何人均可读取；公开仓库使用标准托管 runner 的运行分钟免费，此工作流不使用付费大型 runner。新建仓库默认保持私有。同步拒绝未知可见性、fork、归档仓库、未提交源码、浅克隆历史和不一致的基线。浅克隆先通过 `git fetch --unshallow origin` 从现有桌面仓库补齐历史，再进行同步。脚本只原子推送 `main` 和固定基线 tag；引用分叉时直接失败，不强推、不删除引用、不修改 remote。上传期间 Actions 保持禁用。适配层禁用复制过来的上游工作流，仅启用产品打包工作流，限制允许使用的 Actions，再触发上传的精确提交。工作流尚未被索引或推送失败时 Actions 保持禁用；解决报错后省略 `--create` 重试。

内部手动工作流 **同步桌面构建到 GitHub** 读取仓库变量 `DESKTOP_GITHUB_REPOSITORY`（源码）和 `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY`（公开下载）。Gitea 保留以 `GITHUB_` 开头的名称。`DESKTOP_GITHUB_TOKEN` 需要源码同步权限和下载仓库的 Contents 写权限，优先使用仅限这两个仓库的凭据。`RELEASE_USERNAME` 和 `RELEASE_CREDENTIAL` 用于内网 Gitea Release。GitHub runner 不接收这些发布凭据，也不访问内部 Gitea 或生产服务。桌面 Git 历史只上传到构建仓库；服务端和控制中心仓库留在内网。

新构建检出 `main` 或明确填写的 `source_sha`，要求该提交的 main CI 成功，校验登记补丁、同步源码，然后等待本次关联的 GitHub 构建。填写 `github_run_id` 恢复发布时，从当前 `main` 获取发布脚本，`source_sha` 仍指向已构建源码；两个提交都必须通过 main CI。版本和产物校验使用已构建源码，不使用发布脚本的提交。三个平台从托管运行的 UTC 开始日期、编号和重试次数生成同一版本。任一平台失败、取消、缺失或身份不符都会停止发布。内网 runner 暂存有界 ZIP，根据中央目录解压普通文件，按清单检查每个安装包，并生成汇总的 `build-manifest.json` 和 `SHA256SUMS.txt`。解压结束清理临时压缩包。公开下载仓库只接收安装文件及这些元数据，不推送源码。

两个目标先创建开发预发布草稿。每个上传文件都重新下载并校验大小及 SHA-256，全部通过后才完成 Release 发布。发布不替换身份或内容不同的文件及 tag，也不删除旧下载。失败时保留已验证的草稿供重试。GitHub 的 tag 接口返回 404 时，草稿恢复检查全部 Release 列表分页，并拒绝重复 tag。两个服务的发布依次执行：第二个发布失败时，第一个完整 Release 可能已经可见。填写 `github_run_id` 和对应的 `source_sha` 可复用同一次成功构建，核对中断上传并完成发布，无需重新打包。托管产物必须尚未过期；产物过期或运行重试次数变化后应重跑全部平台。工作流允许 180 分钟，其中 main CI 最多等待 20 分钟、托管构建最多等待 150 分钟。

每个平台使用原生托管 runner 安装锁定依赖、验证基线、测试产品 sidecar，并调用产品打包入口。Windows 验证未签名文件和安装器生命周期；打包包含官方运行时 smoke。runner 先运行已构建的官方及产品 profile，再运行安装后的产品应用：Windows 将 EXE 静默安装到私有目录，结束后卸载；macOS 将 DMG 中的应用复制到私有目录，结束后卸载磁盘映像。安装后验收启动打包的 ASAR、内置 Host、扩展和 sidecar，不使用源码运行时覆盖。仅将临时安装副本的服务地址指向本地测试服务，使用独立数据、测试身份和模拟模型。同一无密钥界面回归覆盖目录、技能与套件安装、连接器状态、知识库原文件预览、任务选择及重启恢复，不登录真实员工，也不验证系统签名提示。截图和 JSON 报告保留十四天，失败时也上传；日志及产物遵循源码仓库可见性。界面失败会阻止安装包发布。成功构建生成未签名安装包、blockmap 和 `build-manifest.json`，记录版本、源码提交、平台、大小及 SHA-256。Actions 安装包产物保留一天；已发布的 Release 下载文件不自动过期。

验收构建产出 Windows EXE 或 macOS DMG；官方管线产出的其他压缩包或 blockmap 也会一并上传。内网交付工作流将已验证的未签名安装包发布到公开 GitHub 和内网 Gitea 预发布。单独运行 GitHub 打包仍只上传 Actions 产物。两种流程均不发布自动更新源、不使用签名证书，也不进行 macOS 公证。两个 macOS 目标沿用官方未签名本地构建的应用标识；Windows 使用配置的产品应用标识。未签名安装包可能需要正常的操作系统确认。Gitea 保留桌面 CI 和手动 GitHub 同步；原生安装包由 GitHub 工作流构建。正式签名分发需要单独配置发布流程。

<a id="local-checks"></a>
## 本地检查

内部桌面 CI 覆盖制品导入、对话修改、草稿重启和真实 Loader 的技能及套件组合。[工作流回归](../../scripts/deepseek-harness-electron-workflows.spec.ts)要求这些测试保留在实际执行的 CI 命令中。托管打包开始前，精确源码提交必须通过 main CI。

内网同步步骤可从 Gitea Secrets 读取 `DESKTOP_GITHUB_PROXY_URL`。Node 和 Git 仅在该步骤内使用此认证代理，GitHub Git 请求使用 HTTP/1.1。代理 URL 不写入仓库变量或源码；源码获取、依赖安装和托管打包使用各自的网络配置。

源码同步与发布共用完整读取重试：暂时网络错误或 HTTP 408/429/500/502/503/504 按 1/2/4 秒间隔最多尝试四次，也覆盖响应正文读取中断。产物中断后从空的私有暂存目录重新下载；内容非法、权限拒绝及校验和冲突不重试。源码同步写操作，包括启动构建，只执行一次；结果不确定时，必须核对远端状态后再重试。诊断只包含安全错误码和操作名称，不包含凭据、签名 URL 查询参数或响应正文。Git 推送失败只报告进程状态，避免 stderr 泄露代理凭据。

工作流选择只管理 `.github/workflows/` 下的文件。Dependabot 等由 GitHub 管理的动态工作流使用独立仓库设置，无法通过工作流 API 停用。

上游回归在所有托管平台运行。执行权限位变化在文件系统支持该权限的 macOS 和 Linux 上验证；失效符号链接检查也在 Windows 上运行。

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs apps/product-desktop/tests/desktop-release.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm run verify:upstream
pnpm --dir apps/product-desktop run test:installed --target mac-arm64
```

安装后验收需要原生 Windows 或 macOS runner 及其生成的安装包。使用 `--installer /absolute/path/to/installer.dmg`（或 EXE）可验证已有下载包，无需重新构建。验收使用私有临时目录，结束后清理；不要在 Windows 上与同一产品的其他安装操作同时运行。

macOS 界面验收在一次性配置目录中使用 Chromium 测试钥匙串，避免等待访问 runner 登录钥匙串的交互授权。这验证凭据传递和重启行为，不验证系统钥匙串保护及其授权弹窗。应用启动入口和打包配置不含该测试标志；正常启动仍使用操作系统加密存储。

开发启动和构建后配置验收在所有平台都通过文件 URL 传递产品扩展的 ESM 入口。首个窗口出现前的启动错误以脱敏诊断制品记录，仅在失败时保留。
