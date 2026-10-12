# DeepSeek Harness Electron product layer

English | [中文](deepseek-harness-electron-architecture.zh.md)

The DeepSeek Harness desktop uses DeepSeek Harness `dsh-v0.2.1-alpha.2` as its only desktop, runtime, and session baseline. The official Electron window, `apps/desktop-host`, Harness Session, Conversation, Browser, Approval, Question, Tool, history replay, and Office are owned by upstream.

The [product subsystem](subsystems/deepseek-harness-product.md) defines the independent protocol, runtime, desktop, and UI packages. The product UI uses the `product` namespace of `window.dshDesktop.extensions` for:

- DingTalk enterprise sign-in and employee session;
- expert-kit, skill, and connector catalogs;
- WeKnora knowledge base;
- System schedules;
- artifacts, business references, and product labels.

Renderer calls product and native methods through the generic preload transport; the product package validates its method allowlist. Electron validates the owning window, origin, and main frame. Employee tokens remain in main. Host receives inference configuration and a private loopback MCP relay capability, while Renderer receives neither employee tokens nor bootstrap secrets. The UI selects capabilities through official Session, Workspace, Preset, and draft APIs; Harness owns Turns, Steps, Tool Cards, and Transcripts.

The Host requests only catalog, artifact, connector, knowledge, and desktop-version operations over private Electron IPC. Cancellation reaches main, Host, and HTTP requests. Published failures retain codes, related resources, and retryability without credential text; unknown failures use generic diagnostics. Product archives are verified and extracted with entry-count, compressed-size, expanded-size, path, and file-type limits. Official Harness registries own the resulting Skills, Agent Presets, MCP tools, prompt context, and Session events.

Product desktop startup refreshes the stored DingTalk session or completes DingTalk OAuth in the system browser, reads the authenticated bootstrap, and supplies inference configuration and Loader overlays to the official Host. The desktop product package owns login, encrypted storage, relay and sidecar cleanup, and packaging resources. The official profile boots without these extensions. Host owns all model requests and Session execution.

Native product methods use the `deepseek-harness.native.v1` line protocol in `native/deepseek-harness`. The protocol provides bounded filesystem, attachment, SQLite, credential, DingTalk state, device identity, image preview, and file undo methods. Paths stay within Electron's assigned data directory and file payloads use hex encoding with an 8 MiB limit. The sidecar does not host Harness execution and has no legacy Tauri `invoke` protocol.

Upstream synchronization uses tags and a pinned commit. The desktop repository stores the pinned official tag and its Git objects; CI and release jobs fetch that tag from `origin` without fetching GitHub or using a separate mirror repository. `UPSTREAM_REPOSITORY` identifies the official source used only by explicit upgrades and optional release checks. `pnpm run verify:upstream` checks local tag resolution, registered complete patches, and public Harness imports without requiring an upstream remote or network access. Upgrade by updating the pin, running `pnpm run sync:upstream` to fetch the selected official tag and publish it to `origin`, explicitly applying and resolving patches, validating the adapter, and running official and product acceptance tests. See the [breaking change guide](upgrade-guide/v0.2.0-rc.2/product-task-capabilities/guide.md).
