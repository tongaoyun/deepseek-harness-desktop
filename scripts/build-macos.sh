#!/bin/bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
repository="$(cd "$script_dir/.." && pwd)"
export XIAOYIN_MACOS_ARCH="${1:-${XIAOYIN_MACOS_ARCH:-$(uname -m)}}"
source "$script_dir/macos-build-env.sh"
macos_check_execution
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH-}" ]]; then
  echo 'Set the existing Tauri update signing key before building release installers.' >&2
  exit 1
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY-}" ]]; then
  if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" || ! -r "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo 'The Tauri update signing key file is missing or unreadable.' >&2
    exit 1
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SIGNING_PRIVATE_KEY_PATH")"
  unset TAURI_SIGNING_PRIVATE_KEY_PATH
fi
cd "$repository"
pnpm verify:version
rustup target add "$rust_target"
bash scripts/prepare-harness-runtime-macos.sh
pnpm tauri build --config src-tauri/tauri.macos.conf.json --target "$rust_target"
bash scripts/package-macos-dmg.sh
bash scripts/smoke-test-macos-bundle.sh
