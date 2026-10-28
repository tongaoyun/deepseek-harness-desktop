# deepseek-harness-native

[English](README.md) | 中文

这是产品自有的 Electron sidecar，通过逐行 JSON 协议 `deepseek-harness.native.v1` 提供 `health` 和 `device-identity.get`。它不持有 Harness Session 状态，也不执行智能体。

`health` 上报 sidecar 就绪状态和 `device-identity` 能力。Electron 使用安装标识上报设备；sidecar 从 `DEEPSEEK_HARNESS_NATIVE_DATA_DIR` 下的 `device/device-id` 读取既有标识，仅在文件缺失时创建。既有标识和数据目录内的其他文件均保留。凭据加密由 Electron 独立检查。

产品方法白名单只暴露 `native.device-identity.get`，不提供通用文件、附件、数据库、凭据、认证、预览或撤销操作。设备策略配置见[升级说明](../../docs/upgrade-guide/v0.2.1-rc.2/product-native-sidecar/guide.zh.md)。
