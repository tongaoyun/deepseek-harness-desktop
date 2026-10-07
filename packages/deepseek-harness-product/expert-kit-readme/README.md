---
description: "Model-only Harness skill provider that loads DeepSeek Harness Expert Kit instructions directly from README files."
kind: "package-reference"
---

# DeepSeek Harness Expert Kit README

English | [中文](README.zh.md)

## Summary

This Preset-scoped provider publishes each enabled Expert Kit's name and summary to the official Harness skill catalog. The official `skill` tool reads the original packaged `README.md` only when the model selects that Expert Kit. The entry is model-invocable and absent from user command catalogs.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Expert Kit instructions

#### What the model sees

The Session skill catalog contains one `expert-kit-<id>` summary for each enabled kit. Loading that entry returns the kit's original README as trusted instructions with its package directory as the resource base.

#### Token effect

The initial catalog contains only the entry name and summary. README content enters context only after the official `skill` tool loads it.

#### KV Cache effect

Different enabled-kit snapshots change the catalog and its cache prefix. Loading a README adds its content to subsequent requests in that Session. Expert Kit artifacts are retained by SHA-256 generation, and Host restart restores only Presets referenced by Sessions or the current enabled selection. <a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- No runtime invariant companion is published because this package only exposes model instructions and has no package-owned runtime checks.
- README files are limited to 64 KiB.

<a id="dev-note"></a>
### Dev Note

Keep Expert Kit instructions in the packaged README. Do not copy them into generated skill files or initial Session prompts.
