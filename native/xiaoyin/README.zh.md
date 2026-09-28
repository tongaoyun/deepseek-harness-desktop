# xiaoyin-native

[English](README.md) | 中文

这是必须留在 Renderer 之外的产品能力 Electron sidecar 边界。它使用逐行 JSON-RPC 协议：

```text
xiaoyin.native.v1
```

sidecar 不持有任何 Harness Session 状态，只提供受限产品操作：`filesystem.list/read/write`、`attachments.put/get/list`、`secure-storage.get/set`、`sqlite.query/execute`、`dingtalk-auth.state`、`device-identity.get`、`image-preview.inspect` 和 `file-undo.record/undo`。路径相对于 Electron 管理的数据目录，SQLite 只有显式选择 execute 方法时才允许写入，文件载荷使用 hex 编码且限制为 8 MiB。Electron 启动 sidecar 并校验每个方法；Renderer 不会取得 sidecar 进程句柄或原始凭据。

协议不提供旧 Tauri `invoke` 兼容路径。
