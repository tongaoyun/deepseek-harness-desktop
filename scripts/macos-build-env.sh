#!/bin/bash
# Source after setting repository. An explicit architecture uses Cargo's target subdirectory.
macos_arch="${XIAOYIN_MACOS_ARCH:-$(uname -m)}"
case "$macos_arch" in
  arm64|aarch64) macos_arch=arm64; node_arch=arm64; artifact_arch=aarch64; binary_arch=arm64; rust_target=aarch64-apple-darwin ;;
  x64|x86_64) macos_arch=x64; node_arch=x64; artifact_arch=x64; binary_arch=x86_64; rust_target=x86_64-apple-darwin ;;
  *) echo "Unsupported macOS target architecture: $macos_arch" >&2; exit 1 ;;
esac
target_dir="${CARGO_TARGET_DIR:-$repository/src-tauri/target}"
[[ "$target_dir" = /* ]] || target_dir="$repository/$target_dir"
if [[ -n "${XIAOYIN_MACOS_ARCH-}" ]]; then target_dir="$target_dir/$rust_target"; fi

macos_check_execution() {
  if [[ "$(uname -m)" == arm64 && "$macos_arch" == x64 ]]; then
    /usr/bin/arch -x86_64 /usr/bin/true || { echo 'Intel runtime verification requires Rosetta 2.' >&2; return 1; }
  elif [[ "$(uname -m)" == x86_64 && "$macos_arch" == arm64 ]]; then
    echo 'Apple Silicon runtime verification requires an Apple Silicon Mac.' >&2; return 1
  fi
}
