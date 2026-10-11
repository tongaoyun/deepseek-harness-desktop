---
kind: upgrade-guide
description: "Independent product packages and task snapshots replace embedded runtime and legacy selection."
---

# Product Task Capabilities

English | [中文](guide.zh.md)

## Change

`@deepseek-harness/desktop-assembly` loads independent product packages; the official desktop runs alone. Preload transports `dshDesktop.extensions`; the product validates methods and restores typed errors across Electron's bridge.

`tasks.capabilities.prepare` replaces `expertKits.preset.prepare` and retains selections with `tasks.capabilities.read`. Started tasks fork with the source Workspace and latest draft. Required dependencies stay locked; unselected knowledge supplies no retrieval tool.

Legacy caches and product globals are unsupported. The official Preset API restores snapshots of content and connector definitions without credentials. Session log format is unchanged.

`basePresetId` changes mode, retaining capabilities. The native selector shows names and descriptions, filters coding modes through Developer tools, and becomes read-only after execution starts. Empty tasks select accessible installed Kits; started headers show only selected Kit labels. `expertKitId: null` clears the Kit, retaining knowledge. Knowledge selection uses the conversation, not its details. README tables register no commands.

Kits require explicit installation before selection or shortcuts. Preparation preserves installation records; new selections reject absent or mismatched catalog versions with `KIT_NOT_INSTALLED` or `KIT_INSTALLED_VERSION_CHANGED`. Uninstall never triggers reinstallation; existing tasks retain pinned content and current access checks.

`skills.install` and `skills.installed.read` replace `skills.prepare` and `addSkillIds`, preserving Session, Preset, and draft. Skills have no enable/disable state. Eligible skills enter the official catalog; models use `skill`, explicit invocation uses `/<skillName>`. Started tasks freeze versions.

Task responses expose `requiredConnectorIds`. Connector tabs use **All** and **Connected** for authorization. Skills mount declared authorized connectors through official MCP; restart supplies current relay credentials to pinned definitions.

Knowledge scopes become `PERSONAL`, `DEPARTMENT`, and `COMPANY`, with fresh DingTalk organization checks on every list and search. Version 2 snapshots pin `requiredKnowledgeBaseIds`. Missing or invalid product snapshots block affected tasks until explicit recovery; official Session history remains unchanged. Kit revocation blocks execution and instruction loading without replacing pinned content.

## Migration

Keep artifacts, snapshots, and official Session history. Unsupported standalone Skill or Kit Presets require new tasks.

1. Review pinned baseline and [patch manifest](../../../../scripts/upstream-patches/manifest.json).
2. Start enterprise profiles with the product assembly. Development uses `DEEPSEEK_HARNESS_SERVER_URL`; packaged apps use product resources.
3. Replace product globals with namespace and task capability methods, and Preset display YAML with public typed `derive`.
4. Re-select legacy product capabilities in new tasks; caches have no migration.
5. Run `pnpm run verify:upstream` and focused product tests. Confirm unregistered official edits fail and the official profile boots without product overlays.
6. Use `skills.install` and `skills.installed.read`; remove `skills.prepare` and `addSkillIds`. Tasks retain pinned content.
7. Use `expertKits.install` before selecting Kits or published updates. Started headers cannot switch Kits; use directory **Start using** or shortcuts for new tasks. Verify uninstall preserves pinned tasks without reinstallation. Remove `setConnectorEnabled` and connector task selection. Submit complete knowledge scope. Skill caches without connector definitions require new tasks. Verify approval, revocation, restart, and unloading.
8. Configure company ID and DingTalk freshness; migrate ownership and bind unconfirmed bases in the administrator console. `recoverCapabilities: true` exits Kits, retaining visible knowledge IDs. Verify transfers and revocation before resuming.
