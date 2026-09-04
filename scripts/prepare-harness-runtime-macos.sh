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
machine="$(uname -m)"
case "$machine" in
  arm64) node_arch="arm64" ;;
  x86_64) node_arch="x64" ;;
  *) echo "Unsupported macOS architecture: $machine" >&2; exit 1 ;;
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
rm -rf -- "$next_stage/harness-host/node_modules/.bin"

archive="node-$node_version-darwin-$node_arch.tar.gz"
base_url="https://nodejs.org/dist/$node_version"
curl --fail --location --silent --show-error "$base_url/$archive" --output "$temporary/$archive"
curl --fail --location --silent --show-error "$base_url/SHASUMS256.txt" --output "$temporary/SHASUMS256.txt"
expected_sha="$(awk -v file="$archive" '$2 == file { print $1 }' "$temporary/SHASUMS256.txt")"
actual_sha="$(shasum -a 256 "$temporary/$archive" | awk '{ print $1 }')"
if [[ -z "$expected_sha" || "$actual_sha" != "$expected_sha" ]]; then
  echo "Node.js archive SHA-256 verification failed." >&2
  exit 1
fi
tar -xzf "$temporary/$archive" -C "$temporary"
node_root="$temporary/node-$node_version-darwin-$node_arch"
mkdir -p "$next_stage/node"
cp "$node_root/bin/node" "$next_stage/node/node"
cp "$node_root/LICENSE" "$next_stage/node/LICENSE"
chmod 755 "$next_stage/node/node"

node_binary="$next_stage/node/node"
entry="$next_stage/harness-host/dist/index.js"
config="$next_stage/harness-host/runtime/cordis.yml"
for required in "$node_binary" "$entry" "$config"; do
  [[ -f "$required" ]] || { echo "Packaged Harness file is missing: $required" >&2; exit 1; }
done

runtime_output="$temporary/runtime-output.jsonl"
old_config="${DSH_CORDIS_CONFIG-}"
old_allow_shell="${XIAOYIN_ALLOW_SHELL-}"
old_approve_shell="${XIAOYIN_APPROVE_SHELL-}"
export DSH_CORDIS_CONFIG="$config"
export XIAOYIN_ALLOW_SHELL="true"
export XIAOYIN_APPROVE_SHELL="false"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"host.initialize"}' \
  '{"jsonrpc":"2.0","id":2,"method":"host.health"}' \
  '{"jsonrpc":"2.0","id":3,"method":"host.shutdown"}' |
  "$node_binary" "$entry" > "$runtime_output"
export DSH_CORDIS_CONFIG="$old_config"
export XIAOYIN_ALLOW_SHELL="$old_allow_shell"
export XIAOYIN_APPROVE_SHELL="$old_approve_shell"

grep -q '"status":"initialized"' "$runtime_output" || { echo "Harness initialization failed." >&2; exit 1; }
grep -q '"status":"ready"' "$runtime_output" || { echo "Harness health check failed." >&2; exit 1; }

printf '{\n  "schemaVersion": 1,\n  "platform": "macos-%s",\n  "nodeVersion": "%s",\n  "nodeArchiveSha256": "%s"\n}\n' \
  "$node_arch" "$node_version" "$actual_sha" > "$next_stage/runtime-manifest.json"

rm -rf -- "$stage"
mv "$next_stage" "$stage"
trap 'rm -rf -- "$temporary"' EXIT
echo "Packaged Harness runtime is ready: $stage"
echo "Node runtime: $node_version ($node_arch)"
