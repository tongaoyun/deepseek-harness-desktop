# xiaoyin-native

English | [中文](README.zh.md)

The Electron sidecar boundary for product capabilities that must stay outside
the Renderer. It speaks one line-delimited JSON-RPC protocol:

```text
xiaoyin.native.v1
```

The sidecar owns no Harness Session state. It exposes only bounded product
operations: `filesystem.list/read/write`, `attachments.put/get/list`,
`secure-storage.get/set`, `sqlite.query/execute`, `dingtalk-auth.state`,
`device-identity.get`, `image-preview.inspect`, and `file-undo.record/undo`.
Paths are relative to the Electron-owned data directory, SQLite queries are
read-only unless the explicit execute method is selected, and file payloads
are hex encoded with an 8 MiB limit. Electron starts it and validates every
method; Renderer code never receives the sidecar process handle or raw
credentials.

The protocol intentionally has no legacy Tauri `invoke` compatibility path.
