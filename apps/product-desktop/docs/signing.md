# 产品桌面签名与更新接入

本页面向负责软件分发的公司管理员。免费内部更新使用固定自签 Mac 证书和未签名 Windows 安装器；正式签名分发使用下述付费资质。构建配置、发布规则和更新源由[桌面交付说明](delivery.md#update-modes)维护，两种模式都需要真实安装升级验收。

## 免费内部更新

只在首次配置时创建固定证书，受控目录必须位于 checkout 外且尚不存在：

```sh
node apps/product-desktop/scripts/create-internal-identity.mjs --directory /absolute/private/internal-macos
```

脚本生成十年有效的代码签名证书、加密 `identity.p12`、独立 `password` 和公开 `identity.json`，不覆盖已有目录，删除中间明文私钥。目录权限为 0700，P12 和密码为 0600。加密 P12 与密码应分别保存在受控凭据存储中；删除本机副本前确认可恢复，不能每次构建重新生成证书。证书过期或轮换需要重新制定安装衔接方案。

通过标准输入将 P12 的 Base64 和密码分别设置为源码仓库的 `DESKTOP_INTERNAL_MAC_CERTIFICATE`、`DESKTOP_INTERNAL_MAC_PASSWORD` Secrets，将 `identity.json` 中的指纹设置为 `DESKTOP_INTERNAL_MAC_CERTIFICATE_SHA256` 公开变量。不要在命令参数、日志、聊天或仓库中保存私钥与密码。Gitea 只需要公开指纹与内部下载仓库配置，不接收签名私钥。

选择同步工作流的 `signing=internal`。固定自签证书使 Mac 原生更新器能够验证后续更新仍由相同身份签署；Windows 使用原生未签名 NSIS 更新流程。此模式不需要付费 Apple 或 Windows 签名资质，但不解决首次安装时的 Gatekeeper／未知发布者提示，不具备公证或第三方发行者信任。自签身份与 Developer ID 身份不能混用同一更新源。

## 需要办理什么

| 平台 | 办理或准备 | 用途 |
|---|---|---|
| macOS | Apple Developer Program；Developer ID Application 证书及对应私钥；公证凭据 | 签名应用并向 Apple 公证，分发签名 DMG 和更新 ZIP |
| Windows | 可信 CA 颁发的代码签名证书、与现有签名脚本兼容的硬件令牌及驱动 | 以固定公司身份签名应用、运行时及安装器 |
| 构建环境 | Windows x64、Mac ARM64 原生签名 runner | 运行现有两平台签名、打包和安装验收 |

现有 Windows 实现使用 SafeNet 的 `eToken Base Cryptographic Provider` 和官方 SignTool。购买前须向供应商确认硬件、驱动和签名接口与该实现兼容；云签名服务、其他 CSP/KSP 或任意可导出的 PFX 不能直接视为现有流程可用。底层配置及设备操作见[官方 Windows 签名说明](../../desktop/windows-signing/README.zh.md)。

66、67 上的 Linux 服务不能代替原生签名 runner。当前签名工作流要求两个目标都明确配置，不支持仅配置一个目标后发布完整签名版本；未签名开发包仍可继续构建和手动安装。

## Mac 办理顺序

1. 由公司负责人注册 [Apple Developer Program](https://developer.apple.com/programs/enroll/)。企业产品建议用组织账号，准备公司法定名称、D-U-N-S 编号及有权代表公司签约的负责人。Apple 公布的会员费为每年 99 美元，当地价格和资格以报名页为准。
2. 账号获批后，由有权限的账号创建 [Developer ID Application 证书](https://developer.apple.com/support/developer-id/)，保管生成证书请求时的私钥。仅有下载的 `.cer` 不够；签名机需要与证书匹配的私钥。现有模板使用加密 `.p12`。
3. 按[官方 macOS 打包说明](../../desktop/packaging/README.zh.md)准备公证凭据。产品模板使用 App Store Connect API Key，对应私有 `.p8`、Key ID 和 Issuer ID；只能选择官方支持的一种公证认证方式。
4. 在 ARM64 签名机导入证书与私钥，配置私有凭据目录并验证签名和公证。公司 Team ID 和产品应用标识保持一致。

这里的 Developer ID 用于 App Store 外分发，不要求把应用提交 Mac App Store。现有 DMG／ZIP 交付不需要将用于 `.pkg` 的 Developer ID Installer 证书当作替代品。

## Windows 办理顺序

1. 向可信 CA 咨询公司代码签名证书。现有官方流程按 EV 硬件令牌配置；价格、组织核验、交付周期和令牌型号由供应商确认，不将某个证书等级视为所有 Windows 应用的统一平台要求。
2. 准备受控 Windows x64 签名机、兼容令牌、驱动及 SignTool，由设备管理员完成首次初始化和解锁。
3. 按官方模板配置公有证书、SignTool 路径、私钥容器和 PIN。私钥保留在硬件中；证书有效并不代表令牌当前可签名。
4. 执行官方签名前置检查，再完成应用、运行时和安装器的签名与时间戳验证。设备错误时停止，不能反复尝试 PIN。

## 接入与验收

账号、证书和机器就绪后，维护者按[原生更新配置](delivery.md#update-modes)配置 runner 标签、checkout 外的目录和公开下载仓库。公开变量只包含路由与目录；证书私钥、`.p12` 密码、`.p8` 和令牌 PIN 留在签名机受控配置中，不发到聊天或提交进仓库。仅向这些 runner 分派经过审核的本项目代码。

完成一次签名构建仍不代表更新可用。Windows 和 Mac ARM64 都需用两个递增版本执行真实 A→B 验收：安装 A，发现 B，下载，取消重启后仍可使用 A，再确认重启安装 B；检查应用版本、原任务与草稿保留，以及 Host 和 sidecar 退出。签名、公证、安装或升级任一项失败都不能发布为已验证的更新。

既有未签名安装版未内置更新源，首次需要手动安装签名版。Mac 的应用标识和钥匙串授权差异按桌面交付说明单独确认，不自动复制员工令牌。没有这些资质时可以选择免费内部更新，或继续交付不含更新源的未签名开发包。
