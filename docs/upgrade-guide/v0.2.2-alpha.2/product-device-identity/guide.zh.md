---
kind: upgrade-guide
description: "产品 RPC 不再提供原始安装标识，桌面启动要求 sidecar 就绪且协议匹配。"
---

# 设备标识仅留在 Electron 主进程

[English](guide.md) | 中文

## 变更

产品桥接移除 `native.device-identity.get` 和构造参数 `nativeInvoke`，不再提供任何 `native.*` 产品 RPC。Electron 主进程仍使用既有安装标识上报设备和提交反馈；持久化安装标识和服务端设备 ID 不变。

桌面启动和设备上报要求 `health` 返回 `ready: true`、`protocol: deepseek-harness.native.v1` 以及包含 `device-identity`、无重复项的能力列表。无效回执返回 `DEVICE_HEALTH_INVALID`；启动失败前等待 sidecar 清理完成。

## 迁移

1. 移除自定义页面对 `native.device-identity.get` 的调用，以及桥接构造中的 `nativeInvoke`。认证后的上报状态通过 `support.device.report` 获取，不含凭据；原始标识没有替代接口。
2. 桌面和匹配的 sidecar 一起打包，保留原生数据目录及 `device/device-id` 文件。
3. 确认启动成功，下一次设备报告的服务端设备 ID 不变；不兼容的 sidecar 拒绝启动，产品桥接不接受任何 `native.*` 调用。
