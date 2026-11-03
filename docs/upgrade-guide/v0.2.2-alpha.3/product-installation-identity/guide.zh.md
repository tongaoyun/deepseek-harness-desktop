---
kind: upgrade-guide
description: "产品设备上报使用 Harness 原生 home 身份，不再需要 Rust sidecar。"
---

# 产品安装身份

[English](guide.md) | 中文

## 变更

Electron 从 `$DSH_HOME/.anonymous-user-id`（默认 `~/.dsh/.anonymous-user-id`）的 Harness 原生匿名 ID 派生公司设备 UUID。设备上报与反馈共用此 ID，均不暴露原始匿名 ID。升级后每个 Harness home 会生成一条新设备记录；重置或切换 home 也会生成新设备记录。

产品 Rust sidecar、健康协议、`build:native-product` 和 `DEEPSEEK_HARNESS_NATIVE_BINARY` 已移除。原 Electron `native/device/device-id` 文件不再读取，文件保持原样。Harness 原生服务与 Node addon 继续提供能力。

## 迁移

1. 移除自定义 sidecar 启动、Cargo 构建和二进制复制步骤，使用标准产品桌面命令与组合清单。
2. 保持 Harness home 可写且路径稳定，以在重启后保留设备身份。
3. 确认没有 `deepseek-harness-native` 进程时，重启后仍能完成设备上报与反馈。同一 home 保留新的设备 UUID，不同 home 作为独立安装上报。
