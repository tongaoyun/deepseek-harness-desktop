---
kind: upgrade-guide
description: "Product device reports use the native Harness home identity and no longer require a Rust sidecar."
---

# Product installation identity

English | [中文](guide.zh.md)

## Change

Electron derives the company device UUID from Harness's native anonymous ID in `$DSH_HOME/.anonymous-user-id` (default `~/.dsh/.anonymous-user-id`). Reports and feedback share this ID; neither exposes the original anonymous ID. Upgrading creates one new device record for each Harness home. Resetting or changing the home also creates a new device record.

The product Rust sidecar, its health protocol, `build:native-product` and `DEEPSEEK_HARNESS_NATIVE_BINARY` are removed. The previous Electron `native/device/device-id` file is ignored and left untouched. Native Harness services and the Node addon remain available.

## Migration

1. Remove custom sidecar launch, Cargo build and binary-copy steps. Use the standard product desktop commands and assembly manifest.
2. Keep the Harness home writable and stable to preserve the device identity across launches.
3. Confirm device reporting and feedback work after restart without a `deepseek-harness-native` process. The same home retains its new device UUID; distinct homes report separate installations.
