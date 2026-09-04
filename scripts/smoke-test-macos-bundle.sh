#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundle smoke test must run on macOS." >&2
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

case "$(uname -m)" in
  arm64) artifact_arch="aarch64" ;;
  x86_64) artifact_arch="x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

dmg="$target_dir/release/bundle/dmg/小胤_${version}_${artifact_arch}.dmg"
[[ -f "$dmg" ]] || { echo "macOS disk image is missing: $dmg" >&2; exit 1; }

temporary="$(mktemp -d)"
mount_point="$temporary/mounted"
runtime_output="$temporary/runtime-output.jsonl"
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
for required in "$app" "$binary" "$node_binary" "$entry" "$config"; do
  [[ -e "$required" ]] || { echo "Packaged file is missing: $required" >&2; exit 1; }
done

/usr/bin/codesign --verify --deep --strict "$app"
file "$binary" | grep -q "$(uname -m)" || { echo "Application architecture does not match the runner." >&2; exit 1; }
file "$node_binary" | grep -q "$(uname -m)" || { echo "Node.js architecture does not match the runner." >&2; exit 1; }

export DSH_CORDIS_CONFIG="$config"
export XIAOYIN_ALLOW_SHELL="true"
export XIAOYIN_APPROVE_SHELL="false"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"host.initialize"}' \
  '{"jsonrpc":"2.0","id":2,"method":"host.health"}' \
  '{"jsonrpc":"2.0","id":3,"method":"host.shutdown"}' |
  "$node_binary" "$entry" > "$runtime_output"

grep -q '"status":"initialized"' "$runtime_output" || { echo "Packaged Harness initialization failed." >&2; exit 1; }
grep -q '"status":"ready"' "$runtime_output" || { echo "Packaged Harness health check failed." >&2; exit 1; }

echo "macOS bundle smoke test passed: $dmg"
