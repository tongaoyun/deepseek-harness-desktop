---
kind: upgrade-guide
description: "Expert Kit guides and explicitly bound shortcut skills enter model context before execution."
---

# Expert Kit Shortcut Instructions

English | [中文](guide.zh.md)

## Change

Selecting an Expert Kit automatically loads its pinned README before model execution. A shortcut's `skillIds` explicitly selects 1–8 unique bundled skills whose full instructions load with the guide. Other installed and bundled skills retain native semantic discovery. MCP and approval use the official execution loop.

The client sends `expertKitTaskId` to `tasks.capabilities.prepare`; Host resolves the task from the immutable installed artifact and returns its authoritative `prompt`. Capability snapshots pin `expertKitTask` and the provider configuration. Official pre-step messages record model-visible content with the attribution source `product-expert-kit-instructions`. Visible instructions are deduplicated across steps and restart, and restored after context replacement. Authorization is checked on every step.

New kit releases and imports require shortcut bindings. Missing, duplicate or unknown skill IDs fail preparation. Legacy artifact bytes and Session history stay unchanged; an unmapped legacy shortcut cannot start a new task. Ordinary kit selection remains available.

## Migration

1. Apply server migration V55 and deploy the shortcut metadata contract before submitting new releases.
2. Add `skillIds` to each shortcut and publish a new kit version, retaining older artifacts and task snapshots. Install the new version on the device.
3. Upgrade desktop runtime and adapters together. Do not submit a shortcut prompt as its identity or infer skill bindings from display names.
4. Verify first-request instructions, missing bindings, permission revocation, restart, context replacement, draft preservation, and `verify:upstream`. Installed distributions require a fresh desktop build.
