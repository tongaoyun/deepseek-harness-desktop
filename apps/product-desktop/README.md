# Product desktop delivery

English | [中文](README.zh.md)

## Summary

The product assembly launches and packages the enterprise desktop through the official Electron pipeline. Internal Gitea owns development and review. A GitHub source repository receives selected committed source and its stored Harness baseline for hosted Windows x64, macOS ARM64, and macOS Intel builds. Start with the [product overview](docs/README.md) for workflows and architecture.

<a id="local-development"></a>
## Local Development

After the repository build and native runtime preparation, run `pnpm run start:product-desktop` from the repository root to open the current product assembly. `pnpm run dev:product-desktop` also builds before launch. Use these entries for DingTalk login and enterprise catalogs; the official `dev:desktop` and `start:desktop` entries do not select the product extension.

The product launcher owns separate home and Electron user-data directories under `apps/desktop/.desktop-build/product-development/`. `DSH_PRODUCT_HOME` and `DSH_PRODUCT_USER_DATA` explicitly override them. Inherited official `DSH_HOME` and `DSH_DESKTOP_USER_DATA_DIR` do not select product state. `DEEPSEEK_HARNESS_SERVER_URL` may override the server origin for development; installed applications read the packaged resource. A saved expired employee session requires normal DingTalk login. Do not copy tokens between profiles.

## GitHub Packaging

Authenticate with `gh auth login --hostname github.com --git-protocol https --scopes workflow`. The account needs repository administration, source upload, workflow update, and Actions dispatch access. Commit and validate the source before synchronizing. This command creates an empty private repository and starts the first acceptance build:

```sh
node apps/product-desktop/scripts/sync-github.mjs --repository OWNER/deepseek-harness-desktop --create
```

For an existing build repository, omit `--create`. Synchronization accepts public or private source repositories without changing their visibility. Public source and its Git history are readable by anyone; standard hosted runners have free runtime minutes for public repositories. This workflow uses no larger paid runners. New repositories remain private by default. Synchronization rejects unknown visibility, forks, archived repositories, dirty source, shallow history, and an inconsistent baseline. Complete a shallow checkout with `git fetch --unshallow origin` from the existing desktop repository before synchronizing. It atomically pushes only `main` and the pinned baseline tag; divergent refs fail without force, deletion, or remote changes. Actions stay disabled during upload. The adapter disables all copied upstream workflows, enables only the product packaging workflow, restricts allowed Actions, and dispatches the exact uploaded commit. A workflow indexing or push failure leaves Actions disabled; retry without `--create` after resolving the reported failure.

The internal manual **同步桌面构建到 GitHub** workflow reads repository variables `DESKTOP_GITHUB_REPOSITORY` (source) and `DESKTOP_GITHUB_DOWNLOAD_REPOSITORY` (public downloads). Gitea reserves names starting with `GITHUB_`. `DESKTOP_GITHUB_TOKEN` requires source synchronization permissions and Contents write access to the download repository; prefer a credential limited to these repositories. `RELEASE_USERNAME` and `RELEASE_CREDENTIAL` authorize internal Gitea releases. GitHub runners receive none of these release credentials and never access internal Gitea or production services. Desktop Git history is uploaded only to the build repository; server and control-center repositories stay internal.

New builds check out `main` or the explicitly supplied `source_sha`, require successful main CI for that exact commit, verify registered patches, synchronize source, and wait for their correlated GitHub build. Resuming with `github_run_id` checks out current `main` for delivery scripts while `source_sha` remains the built source; both commits require successful main CI. Version and artifact validation use the built source rather than the delivery code. All platforms derive the same version from the hosted run's UTC start date, number and attempt. A failed, cancelled, missing or mismatched platform stops publication. The internal runner stages a bounded ZIP, extracts regular files using its central directory, checks every installer against its manifest, and produces one aggregate `build-manifest.json` and `SHA256SUMS.txt`. Temporary archives are removed after extraction. Only installer files and those metadata files enter the public download repository; source is never pushed there.

Both destinations stage development prereleases as drafts. Every uploaded asset is downloaded and checked by size and SHA-256 before either release is finalized. Publication does not replace an asset or tag with different identity/content, nor delete old downloads. A failure leaves verified drafts available for retry. GitHub draft recovery inspects every release-list page when the tag endpoint returns 404 and rejects duplicate tags. Finalization across two services is sequential: one complete release may become visible before the other finalization fails. Retry with `github_run_id` and the matching `source_sha` to reuse the same successful hosted run, reconcile interrupted uploads and complete publication without rebuilding. Hosted artifacts must still be unexpired; rerun all platforms after expiry or a changed run attempt. The workflow allows 180 minutes, including up to 20 minutes for main CI and 150 minutes for the hosted build.

Each native hosted runner installs locked dependencies, verifies the baseline, tests the product sidecar, and runs the product packaging entry. Windows validates unsigned files and the installer lifecycle; packaging includes the official runtime smoke. Runners exercise built official and product profiles, then the installed product application: Windows silently installs the EXE into a private directory and uninstalls afterward; macOS copies the DMG application into a private directory and detaches afterward. Installed acceptance launches the packaged ASAR, bundled Host, extension, and sidecar without source runtime overrides. Only the disposable installation's server configuration points to a local fixture service, with isolated data, fixture identities and a mock model. The same keyless UI regression covers catalogs, skill and kit installation, connector states, original knowledge previews, task selection and restart recovery. It neither authenticates real employees nor verifies OS signing prompts. Screenshots and JSON reports are retained for fourteen days, including on failure; logs and artifacts follow source repository visibility. UI failures block installer publication. Successful runs produce unsigned installers, blockmaps and `build-manifest.json` with version, source commit, platform, size and SHA-256. Installer Actions artifacts last one day; published Release downloads do not automatically expire.

Acceptance builds produce a Windows EXE or macOS DMG; any additional archives or blockmaps are included when the official pipeline produces them. The internal delivery workflow publishes verified unsigned installers to public GitHub and internal Gitea prereleases. Standalone GitHub packaging still only uploads Actions artifacts. Neither path publishes automatic update feeds, uses signing certificates, or notarizes macOS applications. Both macOS targets use the official unsigned local-build application identifier; Windows uses the configured product application identifier. Unsigned packages may require normal operating-system confirmation. Gitea keeps desktop CI and manual GitHub synchronization; native installers are built by the GitHub workflow. Signed distribution requires a separately configured release process.

<a id="local-checks"></a>
## Local Checks

Internal desktop CI covers archive import, conversation editing, draft restart, and the real Loader skill and kit compositions. The [workflow regression](../../scripts/deepseek-harness-electron-workflows.spec.ts) requires these tests to remain in the executed CI command. Main CI must succeed for the exact source commit before hosted packaging starts.

The internal synchronization step optionally reads `DESKTOP_GITHUB_PROXY_URL` from Gitea Secrets. Node and Git use that authenticated proxy only within this step, and GitHub Git requests use HTTP/1.1. Keep the URL out of repository variables and source; checkout, dependency installation, and hosted packaging retain their own network configuration.

Source synchronization and publication share complete-read retries: transient network errors or HTTP 408/429/500/502/503/504 get up to four attempts with 1/2/4-second delays, including interrupted response bodies. An interrupted artifact restarts in an empty private stage; malformed content, denied access and checksum conflicts do not retry. Source synchronization writes, including build dispatch, execute once; an uncertain outcome requires checking remote state before retrying. Diagnostics include safe codes and operation labels, never credentials, signed URL queries or response bodies. Git push failures report process status without exposing proxy credentials from stderr.

Workflow selection controls files under `.github/workflows/`. GitHub-managed dynamic workflows, such as Dependabot, use separate repository settings and cannot be disabled through the workflow API.

Upstream regressions run on every hosted platform. Executable-bit changes are tested on macOS and Linux, where filesystem permissions represent them; dangling-symlink checks also run on Windows.

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs apps/product-desktop/tests/desktop-release.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm run verify:upstream
pnpm --dir apps/product-desktop run test:installed --target mac-arm64
```

Installed acceptance requires a native Windows or macOS runner and its generated installer. Use `--installer /absolute/path/to/installer.dmg` (or EXE) to exercise an existing download without rebuilding. It uses private temporary directories and cleans them after acceptance; do not run Windows installation acceptance alongside another installation of the same product.

macOS UI acceptance uses Chromium's test keychain in the disposable profile to avoid interactive access to the runner's login keychain. This covers credential routing and restart behavior, not system keychain protection or its authorization dialogs. The test flag is absent from application launchers and packaging configuration; ordinary launches retain OS-backed encrypted storage.

Development and built-profile acceptance pass a file URL for the product extension's ESM entry on every platform. Startup errors before the first window are captured in sanitized, failure-only diagnostic artifacts. A test-only profile plugin records loaded boot-module URLs and root Include identities after application readiness; failed acceptance prints this credential-free evidence alongside renderer startup warnings.
