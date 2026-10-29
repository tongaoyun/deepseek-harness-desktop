---
kind: upgrade-guide
description: "Product RPC no longer exposes the raw installation identity, and desktop startup requires a compatible ready sidecar."
---

# Device identity stays in Electron main

English | [中文](guide.zh.md)

## Change

The product bridge removes `native.device-identity.get` and its `nativeInvoke` constructor option. No `native.*` product RPC remains. Electron main still uses the existing installation identifier for device reports and feedback; the stored identifier and server device ID do not change.

Desktop startup and device reporting require `health` to return `ready: true`, `protocol: deepseek-harness.native.v1` and a unique capability list containing `device-identity`. Invalid receipts fail with `DEVICE_HEALTH_INVALID`; startup waits for sidecar cleanup before reporting failure.

## Migration

1. Remove custom page calls to `native.device-identity.get` and bridge construction using `nativeInvoke`. Use `support.device.report` for authenticated, credential-free report status; there is no raw-identity replacement.
2. Package the desktop and its matching sidecar together. Keep the native data directory and `device/device-id` file.
3. Confirm startup succeeds and the next device report retains the server device ID. Confirm an incompatible sidecar rejects startup and no `native.*` call is accepted by the product bridge.
