# 桌面交付说明

本页面向维护构建和发布的开发者。产品启动见[构建入口](../README.md)，首次签名配置见[签名接入](signing.md)，平台验收见[验收说明](acceptance.md)。以下路径和命令均以仓库根目录为准。

## 构建仓库

通过 `gh auth login --hostname github.com --git-protocol https --scopes workflow` 登录。账号需要仓库管理、源码上传、工作流更新和 Actions 触发权限。同步前提交并验证源码。以下命令创建空的私有仓库，并触发首次验收构建：

```sh
node apps/product-desktop/scripts/sync-github.mjs --repository OWNER/deepseek-harness-desktop --create
```

已有仓库省略 `--create`。同步不改变可见性；新建默认私有。公开仓库的源码与 Git 历史可公开读取，标准托管 runner 的分钟免费，本流程不使用大型 runner。

同步拒绝 fork、归档、未知可见性、未提交源码、浅历史和错误基线。浅克隆须先从原桌面仓库补齐历史。只原子推送 `main` 和固定基线 tag，分叉直接失败，不强推或删引用。上传期间关闭 Actions，仅在精确提交和产品工作流可用后启用并启动构建；失败后按错误恢复，不重复建仓。

## Gitea 发布入口

内部手动工作流 **同步桌面构建到 GitHub** 读取仓库变量 `DESKTOP_GITHUB_REPOSITORY`（源码）和 `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY`（公开下载）。Gitea 保留以 `GITHUB_` 开头的名称。`DESKTOP_GITHUB_TOKEN` 需要源码同步权限和下载仓库的 Contents 写权限，优先使用仅限这两个仓库的凭据。`RELEASE_USERNAME` 和 `RELEASE_CREDENTIAL` 用于内网 Gitea Release。GitHub runner 不接收这些发布凭据，也不访问内部 Gitea 或生产服务。桌面 Git 历史只上传到构建仓库；服务端和控制中心仓库留在内网。

| 工作流输入 | 用途 |
| --- | --- |
| `source_sha` | 选择精确源码提交；省略时使用 `main` |
| `signing` | `unsigned`、`internal` 或 `signed` |
| `github_run_id` | 恢复一次已成功构建的发布，须与原源码及签名模式一致 |

新构建要求精确源码的 main CI 成功，校验上游补丁后同步。恢复使用当前 `main` 的发布脚本和原 `source_sha` 的产物校验，两者都须通过 main CI。三个平台共用由 GitHub 运行日期、编号和重试次数生成的版本；任一失败、取消或身份不符均停止发布。

内网 runner 下载有界 ZIP，按中央目录仅解压普通文件并校验清单，完成后清理临时压缩包。公开下载仓库只接收安装文件和元数据，不推送源码。

## 构建性能

main CI 执行完整类型检查；原生打包使用 `build:artifacts`，保留本地或正式品牌配置、生成声明和构建记录校验。打包前按官方 CLI、Desktop Host 和产品装配根计算生产依赖闭包，仅打包选中的工作区；安装包组装时再次从实际 tarball 核对依赖闭包和 Host 入口文件。

Mac 并行准备软件包与运行时，Electron 与主运行时也独立准备；任一失败均等待已启动的任务结束，再停止后续组装。应用目录仅组装一次，DMG 与 ZIP 从同一目录生成；ZIP 使用 `DSH_DESKTOP_MACOS_ZIP_COMPRESSION_LEVEL`（默认 `3`）。产品模块随统一构建生成，Rust sidecar 在产品入口构建一次。依赖安装保留 frozen lock 并优先复用本地 store；pnpm 元数据缓存单独保留，供应链策略检查继续执行。

GitHub 按系统及架构缓存 Electron、锁定的 Node/Python 与 Office 下载、桌面运行时 pnpm store、electron-builder 工具以及 Rust registry、Git 依赖和编译中间产物。下载缓存随依赖锁更新，Rust 缓存同时区分工具链与源码；无精确命中时复用同目标的旧缓存，由下载校验和 Cargo 增量构建确认有效性。首次运行仍需填充缓存。构建产物、安装状态和签名凭据不进入这些缓存，真实安装、启动和自动更新验收每次执行。

## 下载与恢复

下载仓库须先初始化默认分支，至少有一条提交。空仓库可以接收 Release 草稿附件，但无法完成发布；先确认仓库初始化，再启动大文件构建及上传。

GitHub 和 Gitea 先创建草稿，每个文件上传后重新下载，核对大小与 SHA-256，全部通过才发布。不替换身份或内容不同的文件及 tag。两个服务依次发布，第二个失败时第一个可能已可见。旧版本遵循下方[保留规则](#产物与保留)。

上传中断保留已校验草稿。只有重新核对为未完成的草稿 `starter` 附件才可删除后重传；完整附件直接校验，状态不明或权限失败则停止。tag 查询 404 时分页查找草稿，重复 tag 拒绝。

恢复填写原 `github_run_id`、`source_sha` 和 `signing`，继续同一次成功构建；产物过期或重试次数改变则重跑全部平台。工作流总期限 180 分钟，main CI 最多 20 分钟，GitHub 构建最多 150 分钟。

临时网络错误及 HTTP 408/429/500/502/503/504 最多尝试四次，间隔 1/2/4 秒；包含响应正文中断。产物中断后重新下载到空的私有目录。权限、非法内容及校验冲突不重试。等待继续跟踪同一个 GitHub run，总期限不重置；超时保留 run ID，不能重新派发来恢复上传。

源码写入及启动构建只执行一次。原子推送失败后回读远端 `main` 和固定基线，只有均与请求一致时才继续；否则保持 Actions 关闭。诊断不返回凭据、签名 URL 参数、响应正文或 Git stderr。工作流 API 只管理 `.github/workflows/` 文件；Dependabot 等动态工作流使用独立仓库设置。

内网 CI 与同步工作流的依赖安装步骤，以及源码同步与发布步骤，从 Gitea Secrets 读取 `DESKTOP_GITHUB_PROXY_URL`，仅在这些步骤内使用认证代理；GitHub Git 请求使用 HTTP/1.1。代理 URL 不写入仓库变量或源码，不设置服务器全局代理；内网源码获取和 GitHub 托管打包使用各自的网络配置。

<a id="update-modes"></a>
## 更新与签名模式

应用启动、周期检查和手动检查沿用官方调度。发现新版后由用户下载，再确认重启安装；取消则保留当前应用。任务停止、Host 关闭和安装由官方更新器处理，不检查 Harness 上游源码，不访问官方 DeepSeek 登录或策略服务。

### 未签名开发包

默认 `signing=unsigned` 输出 EXE 或 DMG，发布为开发预发布，无更新清单，不覆盖已有更新 latest。Mac 沿用官方未签名应用标识，Windows 使用产品应用标识；首次安装可能需要系统确认。单独 GitHub 打包只上传 Actions 产物，交付须继续内网同步流程。

### 免费内部更新

`signing=internal` 使用标准 GitHub 托管 runner。Mac 使用同一张固定自签证书签署应用、Electron 组件和产品 sidecar，不进行 Apple 公证；已准备的 Harness 与 Python 运行时保留原有字节和签名，并由官方清单与应用资源封装验证；Windows 保持未签名 NSIS 安装器。Mac 同时产出 DMG 和更新 ZIP，Windows 产出 EXE；文件名带 `-internal`，清单如实记录签名方式和 `notarized: false`，不能冒充正式签名包。发布仍要求三个平台构建与安装验收全部通过。

GitHub 源码仓库配置 Secrets `DESKTOP_INTERNAL_MAC_CERTIFICATE`（加密 P12 的 Base64）和 `DESKTOP_INTERNAL_MAC_PASSWORD`，以及公开变量 `DESKTOP_INTERNAL_MAC_CERTIFICATE_SHA256`。证书只在 Mac 打包及隔离安装验收步骤传入，导入独立临时钥匙串；打包结束或失败后恢复搜索列表并删除导入的凭据，不修改系统证书信任。P12 输入及密码不传入后续构建子进程、发布机或渲染进程。固定证书的创建与保管见签名说明。

GitHub 和 Gitea 都配置 `DESKTOP_INTERNAL_DOWNLOAD_REPOSITORY` 及相同的公开证书指纹；内部下载仓库必须与正式的 `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY` 分开。发布前核对固定证书指纹、源码、版本、更新清单和实际安装文件的大小及哈希。更新源使用内部下载仓库的匿名 latest 地址，不携带 GitHub 或员工令牌。

自签只提供相同身份间的原生更新校验，不提供 Apple 信任或公证。首次下载安装仍可能被 Gatekeeper 阻止，Windows 仍可能显示未知发布者提示；不能通过关闭系统安全功能解决。旧开发包首次需手动安装内部包，之后可检查新版、下载并确认重启安装。证书必须持续使用，丢失或更换后不能依赖原生更新自动衔接。

### 正式签名更新

`signing=signed` 需要公开下载仓库 `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY`，以及按 `win-x64`、`mac-arm64`、`mac-x64` 索引的 JSON 变量：

| 变量 | 每个目标的值 |
| --- | --- |
| `DESKTOP_SIGNING_RUNNERS` | 含 `self-hosted`、原生操作系统、架构及专用机器标签的数组 |
| `DESKTOP_SIGNING_CONFIG_DIRS` | checkout 外的绝对配置目录 |

缺少任一目标则前置检查失败，不排队、不降级。签名机只运行审核过的本项目代码。底层配置见[Windows 签名机](../../desktop/windows-signing/README.zh.md)和 [Mac 签名公证](../../desktop/packaging/README.zh.md)。

每台签名机的 `presets/production.env` 必须包含以下公开配置；`OWNER/REPO` 与公开下载仓库变量一致。签名凭据仍放在官方定义的 `secrets/windows-signing.env` 或 `secrets/macos-signing.env`，不传给发布机或渲染进程。签名构建提供 nightly 产品版本，强制升级策略显式关闭，不访问官方 DeepSeek 登录或策略服务。

```dotenv
DSH_DESKTOP_APP_ID=com.instudio.deepseek-harness.desktop
DSH_DESKTOP_AUTO_UPDATE_ENV=production
DSH_DESKTOP_UPDATE_URL=https://github.com/OWNER/REPO/releases/latest/download/
DSH_DESKTOP_MANDATORY_UPDATE_ENABLED=0
```

发布核对签名管线记录中的版本、源码、干净状态、目标和更新地址。Mac 必须有签名公证的 DMG 与 ZIP，Windows 必须通过签名验证。原生清单核对大小和 SHA-512，Mac 两种架构合并为一份清单；安装文件使用固定版本绝对地址。

两端所有产物校验后才更新 latest；恢复旧构建不得回退更新源。Release 标记不改变源码预发布版本或原生 nightly 比较规则。

原来的未签名安装版没有更新配置，不能自行发现首个签名版本；首次需要手动安装签名包，之后才进入原生更新流程。Mac 的产品签名包与原未签名包应用标识不同，首次安装应明确检查数据目录及钥匙串授权，不自动复制员工令牌。配置和模拟回归通过不等同于签名成功；启用分发前必须在签名机分别完成 Windows 和两种 Mac 架构的真实 A→B 安装升级验收。

## 产物与保留

三平台先运行已构建的官方及产品 profile，再验证安装后的完整应用；失败阻止发布。成功构建生成安装包、blockmap 和平台 `build-manifest.json`，发布端汇总源码、版本、平台、大小及 SHA-256，并生成 `SHA256SUMS.txt`。

Actions 安装包保留一天，截图与 JSON 验收报告保留十四天。日志及 Actions 产物遵循源码仓库可见性。归档 Host 启动回归必须在产品 bootstrap 编译后、安装包上传前运行，不能依赖 runner 缓存。

Gitea Release 和两个 GitHub 下载仓库分别保留最新两个已发布版本，开发预发布与原生更新渠道分别计数；按发布时间排序，每个版本完整保留 Windows x64、macOS ARM64、macOS Intel 安装包及 ZIP、blockmap、更新清单和校验文件。草稿不计数、不自动删除。回收仅处理产品交付版本标签，保留源码 Git tag；有安装文件的旧版本须在两个保留版本均含三平台安装包时才可删除，权限或元数据异常会停止清理。

“桌面 Release 回收”工作流每日北京时间 09:00 执行，使用与发布相同的互斥组。手动运行默认只预览，开启 `apply` 才删除；不重新打包或发布桌面。Gitea 软件包的保留规则不适用于 Release 附件。
