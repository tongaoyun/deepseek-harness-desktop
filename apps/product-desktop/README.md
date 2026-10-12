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

The internal manual **同步桌面构建到 GitHub** workflow reads repository variables `DESKTOP_GITHUB_REPOSITORY` (private source) and `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY` (public downloads). Gitea reserves names starting with `GITHUB_`. `DESKTOP_GITHUB_TOKEN` requires source synchronization permissions and Contents write access to the download repository; prefer a credential limited to these repositories. `RELEASE_USERNAME` and `RELEASE_CREDENTIAL` authorize internal Gitea releases. GitHub runners receive none of these release credentials and never access internal Gitea or production services. Private desktop Git history is uploaded only to the build repository; server and control-center repositories stay internal.

New builds check out `main` or the explicitly supplied `source_sha`, require successful main CI for that exact commit, verify registered patches, synchronize source, and wait for their correlated GitHub build. Resuming with `github_run_id` checks out current `main` for delivery scripts while `source_sha` remains the built source; both commits require successful main CI. Version and artifact validation use the built source rather than the delivery code. All platforms derive the same version from the hosted run's UTC start date, number and attempt. A failed, cancelled, missing or mismatched platform stops publication. The internal runner stages a bounded ZIP, extracts regular files using its central directory, checks every installer against its manifest, and produces one aggregate `build-manifest.json` and `SHA256SUMS.txt`. Temporary archives are removed after extraction. Only installer files and those metadata files enter the public download repository; source is never pushed there.

Both destinations stage development prereleases as drafts. Every uploaded asset is downloaded and checked by size and SHA-256 before either release is finalized. Publication does not replace an asset or tag with different identity/content, nor delete old downloads. A failure leaves verified drafts available for retry. GitHub draft recovery inspects every release-list page when the tag endpoint returns 404 and rejects duplicate tags. Finalization across two services is sequential: one complete release may become visible before the other finalization fails. Retry with `github_run_id` and the matching `source_sha` to reuse the same successful hosted run, reconcile interrupted uploads and complete publication without rebuilding. Hosted artifacts must still be unexpired; rerun all platforms after expiry or a changed run attempt. The workflow allows 180 minutes, including up to 20 minutes for main CI and 150 minutes for the hosted build.

Each native hosted runner installs locked dependencies, verifies the baseline, tests the product sidecar, and runs the product packaging entry. Windows uses native PowerShell and validates the unsigned installer, application, sidecar, and installer lifecycle. Packaging includes the official packaged-runtime smoke. All three runners then exercise the built official and product Electron profiles with isolated data, fixture identities, a local product service and a mock model. The keyless UI regression covers catalogs, skill and kit installation, connector states, original knowledge previews, task selection and restart recovery; it does not authenticate real employees or operate the packaged installer UI. Screenshots and JSON reports are retained for fourteen days as separate private Actions artifacts, including on failure. UI failure blocks installer publication. A run produces unsigned installers, companion blockmaps, and `build-manifest.json` with version, source commit, target, size, and SHA-256. Installer Actions artifacts are retained for one day for delivery and publication retries; published Release downloads have no automatic expiry. Failed jobs do not upload partial installers.

Acceptance builds produce a Windows EXE or macOS DMG; any additional archives or blockmaps are included when the official pipeline produces them. The internal delivery workflow publishes verified unsigned installers to public GitHub and internal Gitea prereleases. Standalone GitHub packaging still only uploads Actions artifacts. Neither path publishes automatic update feeds, uses signing certificates, or notarizes macOS applications. Both macOS targets use the official unsigned local-build application identifier; Windows uses the configured product application identifier. Unsigned packages may require normal operating-system confirmation. Gitea keeps desktop CI and manual GitHub synchronization; native installers are built by the GitHub workflow. Signed distribution requires a separately configured release process.

## Local Checks

The internal synchronization step optionally reads `DESKTOP_GITHUB_PROXY_URL` from Gitea Secrets. Node and Git use that authenticated proxy only within this step, and GitHub Git requests use HTTP/1.1. Keep the URL out of repository variables and source; checkout, dependency installation, and hosted packaging retain their own network configuration.

Complete API reads, artifact downloads and remote checksum reads retry transient network errors or HTTP 408/429/500/502/503/504 up to four attempts with 1/2/4-second delays. An interrupted artifact restarts in an empty private stage; malformed content, denied access and checksum conflicts do not retry. Writes require release reconciliation before retrying. Diagnostics include safe error codes and operation labels, never credentials, signed URL queries or response bodies.

Workflow selection controls files under `.github/workflows/`. GitHub-managed dynamic workflows, such as Dependabot, use separate repository settings and cannot be disabled through the workflow API.

Upstream regressions run on every hosted platform. Executable-bit changes are tested on macOS and Linux, where filesystem permissions represent them; dangling-symlink checks also run on Windows.

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs apps/product-desktop/tests/desktop-release.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm run verify:upstream
```
