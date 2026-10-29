# deepseek-harness-native

English | [中文](README.zh.md)

This product-owned Electron sidecar provides `health` and `device-identity.get` through the line-delimited JSON protocol `deepseek-harness.native.v1`. It owns no Harness Session state or agent execution.

`health` reports sidecar readiness and the `device-identity` capability. Electron uses the installation identifier for device reporting; the sidecar reads the existing `device/device-id` file under `DEEPSEEK_HARNESS_NATIVE_DATA_DIR` and creates it only when missing. Existing identifiers and other files in the data directory are preserved. Credential encryption is checked separately by Electron.

Electron main checks readiness, protocol and the device-identity capability before starting product services. The product bridge exposes no `native.*` methods or raw installation identifier to the page. Files, attachments, databases, credentials, authentication, previews and undo have no generic sidecar operations. See the [upgrade guide](../../docs/upgrade-guide/v0.2.1-rc.2/product-native-sidecar/guide.md) for device-policy configuration.
