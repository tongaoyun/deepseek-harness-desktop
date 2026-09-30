# DeepSeek Harness Electron product layer

English | [中文](deepseek-harness-electron-architecture.zh.md)

The DeepSeek Harness desktop uses DeepSeek Harness `dsh-v0.2.0-rc.2` as its only desktop, runtime, and session baseline. The official Electron window, `apps/desktop-host`, Harness Session, Conversation, Browser, Approval, Question, Tool, history replay, and Office are owned by upstream.

Product capabilities live in `packages/deepseek-harness-product/product` and are accessed through `window.deepseek-harness.product` (`window.dshDesktop.product` is the same bridge reference carried by the official desktop shell):

- DingTalk enterprise sign-in and employee session;
- expert-kit, skill, and connector catalogs;
- WeKnora knowledge base;
- System schedules;
- artifacts, business references, and product labels.

The Renderer can call allowlisted product and native methods through the preload bridge, including bounded filesystem, SQLite, credential, attachment, device, image-preview, and file-undo operations. `sessionToken` and the employee-scoped model key remain in the Electron main process and are never returned through `window`. The product layer does not create Turns, Steps, Tool Cards, or Transcripts, and does not change Harness Session state.

The Host requests only catalog, artifact, connector, and knowledge operations over private Electron IPC; cancellation propagates to in-flight knowledge HTTP requests, and main-process errors cross back as generic diagnostics without credential text. Product archives are verified and extracted with entry-count, compressed-size, expanded-size, path, and file-type limits. Official Harness registries own the resulting Skills, Agent Presets, MCP tools, prompt context, and Session events.

Desktop startup has one enterprise identity boundary: refresh the stored DingTalk session or complete DingTalk OAuth in the system browser, read the authenticated DeepSeek Harness bootstrap, then start the official Harness Host with the employee-scoped model key and LiteLLM endpoint. The official DeepSeek welcome page is not a DeepSeek Harness login route. Bootstrap secrets are main-process-only and are never available through the preload API; the Host still owns all model requests and Session execution.

Native product methods use the `deepseek-harness.native.v1` line protocol in `native/deepseek-harness`. The protocol provides bounded filesystem, attachment, SQLite, credential, DingTalk state, device identity, image preview, and file undo methods. Paths stay within Electron's assigned data directory and file payloads use hex encoding with an 8 MiB limit. The sidecar does not host Harness execution and has no legacy Tauri `invoke` protocol.

Upstream synchronization uses tags and a pinned commit. `pnpm run verify:upstream` requires the configured Git remote and local tag to resolve to that commit. Verify the official tests and Electron build first, then verify the product package, sidecar, and server contracts.
