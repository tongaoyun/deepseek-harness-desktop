# DeepSeek Harness product

English | [中文](deepseek-harness-product.zh.md)

The DeepSeek Harness product layer adds enterprise capabilities around the official DeepSeek Harness desktop. It owns product data and integrations, while Harness remains the authority for sessions, turns, tools, approvals, conversation rendering, Browser, Office, permissions, and session persistence.

## Product-owned capabilities

- DingTalk OAuth session and employee bootstrap.
- Expert-kit, skill, data-connection, and knowledge-base catalogs.
- System schedule associations.
- Product references, delivered artifacts, and the Electron bridge.

The product bridge exposes `invoke`, `subscribe`, and `getSession` to the Renderer. Allowlisted native filesystem, credential, SQLite, attachment, device identity, image-preview, and file-undo operations pass through `invoke` to the `deepseek-harness.native.v1` sidecar protocol.

The Electron main process refreshes DingTalk identity before Host startup and reads the authenticated runtime bootstrap itself. The employee-scoped model key and inference endpoint are passed only to the official Host process; `bootstrap.get` is not a Renderer bridge method.

The Desktop Host reads product catalogs through a private correlated IPC client. The catalog manager refreshes after sign-in, when the window regains focus, every five minutes, and on manual request; concurrent refreshes share one request, and failures retain the last successful snapshot. A `catalog.changed` event publishes successful snapshot changes to the UI and Host. Preparation status is scoped to the catalog entry's `id`, `version`, and SHA-256 identity and stale identities are discarded after refresh. New Sessions use the latest snapshot while existing Sessions retain their recorded content versions and Presets.

Standalone Skill archives are prepared only when selected. The Host keys each immutable generation by `id`, `version`, and SHA-256, enforces a compressed-size limit, verifies the digest, safely extracts with an atomic rename, and registers the content through `dsh-skill-filesystem`. It creates an immutable Skill Preset that also fixes the catalog version's data connections, tool declarations, and knowledge-base references; missing authorization, tools, or visible knowledge blocks Session creation. The Skills detail action creates an official Session bound to that Preset and inserts a localized Skill reference Chip through the official input-trigger source; `ReferenceCodec` serializes it exactly as `/<skillId>` when submitted. The official model-facing `skill` tool reads the prepared Skill. Local skills use the Harness default roots, including `$DSH_HOME/skills` and `~/.agents/skills`; the product adds no `~/.codex/skills` root.

Each Expert Kit is also prepared on demand into a content-addressed `<kitId>/<sha256>` directory. Selecting **Start using** asks the Host to register one immutable Agent Preset that extends `standard` with the exact README, Skill versions, `dsh-mcp-client` data connections, knowledge-base references, and tool permissions from that catalog snapshot; the client then creates an official Session, binds that Preset, and opens it. A Common task follows the same path and pre-fills its business prompt without sending it. A non-secret descriptor lets the Host restore Presets referenced by Session projections after restart. Once every Session has been inspected successfully, the Host removes generations absent from both Session references and the current catalog; incomplete inspection or cleanup failure retains data and does not block startup. Preparation failure affects only the selected item and can be retried without blocking Host startup.

For `oauth` data connections, the Electron main process opens the system browser while the server owns employee credentials, refresh, revocation, and the MCP proxy. The Renderer and Host receive no upstream access token or refresh token. `none` connects directly; `employee-bearer` receives the employee Session only inside the server proxy. Runtime read/write access comes from MCP ToolSpec annotations, and unknown tools require official Harness approval as writes.

The global `knowledge_search` tool uses the current Session snapshot's knowledge-base references and records calls and results in the normal Harness Session log.

## Boundary

Product packages use public Harness package APIs and stable extension points. They do not import private runtime modules, replace the Session Controller, or maintain a second conversation reducer. Product capabilities use the official Sidebar/Main slots, while Settings retains only general configuration.
