# DeepSeek Harness product

English | [中文](deepseek-harness-product.zh.md)

The DeepSeek Harness product layer adds enterprise capabilities around the official DeepSeek Harness desktop. It owns product data and integrations, while Harness remains the authority for sessions, turns, tools, approvals, conversation rendering, Browser, Office, permissions, and session persistence.

## Product-owned capabilities

- DingTalk OAuth session and employee bootstrap.
- Expert-kit, skill, connector, and knowledge-base catalogs.
- System schedule associations.
- Product references, delivered artifacts, and the Electron bridge.

The product bridge exposes `invoke`, `subscribe`, and `getSession` to the Renderer. Allowlisted native filesystem, credential, SQLite, attachment, device identity, image-preview, and file-undo operations pass through `invoke` to the `deepseek-harness.native.v1` sidecar protocol.

The Electron main process refreshes DingTalk identity before Host startup and reads the authenticated runtime bootstrap itself. The employee-scoped model key and inference endpoint are passed only to the official Host process; `bootstrap.get` is not a Renderer bridge method.

The Desktop Host reads product catalogs through a private correlated IPC client. Standalone skill archives are streamed through a compressed-size limit, SHA-256 verified, safely extracted into the product-managed Harness home, and registered through `dsh-skill-filesystem`, so the official `/` skill picker and `skill` tool remain the only invocation paths. Local skills use the Harness default roots, including `$DSH_HOME/skills` and `~/.agents/skills`; the product adds no `~/.codex/skills` root. The Skills detail action reuses the current official Session, or creates an ordinary Session when none is open, and pre-fills `/<skillId>` without replacing an existing draft.

Expert-kit enablement is stored per employee in the native product database. The Host combines enabled kits into a deterministic capability snapshot that extends `standard` with deduplicated skill roots, model-only Expert Kit README entries, `dsh-mcp-client` connectors, and knowledge-base references, then selects it as the default for future Sessions. Expert Kit artifacts live under content-addressed `<kitId>/<sha256>` directories. A non-secret snapshot descriptor records the kit generations; after restart, the Host restores only snapshots referenced by Session projections or the current enabled selection. Once every Session has been inspected successfully, the Host removes descriptors and artifact generations that are absent from both those references and the current catalog; incomplete inspection or cleanup failure retains data and does not block startup. The initial skill catalog contains only each kit's name and summary; the official `skill` tool reads the original packaged README when the model selects that kit. A later toggle creates or selects another immutable snapshot; existing Sessions retain their original snapshot. An enabled kit's quick command creates an ordinary Session and pre-fills the declared `/<skillId>` plus its description. One invalid or unavailable kit is skipped during catalog loading, and an enabled kit that is unavailable prevents selection of an incomplete snapshot.

The global `knowledge_search` tool uses the current Session snapshot's knowledge-base references and records calls and results in the normal Harness Session log.

## Boundary

Product packages use public Harness package APIs and stable extension points. They do not import private runtime modules, replace the Session Controller, or maintain a second conversation reducer. Product capabilities use the official Sidebar/Main slots, while Settings retains only general configuration.
