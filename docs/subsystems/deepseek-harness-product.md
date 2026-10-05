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

The Desktop Host reads product catalogs through a private correlated IPC client. Standalone skill archives are streamed through a compressed-size limit, SHA-256 verified, safely extracted into the product-managed Harness home, and registered through `dsh-skill-filesystem`, so the official `/` skill picker and `skill` tool remain the only invocation paths. Local skills use the Harness default roots, including `$DSH_HOME/skills` and `~/.agents/skills`; the product adds no `~/.codex/skills` root. The Skills detail action creates an ordinary official Session and pre-fills `/<skillId>` without sending it. It does not reuse an Expert Kit Session or carry over another Session's draft.

Each Expert Kit artifact lives under a content-addressed `<kitId>/<sha256>` directory. Selecting **Start using** asks the Host to register one immutable Agent Preset that extends `standard` with that kit's Skill directory, model-only README entry, `dsh-mcp-client` connectors, and knowledge-base references; the client then creates an official Session, binds that Preset, and opens it. A Common task follows the same path and pre-fills its business prompt without sending it. It has no slash prefix or Skill ID binding. A non-secret descriptor records the single kit generation and connector metadata so the Host can restore Presets referenced by Session projections after restart. Once every Session has been inspected successfully, the Host removes descriptors and artifact generations absent from both those references and the current catalog; incomplete inspection or cleanup failure retains data and does not block startup. Invalid or unavailable kits are skipped during catalog loading, and the Host rejects attempts to prepare a missing kit rather than selecting an incomplete Preset. Standalone Skills remain registered separately and keep the official `/<skillId>` invocation path.

The global `knowledge_search` tool uses the current Session snapshot's knowledge-base references and records calls and results in the normal Harness Session log.

## Boundary

Product packages use public Harness package APIs and stable extension points. They do not import private runtime modules, replace the Session Controller, or maintain a second conversation reducer. Product capabilities use the official Sidebar/Main slots, while Settings retains only general configuration.
