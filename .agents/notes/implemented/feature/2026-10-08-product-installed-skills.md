# Agent Note: Installed enterprise skills

Status: implemented

English | [中文](2026-10-08-product-installed-skills.zh.md)

## Problem

Selecting a marketplace Skill derived a task Preset even when it only supplied instructions. Users had to select every Skill before the model could discover it, and installing content changed task configuration.

## Decision

The product runtime owns an employee-scoped installation registry and contributes a per-agent official Skill Provider. Installation changes content availability without selecting a Preset or changing a draft. Skills have no enable or disable state. Skills and Expert Kits supply connector dependencies; available installed Skills mount their declared authorized connectors in the Agent scope. Knowledge remains task-selected to constrain retrieval scope.

The first model-step boundary pins the directory and content identities for the Session. Installing a new version cannot change instructions midway through a task. Task dependencies filter discovery, and listing and loading recheck service permissions. Installed instructions use the official skill tool and slash invocation rather than a second execution loop.

The official client exposes generic `uiSkills.refresh(sessionId?)` so installing-provider clients can invalidate cached discovery. Product methods remain in product packages. The complete client patch is registered for upstream upgrades. Per-task manual Skill selection is removed because it duplicates installation and prevents ordinary model discovery.

## Consequences

Installation no longer adjusts a task's mode, capabilities, or draft. Dependencies still require explicit task selection. Started tasks retain their pinned content, and installing or upgrading a Skill affects tasks that have not started. Installed content and Session snapshots remain on disk without automatic garbage collection.

## Alternatives considered

Keeping per-task Skill selection would preserve unnecessary Preset derivation and prevent ordinary discovery. Exposing every marketplace Skill without installation would download instructions implicitly and make available content depend on catalog refresh. A global mutable directory would let upgrades change running tasks. The scoped Provider and pinned directory retain the official execution path and stable task inputs.

## Verification

Real Loader tests cover discovery, official skill tool output, slash invocation, pinned versions, restart restoration, permissions, dependency filtering, employee isolation, and provider disposal. Client tests assert that installing a Skill does not create or select a Session or modify a draft. Built browser and Electron scenarios cover installation state, four directories, responsive layout, unchanged drafts, and the official profile without product extensions.

The adapter fixture requests a Skill deterministically; it does not assess a live model's decision to choose a Skill from natural language.
