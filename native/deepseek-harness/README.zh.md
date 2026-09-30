# deepseek-harness-native

[English](README.md) | 中文

Electron sidecar 实现 Renderer 通过 preload 白名单调用的原生产品能力。它使用逐行 JSON-RPC 协议：

```text
deepseek-harness.native.v1
```

sidecar 不持有任何 Harness Session 状态，只提供受限产品操作：`filesystem.list/read/write`、`attachments.put/get/list`、`secure-storage.get/set`、`sqlite.query/execute`、`dingtalk-auth.state`、`device-identity.get`、`image-preview.inspect` 和 `file-undo.record/undo`。路径相对于 Electron 管理的数据目录，SQLite 只有显式选择 execute 方法时才允许写入，文件载荷使用 hex 编码且限制为 8 MiB。Electron 启动 sidecar 并校验每个方法；Renderer 不会取得 sidecar 进程句柄，白名单凭据操作会返回其声明的结果。

协议不提供旧 Tauri `invoke` 兼容路径。
