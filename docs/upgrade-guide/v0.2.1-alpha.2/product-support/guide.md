---
kind: upgrade-guide
description: "产品桌面支持配置和反馈 HTTP 要求变更，桌面执行审计接口移除。"
---

# 产品设备与反馈支持

## Change

产品桌面装配的 `product.json` 必须包含 `support` 对象。员工认证后启动设备能力上报和在线心跳。反馈提交必须带 UUID `Idempotency-Key`；管理员更新反馈必须提供 `expectedUpdatedAt`。设备总览返回服务端分页及独立的在线与能力上报时间。桌面执行审计接口移除，官方 Session 历史仍保留在本地。

## Migration

1. 先升级产品服务端并执行数据库迁移。已有反馈和设备报告继续可用，历史内部知识库操作审计数据保留。
2. 在产品装配的 `product.json` 中添加 `"support": { "heartbeatIntervalMs": 300000, "reportIntervalMs": 86400000 }`。心跳范围为 60,000–3,600,000 毫秒；完整上报间隔不小于心跳间隔，不超过一天。参见[桌面包](../../../../packages/deepseek-harness-product/desktop/README.md#device-and-feedback)。
3. 反馈调用方为未修改的同次提交保留 UUID；管理员修改时将最后读取的 `updatedAt` 作为 `expectedUpdatedAt`。遇到 HTTP 409，先读取并确认最新反馈，再使用新时间戳重试。
4. 删除对 `/api/v1/audit-events` 和 `/api/v1/admin/audit-events` 的外部调用。设备总览调用方适配 `page`、`size`、`matchedDevices`、`totalPages` 和 `capabilitiesReportedAt`。
5. 重新构建产品装配并认证，确认控制中心显示该设备。从桌面设置菜单提交反馈，确认控制中心收到对应回执。官方装配不需要产品配置。
