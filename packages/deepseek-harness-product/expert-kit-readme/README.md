---
description: "Model-only Harness skill provider that loads DeepSeek Harness Expert Kit instructions directly from README files."
kind: "package-reference"
---

# DeepSeek Harness Expert Kit README

English | [中文](README.zh.md)

## Summary

This Preset-scoped plugin loads the selected Expert Kit's original README and any shortcut-bound skills before the first model request, through the official `agent/pre-step` message pipeline. It also publishes the README to the official skill catalog for model lookup; the entry is absent from user command catalogs.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Expert Kit instructions

#### What the model sees

The first request includes the pinned kit guide and the full instructions of explicitly bound shortcut skills, with their package resource bases. The Session records these as `product-expert-kit-instructions` user messages. Other kit skills remain available through native semantic discovery and the official `skill` tool.

#### Token effect

The guide and selected shortcut skills consume context from the first request. Instructions are deduplicated against the current model-visible history and loaded again if context replacement removes them.

#### KV Cache effect

Pinned content remains stable across requests and Host restart. Changing kit or shortcut selection changes the task snapshot and its cache prefix. Current server authorization is checked before every step and instruction load. <a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- Shortcut skills must resolve from their pinned kit provider; missing or conflicting definitions stop execution.
- README files are limited to 64 KiB.

<a id="dev-note"></a>
### Dev Note

Keep instructions in packaged README and SKILL.md files. Product runtime supplies the explicit shortcut mapping; this plugin reads pinned content and lets the official pipeline persist it before model execution.
