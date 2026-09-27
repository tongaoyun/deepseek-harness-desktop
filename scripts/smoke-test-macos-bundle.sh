#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundle smoke test must run on macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository="$(cd "$script_dir/.." && pwd)"
version="$(node -p "require('$repository/package.json').version")"
source "$script_dir/macos-build-env.sh"
macos_check_execution

dmg="$target_dir/release/bundle/dmg/小胤_${version}_${artifact_arch}.dmg"
[[ -f "$dmg" ]] || { echo "macOS disk image is missing: $dmg" >&2; exit 1; }

temporary="$(mktemp -d)"
mount_point="$temporary/mounted"
mkdir -p "$mount_point"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount_point" -quiet || true
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT

hdiutil verify "$dmg"
hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$dmg" >/dev/null
mounted=true

app="$mount_point/小胤.app"
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
binary="$app/Contents/MacOS/$executable_name"
runtime="$app/Contents/Resources/resources/harness-runtime"
node_binary="$runtime/node/node"
entry="$runtime/harness-host/dist/index.js"
config="$runtime/harness-host/runtime/cordis.yml"
primary_manifest="$runtime/primary-runtime/runtime.json"
office_checker="$runtime/office-skills/scripts/check_office.py"
for required in "$app" "$binary" "$node_binary" "$entry" "$config" "$primary_manifest" "$office_checker"; do
  [[ -e "$required" ]] || { echo "Packaged file is missing: $required" >&2; exit 1; }
done

/usr/bin/codesign --verify --deep --strict "$app"
bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
[[ "$bundle_version" == "$version" ]] || { echo 'Installed bundle version does not match the release.' >&2; exit 1; }
erp_http="$(/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSExceptionDomains:www.instudio.me:NSExceptionAllowsInsecureHTTPLoads' "$app/Contents/Info.plist")"
[[ "$erp_http" == true ]] || { echo 'ERP HTTP login callback is blocked by macOS ATS.' >&2; exit 1; }
for broad_exception in NSAllowsArbitraryLoads NSAllowsArbitraryLoadsInWebContent; do
  allowed="$(/usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:$broad_exception" "$app/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$allowed" != true ]] || { echo 'macOS ATS must remain enabled outside the ERP domain.' >&2; exit 1; }
done
/usr/bin/lipo "$binary" -verify_arch "$binary_arch"
/usr/bin/lipo "$node_binary" -verify_arch "$binary_arch"
/usr/bin/lipo "$runtime/harness-host/native/xiaoyin-computer-use" -verify_arch "$binary_arch"
"$node_binary" "$repository/scripts/check-macos-runtime.mjs" "$runtime/harness-host" "$node_arch"

node "$repository/scripts/check-harness-runtime.mjs" "$node_binary" "$runtime/harness-host"

archive="$target_dir/release/bundle/macos/小胤.app.tar.gz"
[[ -s "$archive.sig" ]] || { echo 'Updater signature is missing.' >&2; exit 1; }
node "$repository/scripts/verify-updater-signature.mjs" "$archive" "$repository/src-tauri/tauri.conf.json"
mkdir -p "$temporary/update"
tar -xzf "$archive" -C "$temporary/update"
update_app="$temporary/update/小胤.app"
/usr/bin/codesign --verify --deep --strict "$update_app"
diff -qr "$app" "$update_app" >/dev/null || { echo 'DMG and updater archive contain different applications.' >&2; exit 1; }

echo "macOS bundle smoke test passed: $dmg"
