# DeepSeek Harness Electron 产品层

企业桌面使用固定 Harness 基线，版本见 [UPSTREAM_TAG](../UPSTREAM_TAG)。官方 Electron 壳、Host、Session、对话、执行、审批、定时任务及文档预览由上游实现负责；员工入口见[项目总览](../apps/product-desktop/docs/README.md)。

## 进程职责

| 位置 | 职责 |
| --- | --- |
| Electron 主进程 | 钉钉登录、加密凭据、Bootstrap、原生文件、MCP 代理及设备上报 |
| Host | 原生 Agent、Session、Skill Provider、专家委派、连接器发现与限定范围知识检索 |
| Renderer | 通过原生 UI 插槽及产品桥展示扩展页面，使用官方 Session、Workspace、Preset 和草稿 API |

产品桥使用 `window.dshDesktop.extensions` 的 `product` 命名空间。主进程校验方法白名单，Electron 校验所属窗口、来源及主 frame；员工令牌和 Bootstrap 机密不进入 Renderer。Host 通过私有 IPC 请求产品服务，只接收推理配置和私有 loopback MCP 代理凭证。

登录、已认证 Bootstrap 和 overlay 准备完成后才启动 Host。取消贯穿 Renderer、主进程、Host 和 HTTP；关闭等待在途操作和资源释放。公开失败保留错误码、相关资源和可重试性，诊断不包含凭据。接口、权限及模块职责见[产品子系统](subsystems/deepseek-harness-product.md)，设备实现见[桌面模块](../packages/deepseek-harness-product/desktop/README.md#device-and-feedback)。

## 源码与交付

Gitea 是开发主仓库，GitHub 原生 runner 负责 Windows x64 与 macOS ARM64 打包和安装验收；内网交付 runner 向下载仓库及 Gitea 发布安装文件。凭据、签名模式和恢复由[交付说明](../apps/product-desktop/docs/delivery.md)维护。

上游按 tag 和固定 commit 同步，仓库保存对应 Git 对象。`UPSTREAM_REPOSITORY` 标识官方源，仅用于显式升级；CI 从 `origin` 获取已保存的 tag。`pnpm run verify:upstream` 离线校验固定版本、登记补丁和公开出口。升级使用 `pnpm run sync:upstream` 获取指定 tag、显式解决补丁冲突，再完成官方及产品验收。
