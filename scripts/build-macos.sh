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
cd "$repository"
export VITE_CONTROL_PLANE_BASE_URL="${VITE_CONTROL_PLANE_BASE_URL:-http://192.168.2.67:30081}"
pnpm verify:version
rustup target add "$rust_target"
bash scripts/prepare-harness-runtime-macos.sh
pnpm tauri build --config src-tauri/tauri.macos.conf.json --target "$rust_target"
bash scripts/package-macos-dmg.sh
bash scripts/smoke-test-macos-bundle.sh
