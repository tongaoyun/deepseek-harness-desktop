---
kind: upgrade-guide
description: "产品原生 RPC 删除闲置操作及七项设备能力上报。"
---

# 产品 sidecar 保留健康检查和设备标识

[English](guide.md) | 中文

## 变更

产品自有 Rust sidecar 只接受 `health` 和 `device-identity.get`。通用 `filesystem.list/read/write`、`secure-storage.get/set/delete`、`sqlite.query/execute`、`dingtalk-auth.state`、`attachments.put/get/list`、`file-undo.record/undo` 和 `image-preview.inspect` 操作删除，对应带 `native.` 前缀的产品 RPC 同样拒绝。不删除上游 Harness 实现或当前产品功能。

健康检查只上报 `device-identity`，Electron 独立上报 `credentials.encryption`。既有安装标识和数据文件保留，历史设备报告仍可读取。

## 迁移

1. 若有外部自定义集成调用已删除的产品 RPC，移除这些调用，按实际操作使用所属 Harness 或产品 API；不提供通用 sidecar 替代接口。
2. 桌面发布前检查服务端 Nacos `deepseek-harness-server.yaml` 中的 `deepseek-harness.device-policy.required-capabilities`，退役对 `native.filesystem`、`native.secure-storage`、`native.sqlite`、`native.dingtalk-auth`、`native.attachments`、`native.file-undo`、`native.image-preview` 的要求。保留其他策略设置和对真实能力的既有要求，不把已删除实现标为 READY。策略若保留旧键，新版桌面会正常显示缺少对应能力。
3. 安装新版桌面时保留原生数据目录及 `device/device-id`。确认下一次完整设备报告的设备 ID 不变，上报 `native.device-identity` 和实际的 `credentials.encryption` 状态，不再包含退役的原生能力。
