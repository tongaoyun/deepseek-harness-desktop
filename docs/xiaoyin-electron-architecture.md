# Xiaoyin Electron product layer

English | [中文](xiaoyin-electron-architecture.zh.md)

The Xiaoyin desktop uses DeepSeek Harness `dsh-v0.1.7-rc.2` as its only desktop, runtime, and session baseline. The official Electron window, `apps/desktop-host`, Harness Session, Conversation, Browser, Approval, Question, Tool, history replay, and Office are owned by upstream.

Product capabilities live in `packages/xiaoyin-product/product` and are accessed through `window.xiaoyin.product` (`window.dshDesktop.product` is only the same read-only reference carried by the official desktop shell):

- DingTalk enterprise sign-in and employee session;
- expert-kit, skill, and connector catalogs;
- WeKnora knowledge base;
- IM and system schedules;
- artifacts, business references, and product labels.

The Renderer can call only allowlisted product methods. `sessionToken` stays in the Electron main process or `xiaoyin-native` sidecar and is never exposed through `window`. The product layer does not create Turns, Steps, Tool Cards, or Transcripts, and does not change Harness Session state.

Capabilities needing native permissions use the `xiaoyin.native.v1` line protocol in `native/xiaoyin`. The protocol provides bounded filesystem, attachment, SQLite, credential, DingTalk state, device identity, image preview, and file undo methods. Paths stay within Electron's assigned data directory and file payloads use hex encoding with an 8 MiB limit. The sidecar does not host Harness execution and has no legacy Tauri `invoke` protocol.

Upstream synchronization uses tags and a pinned commit. `pnpm run verify:upstream` requires the configured Git remote and local tag to resolve to that commit. Verify the official tests and Electron build first, then verify the product package, sidecar, and server contracts.
