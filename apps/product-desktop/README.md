# 产品桌面构建

## 概要

产品 assembly 通过官方 Electron 管线启动和打包企业桌面。内网 Gitea 负责开发和审核；GitHub 源码仓库接收选定的已提交源码及其固定 Harness 基线，使用托管 runner 构建 Windows x64、macOS ARM64 和 macOS Intel 安装包。产品流程和架构从[项目总览](docs/README.md)开始阅读。

<a id="local-development"></a>
## 本地开发

完成仓库构建和原生运行时准备后，在仓库根目录执行 `pnpm run start:product-desktop` 打开当前产品装配；`pnpm run dev:product-desktop` 会先构建再启动。钉钉登录和企业目录使用这些入口，官方 `dev:desktop` 和 `start:desktop` 不选择产品扩展。

产品启动器在 `apps/desktop/.desktop-build/product-development/` 下使用独立 home 和 Electron 用户数据目录，可通过 `DSH_PRODUCT_HOME` 和 `DSH_PRODUCT_USER_DATA` 显式覆盖。继承的官方 `DSH_HOME` 和 `DSH_DESKTOP_USER_DATA_DIR` 不决定产品状态目录。开发时可用 `DEEPSEEK_HARNESS_SERVER_URL` 覆盖服务端 origin，安装版读取打包资源。已保存的员工会话过期时需正常钉钉登录，不在 profile 之间复制令牌。

## GitHub 打包

归档 Host 启动测试在产品打包生成编译后的 bootstrap 文件后运行，安装包上传前必须通过；干净 runner 不依赖已有编译缓存。

通过 `gh auth login --hostname github.com --git-protocol https --scopes workflow` 登录。账号需要仓库管理、源码上传、工作流更新和 Actions 触发权限。同步前提交并验证源码。以下命令创建空的私有仓库，并触发首次验收构建：

```sh
node apps/product-desktop/scripts/sync-github.mjs --repository OWNER/deepseek-harness-desktop --create
```

已有构建仓库时省略 `--create`。同步支持公开或私有源码仓库，不改变仓库可见性。公开仓库的源码和 Git 历史任何人均可读取；公开仓库使用标准托管 runner 的运行分钟免费，此工作流不使用付费大型 runner。新建仓库默认保持私有。同步拒绝未知可见性、fork、归档仓库、未提交源码、浅克隆历史和不一致的基线。浅克隆先通过 `git fetch --unshallow origin` 从现有桌面仓库补齐历史，再进行同步。脚本只原子推送 `main` 和固定基线 tag；引用分叉时直接失败，不强推、不删除引用、不修改 remote。上传期间 Actions 保持禁用。适配层禁用复制过来的上游工作流，仅启用产品打包工作流，限制允许使用的 Actions，再触发上传的精确提交。工作流尚未被索引或推送失败时 Actions 保持禁用；解决报错后省略 `--create` 重试。

内部手动工作流 **同步桌面构建到 GitHub** 读取仓库变量 `DESKTOP_GITHUB_REPOSITORY`（源码）和 `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY`（公开下载）。Gitea 保留以 `GITHUB_` 开头的名称。`DESKTOP_GITHUB_TOKEN` 需要源码同步权限和下载仓库的 Contents 写权限，优先使用仅限这两个仓库的凭据。`RELEASE_USERNAME` 和 `RELEASE_CREDENTIAL` 用于内网 Gitea Release。GitHub runner 不接收这些发布凭据，也不访问内部 Gitea 或生产服务。桌面 Git 历史只上传到构建仓库；服务端和控制中心仓库留在内网。

新构建检出 `main` 或明确填写的 `source_sha`，要求该提交的 main CI 成功，校验登记补丁、同步源码，然后等待本次关联的 GitHub 构建。填写 `github_run_id` 恢复发布时，从当前 `main` 获取发布脚本，`source_sha` 仍指向已构建源码；两个提交都必须通过 main CI。版本和产物校验使用已构建源码，不使用发布脚本的提交。三个平台从托管运行的 UTC 开始日期、编号和重试次数生成同一版本。任一平台失败、取消、缺失或身份不符都会停止发布。内网 runner 暂存有界 ZIP，根据中央目录解压普通文件，按清单检查每个安装包，并生成汇总的 `build-manifest.json` 和 `SHA256SUMS.txt`。解压结束清理临时压缩包。公开下载仓库只接收安装文件及这些元数据，不推送源码。

两个目标先创建 Release 草稿。每个上传文件都重新下载并校验大小及 SHA-256，全部通过后才完成发布。发布不替换身份或内容不同的文件及 tag，也不删除旧下载。失败时保留已验证的草稿供重试。GitHub 的 tag 接口返回 404 时，草稿恢复检查全部 Release 列表分页，并拒绝重复 tag。两个服务的发布依次执行：第二个发布失败时，第一个完整 Release 可能已经可见。填写 `github_run_id`、对应的 `source_sha` 和原构建的 `signing` 可复用同一次成功构建，核对中断上传并完成发布，无需重新打包。托管产物必须尚未过期；产物过期或运行重试次数变化后应重跑全部平台。工作流允许 180 分钟，其中 main CI 最多等待 20 分钟、托管构建最多等待 150 分钟。

每个平台使用原生 runner 安装锁定依赖、验证基线、测试产品 sidecar，并调用产品打包入口。Windows 按所选模式验证签名状态和安装器生命周期；打包包含官方运行时 smoke。runner 先运行已构建的官方及产品 profile，再运行安装后的产品应用：Windows 将 EXE 静默安装到私有目录，结束后卸载；macOS 将 DMG 中的应用复制到私有目录，结束后卸载磁盘映像。安装后验收启动打包的 ASAR、内置 Host、扩展和 sidecar，不使用源码运行时覆盖。仅将临时安装副本的服务地址指向本地测试服务，使用独立数据、测试身份和模拟模型。同一无密钥界面回归覆盖目录、技能与套件安装、连接器状态、知识库原文件预览、任务选择及重启恢复，不登录真实员工，也不验证系统签名提示。截图和 JSON 报告保留十四天，失败时也上传；日志及产物遵循源码仓库可见性。界面失败会阻止安装包发布。成功构建生成安装包、blockmap 和 `build-manifest.json`，记录版本、源码提交、平台、大小及 SHA-256。Actions 安装包产物保留一天；已发布的 Release 下载文件不自动过期。

默认 `signing=unsigned` 产出 Windows EXE 或 macOS DMG，发布为开发预发布，不提供更新清单，也不改变已有签名版本的 latest 下载。两个 macOS 目标沿用官方未签名本地构建的应用标识；Windows 使用配置的产品应用标识。未签名安装包可能需要操作系统确认。单独运行 GitHub 打包只上传 Actions 产物，正式交付继续使用内网同步工作流。Windows 打包前用 PowerShell 实际执行两种签名模式的命令回归，检查目标、版本和 `--unsigned` 参数完整传递。

## 软件版本更新

`signing=signed` 接入这个产品桌面软件的原生更新，使用公开下载仓库的 `releases/latest/download/` 地址，无需 GitHub 登录或员工令牌。应用启动及周期检查沿用官方更新调度，也可从原生菜单检查更新。发现新版后由用户下载，下载完成后再次确认重启安装；取消确认会保留当前应用。任务停止、Host 关闭和安装交给官方更新器处理，不检查或同步 Harness 上游源码。

签名构建必须配置 GitHub 仓库变量 `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY`、`DESKTOP_SIGNING_RUNNERS` 和 `DESKTOP_SIGNING_CONFIG_DIRS`。后两项是按 `win-x64`、`mac-arm64`、`mac-x64` 索引的 JSON 对象，分别保存 runner 标签数组和机器上的绝对配置目录。标签必须包括 `self-hosted`、原生操作系统、原生架构及专用机器标签，例如 Windows 的 `["self-hosted","Windows","X64","product-signing-win"]`。macOS 使用 `macOS` 与 `ARM64` 或 `X64`。缺少任一目标配置时，前置检查失败，不排队签名，也不降级为开发包。签名机仅运行经过审核的本项目提交，配置目录和证书放在 checkout 外。Windows 沿用[官方签名机](../desktop/windows-signing/README.zh.md)，Mac 沿用[官方签名和公证流程](../desktop/packaging/README.zh.md)。

每台签名机的 `presets/production.env` 必须包含以下公开配置；`OWNER/REPO` 与公开下载仓库变量一致。签名凭据仍放在官方定义的 `secrets/windows-signing.env` 或 `secrets/macos-signing.env`，不传给发布机或渲染进程。签名构建提供 nightly 产品版本，强制升级策略显式关闭，不访问官方 DeepSeek 登录或策略服务。

```dotenv
DSH_DESKTOP_APP_ID=com.instudio.deepseek-harness.desktop
DSH_DESKTOP_AUTO_UPDATE_ENV=production
DSH_DESKTOP_UPDATE_URL=https://github.com/OWNER/REPO/releases/latest/download/
DSH_DESKTOP_MANDATORY_UPDATE_ENABLED=0
```

更新清单只接受官方签名管线完成记录，检查版本、源码、干净状态、目标和更新地址。Mac 必须产出经过签名及公证的 DMG 与 ZIP；Windows 必须通过签名验证。交付步骤核对原生清单中的大小及 SHA-512，将 Mac 两种架构合并成一份原生清单，由原生更新器选择架构。清单中的安装文件使用固定版本的绝对下载地址，后续发布不影响已发现版本的下载。两个目标的全部产物验证完成后，签名版本才成为公开 latest；恢复旧构建不得将更新源回退到较低版本。这里的 Release 标记控制产品下载入口，源码中的 alpha／beta 版本号和原生 nightly 比较规则不变。开发预发布永不覆盖该入口。

原来的未签名安装版没有更新配置，不能自行发现首个签名版本；首次需要手动安装签名包，之后才进入原生更新流程。Mac 的产品签名包与原未签名包应用标识不同，首次安装应明确检查数据目录及钥匙串授权，不自动复制员工令牌。配置和模拟回归通过不等同于签名成功；启用分发前必须在签名机分别完成 Windows 和两种 Mac 架构的真实 A→B 安装升级验收。

<a id="local-checks"></a>
## 本地检查

Office 原文件验收样本使用固定 ZIP 时间戳，下载、系统打开与稍后校验使用相同字节；本地和三平台构建均运行跨时钟回归，避免把测试样本变化误报为文件损坏。产品界面沿用官方主题的细边框、圆形标记和分层滚动条颜色。

内部桌面 CI 覆盖制品导入、对话修改、草稿重启和真实 Loader 的技能及套件组合。[工作流回归](../../scripts/deepseek-harness-electron-workflows.spec.ts)要求这些测试保留在实际执行的 CI 命令中。托管打包开始前，精确源码提交必须通过 main CI。

内网同步步骤可从 Gitea Secrets 读取 `DESKTOP_GITHUB_PROXY_URL`。Node 和 Git 仅在该步骤内使用此认证代理，GitHub Git 请求使用 HTTP/1.1。代理 URL 不写入仓库变量或源码；源码获取、依赖安装和托管打包使用各自的网络配置。

源码同步与发布共用完整读取重试：暂时网络错误或 HTTP 408/429/500/502/503/504 按 1/2/4 秒间隔最多尝试四次，也覆盖响应正文读取中断。产物中断后从空的私有暂存目录重新下载；内容非法、权限拒绝及校验和冲突不重试。源码同步写操作，包括启动构建，只执行一次。原子推送失败后回读远端 main 和固定基线，包含附注标签；仅两个提交均与请求一致时继续同步，其他失败保持 Actions 关闭。诊断只包含安全错误码和操作名称，不包含凭据、签名 URL 查询参数或响应正文。Git 推送失败区分 TLS、代理授权、网络和版本冲突，不返回 stderr。

工作流选择只管理 `.github/workflows/` 下的文件。Dependabot 等由 GitHub 管理的动态工作流使用独立仓库设置，无法通过工作流 API 停用。

上游回归在所有托管平台运行。执行权限位变化在文件系统支持该权限的 macOS 和 Linux 上验证；失效符号链接检查也在 Windows 上运行。

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs apps/product-desktop/tests/desktop-release.test.mjs apps/product-desktop/tests/product-updates.test.mjs apps/product-desktop/tests/acceptance-process.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm exec vitest run apps/product-desktop/tests/close-electron.spec.ts
pnpm exec vitest run apps/product-desktop/tests/office-fixture.spec.ts
pnpm run verify:upstream
pnpm --dir apps/product-desktop run test:installed --target mac-arm64
```

安装后验收需要原生 Windows 或 macOS runner 及其生成的安装包。使用 `--installer /absolute/path/to/installer.dmg`（或 EXE）可验证已有下载包，无需重新构建。验收使用私有临时目录，结束后清理；不要在 Windows 上与同一产品的其他安装操作同时运行。

安装版界面命令使用独立于打包任务的十分钟超时。超时或 SIGINT/SIGTERM 取消会使验收失败，终止正在运行的命令进程树（Windows 使用 `taskkill /T /F`，macOS 使用独立进程组），等待命令关闭后再卸载。进程终止与关闭分别最多等待十秒，清理错误也会使运行失败。原生 runner 使用真实子进程及孙进程验证超时和取消。这限制测试卡住的影响，不会将未完成的验收视为成功构建。

每次 Electron 重启和最终关闭都最多等待十秒正常退出。重启验收先等待官方 Agent 空闲 UI，不能仅凭回复文字判断任务完成；关闭前释放当前应用所有权，失败后不会再次关闭已释放的 Playwright 应用。页面已关闭时保留进程诊断，不再尝试失败截图。关闭卡住时会终止应用进程树、等待退出并使测试失败。Windows 卸载前还会终止解析后可执行路径位于私有安装目录内的孤儿进程，即使父进程已经退出。恢复不按应用名称匹配，其他安装和无关进程不在清理范围。Windows CI 使用孤儿可执行进程及无关存活进程验证该限制。

进程清理回归要求所有测试进程停止执行。Linux 通过 `/proc` 区分存活进程与等待容器 PID 1 回收的僵尸或已死亡记录；后者已停止执行并释放文件。其他平台要求 PID 消失。直接命令还必须通过关闭事件确认退出。

macOS 界面验收在一次性配置目录中使用 Chromium 测试钥匙串，避免等待访问 runner 登录钥匙串的交互授权。这验证凭据传递和重启行为，不验证系统钥匙串保护及其授权弹窗。应用启动入口和打包配置不含该测试标志；正常启动仍使用操作系统加密存储。

开发启动和构建后配置验收在所有平台都通过文件 URL 传递产品扩展的 ESM 入口。首个窗口出现前的启动错误以脱敏诊断制品记录，仅在失败时保留。仅用于测试的 profile 插件在应用就绪后记录已加载的启动模块 URL 和根 Include 标识；验收失败时，将这些不含凭据的证据与渲染进程启动警告一起输出。
