---
kind: upgrade-guide
description: "Product-native RPC drops unused operations and seven reported device capabilities."
---

# Product sidecar retains health and device identity

English | [中文](guide.zh.md)

## Change

The product-owned Rust sidecar accepts only `health` and `device-identity.get`. Its generic `filesystem.list/read/write`, `secure-storage.get/set/delete`, `sqlite.query/execute`, `dingtalk-auth.state`, `attachments.put/get/list`, `file-undo.record/undo` and `image-preview.inspect` operations are removed. Their `native.` product RPC names are also rejected. This does not remove upstream Harness implementations or current product features.

Health reports only `device-identity`; Electron separately reports `credentials.encryption`. Existing installation identifiers and data files are preserved. Historical device reports remain readable.

## Migration

1. Remove calls to the retired product RPC methods from any external custom integration. Use the owning Harness or product API for the required operation; there is no generic sidecar replacement.
2. Before rolling out the desktop, review `deepseek-harness.device-policy.required-capabilities` in the server's Nacos `deepseek-harness-server.yaml`. Retire requirements for `native.filesystem`, `native.secure-storage`, `native.sqlite`, `native.dingtalk-auth`, `native.attachments`, `native.file-undo` and `native.image-preview`. Preserve other policy settings and existing requirements for actual capabilities; do not mark removed implementations as READY. Policies that retain the removed keys will correctly flag new desktops as missing those capabilities.
3. Install the new desktop without deleting its native data directory or `device/device-id`. Confirm that the next full device report keeps the same device ID, reports `native.device-identity` and the actual `credentials.encryption` status, and has no retired native capabilities.
