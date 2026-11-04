---
version: 1
slug: "product-src-client-knowledgeworkspace-tsx-b1297a25"
primary_target: "packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeWorkspace.tsx"
related_targets: ["packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeLibraryDirectory.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeDocuments.tsx","packages/extensions/ui-deepseek-harness-product/src/DeepSeekHarnessProduct.module.css"]
---

# Knowledge workspace

Mode: Operate. Scope: the product knowledge directory, library materials, and inline reader. The surrounding Harness shell and native controls retain their identity.

## Direction contract

THESIS: Separate choosing a library from managing its contents. WorkBuddy is the user-pinned product reference; preserve real permissions, file operations, and native preview behavior.

OWN-WORLD: Native Harness neutral surfaces and selection, system typography, 12px library corners, a quiet navigation rail, and generous document rows. Honor native light and dark tokens.

STORY: Find a personal, department, or company library, open its materials, then read the original document. Returning to the directory cancels the previous library's work.

FIRST VIEWPORT: A 28px library title and concise helper text lead a centered directory. A search field, scope tabs, and one primary create action sit above responsive library cards. Within a library, the navigation rail stays separate from a title, compact filter toolbar, and full-width materials table. Reading replaces only the materials pane.

FORM: The user-pinned WorkBuddy resource-management reference within the incumbent Harness system; code-led. No visual-world tournament applies to this pinned reference.

FINISH: Use independent visual review, DESIGN.md, and light and dark captures at desktop, tablet, and mobile widths. Runtime icons come from native Harness primitives.
