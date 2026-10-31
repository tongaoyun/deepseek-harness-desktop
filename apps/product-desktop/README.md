# 产品桌面构建

企业桌面通过官方 Electron 管线启动和打包。产品使用与架构见[项目总览](docs/README.md)；本页是开发和交付入口。

<a id="local-development"></a>
## 本地开发

完成仓库构建和原生运行时准备后，在仓库根目录执行 `pnpm run start:product-desktop` 打开当前产品装配；`pnpm run dev:product-desktop` 会先构建再启动。钉钉登录和企业目录使用这些入口，官方 `dev:desktop` 和 `start:desktop` 不选择产品扩展。

产品启动器在 `apps/desktop/.desktop-build/product-development/` 下使用独立 home 和 Electron 用户数据目录，可通过 `DSH_PRODUCT_HOME` 和 `DSH_PRODUCT_USER_DATA` 显式覆盖。继承的官方 `DSH_HOME` 和 `DSH_DESKTOP_USER_DATA_DIR` 不决定产品状态目录。开发时可用 `DEEPSEEK_HARNESS_SERVER_URL` 覆盖服务端 origin，安装版读取打包资源。已保存的员工会话过期时需正常钉钉登录，不在 profile 之间复制令牌。

Host 沿用官方 CLI 包作为安装清单入口，插件管理页据此发现随附的实验插件。自定义插件市场在“插件 → 实验性插件 → 更多”中启用；市场源由用户配置，产品不预置市场源。

## 构建与发布

Gitea 负责开发评审和 CI；手动工作流“同步桌面构建到 GitHub”同步精确源码提交，由原生 runner 构建 Windows x64 和 macOS ARM64。校验及安装验收通过后，安装包同步到公开 GitHub 下载仓库和内网 Gitea Release。

| 模式 | 用途 | 软件内更新 |
| --- | --- | --- |
| `unsigned` | 未签名开发预发布 | 无更新源，手动安装 |
| `internal` | Mac 固定自签、Windows 未签名的免费内部分发 | 下载后确认重启安装；首次安装仍有系统安全提示 |
| `signed` | 正式可信签名及 Mac 公证 | 下载后确认重启安装；需要签名资质与原生签名机 |

打包前筛选运行时依赖，并缓存下载和 Rust 编译结果；类型检查由 main CI 执行，安装及自动更新验收保留。参数、缓存范围和发布恢复见[交付说明](docs/delivery.md)。公开构建仓库的源码和 Git 历史可公开读取；下载仓库只保存安装文件与校验元数据。

## 发布公司专家与技能

公司内容发布技能随本仓库维护。同事可让 Codex／Claude 从仓库安装或更新，无需手工传包、安装桌面依赖或重新构建软件。仓库安装、AI 发布及受控凭据接入见[公司内容发布](docs/company-content.md#ai-publishing)；公司正文保存在私有内容目录和服务端，不提交到公开桌面仓库。

<a id="native-updates"></a>
## 软件版本更新

更新的是产品软件，沿用官方更新器。`internal` 与 `signed` 使用独立更新源，不混用签名身份；开发预发布不覆盖更新源。固定自签不能代替 Apple 公证，也不消除首次安装限制。

配置见[更新与签名模式](docs/delivery.md#update-modes)，证书办理和保管见[签名与更新接入](docs/signing.md)。每个平台都需通过真实 A→B 安装升级验收，不能只凭构建成功宣称更新可用。

<a id="local-checks"></a>
## 本地检查

按改动选择产品回归、真实 Loader/profile 或安装后验收；只改文档不重跑安装流程。完整构建中的 Host 总检查等待产品 bundle 声明生成，避免读取正在重建的文件。[验收说明](docs/acceptance.md)列出入口、结果和限制，仓库级检查见[测试文档](../../docs/testing.zh.md)。
