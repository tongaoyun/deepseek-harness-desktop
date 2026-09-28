# 小胤产品层

[English](xiaoyin-product.md) | 中文

小胤产品层围绕官方 DeepSeek Harness 桌面端提供企业能力。产品层只负责产品数据和外部集成；会话、回合、工具、审批、会话界面、Browser、Office、权限以及会话持久化仍由 Harness 负责。

## 产品能力

- 钉钉 OAuth 会话和员工初始化信息。
- 专家套件、技能、连接器和知识库目录。
- IM 与系统定时任务关联。
- 产品引用、交付成果和受限 Electron 桥接。

产品桥只向 Renderer 暴露 `invoke`、`subscribe` 和 `getSession`。文件系统、凭据、SQLite、附件和设备身份操作都留在 `xiaoyin.native.v1` sidecar 协议之后。

## 边界

产品包只能使用公开的 Harness 包 API 和稳定扩展点，不得导入私有运行时模块，不得替换 Session Controller，也不得维护第二套会话 reducer。产品元数据通过官方 Sidebar 和 Slot 扩展点叠加。
