# Product desktop delivery

English | [中文](README.zh.md)

## Summary

The product assembly packages the enterprise desktop through the official Electron pipeline. Internal Gitea owns development and review. A private GitHub repository receives selected committed source and its stored Harness baseline for hosted Windows x64, macOS ARM64, and macOS Intel builds.

## GitHub Packaging

Authenticate with `gh auth login --hostname github.com --git-protocol https --scopes workflow`. The account needs repository administration, source upload, workflow update, and Actions dispatch access. Commit and validate the source before synchronizing. This command creates an empty private repository and starts the first acceptance build:

```sh
node apps/product-desktop/scripts/sync-github.mjs --repository OWNER/deepseek-harness-desktop --create
```

For an existing build repository, omit `--create`. Synchronization rejects public repositories, forks, archived repositories, dirty source, shallow history, and an inconsistent baseline. Complete a shallow checkout with `git fetch --unshallow origin` from the existing desktop repository before synchronizing. It atomically pushes only `main` and the pinned baseline tag; divergent refs fail without force, deletion, or remote changes. Actions stay disabled during upload. The adapter disables all copied upstream workflows, enables only the product packaging workflow, restricts allowed Actions, and dispatches the exact uploaded commit. A workflow indexing or push failure leaves Actions disabled; retry without `--create` after resolving the reported failure.

The internal manual **Sync desktop packages to GitHub** workflow reads repository variable `DESKTOP_GITHUB_REPOSITORY` and secret `DESKTOP_GITHUB_TOKEN`; Gitea reserves names starting with `GITHUB_`. Store only the owner/name in the variable. The secret requires Contents, Workflows, Actions, and Administration write access; prefer a credential limited to this build repository. The job fetches Gitea `main` and its stored baseline, verifies registered patches, and synchronizes that source. GitHub runners never access internal Gitea or production credentials. Private desktop Git history is uploaded to GitHub; server and control-center repositories stay internal.

Each native hosted runner installs locked dependencies, verifies the baseline, tests the product sidecar, and runs the product packaging entry. Windows uses native PowerShell and validates the unsigned installer, application, sidecar, and installer lifecycle. Packaging includes the official packaged-runtime smoke. A run produces unsigned installers, companion blockmaps, and `build-manifest.json` with version, source commit, target, size, and SHA-256. Download them from the run's Artifacts area within fourteen days. Failed jobs do not upload partial installers.

Acceptance builds produce a Windows EXE or macOS DMG; any additional archives or blockmaps are included when the official pipeline produces them. These builds do not create Releases, publish update feeds, use signing certificates, or notarize macOS applications. Both macOS targets use the official unsigned local-build application identifier; Windows uses the configured product application identifier. Unsigned packages may require normal operating-system confirmation. Gitea keeps desktop CI, manual GitHub synchronization, and upstream version checks; native installers are built by the GitHub workflow. Signed distribution requires a separately configured release process.

## Local Checks

The internal synchronization step optionally reads `DESKTOP_GITHUB_PROXY_URL` from Gitea Secrets. Node and Git use that authenticated proxy only within this step, and GitHub Git requests use HTTP/1.1. Keep the URL out of repository variables and source; checkout, dependency installation, and hosted packaging retain their own network configuration.

Workflow selection controls files under `.github/workflows/`. GitHub-managed dynamic workflows, such as Dependabot, use separate repository settings and cannot be disabled through the workflow API.

Upstream regressions run on every hosted platform. Executable-bit changes are tested on macOS and Linux, where filesystem permissions represent them; dangling-symlink checks also run on Windows.

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm run verify:upstream
```
