#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Harness macOS packaging must run on macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository="$(cd "$script_dir/.." && pwd)"
stage="$repository/src-tauri/resources/harness-runtime"
expected_stage="$repository/src-tauri/resources/harness-runtime"
node_version="v24.19.0"
source "$script_dir/macos-build-env.sh"
macos_check_execution

case "$node_arch" in
  arm64) expected_sha="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d" ;;
  x64) expected_sha="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316" ;;
esac

if [[ "$stage" != "$expected_stage" ]]; then
  echo "Refusing to stage outside the dedicated Tauri resource directory: $stage" >&2
  exit 1
fi

temporary="$(mktemp -d)"
next_stage="$repository/src-tauri/resources/harness-runtime.next"
trap 'rm -rf -- "$temporary" "$next_stage"' EXIT
rm -rf -- "$next_stage"
mkdir -p "$next_stage"

cd "$repository"
pnpm --dir harness-host build
pnpm --config.node-linker=hoisted --filter '@xiaoyin/harness-host' --prod deploy "$next_stage/harness-host"
host_stage="$next_stage/harness-host"
mkdir -p "$host_stage/native"
helper="$repository/harness-host/native/xiaoyin-computer-use"
if [[ -n "${XIAOYIN_MACOS_ARCH-}" ]]; then helper="$helper-$binary_arch"; fi
cp "$helper" "$host_stage/native/xiaoyin-computer-use"
chmod 755 "$host_stage/native/xiaoyin-computer-use"
node_modules="$host_stage/node_modules"
rm -rf -- \
  "$node_modules/.bin" \
  "$node_modules/@types" \
  "$host_stage/src" \
  "$host_stage/tsconfig.json" \
  "$host_stage/pnpm-lock.yaml"
find "$host_stage/dist" -type f \( -name '*.d.ts' -o -name '*.map' \) -delete
find "$node_modules" -type f \( -name '*.map' -o -name '*.pdb' \) -delete

# node-pty publishes native builds for every desktop platform. Keep only the
# build matching the requested target, which may differ from the runner.
node_pty_prebuilds="$node_modules/node-pty/prebuilds"
if [[ -d "$node_pty_prebuilds" ]]; then
  find "$node_pty_prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "darwin-$node_arch" -exec rm -rf -- {} +
fi
spawn_helper="$node_pty_prebuilds/darwin-$node_arch/spawn-helper"
if [[ -f "$spawn_helper" ]]; then chmod 755 "$spawn_helper"; fi

archive="node-$node_version-darwin-$node_arch.tar.gz"
base_url="https://nodejs.org/dist/$node_version"
cache_root="${XIAOYIN_BUILD_CACHE_DIR:-$HOME/Library/Caches/xiaoyin-desktop-builder}"
archive_cache="$cache_root/node/$node_version/$archive"
mkdir -p "$(dirname "$archive_cache")"
actual_sha=""
if [[ -f "$archive_cache" ]]; then
  actual_sha="$(shasum -a 256 "$archive_cache" | awk '{ print $1 }')"
fi
if [[ "$actual_sha" != "$expected_sha" ]]; then
  download="$temporary/$archive"
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 --speed-limit 1024 --speed-time 60 --retry 2 "$base_url/$archive" --output "$download"
  actual_sha="$(shasum -a 256 "$download" | awk '{ print $1 }')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Node.js archive SHA-256 verification failed." >&2
    exit 1
  fi
  mv -f "$download" "$archive_cache"
fi
tar -xzf "$archive_cache" -C "$temporary"
node_root="$temporary/node-$node_version-darwin-$node_arch"
mkdir -p "$next_stage/node"
cp "$node_root/bin/node" "$next_stage/node/node"
cp "$node_root/LICENSE" "$next_stage/node/LICENSE"
chmod 755 "$next_stage/node/node"

node_binary="$next_stage/node/node"
entry="$host_stage/dist/index.js"
pptx_worker="$host_stage/dist/pptx-render-worker.mjs"
config="$host_stage/runtime/cordis.yml"
for required in "$node_binary" "$entry" "$pptx_worker" "$config"; do
  [[ -f "$required" ]] || { echo "Packaged Harness file is missing: $required" >&2; exit 1; }
done

printf '{\n  "schemaVersion": 1,\n  "platform": "macos-%s",\n  "nodeVersion": "%s",\n  "nodeArchiveSha256": "%s"\n}\n' \
  "$node_arch" "$node_version" "$actual_sha" > "$next_stage/runtime-manifest.json"

rm -rf -- "$stage"
mv "$next_stage" "$stage"
trap 'rm -rf -- "$temporary"' EXIT
echo "Packaged Harness runtime is ready: $stage"
echo "Node runtime: $node_version ($node_arch)"
