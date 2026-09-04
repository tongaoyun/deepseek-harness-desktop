#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packaging must run on macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository="$(cd "$script_dir/.." && pwd)"
version="$(node -p "require('$repository/package.json').version")"
if [[ -n "${CARGO_TARGET_DIR-}" ]]; then
  if [[ "$CARGO_TARGET_DIR" = /* ]]; then
    target_dir="$CARGO_TARGET_DIR"
  else
    target_dir="$repository/$CARGO_TARGET_DIR"
  fi
else
  target_dir="$repository/src-tauri/target"
fi
machine="$(uname -m)"
case "$machine" in
  arm64) artifact_arch="aarch64" ;;
  x86_64) artifact_arch="x64" ;;
  *) echo "Unsupported macOS architecture: $machine" >&2; exit 1 ;;
esac

app="$target_dir/release/bundle/macos/小胤.app"
dmg="$target_dir/release/bundle/dmg/小胤_${version}_${artifact_arch}.dmg"
[[ -d "$app" ]] || { echo "Built application is missing: $app" >&2; exit 1; }

# Local/internal builds use an ad-hoc deep signature. Public distribution still
# requires a Developer ID certificate and Apple notarization.
/usr/bin/codesign --force --deep --sign - "$app"
/usr/bin/codesign --verify --deep --strict "$app"

stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
ditto "$app" "$stage/小胤.app"
ln -s /Applications "$stage/Applications"
mkdir -p "$(dirname "$dmg")"
hdiutil create -volname "小胤" -srcfolder "$stage" -ov -format UDZO "$dmg"

echo "macOS application: $app"
echo "macOS disk image: $dmg"
shasum -a 256 "$dmg"
